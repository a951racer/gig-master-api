const request = require('supertest');
const mongoose = require('mongoose');

const app = require('../app');
const User = require('../models/User');
const Band = require('../models/Band');
const Song = require('../models/Song');
const Chart = require('../models/Chart');
const authService = require('../services/authService');
const membershipService = require('../services/membershipService');

// Integration tests for the chart CRUD routes nested under songs (task 3.3):
//   GET    /songs/:id/chart
//   PUT    /songs/:id/chart
//   DELETE /songs/:id/chart
//   DELETE /songs/:id            (chart cascade on song delete)
//
// These exercise the real Express app via supertest against the in-memory
// MongoDB started by the shared test infra (src/config/testSetup.js sets
// process.env.MONGODB_URI). The token/X-Band-Id setup mirrors
// invites.bands.test.js and admin.bands.test.js: a real User is created, added
// to a band via membershipService, then a signed access token is minted with
// authService.generateAccessToken(user) after populating bands.band -> name so
// the bands[] claim carries id/name/isAdmin that bandScope reads. The chart
// routes use authenticate + bandScope, so the X-Band-Id header selects the
// current band.
//
// Property coverage (design.md "Correctness Properties"):
//   - Property 2: Canonical number storage — after any PUT the stored body
//     contains only number chord tokens (never names).
//   - Property 6: Band confinement — chart ops for a song outside the current
//     band return the song's own 404 (NOT_FOUND).
//   - Property 8: Explicit missing-chart — GET chart with no chart returns
//     CHART_NOT_FOUND (404), never a 500.
//   - Property 9: Cascade on song delete — deleting the song removes its chart.

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
// an administrator), mirroring invites.bands.test.js' createBandWithAdmin.
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

// A member of a single band with a song in it, plus their minted token.
async function setupMemberWithSong(email = 'member@example.com') {
  const admin = await createUser('band-admin@example.com');
  const band = await createBand(admin, 'The Members');
  const member = await createUser(email);
  await membershipService.addMember(band._id, member._id, { isAdmin: false });
  const token = await tokenFor(member._id);
  const song = await createSong(band._id);
  return { band, member, token, song };
}

// Helpers that attach the member's token + current band header.
function authed(req, token, bandId) {
  return req
    .set('Authorization', `Bearer ${token}`)
    .set('X-Band-Id', bandId.toString());
}

describe('PUT /songs/:id/chart — create from numbers', () => {
  it('stores a numbers body as-is and GET returns it unchanged', async () => {
    const { band, token, song } = await setupMemberWithSong();
    const numbersBody = 'VERSE 1\n[1]Almost heaven, [4]West [1]Virginia';

    const put = await authed(
      request(app).put(`/songs/${song._id}/chart`),
      token,
      band._id
    ).send({ enteredKey: 'Numbers', body: numbersBody });

    expect(put.status).toBe(200);
    expect(put.body.body).toBe(numbersBody);

    const get = await authed(
      request(app).get(`/songs/${song._id}/chart`),
      token,
      band._id
    );

    expect(get.status).toBe(200);
    expect(get.body.body).toBe(numbersBody);
  });
});

describe('PUT /songs/:id/chart — create from names (Property 2)', () => {
  it('converts a names body to canonical numbers and GET returns the numbers body', async () => {
    const { band, token, song } = await setupMemberWithSong();
    // In G major: G -> 1, Em -> 6m.
    const namesBody = '[G]Hi [Em]there';

    const put = await authed(
      request(app).put(`/songs/${song._id}/chart`),
      token,
      band._id
    ).send({ enteredKey: 'G', body: namesBody });

    expect(put.status).toBe(200);

    const get = await authed(
      request(app).get(`/songs/${song._id}/chart`),
      token,
      band._id
    );

    expect(get.status).toBe(200);
    // Property 2 — Canonical number storage: the stored body is numbers.
    expect(get.body.body).toBe('[1]Hi [6m]there');
    // It contains the expected number tokens...
    expect(get.body.body).toContain('[1]');
    expect(get.body.body).toContain('[6m]');
    // ...and NO letter chord tokens (the originals G / Em are gone).
    expect(get.body.body).not.toContain('[G]');
    expect(get.body.body).not.toContain('[Em]');
    // Defensively assert no chord token contains a letter root A-G.
    const chordTokens = get.body.body.match(/\[([^\]]*)\]/g) || [];
    for (const tok of chordTokens) {
      expect(tok).not.toMatch(/[A-G]/);
    }
  });
});

describe('PUT /songs/:id/chart — replace (1:1)', () => {
  it('a second PUT replaces the chart; GET reflects it and exactly one chart exists', async () => {
    const { band, token, song } = await setupMemberWithSong();

    const first = await authed(
      request(app).put(`/songs/${song._id}/chart`),
      token,
      band._id
    ).send({ enteredKey: 'Numbers', body: '[1]first body' });
    expect(first.status).toBe(200);

    const second = await authed(
      request(app).put(`/songs/${song._id}/chart`),
      token,
      band._id
    ).send({ enteredKey: 'Numbers', body: '[5]second body' });
    expect(second.status).toBe(200);

    const get = await authed(
      request(app).get(`/songs/${song._id}/chart`),
      token,
      band._id
    );
    expect(get.status).toBe(200);
    expect(get.body.body).toBe('[5]second body');

    // The 1:1 invariant: exactly one chart for this song.
    const count = await Chart.countDocuments({ song: song._id });
    expect(count).toBe(1);
  });
});

