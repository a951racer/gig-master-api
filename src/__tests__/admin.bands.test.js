const request = require('supertest');
const mongoose = require('mongoose');

const app = require('../app');
const User = require('../models/User');
const Band = require('../models/Band');
const Genre = require('../models/Genre');
const Song = require('../models/Song');
const Playlist = require('../models/Playlist');
const Gig = require('../models/Gig');
const JoinRequest = require('../models/JoinRequest');
const Invite = require('../models/Invite');
const SeedGenreList = require('../models/SeedGenreList');
const authService = require('../services/authService');
const seedGenres = require('../config/seedGenres');

// Integration tests for the system-administrator router (Task 9.2). These
// exercise the real Express app (require '../app') via supertest against the
// in-memory MongoDB started by the shared test infra (src/config/testSetup.js
// sets process.env.MONGODB_URI). We connect mongoose in beforeAll and build
// indexes on the models we touch, mirroring auth.bands.test.js /
// models.bands.test.js.
//
// Every /admin route is gated by `authenticate -> requireSystemAdmin` and is
// band-independent, so we mint Bearer tokens by creating a real User and
// calling authService.generateAccessToken(user) after populating
// bands.band -> name (mirrors /auth/login). No X-Band-Id header is ever sent,
// proving sysadmin access does not depend on the current band (Req 11.5).
//
// Validates: Requirements 3.5, 11.1, 11.2, 11.3, 11.4, 11.5

const PASSWORD = 'password123';

// Create a real persisted user with the given role, then mint a signed access
// token for them exactly as /auth/login does (load + populate memberships).
async function createUserWithToken(email, role = 'user') {
  const passwordHash = await authService.hashPassword(PASSWORD);
  await User.create({ email: email.toLowerCase(), passwordHash, role });

  // Reload with populated band names so buildBandsClaim mirrors the login path.
  const user = await User.findOne({ email: email.toLowerCase() }).populate(
    'bands.band',
    'name'
  );
  const token = authService.generateAccessToken(user);
  return { user, token };
}

beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await Promise.all([
    User.syncIndexes(),
    Band.syncIndexes(),
    Genre.syncIndexes(),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
});

afterEach(async () => {
  await Promise.all([
    User.deleteMany({}),
    Band.deleteMany({}),
    Genre.deleteMany({}),
    Song.deleteMany({}),
    Playlist.deleteMany({}),
    Gig.deleteMany({}),
    JoinRequest.deleteMany({}),
    Invite.deleteMany({}),
    SeedGenreList.deleteMany({}),
  ]);
});

