const request = require('supertest');
const mongoose = require('mongoose');

const app = require('../app');
const User = require('../models/User');
const Band = require('../models/Band');
const Song = require('../models/Song');
const Chart = require('../models/Chart');
const authService = require('../services/authService');
const membershipService = require('../services/membershipService');

// Integration tests for the chart PDF endpoint (task 5.2):
//   GET /songs/:id/chart/pdf?key=<Numbers|KEY>
//
// These exercise the real Express app via supertest against the in-memory
// MongoDB started by the shared test infra (src/config/testSetup.js sets
// process.env.MONGODB_URI). The token / X-Band-Id setup mirrors
// charts.routes.test.js and chartView.routes.test.js: a real User is created,
// added to a band via membershipService, then a signed access token is minted
// with authService.generateAccessToken(user) after populating bands.band ->
// name so the bands[] claim carries id/name/isAdmin that bandScope reads. The
// PDF route uses authenticate + bandScope and is band-scoped via the song, so
// the X-Band-Id header selects the current band.
//
// The endpoint streams a binary PDF, so these tests use supertest's
// `.buffer(true)` to collect the raw response body as a Buffer and assert on
// the Content-Type and the `%PDF` magic bytes that begin every PDF file.
//
// Requirements covered: 9.1 (valid PDF for numbers + names-in-key),
// 9.4 (422 on a bad/unsupported key), 9.5 (band-scoped authorization 404).

const PASSWORD = 'password123';

// Mint a signed access token for a persisted user, mirroring /auth/login:
// reload with populated band names so buildBandsClaim carries each membership.
async function tokenFor(userId) {
  const user = await User.findById(userId).populate('bands.band', 'name');
  return authService.generateAccessToken(user);
}

async function createUser(email, role = 'user') {
  const passwordHash = await authService.hashPassword(PASSWORD);
  return User.create({ email: email.toLowerCase(), passwordHash, role });
}

// Create a band with `adminUser` as its administrator (the Band model requires
// an administrator), mirroring the other chart suites' createBand helper.
async function createBand(adminUser, name = 'Test Band') {
  const band = await Band.create({ name, administrator: adminUser._id });
  await membershipService.setAdministrator(band._id, adminUser._id);
  return band;
}

async function createSong(bandId, overrides = {}) {
  return Song.create({
    band: bandId,
    title: 'Country Roads',
    artist: 'John Denver',
    ...overrides,
  });
}

// Helper that attaches the member's token + current band header.
function authed(req, token, bandId) {
  return req
    .set('Authorization', `Bearer ${token}`)
    .set('X-Band-Id', bandId.toString());
}

beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await Promise.all([
    User.syncIndexes(),
    Band.syncIndexes(),
    Song.syncIndexes(),
    Chart.syncIndexes(),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
});

afterEach(async () => {
  await Promise.all([
    User.deleteMany({}),
    Band.deleteMany({}),
    Song.deleteMany({}),
    Chart.deleteMany({}),
  ]);
});

// A member of a band with a song that has a stored numbers chart, plus their
// minted token. The chart is seeded via PUT so it goes through the real write
// path (enteredKey:'Numbers' stores the body as-is).
async function seedChartedSong(email = 'member@example.com') {
  const admin = await createUser('band-admin@example.com');
  const band = await createBand(admin, 'The Members');
  const member = await createUser(email);
  await membershipService.addMember(band._id, member._id, { isAdmin: false });
  const token = await tokenFor(member._id);
  const song = await createSong(band._id);

  const put = await authed(
    request(app).put(`/songs/${song._id}/chart`),
    token,
    band._id
  ).send({ enteredKey: 'Numbers', body: 'VERSE 1\n[1]Almost [4]heaven [5]West Virginia' });
  expect(put.status).toBe(200);

  return { admin, band, member, token, song };
}

// Assert that a supertest response is a non-empty PDF: application/pdf
// content-type and a body Buffer beginning with the `%PDF` magic bytes.
function expectPdf(res) {
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toMatch(/application\/pdf/);
  expect(Buffer.isBuffer(res.body)).toBe(true);
  expect(res.body.length).toBeGreaterThan(0);
  // Every PDF file begins with the ASCII header "%PDF".
  expect(res.body.slice(0, 4).toString('ascii')).toBe('%PDF');
}

describe('GET /songs/:id/chart/pdf — valid PDF (R9.1)', () => {
  it('returns a PDF for key=Numbers (content-type application/pdf, body begins with %PDF)', async () => {
    const { token, band, song } = await seedChartedSong();

    const res = await authed(
      request(app).get(`/songs/${song._id}/chart/pdf?key=Numbers`),
      token,
      band._id
    ).buffer(true);

    expectPdf(res);
  });

  it('returns a PDF when the key param is omitted (defaults to the stored numbers form)', async () => {
    const { token, band, song } = await seedChartedSong();

    const res = await authed(
      request(app).get(`/songs/${song._id}/chart/pdf`),
      token,
      band._id
    ).buffer(true);

    expectPdf(res);
  });

  it('returns a PDF for a names key (key=G transposes numbers -> names)', async () => {
    const { token, band, song } = await seedChartedSong();

    const res = await authed(
      request(app).get(`/songs/${song._id}/chart/pdf?key=G`),
      token,
      band._id
    ).buffer(true);

    expectPdf(res);
  });

  it('sets an attachment Content-Disposition filename derived from the song/chart title', async () => {
    const { token, band, song } = await seedChartedSong();

    const res = await authed(
      request(app).get(`/songs/${song._id}/chart/pdf?key=Numbers`),
      token,
      band._id
    ).buffer(true);

    expectPdf(res);
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    expect(res.headers['content-disposition']).toMatch(/filename=/);
  });
});

describe('GET /songs/:id/chart/pdf — invalid key (R9.4)', () => {
  it('returns 422 KEY_INVALID for an unsupported key (H)', async () => {
    const { token, band, song } = await seedChartedSong();

    const res = await authed(
      request(app).get(`/songs/${song._id}/chart/pdf?key=H`),
      token,
      band._id
    );

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('KEY_INVALID');
  });

  it('returns 422 KEY_INVALID for a minor key (out of scope — Am)', async () => {
    const { token, band, song } = await seedChartedSong();

    const res = await authed(
      request(app).get(`/songs/${song._id}/chart/pdf?key=Am`),
      token,
      band._id
    );

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('KEY_INVALID');
  });
});

describe('GET /songs/:id/chart/pdf — band confinement (R9.5)', () => {
  // Band A owns the charted song; a member of band B requests the PDF under
  // band B's scope. The song lookup is scoped to the current band, so a song in
  // band A is invisible under scope B and the PDF route returns the song's own
  // 404 NOT_FOUND — the same deny the song itself would give.
  it('returns the song 404 NOT_FOUND for a song in another band', async () => {
    const { song } = await seedChartedSong();

    const otherAdmin = await createUser('other-admin@example.com');
    const otherBand = await createBand(otherAdmin, 'Other Band');
    const otherMember = await createUser('other-member@example.com');
    await membershipService.addMember(otherBand._id, otherMember._id, {
      isAdmin: false,
    });
    const otherToken = await tokenFor(otherMember._id);

    const res = await authed(
      request(app).get(`/songs/${song._id}/chart/pdf?key=Numbers`),
      otherToken,
      otherBand._id
    );

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