describe('DELETE /songs/:id/chart', () => {
  it('removes the chart; a subsequent GET returns 404 CHART_NOT_FOUND', async () => {
    const { band, token, song } = await setupMemberWithSong();

    await authed(
      request(app).put(`/songs/${song._id}/chart`),
      token,
      band._id
    ).send({ enteredKey: 'Numbers', body: '[1]to be deleted' });

    const del = await authed(
      request(app).delete(`/songs/${song._id}/chart`),
      token,
      band._id
    );
    expect(del.status).toBe(200);

    expect(await Chart.countDocuments({ song: song._id })).toBe(0);

    const get = await authed(
      request(app).get(`/songs/${song._id}/chart`),
      token,
      band._id
    );
    expect(get.status).toBe(404);
    expect(get.body.error.code).toBe('CHART_NOT_FOUND');
  });
});

describe('GET /songs/:id/chart — no chart (Property 8)', () => {
  it('returns 404 CHART_NOT_FOUND (not 500) for a song with no chart', async () => {
    const { band, token, song } = await setupMemberWithSong();

    const get = await authed(
      request(app).get(`/songs/${song._id}/chart`),
      token,
      band._id
    );

    expect(get.status).toBe(404);
    expect(get.body.error.code).toBe('CHART_NOT_FOUND');
  });
});

describe('PUT /songs/:id/chart — validation (422s)', () => {
  it('rejects a body with bad grammar with 422 CHART_INVALID and fields', async () => {
    const { band, token, song } = await setupMemberWithSong();

    // `[9]` is not a valid chord token (degrees are 1-7), so grammar validation
    // rejects the body.
    const put = await authed(
      request(app).put(`/songs/${song._id}/chart`),
      token,
      band._id
    ).send({ enteredKey: 'Numbers', body: '[9zz]broken chord' });

    expect(put.status).toBe(422);
    expect(put.body.error.code).toBe('CHART_INVALID');
    expect(put.body.error.fields).toBeTruthy();
  });

  it('rejects an unsupported enteredKey with 422 KEY_INVALID', async () => {
    const { band, token, song } = await setupMemberWithSong();

    const put = await authed(
      request(app).put(`/songs/${song._id}/chart`),
      token,
      band._id
    ).send({ enteredKey: 'H', body: '[C]valid names body' });

    expect(put.status).toBe(422);
    expect(put.body.error.code).toBe('KEY_INVALID');
  });
});

describe('Band confinement (Property 6)', () => {
  // A member of band B tries to GET/PUT/DELETE the chart of a song in band A,
  // using band B as the current scope (X-Band-Id: B). The song lookup is
  // scoped to the current band, so a song in band A is invisible under scope B
  // and every chart op returns the song's own 404 NOT_FOUND — the same deny
  // the song itself would give.
  async function setupTwoBands() {
    const adminA = await createUser('admin-a@example.com');
    const adminB = await createUser('admin-b@example.com');
    const bandA = await createBand(adminA, 'Band A');
    const bandB = await createBand(adminB, 'Band B');
    // The actor is a member of BOTH bands, so selecting band B as the current
    // scope passes bandScope; the 404 then comes from the song-in-A lookup
    // (confinement), not from a membership denial.
    const user = await createUser('cross@example.com');
    await membershipService.addMember(bandA._id, user._id, { isAdmin: false });
    await membershipService.addMember(bandB._id, user._id, { isAdmin: false });
    const token = await tokenFor(user._id);

    const songInA = await createSong(bandA._id, { title: 'A-Only Song' });
    // Give the song in A a chart so a leak would be observable.
    await Chart.create({ song: songInA._id, body: '[1]secret of band A' });

    return { bandA, bandB, token, songInA };
  }

  it('GET a band-A song chart under band-B scope returns the song 404 NOT_FOUND', async () => {
    const { bandB, token, songInA } = await setupTwoBands();

    const res = await authed(
      request(app).get(`/songs/${songInA._id}/chart`),
      token,
      bandB._id
    );

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('PUT a band-A song chart under band-B scope returns the song 404 and does not alter the chart', async () => {
    const { bandB, token, songInA } = await setupTwoBands();

    const res = await authed(
      request(app).put(`/songs/${songInA._id}/chart`),
      token,
      bandB._id
    ).send({ enteredKey: 'Numbers', body: '[2]tampered' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');

    // The chart in band A is untouched.
    const chart = await Chart.findOne({ song: songInA._id });
    expect(chart.body).toBe('[1]secret of band A');
  });

  it('DELETE a band-A song chart under band-B scope returns the song 404 and leaves the chart', async () => {
    const { bandB, token, songInA } = await setupTwoBands();

    const res = await authed(
      request(app).delete(`/songs/${songInA._id}/chart`),
      token,
      bandB._id
    );

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');

    expect(await Chart.countDocuments({ song: songInA._id })).toBe(1);
  });
});

describe('Cascade on song delete (Property 9)', () => {
  it('DELETE /songs/:id removes the song chart; GET chart afterward is 404', async () => {
    const { band, token, song } = await setupMemberWithSong();

    await authed(
      request(app).put(`/songs/${song._id}/chart`),
      token,
      band._id
    ).send({ enteredKey: 'Numbers', body: '[1]doomed with its song' });

    expect(await Chart.countDocuments({ song: song._id })).toBe(1);

    const del = await authed(
      request(app).delete(`/songs/${song._id}`),
      token,
      band._id
    );
    expect(del.status).toBe(200);

    // The chart is gone from the database.
    expect(await Chart.countDocuments({ song: song._id })).toBe(0);

    // And the chart endpoint now 404s (the song itself is gone -> song 404).
    const get = await authed(
      request(app).get(`/songs/${song._id}/chart`),
      token,
      band._id
    );
    expect(get.status).toBe(404);
  });

  // The band hard-delete cascade (admin.js DELETE /admin/bands/:id) requires a
  // sysadmin + a prior archive step and is covered by admin.bands.test.js; this
  // suite covers the song-delete cascade (Property 9) directly.
});
