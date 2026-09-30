const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const app = require('../app');
const User = require('../models/User');
const RefreshToken = require('../models/RefreshToken');

// Integration tests for auth backward compatibility with the new JWT claim
// (Task 4.3). These exercise the real Express app (require '../app') via
// supertest against the in-memory MongoDB started by the shared test infra
// (src/config/testSetup.js sets process.env.MONGODB_URI). Because the tests
// hit routes that read/write the DB (register/login/refresh/me) and the
// `authenticate` middleware loads req.user, we connect mongoose here in
// beforeAll — mirroring models.bands.test.js — and build the User index.
//
// Validates: Requirements 5.3, 5.4, 20.2, 20.3

const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'dev-access-secret';

const EMAIL = 'backcompat@example.com';
const PASSWORD = 'password123';

function decodeAccessToken(token) {
  // Verify with the same secret the app signs with, so we assert on a
  // cryptographically valid token, not just a base64 blob.
  return jwt.verify(token, ACCESS_TOKEN_SECRET);
}

async function registerUser(email = EMAIL, password = PASSWORD) {
  return request(app).post('/auth/register').send({ email, password });
}

async function loginUser(email = EMAIL, password = PASSWORD) {
  return request(app).post('/auth/login').send({ email, password });
}

beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await User.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
});

afterEach(async () => {
  await Promise.all([User.deleteMany({}), RefreshToken.deleteMany({})]);
});

describe('POST /auth/register — backward compatibility (Requirements 2.2, 20.1)', () => {
  it('still creates a user with role "user" and an empty bands[]', async () => {
    const res = await registerUser();

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ message: 'User created' });

    // Verify the persisted defaults via the DB.
    const user = await User.findOne({ email: EMAIL });
    expect(user).not.toBeNull();
    expect(user.role).toBe('user');
    expect(Array.isArray(user.bands)).toBe(true);
    expect(user.bands).toHaveLength(0);
  });
});

describe('POST /auth/login — shape unchanged, token carries new claim (Requirements 5.3, 20.2)', () => {
  beforeEach(async () => {
    await registerUser();
  });

  it('returns the unchanged response body shape { accessToken, user: { id, email } }', async () => {
    const res = await loginUser();

    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');
    expect(res.body.user).toBeDefined();
    expect(res.body.user.email).toBe(EMAIL);
    expect(res.body.user.id).toBeDefined();

    // The user object exposes exactly id and email — nothing new leaked here.
    expect(Object.keys(res.body.user).sort()).toEqual(['email', 'id']);
    // Top-level body is still just accessToken + user.
    expect(Object.keys(res.body).sort()).toEqual(['accessToken', 'user']);
  });

  it('issues an access token whose decoded payload now carries sub, role and bands[]', async () => {
    const res = await loginUser();
    expect(res.status).toBe(200);

    const payload = decodeAccessToken(res.body.accessToken);

    // sub matches the returned user id.
    expect(payload.sub).toBe(res.body.user.id.toString());
    // New claim: authoritative role for a fresh registration.
    expect(payload.role).toBe('user');
    // New claim: membership list, empty for a fresh user.
    expect(Array.isArray(payload.bands)).toBe(true);
    expect(payload.bands).toEqual([]);
  });
});

describe('POST /auth/refresh — loads the user and returns full claim (Requirement 5.4)', () => {
  beforeEach(async () => {
    await registerUser();
  });

  it('returns { accessToken } whose decoded payload carries role and bands[]', async () => {
    // Log in to obtain the refresh cookie.
    const loginRes = await loginUser();
    expect(loginRes.status).toBe(200);

    const setCookie = loginRes.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const refreshCookie = setCookie.find((c) => c.startsWith('refreshToken='));
    expect(refreshCookie).toBeDefined();

    // POST /auth/refresh with the captured cookie.
    const refreshRes = await request(app)
      .post('/auth/refresh')
      .set('Cookie', refreshCookie);

    expect(refreshRes.status).toBe(200);
    // Response body shape is exactly { accessToken }.
    expect(Object.keys(refreshRes.body)).toEqual(['accessToken']);
    expect(typeof refreshRes.body.accessToken).toBe('string');

    // The refreshed token was signed after loading the user, so it carries the
    // full claim just like the login token.
    const payload = decodeAccessToken(refreshRes.body.accessToken);
    const loginPayload = decodeAccessToken(loginRes.body.accessToken);

    expect(payload.sub).toBe(loginPayload.sub);
    expect(payload.role).toBe('user');
    expect(Array.isArray(payload.bands)).toBe(true);
    expect(payload.bands).toEqual([]);
  });
});

describe('authenticate middleware — still loads req.user (Requirement 20.3)', () => {
  beforeEach(async () => {
    await registerUser();
  });

  it('GET /auth/me returns 200 with the authenticated user for a valid token', async () => {
    const loginRes = await loginUser();
    expect(loginRes.status).toBe(200);
    const { accessToken } = loginRes.body;

    const meRes = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(meRes.status).toBe(200);
    expect(meRes.body.email).toBe(EMAIL);
    expect(meRes.body.id.toString()).toBe(loginRes.body.user.id.toString());
  });

  it('GET /auth/me rejects a missing token with 401', async () => {
    const res = await request(app).get('/auth/me');
    expect(res.status).toBe(401);
  });
});

// Self-service profile editing (#39): PATCH /auth/me handles first/last name
// alongside the existing email/password handling; GET /auth/me returns names.
describe('Self-service profile editing (#39)', () => {
  beforeEach(async () => {
    await registerUser();
  });

  async function login() {
    const res = await loginUser();
    return res.body.accessToken;
  }

  it('PATCH /auth/me updates first/last name (trimmed) and returns them', async () => {
    const token = await login();

    const res = await request(app)
      .patch('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ firstName: '  Ada  ', lastName: '  Lovelace  ' });

    expect(res.status).toBe(200);
    expect(res.body.firstName).toBe('Ada');
    expect(res.body.lastName).toBe('Lovelace');

    const persisted = await User.findOne({ email: EMAIL });
    expect(persisted.firstName).toBe('Ada');
    expect(persisted.lastName).toBe('Lovelace');
  });

  it('GET /auth/me returns first/last name and email', async () => {
    const token = await login();
    await request(app)
      .patch('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ firstName: 'Grace', lastName: 'Hopper' });

    const res = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.email).toBe(EMAIL);
    expect(res.body.firstName).toBe('Grace');
    expect(res.body.lastName).toBe('Hopper');
  });

  it('still enforces email uniqueness (409 EMAIL_TAKEN)', async () => {
    // A second user occupies the target email.
    await request(app).post('/auth/register').send({ email: 'taken2@example.com', password: PASSWORD });
    const token = await login();

    const res = await request(app)
      .patch('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'taken2@example.com' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('still requires the correct current password to change password', async () => {
    const token = await login();

    const res = await request(app)
      .patch('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'wrong-password', newPassword: 'a-new-password' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });
});