describe('Admin routes DENY non-sysadmin callers (Requirements 3.5, 11.1)', () => {
  let userToken;
  let targetUserId;

  beforeEach(async () => {
    const { token } = await createUserWithToken('plain-user@example.com', 'user');
    userToken = token;
    // A separate target for the PATCH-role route so the id resolves.
    const passwordHash = await authService.hashPassword(PASSWORD);
    const target = await User.create({ email: 'target@example.com', passwordHash });
    targetUserId = target._id.toString();
  });

  it('POST /admin/users returns 403 FORBIDDEN for a role="user" caller', async () => {
    const res = await request(app)
      .post('/admin/users')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ email: 'nope@example.com', password: PASSWORD });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('POST /admin/bands returns 403 FORBIDDEN for a role="user" caller', async () => {
    const res = await request(app)
      .post('/admin/bands')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'Nope Band', administrator: targetUserId });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('PATCH /admin/users/:id/role returns 403 FORBIDDEN for a role="user" caller', async () => {
    const res = await request(app)
      .patch(`/admin/users/${targetUserId}/role`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ role: 'system_administrator' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('GET /admin/seed-genres returns 403 FORBIDDEN for a role="user" caller', async () => {
    const res = await request(app)
      .get('/admin/seed-genres')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('does not require an X-Band-Id header to make the 403 decision (Req 11.5)', async () => {
    // No X-Band-Id set anywhere above — the deny decision is purely role-based.
    const res = await request(app)
      .post('/admin/users')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ email: 'still-nope@example.com', password: PASSWORD });
    expect(res.status).toBe(403);
  });
});

describe('Admin routes ALLOW a system_administrator caller (Requirements 11.1–11.5)', () => {
  let adminToken;

  beforeEach(async () => {
    const { token } = await createUserWithToken('sysadmin@example.com', 'system_administrator');
    adminToken = token;
  });

  it('POST /admin/users creates a user with the given role and persists it (Req 11.1)', async () => {
    const res = await request(app)
      .post('/admin/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'created@example.com', password: PASSWORD, role: 'system_administrator' });

    expect(res.status).toBe(201);
    expect(res.body.email).toBe('created@example.com');
    expect(res.body.role).toBe('system_administrator');

    const persisted = await User.findById(res.body.id);
    expect(persisted).not.toBeNull();
    expect(persisted.role).toBe('system_administrator');
  });

  it('PATCH /admin/users/:id/role changes a user role and persists it (Req 11.1)', async () => {
    const passwordHash = await authService.hashPassword(PASSWORD);
    const user = await User.create({ email: 'promote-me@example.com', passwordHash });
    expect(user.role).toBe('user');

    const res = await request(app)
      .patch(`/admin/users/${user._id}/role`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'system_administrator' });

    expect(res.status).toBe(200);
    expect(res.body.role).toBe('system_administrator');

    const persisted = await User.findById(user._id);
    expect(persisted.role).toBe('system_administrator');
  });

  it('POST /admin/bands creates a band, makes the target admin+member, and seeds genres (Req 11.2)', async () => {
    const passwordHash = await authService.hashPassword(PASSWORD);
    const target = await User.create({ email: 'band-owner@example.com', passwordHash });

    const res = await request(app)
      .post('/admin/bands')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'The Admins', administrator: target._id.toString() });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('The Admins');

    const bandId = res.body.id;

    // Band.administrator points at the target user.
    const band = await Band.findById(bandId);
    expect(band).not.toBeNull();
    expect(band.administrator.toString()).toBe(target._id.toString());

    // The target user's membership for this band exists with isAdmin: true.
    const persistedTarget = await User.findById(target._id);
    const membership = persistedTarget.bands.find(
      (m) => m.band.toString() === bandId.toString()
    );
    expect(membership).toBeDefined();
    expect(membership.isAdmin).toBe(true);

    // The band's genres were seeded from the default seed list.
    const genres = await Genre.find({ band: bandId });
    expect(genres.length).toBe(seedGenres.DEFAULT_GENRES.length);
    const names = genres.map((g) => g.name).sort();
    expect(names).toEqual([...seedGenres.DEFAULT_GENRES].sort());
  });

  it('POST /admin/bands/:id/members adds a member directly (Req 11.3)', async () => {
    const passwordHash = await authService.hashPassword(PASSWORD);
    const owner = await User.create({ email: 'owner2@example.com', passwordHash });
    const newMember = await User.create({ email: 'new-member@example.com', passwordHash });

    const bandRes = await request(app)
      .post('/admin/bands')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Member Band', administrator: owner._id.toString() });
    const bandId = bandRes.body.id;

    const res = await request(app)
      .post(`/admin/bands/${bandId}/members`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ userId: newMember._id.toString() });

    expect(res.status).toBe(200);

    const persisted = await User.findById(newMember._id);
    const membership = persisted.bands.find(
      (m) => m.band.toString() === bandId.toString()
    );
    expect(membership).toBeDefined();
    // Added directly as a plain member (not admin).
    expect(membership.isAdmin).toBe(false);
  });

  it('PATCH /admin/bands/:id/administrator reassigns admin with consistent isAdmin flags (Req 11.3)', async () => {
    const passwordHash = await authService.hashPassword(PASSWORD);
    const firstAdmin = await User.create({ email: 'first-admin@example.com', passwordHash });
    const secondAdmin = await User.create({ email: 'second-admin@example.com', passwordHash });

    const bandRes = await request(app)
      .post('/admin/bands')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Reassign Band', administrator: firstAdmin._id.toString() });
    const bandId = bandRes.body.id;

    const res = await request(app)
      .patch(`/admin/bands/${bandId}/administrator`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ userId: secondAdmin._id.toString() });

    expect(res.status).toBe(200);

    // Band.administrator changed to the second user.
    const band = await Band.findById(bandId);
    expect(band.administrator.toString()).toBe(secondAdmin._id.toString());

    // The new admin's membership is isAdmin: true.
    const secondPersisted = await User.findById(secondAdmin._id);
    const secondMembership = secondPersisted.bands.find(
      (m) => m.band.toString() === bandId.toString()
    );
    expect(secondMembership).toBeDefined();
    expect(secondMembership.isAdmin).toBe(true);

    // The previous admin was demoted for this band (single-admin invariant).
    const firstPersisted = await User.findById(firstAdmin._id);
    const firstMembership = firstPersisted.bands.find(
      (m) => m.band.toString() === bandId.toString()
    );
    if (firstMembership) {
      expect(firstMembership.isAdmin).toBe(false);
    }
  });

  it('GET then PUT then GET /admin/seed-genres reflects the updated list (Req 11.4)', async () => {
    // GET the current maintained list.
    const before = await request(app)
      .get('/admin/seed-genres')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(before.status).toBe(200);
    expect(Array.isArray(before.body.genres)).toBe(true);

    // PUT a replacement list.
    const newList = ['Ska', 'Grunge', 'Ambient'];
    const put = await request(app)
      .put('/admin/seed-genres')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ genres: newList });
    expect(put.status).toBe(200);
    expect(put.body.genres).toEqual(newList);

    // GET again — reads back the persisted list.
    const after = await request(app)
      .get('/admin/seed-genres')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(after.status).toBe(200);
    expect(after.body.genres).toEqual(newList);
  });

  it('sysadmin access does NOT depend on X-Band-Id — no band header sent (Req 11.5)', async () => {
    // The sysadmin has an empty bands[] claim and sends no X-Band-Id, yet all
    // representative admin operations succeed purely on role.
    const passwordHash = await authService.hashPassword(PASSWORD);
    const someUser = await User.create({ email: 'no-band-header@example.com', passwordHash });

    const usersRes = await request(app)
      .post('/admin/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'from-no-band@example.com', password: PASSWORD });
    expect(usersRes.status).toBe(201);

    const bandsRes = await request(app)
      .post('/admin/bands')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'No Header Band', administrator: someUser._id.toString() });
    expect(bandsRes.status).toBe(201);

    const seedRes = await request(app)
      .get('/admin/seed-genres')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(seedRes.status).toBe(200);
  });
});

