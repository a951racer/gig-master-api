const request = require('supertest');
const mongoose = require('mongoose');

const app = require('../app');
const User = require('../models/User');
const Band = require('../models/Band');
const Invite = require('../models/Invite');
const authService = require('../services/authService');
const membershipService = require('../services/membershipService');

// Integration tests for the band-invite endpoints (Part A: /bands/:id/invites
// management; Part B: public /invites accept flow). These exercise the real
// Express app via supertest against the in-memory MongoDB started by the shared
// test infra (src/config/testSetup.js sets process.env.MONGODB_URI).
//
// Tokens are minted by creating a real User and calling
// authService.generateAccessToken(user) after populating bands.band -> name,
// exactly as /auth/login does — so the bands[] claim carries id/name/isAdmin
// that bandScope + requireBandAdmin read. The invite-management routes use
// bandScope, so the X-Band-Id header is set to the band id.
//
// NOTE: emailService.sendMail throws in tests (EMAIL_HOST is not configured).
// The create endpoint wraps the send in try/catch, so invite creation still
// returns 201 — verified below.

const PASSWORD = 'password123';

// Create a persisted user (optionally with populated band memberships) and mint
// a signed access token for them, mirroring the /auth/login path.
async function tokenFor(userId) {
  const user = await User.findById(userId).populate('bands.band', 'name');
  return authService.generateAccessToken(user);
}

async function createUser(email, role = 'user') {
  const passwordHash = await authService.hashPassword(PASSWORD);
  return User.create({ email: email.toLowerCase(), passwordHash, role });
}

// Create a band with `adminUser` as its administrator (single-admin invariant
// via membershipService.setAdministrator), returning the band.
async function createBandWithAdmin(adminUser, name = 'Test Band') {
  const band = await Band.create({ name, administrator: adminUser._id });
  await membershipService.setAdministrator(band._id, adminUser._id);
  return band;
}

beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await Promise.all([
    User.syncIndexes(),
    Band.syncIndexes(),
    Invite.syncIndexes(),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
});

afterEach(async () => {
  await Promise.all([
    User.deleteMany({}),
    Band.deleteMany({}),
    Invite.deleteMany({}),
  ]);
});

