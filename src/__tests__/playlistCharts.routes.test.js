const request = require('supertest');
const mongoose = require('mongoose');

const app = require('../app');
const User = require('../models/User');
const Band = require('../models/Band');
const Song = require('../models/Song');
const Chart = require('../models/Chart');
const Playlist = require('../models/Playlist');
const authService = require('../services/authService');
const membershipService = require('../services/membershipService');

// Integration tests for the playlist-scoped batch chart endpoint (task 6.2):
//   GET /playlists/:id/charts?key=<Numbers|KEY>
//
// These exercise the real Express app via supertest against the in-memory
// MongoDB started by the shared test infra (src/config/testSetup.js sets
// process.env.MONGODB_URI). The token / X-Band-Id setup mirrors
// charts.routes.test.js and chartView.routes.test.js: a real User is created,
// added to a band via membershipService, then a signed access token is minted
// with authService.generateAccessToken(user) after populating bands.band ->
// name so the bands[] claim carries id/name/isAdmin that bandScope reads. The
// playlist routes use authenticate + bandScope, so X-Band-Id selects the
// current band. Charts are seeded through the real write path
// (PUT /songs/:id/chart) and playlists via the Playlist model.
//
// The response shape (see playlists.js) is a wrapping object:
//   { playlistId, charts: [{ songId, title, chart: Render_Representation|null }], truncated }
//
// Requirements covered:
//   - R10.1: every song in the playlist is listed; charted songs carry a
//     Render_Representation.
//   - R10.2: the `key` param is honored (Numbers -> degrees; a key -> names).
//   - R10.3: a song with no chart carries chart: null (flagged, not failing).
//   - R10.4: band-scoped authorization via the playlist (cross-band -> 404).

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

// Create a band administered by `adminUser` (single-admin invariant via
// membershipService.setAdministrator), returning the band.
async function createBand(adminUser, name = 'Playlist Charts Band') {
  const band = await Band.create({ name, administrator: adminUser._id });
  await membershipService.setAdministrator(band._id, adminUser._id);
  return band;
}

async function createSong(band, overrides = {}) {
  return Song.create({
    band: band._id,
    title: 'Untitled',
    artist: 'Someone',
    ...overrides,
  });
}

// Attach a member's token + current band header to a request.
function authed(req, token, bandId) {
  return req
    .set('Authorization', `Bearer ${token}`)
    .set('X-Band-Id', bandId.toString());
}

// Seed a chart for a song through the real write path (PUT /songs/:id/chart)
// so stored bodies are canonical numbers exactly as the app produces them.
async function putChart(token, bandId, songId, payload) {
  const res = await authed(
    request(app).put(`/songs/${songId}/chart`),
    token,
    bandId
  ).send(payload);
  expect(res.status).toBe(200);
  return res;
}

beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await Promise.all([
    User.syncIndexes(),
    Band.syncIndexes(),
    Song.syncIndexes(),
    Chart.syncIndexes(),
    Playlist.syncIndexes(),
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
    Playlist.deleteMany({}),
  ]);
});

// A band with a member + token.
async function setupBandWithMember(suffix = '') {
  const admin = await createUser(`admin${suffix}@example.com`);
  const band = await createBand(admin, `Band${suffix || ''}`);
  const member = await createUser(`member${suffix}@example.com`);
  await membershipService.addMember(band._id, member._id, { isAdmin: false });
  const token = await tokenFor(member._id);
  return { admin, band, member, token };
}

describe('GET /playlists/:id/charts — charted + un-charted songs (R10.1, R10.3)', () => {
  it('lists every song in order; charted songs carry a Render_Representation and un-charted songs carry chart: null', async () => {
    const { band, token } = await setupBandWithMember();

    // Two songs with charts, one song without.
    const charted1 = await createSong(band, { title: 'Country Roads' });
    const unCharted = await createSong(band, { title: 'No Chart Song' });
    const charted2 = await createSong(band, { title: 'Take Me Home' });

    await putChart(token, band._id, charted1._id, {
      enteredKey: 'Numbers',
      body: 'VERSE 1\n[1]Almost [4]heaven',
    });
    await putChart(token, band._id, charted2._id, {
      enteredKey: 'Numbers',
      body: 'CHORUS\n[5]West [1]Virginia',
    });

    // Playlist order: charted1, unCharted, charted2.
    const playlist = await Playlist.create({
      band: band._id,
      name: 'Set List',
      songs: [charted1._id, unCharted._id, charted2._id],
    });

    const res = await authed(
      request(app).get(`/playlists/${playlist._id}/charts`),
      token,
      band._id
    );

    expect(res.status).toBe(200);
    expect(res.body.playlistId).toBe(playlist._id.toString());
    expect(res.body.truncated).toBe(false);

    const { charts } = res.body;
    expect(Array.isArray(charts)).toBe(true);
    // R10.1 — every song in the playlist is listed, in order.
    expect(charts).toHaveLength(3);
    expect(charts.map((c) => c.songId)).toEqual([
      charted1._id.toString(),
      unCharted._id.toString(),
      charted2._id.toString(),
    ]);
    expect(charts.map((c) => c.title)).toEqual([
      'Country Roads',
      'No Chart Song',
      'Take Me Home',
    ]);

    // R10.1 — charted songs carry a Render_Representation.
    const first = charts[0];
    expect(first.chart).not.toBeNull();
    expect(first.chart.keyLabel).toBe('Numbers');
    expect(Array.isArray(first.chart.sections)).toBe(true);
    expect(first.chart.sections[0].label).toBe('VERSE 1');
    expect(first.chart.sections[0].lines[0].segments).toMatchObject([
      { chord: '1', lyric: 'Almost ' },
      { chord: '4', lyric: 'heaven' },
    ]);

    const third = charts[2];
    expect(third.chart).not.toBeNull();
    expect(third.chart.sections[0].label).toBe('CHORUS');
    expect(third.chart.sections[0].lines[0].segments).toMatchObject([
      { chord: '5', lyric: 'West ' },
      { chord: '1', lyric: 'Virginia' },
    ]);

    // R10.3 — the un-charted song is flagged with chart: null, not omitted,
    // and does not fail the whole request.
    const second = charts[1];
    expect(second.songId).toBe(unCharted._id.toString());
    expect(second.chart).toBeNull();
  });
});