// PATCH /admin/users/:id — system-administrator edit of any user (#40).
describe('PATCH /admin/users/:id — admin edit user (#40)', () => {
  let adminToken;

  beforeEach(async () => {
    const { token } = await createUserWithToken('editor-admin@example.com', 'system_administrator');
    adminToken = token;
  });

  it('returns 403 FORBIDDEN for a non-sysadmin caller', async () => {
    const { token: userToken } = await createUserWithToken('plain@example.com', 'user');
    const passwordHash = await authService.hashPassword(PASSWORD);
    const target = await User.create({ email: 'edit-target@example.com', passwordHash });

    const res = await request(app)
      .patch(`/admin/users/${target._id}`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ firstName: 'Nope' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('updates email, first/last name, and role and persists them', async () => {
    const passwordHash = await authService.hashPassword(PASSWORD);
    const target = await User.create({ email: 'old@example.com', passwordHash });

    const res = await request(app)
      .patch(`/admin/users/${target._id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email: 'New@Example.com',
        firstName: '  Jane  ',
        lastName: '  Doe  ',
        role: 'system_administrator',
      });

    expect(res.status).toBe(200);
    expect(res.body.email).toBe('new@example.com');
    expect(res.body.firstName).toBe('Jane');
    expect(res.body.lastName).toBe('Doe');
    expect(res.body.role).toBe('system_administrator');

    const persisted = await User.findById(target._id);
    expect(persisted.email).toBe('new@example.com');
    expect(persisted.firstName).toBe('Jane');
    expect(persisted.role).toBe('system_administrator');
  });

  it('resets a password directly (no current-password) and the new one authenticates', async () => {
    const passwordHash = await authService.hashPassword(PASSWORD);
    const target = await User.create({ email: 'reset-me@example.com', passwordHash });

    const res = await request(app)
      .patch(`/admin/users/${target._id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ newPassword: 'brand-new-pass' });

    expect(res.status).toBe(200);

    const persisted = await User.findById(target._id);
    const ok = await authService.comparePassword('brand-new-pass', persisted.passwordHash);
    expect(ok).toBe(true);
  });

  it('rejects a too-short password with 422', async () => {
    const passwordHash = await authService.hashPassword(PASSWORD);
    const target = await User.create({ email: 'short-pass@example.com', passwordHash });

    const res = await request(app)
      .patch(`/admin/users/${target._id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ newPassword: 'short' });

    expect(res.status).toBe(422);
    expect(res.body.error.fields.newPassword).toBeTruthy();
  });

  it('returns 409 EMAIL_TAKEN when the new email belongs to another user', async () => {
    const passwordHash = await authService.hashPassword(PASSWORD);
    await User.create({ email: 'taken@example.com', passwordHash });
    const target = await User.create({ email: 'mover@example.com', passwordHash });

    const res = await request(app)
      .patch(`/admin/users/${target._id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'taken@example.com' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('rejects an invalid role with 422', async () => {
    const passwordHash = await authService.hashPassword(PASSWORD);
    const target = await User.create({ email: 'bad-role@example.com', passwordHash });

    const res = await request(app)
      .patch(`/admin/users/${target._id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'wizard' });

    expect(res.status).toBe(422);
    expect(res.body.error.fields.role).toBeTruthy();
  });

  it('returns 404 for an unknown user id', async () => {
    const missingId = new mongoose.Types.ObjectId().toString();
    const res = await request(app)
      .patch(`/admin/users/${missingId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ firstName: 'Ghost' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('blocks demoting the last system administrator with 409 LAST_ADMIN', async () => {
    // The editor-admin created in beforeEach is the only sysadmin. Demoting
    // them would leave zero sysadmins.
    const sole = await User.findOne({ email: 'editor-admin@example.com' });

    const res = await request(app)
      .patch(`/admin/users/${sole._id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'user' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LAST_ADMIN');

    const persisted = await User.findById(sole._id);
    expect(persisted.role).toBe('system_administrator');
  });

  it('allows demoting a sysadmin when another sysadmin remains', async () => {
    const passwordHash = await authService.hashPassword(PASSWORD);
    const second = await User.create({
      email: 'second-admin@example.com',
      passwordHash,
      role: 'system_administrator',
    });

    const res = await request(app)
      .patch(`/admin/users/${second._id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'user' });

    expect(res.status).toBe(200);
    expect(res.body.role).toBe('user');
  });
});

// GET /admin/bands/:id/members — sysadmin views any band's members with the
// band-administrator designator (isAdmin).
describe('GET /admin/bands/:id/members (sysadmin band membership view)', () => {
  let adminToken;

  beforeEach(async () => {
    const { token } = await createUserWithToken('members-admin@example.com', 'system_administrator');
    adminToken = token;
  });

  it('returns 403 FORBIDDEN for a non-sysadmin caller', async () => {
    const { token: userToken } = await createUserWithToken('member-peeker@example.com', 'user');
    const someBandId = new mongoose.Types.ObjectId().toString();

    const res = await request(app)
      .get(`/admin/bands/${someBandId}/members`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('returns 404 for an unknown band id', async () => {
    const missingId = new mongoose.Types.ObjectId().toString();
    const res = await request(app)
      .get(`/admin/bands/${missingId}/members`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('lists members with the administrator flagged isAdmin: true', async () => {
    const passwordHash = await authService.hashPassword(PASSWORD);
    const owner = await User.create({ email: 'owner@example.com', passwordHash });
    const plain = await User.create({ email: 'plain-member@example.com', passwordHash });

    // Create a band owned by `owner`, then add `plain` as a regular member.
    const createRes = await request(app)
      .post('/admin/bands')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'The Members Test', administrator: owner._id.toString() });
    expect(createRes.status).toBe(201);
    const bandId = createRes.body.id;

    const addRes = await request(app)
      .post(`/admin/bands/${bandId}/members`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ userId: plain._id.toString() });
    expect(addRes.status).toBe(200);

    const res = await request(app)
      .get(`/admin/bands/${bandId}/members`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);

    const byEmail = Object.fromEntries(res.body.map((m) => [m.email, m]));
    expect(byEmail['owner@example.com'].isAdmin).toBe(true);
    expect(byEmail['plain-member@example.com'].isAdmin).toBe(false);
    // Each member carries id/email and name fields.
    expect(byEmail['owner@example.com'].id).toBeTruthy();
  });
});

// Two-stage band deletion (#42): archive → hard-delete with cascade.
describe('Two-stage band deletion (#42)', () => {
  let adminToken;
  let owner;

  // Create an archived-or-not band owned by a fresh user, seeded with one of
  // each owned resource, and return { bandId, memberId }.
  async function seedBand(name = 'Doomed Band') {
    const createRes = await request(app)
      .post('/admin/bands')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name, administrator: owner._id.toString() });
    expect(createRes.status).toBe(201);
    const bandId = createRes.body.id;

    const passwordHash = await authService.hashPassword(PASSWORD);
    const member = await User.create({ email: `member-${name.replace(/\s/g, '')}@ex.com`, passwordHash });
    await request(app)
      .post(`/admin/bands/${bandId}/members`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ userId: member._id.toString() });

    await Song.create({ band: bandId, title: 'A Song', artist: 'An Artist' });
    await Playlist.create({ band: bandId, name: 'A List' });
    await Gig.create({ band: bandId, name: 'A Gig', date: new Date() });
    await JoinRequest.create({ band: bandId, user: member._id, status: 'pending' });

    return { bandId, memberId: member._id.toString() };
  }

  beforeEach(async () => {
    const { token } = await createUserWithToken('delete-admin@example.com', 'system_administrator');
    adminToken = token;
    const passwordHash = await authService.hashPassword(PASSWORD);
    owner = await User.create({ email: 'band-owner-del@example.com', passwordHash });
  });

  it('archive returns 403 for a non-sysadmin caller', async () => {
    const { token: userToken } = await createUserWithToken('nope-arch@example.com', 'user');
    const { bandId } = await seedBand('Guard Band');

    const res = await request(app)
      .post(`/admin/bands/${bandId}/archive`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('archives a band, and it disappears from the members token claim / GET /me/bands', async () => {
    const { bandId } = await seedBand('Archive Me');

    const archiveRes = await request(app)
      .post(`/admin/bands/${bandId}/archive`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(archiveRes.status).toBe(200);
    expect(archiveRes.body.archivedAt).toBeTruthy();

    // The owner (a member+admin of the band) should no longer see it via
    // GET /me/bands, which excludes archived bands.
    const ownerLoaded = await User.findById(owner._id).populate('bands.band', 'name archivedAt');
    const ownerToken = authService.generateAccessToken(ownerLoaded);
    const meBands = await request(app)
      .get('/bands/me/bands')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(meBands.status).toBe(200);
    expect(meBands.body.find((b) => b.id === bandId)).toBeUndefined();

    // And the token claim excludes it too.
    const claim = authService.buildBandsClaim(ownerLoaded);
    expect(claim.find((b) => b.id === bandId)).toBeUndefined();
  });

  it('archiving an already-archived band returns 409 ALREADY_ARCHIVED', async () => {
    const { bandId } = await seedBand('Twice');
    await request(app).post(`/admin/bands/${bandId}/archive`).set('Authorization', `Bearer ${adminToken}`);

    const again = await request(app)
      .post(`/admin/bands/${bandId}/archive`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_ARCHIVED');
  });

  it('unarchive restores a band (and 409 NOT_ARCHIVED when it was not archived)', async () => {
    const { bandId } = await seedBand('Restore Me');

    const notArchived = await request(app)
      .post(`/admin/bands/${bandId}/unarchive`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(notArchived.status).toBe(409);
    expect(notArchived.body.error.code).toBe('NOT_ARCHIVED');

    await request(app).post(`/admin/bands/${bandId}/archive`).set('Authorization', `Bearer ${adminToken}`);
    const unarch = await request(app)
      .post(`/admin/bands/${bandId}/unarchive`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(unarch.status).toBe(200);
    expect(unarch.body.archivedAt).toBeNull();

    const band = await Band.findById(bandId);
    expect(band.archivedAt).toBeNull();
  });

  it('refuses to hard-delete a band that is not archived (409 NOT_ARCHIVED)', async () => {
    const { bandId } = await seedBand('Not Yet');

    const res = await request(app)
      .delete(`/admin/bands/${bandId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_ARCHIVED');

    // Nothing was deleted.
    expect(await Band.findById(bandId)).not.toBeNull();
    expect(await Song.countDocuments({ band: bandId })).toBe(1);
  });

  it('hard-deletes an archived band and cascades all owned resources + memberships', async () => {
    const { bandId, memberId } = await seedBand('Bye Band');

    await request(app).post(`/admin/bands/${bandId}/archive`).set('Authorization', `Bearer ${adminToken}`);

    const res = await request(app)
      .delete(`/admin/bands/${bandId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    // The band and all owned resources are gone.
    expect(await Band.findById(bandId)).toBeNull();
    expect(await Song.countDocuments({ band: bandId })).toBe(0);
    expect(await Playlist.countDocuments({ band: bandId })).toBe(0);
    expect(await Gig.countDocuments({ band: bandId })).toBe(0);
    expect(await Genre.countDocuments({ band: bandId })).toBe(0);
    expect(await JoinRequest.countDocuments({ band: bandId })).toBe(0);

    // Membership removed from both the owner and the member.
    const ownerAfter = await User.findById(owner._id);
    expect(ownerAfter.bands.find((m) => m.band.toString() === bandId)).toBeUndefined();
    const memberAfter = await User.findById(memberId);
    expect(memberAfter.bands.find((m) => m.band.toString() === bandId)).toBeUndefined();
  });

  it('delete returns 403 for a non-sysadmin and 404 for an unknown band', async () => {
    const { token: userToken } = await createUserWithToken('nope-del@example.com', 'user');
    const { bandId } = await seedBand('Perms Band');
    await request(app).post(`/admin/bands/${bandId}/archive`).set('Authorization', `Bearer ${adminToken}`);

    const forbidden = await request(app)
      .delete(`/admin/bands/${bandId}`)
      .set('Authorization', `Bearer ${userToken}`);
    expect(forbidden.status).toBe(403);

    const missingId = new mongoose.Types.ObjectId().toString();
    const notFound = await request(app)
      .delete(`/admin/bands/${missingId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(notFound.status).toBe(404);
  });
});

// Persisted master Seed_Genre_List (#41): durability + new-band seeding source.
describe('Persisted Seed_Genre_List (#41)', () => {
  let adminToken;

  beforeEach(async () => {
    const { token } = await createUserWithToken('seed-admin@example.com', 'system_administrator');
    adminToken = token;
  });

  it('GET lazily initializes the persisted list from DEFAULT_GENRES', async () => {
    // No SeedGenreList document exists yet (cleaned between tests).
    const res = await request(app)
      .get('/admin/seed-genres')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.genres).toEqual(seedGenres.DEFAULT_GENRES);

    // The singleton was created and persisted.
    const doc = await SeedGenreList.findOne({ key: 'master' });
    expect(doc).not.toBeNull();
    expect(doc.genres).toEqual(seedGenres.DEFAULT_GENRES);
  });

  it('PUT persists the list to the database (survives a fresh model read)', async () => {
    const newList = ['Ska', 'Grunge', 'Ambient'];
    const put = await request(app)
      .put('/admin/seed-genres')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ genres: newList });
    expect(put.status).toBe(200);
    expect(put.body.genres).toEqual(newList);

    // Read straight from the DB (not the API) to prove durability — this is the
    // persistence the in-memory version lacked.
    const doc = await SeedGenreList.findOne({ key: 'master' });
    expect(doc.genres).toEqual(newList);

    // And there is exactly one singleton document (no duplicates on replace).
    expect(await SeedGenreList.countDocuments()).toBe(1);
  });

  it('new bands are seeded from the PERSISTED list, not the hardcoded defaults', async () => {
    // Maintain a custom seed list.
    const customList = ['Surf', 'Shoegaze'];
    await request(app)
      .put('/admin/seed-genres')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ genres: customList });

    // Create a band and verify its genres came from the persisted list.
    const passwordHash = await authService.hashPassword(PASSWORD);
    const owner = await User.create({ email: 'seed-owner@example.com', passwordHash });
    const createRes = await request(app)
      .post('/admin/bands')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Seeded From Custom', administrator: owner._id.toString() });
    expect(createRes.status).toBe(201);

    const genres = await Genre.find({ band: createRes.body.id });
    expect(genres.map((g) => g.name).sort()).toEqual([...customList].sort());
  });

  it('seedBandGenres reads the persisted list directly (service-level)', async () => {
    await seedGenres.setSeedGenreList(['Only One']);
    const bandId = new mongoose.Types.ObjectId();
    await seedGenres.seedBandGenres(bandId);

    const genres = await Genre.find({ band: bandId });
    expect(genres.map((g) => g.name)).toEqual(['Only One']);
  });
})
