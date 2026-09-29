const request = require('supertest');
const mongoose = require('mongoose');

const app = require('../app');
const User = require('../models/User');
const Band = require('../models/Band');
const Genre = require('../models/Genre');
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

    // GET again — the in-memory module-level list reflects the change within
    // this process.
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