describe('POST /bands/:id/invites — create invite (band admin)', () => {
  it('creates a pending invite as band admin and returns 201 even though email send fails', async () => {
    const admin = await createUser('admin@example.com');
    const band = await createBandWithAdmin(admin);
    const token = await tokenFor(admin._id);

    const res = await request(app)
      .post(`/bands/${band._id}/invites`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Band-Id', band._id.toString())
      .send({ email: 'invitee@example.com' });

    expect(res.status).toBe(201);
    expect(res.body.email).toBe('invitee@example.com');
    expect(res.body.status).toBe('pending');

    const invite = await Invite.findById(res.body.id);
    expect(invite).not.toBeNull();
    expect(invite.status).toBe('pending');
    expect(invite.band.toString()).toBe(band._id.toString());
    expect(invite.email).toBe('invitee@example.com');
    // Only the hash is stored — never a raw token field.
    expect(invite.tokenHash).toBeTruthy();
  });

  it('rejects a duplicate pending invite for the same email with 409', async () => {
    const admin = await createUser('admin2@example.com');
    const band = await createBandWithAdmin(admin);
    const token = await tokenFor(admin._id);

    const first = await request(app)
      .post(`/bands/${band._id}/invites`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Band-Id', band._id.toString())
      .send({ email: 'dupe@example.com' });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/bands/${band._id}/invites`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Band-Id', band._id.toString())
      .send({ email: 'dupe@example.com' });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('CONFLICT');
  });

  it('returns 422 for an invalid email', async () => {
    const admin = await createUser('admin3@example.com');
    const band = await createBandWithAdmin(admin);
    const token = await tokenFor(admin._id);

    const res = await request(app)
      .post(`/bands/${band._id}/invites`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Band-Id', band._id.toString())
      .send({ email: 'not-an-email' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 403 for a non-admin member creating an invite', async () => {
    const admin = await createUser('owner@example.com');
    const band = await createBandWithAdmin(admin);
    const member = await createUser('member@example.com');
    await membershipService.addMember(band._id, member._id, { isAdmin: false });
    const token = await tokenFor(member._id);

    const res = await request(app)
      .post(`/bands/${band._id}/invites`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Band-Id', band._id.toString())
      .send({ email: 'someone@example.com' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

describe('GET /bands/:id/invites — list pending', () => {
  it('lists pending invites for the current band', async () => {
    const admin = await createUser('admin4@example.com');
    const band = await createBandWithAdmin(admin);
    const token = await tokenFor(admin._id);

    await request(app)
      .post(`/bands/${band._id}/invites`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Band-Id', band._id.toString())
      .send({ email: 'p1@example.com' });

    const res = await request(app)
      .get(`/bands/${band._id}/invites`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Band-Id', band._id.toString());

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(1);
    expect(res.body[0].email).toBe('p1@example.com');
    expect(res.body[0].status).toBe('pending');
    expect(res.body[0].expiresAt).toBeTruthy();
  });
});

describe('DELETE /bands/:id/invites/:inviteId — revoke', () => {
  it('revokes a pending invite (status becomes revoked)', async () => {
    const admin = await createUser('admin5@example.com');
    const band = await createBandWithAdmin(admin);
    const token = await tokenFor(admin._id);

    const created = await request(app)
      .post(`/bands/${band._id}/invites`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Band-Id', band._id.toString())
      .send({ email: 'revoke@example.com' });
    const inviteId = created.body.id;

    const res = await request(app)
      .delete(`/bands/${band._id}/invites/${inviteId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Band-Id', band._id.toString());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('revoked');

    const persisted = await Invite.findById(inviteId);
    expect(persisted.status).toBe('revoked');
  });

  it('returns 404 for an invite that does not belong to the band', async () => {
    const admin = await createUser('admin6@example.com');
    const band = await createBandWithAdmin(admin);
    const token = await tokenFor(admin._id);

    const res = await request(app)
      .delete(`/bands/${band._id}/invites/${new mongoose.Types.ObjectId()}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Band-Id', band._id.toString());

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

// Helper: create a pending invite directly and return { invite, rawToken }.
async function seedInvite(band, invitedBy, email, overrides = {}) {
  const raw = authService.generateRefreshToken();
  const invite = await Invite.create({
    band: band._id,
    email: email.toLowerCase(),
    tokenHash: authService.hashToken(raw),
    invitedBy: invitedBy._id,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    ...overrides,
  });
  return { invite, rawToken: raw };
}

describe('GET /invites/:token — public lookup', () => {
  it('returns bandName/email/status/hasAccount for a valid token', async () => {
    const admin = await createUser('admin7@example.com');
    const band = await createBandWithAdmin(admin, 'Public Band');
    const { rawToken } = await seedInvite(band, admin, 'lookup@example.com');

    const res = await request(app).get(`/invites/${rawToken}`);

    expect(res.status).toBe(200);
    expect(res.body.bandName).toBe('Public Band');
    expect(res.body.email).toBe('lookup@example.com');
    expect(res.body.status).toBe('pending');
    // No account yet for this email.
    expect(res.body.hasAccount).toBe(false);
    // The raw token must not be echoed back.
    expect(res.body.token).toBeUndefined();
    expect(res.body.tokenHash).toBeUndefined();
  });

  it('reports hasAccount true when a user with the invite email exists', async () => {
    const admin = await createUser('admin8@example.com');
    const band = await createBandWithAdmin(admin);
    await createUser('has-account@example.com');
    const { rawToken } = await seedInvite(band, admin, 'has-account@example.com');

    const res = await request(app).get(`/invites/${rawToken}`);

    expect(res.status).toBe(200);
    expect(res.body.hasAccount).toBe(true);
  });

  it('returns 404 for an unknown token', async () => {
    const res = await request(app).get('/invites/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('POST /invites/:token/accept — accept invite', () => {
  it('adds the matching-email user to the band and marks the invite accepted', async () => {
    const admin = await createUser('admin9@example.com');
    const band = await createBandWithAdmin(admin);
    const invitee = await createUser('accept@example.com');
    const { invite, rawToken } = await seedInvite(band, admin, 'accept@example.com');
    const token = await tokenFor(invitee._id);

    const res = await request(app)
      .post(`/invites/${rawToken}/accept`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('accepted');
    expect(res.body.bandId.toString()).toBe(band._id.toString());

    const persistedInvite = await Invite.findById(invite._id);
    expect(persistedInvite.status).toBe('accepted');

    const persistedUser = await User.findById(invitee._id);
    const membership = persistedUser.bands.find(
      (m) => m.band.toString() === band._id.toString()
    );
    expect(membership).toBeDefined();
    expect(membership.isAdmin).toBe(false);
  });

  it('returns 403 when the logged-in user email does not match the invite', async () => {
    const admin = await createUser('admin10@example.com');
    const band = await createBandWithAdmin(admin);
    const other = await createUser('other@example.com');
    const { rawToken } = await seedInvite(band, admin, 'intended@example.com');
    const token = await tokenFor(other._id);

    const res = await request(app)
      .post(`/invites/${rawToken}/accept`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('returns 409 for an already-accepted invite', async () => {
    const admin = await createUser('admin11@example.com');
    const band = await createBandWithAdmin(admin);
    const invitee = await createUser('accepted-already@example.com');
    const { rawToken } = await seedInvite(band, admin, 'accepted-already@example.com', {
      status: 'accepted',
    });
    const token = await tokenFor(invitee._id);

    const res = await request(app)
      .post(`/invites/${rawToken}/accept`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVITE_INVALID');
  });

  it('returns 409 for a revoked invite', async () => {
    const admin = await createUser('admin12@example.com');
    const band = await createBandWithAdmin(admin);
    const invitee = await createUser('revoked-invite@example.com');
    const { rawToken } = await seedInvite(band, admin, 'revoked-invite@example.com', {
      status: 'revoked',
    });
    const token = await tokenFor(invitee._id);

    const res = await request(app)
      .post(`/invites/${rawToken}/accept`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVITE_INVALID');
  });

  it('returns 409 for an expired invite (expiresAt in the past)', async () => {
    const admin = await createUser('admin13@example.com');
    const band = await createBandWithAdmin(admin);
    const invitee = await createUser('expired-invite@example.com');
    const { rawToken } = await seedInvite(band, admin, 'expired-invite@example.com', {
      expiresAt: new Date(Date.now() - 1000),
    });
    const token = await tokenFor(invitee._id);

    const res = await request(app)
      .post(`/invites/${rawToken}/accept`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVITE_INVALID');
  });
});