describe('GET /playlists/:id/charts — key honored (R10.2)', () => {
  async function seedKeyPlaylist() {
    const { band, token } = await setupBandWithMember('-key');
    const song = await createSong(band, { title: 'Transposable' });
    // Stored canonically as numbers: 1 and 4.
    await putChart(token, band._id, song._id, {
      enteredKey: 'Numbers',
      body: 'VERSE 1\n[1]Hi [4]there',
    });
    const playlist = await Playlist.create({
      band: band._id,
      name: 'Key Set',
      songs: [song._id],
    });
    return { band, token, playlist };
  }

  it('key=Numbers returns the stored degree tokens unchanged', async () => {
    const { band, token, playlist } = await seedKeyPlaylist();

    const res = await authed(
      request(app).get(`/playlists/${playlist._id}/charts?key=Numbers`),
      token,
      band._id
    );

    expect(res.status).toBe(200);
    const chart = res.body.charts[0].chart;
    expect(chart.keyLabel).toBe('Numbers');
    expect(chart.sections[0].lines[0].segments).toMatchObject([
      { chord: '1', lyric: 'Hi ' },
      { chord: '4', lyric: 'there' },
    ]);
  });

  it('key=G transposes degrees to names in that key: 1->G, 4->C', async () => {
    const { band, token, playlist } = await seedKeyPlaylist();

    const res = await authed(
      request(app).get(`/playlists/${playlist._id}/charts?key=G`),
      token,
      band._id
    );

    expect(res.status).toBe(200);
    const chart = res.body.charts[0].chart;
    expect(chart.keyLabel).toBe('G');
    expect(chart.sections[0].lines[0].segments).toMatchObject([
      { chord: 'G', lyric: 'Hi ' },
      { chord: 'C', lyric: 'there' },
    ]);
  });

  it('returns 422 KEY_INVALID for an unsupported/invalid key', async () => {
    const { band, token, playlist } = await seedKeyPlaylist();

    const res = await authed(
      request(app).get(`/playlists/${playlist._id}/charts?key=H`),
      token,
      band._id
    );

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('KEY_INVALID');
  });
});

describe('GET /playlists/:id/charts — band-scoped authorization (R10.4)', () => {
  it('requesting a playlist in another band under the current scope returns the playlist 404 NOT_FOUND', async () => {
    // Band A owns the playlist (with a charted song). The actor is a member of
    // BOTH bands and uses band B as the current scope, so bandScope passes and
    // the 404 comes from the playlist-in-A lookup (confinement), not a
    // membership denial.
    const adminA = await createUser('admin-a@example.com');
    const adminB = await createUser('admin-b@example.com');
    const bandA = await createBand(adminA, 'Band A');
    const bandB = await createBand(adminB, 'Band B');

    const user = await createUser('cross@example.com');
    await membershipService.addMember(bandA._id, user._id, { isAdmin: false });
    await membershipService.addMember(bandB._id, user._id, { isAdmin: false });
    const token = await tokenFor(user._id);

    const songInA = await createSong(bandA, { title: 'A-Only Song' });
    await putChart(token, bandA._id, songInA._id, {
      enteredKey: 'Numbers',
      body: '[1]secret of band A',
    });
    const playlistInA = await Playlist.create({
      band: bandA._id,
      name: 'A Set',
      songs: [songInA._id],
    });

    const res = await authed(
      request(app).get(`/playlists/${playlistInA._id}/charts`),
      token,
      bandB._id
    );

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
