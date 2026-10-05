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

// Integration tests for the gig "all charts" POST endpoints (issue #77):
//   POST /playlists/:id/charts         — JSON, per-song mode selection
//   POST /playlists/:id/charts/pdf     — combined PDF (one doc, song per page)
//   POST /playlists/:id/charts/pdf-zip — one PDF per song, zipped
//
// Setup mirrors playlistCharts.routes.test.js / chartPdf.routes.test.js: a real
// User is added to a band via membershipService, a signed access token is
// minted with authService.generateAccessToken after populating bands.band ->
// name, and X-Band-Id selects the current band. Charts are seeded through the
// real write path (PUT /songs/:id/chart) so stored bodies are canonical
// numbers exactly as the app produces them.

const PASSWORD = 'password123';

async function tokenFor(userId) {
  const user = await User.findById(userId).populate('bands.band', 'name');
  return authService.generateAccessToken(user);
}

async function createUser(email, role = 'user') {
  const passwordHash = await authService.hashPassword(PASSWORD);
  return User.create({ email: email.toLowerCase(), passwordHash, role });
}

async function createBand(adminUser, name = 'All Charts Band') {
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

function authed(req, token, bandId) {
  return req
    .set('Authorization', `Bearer ${token}`)
    .set('X-Band-Id', bandId.toString());
}

async function putChart(token, bandId, songId, payload) {
  const res = await authed(
    request(app).put(`/songs/${songId}/chart`),
    token,
    bandId
  ).send(payload);
  expect(res.status).toBe(200);
  return res;
}

async function setupBandWithMember(suffix = '') {
  const admin = await createUser(`admin${suffix}@example.com`);
  const band = await createBand(admin, `Band${suffix || ''}`);
  const member = await createUser(`member${suffix}@example.com`);
  await membershipService.addMember(band._id, member._id, { isAdmin: false });
  const token = await tokenFor(member._id);
  return { admin, band, member, token };
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

describe('POST /playlists/:id/charts — per-song mode selection', () => {
  it('renders Numbers/Chords per selection, keyLabel follows playedKey regardless of mode, keyless Chords falls back to Numbers, and no-chart songs are chart: null in setlist order', async () => {
    const { band, token } = await setupBandWithMember('-sel');

    // Three charted songs + one with no chart. Stored canonically as numbers.
    const numbersSong = await createSong(band, { title: 'Numbers Song' });   // mode Numbers, key G
    const chordsSong = await createSong(band, { title: 'Chords Song' });     // mode Chords,  key D
    const keylessChords = await createSong(band, { title: 'Keyless Chords' }); // mode Chords, NO key
    const noChart = await createSong(band, { title: 'No Chart Song' });      // no stored chart

    await putChart(token, band._id, numbersSong._id, { enteredKey: 'Numbers', body: '[1]Hi [4]there' });
    await putChart(token, band._id, chordsSong._id, { enteredKey: 'Numbers', body: '[1]Hi [4]there' });
    await putChart(token, band._id, keylessChords._id, { enteredKey: 'Numbers', body: '[1]Hi [4]there' });

    const playlist = await Playlist.create({
      band: band._id,
      name: 'Mixed Set',
      songs: [
        { song: numbersSong._id, playedKey: 'G' },
        { song: chordsSong._id, playedKey: 'D' },
        { song: keylessChords._id }, // no playedKey
        { song: noChart._id, playedKey: 'A' },
      ],
    });

    const res = await authed(
      request(app).post(`/playlists/${playlist._id}/charts`),
      token,
      band._id
    ).send({
      selections: [
        { songId: numbersSong._id.toString(), mode: 'Numbers' },
        { songId: chordsSong._id.toString(), mode: 'Chords' },
        { songId: keylessChords._id.toString(), mode: 'Chords' },
        { songId: noChart._id.toString(), mode: 'Chords' },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.playlistId).toBe(playlist._id.toString());
    expect(res.body.truncated).toBe(false);

    const { charts } = res.body;
    // Setlist order preserved.
    expect(charts.map((c) => c.songId)).toEqual([
      numbersSong._id.toString(),
      chordsSong._id.toString(),
      keylessChords._id.toString(),
      noChart._id.toString(),
    ]);

    // Numbers mode: body stays as degrees; header keyLabel = playedKey (G).
    const numbers = charts[0];
    expect(numbers.chart.mode).toBe('Numbers');
    expect(numbers.chart.keyLabel).toBe('G'); // keyLabel follows playedKey, not mode
    expect(numbers.chart.sections[0].lines[0].segments.map((s) => s.chord)).toEqual(['1', '4']);

    // Chords mode WITH key D: 1->D, 4->G; keyLabel D.
    const chords = charts[1];
    expect(chords.chart.mode).toBe('Chords');
    expect(chords.chart.keyLabel).toBe('D');
    expect(chords.chart.sections[0].lines[0].segments.map((s) => s.chord)).toEqual(['D', 'G']);

    // Chords mode but NO key: falls back to Numbers; keyLabel 'Numbers'.
    const keyless = charts[2];
    expect(keyless.chart.keyLabel).toBe('Numbers');
    expect(keyless.chart.sections[0].lines[0].segments.map((s) => s.chord)).toEqual(['1', '4']);

    // No stored chart: chart is null (header rendered client-side).
    const none = charts[3];
    expect(none.songId).toBe(noChart._id.toString());
    expect(none.chart).toBeNull();
    expect(none.playedKey).toBe('A');
  });

  it('a song absent from selections defaults to Numbers', async () => {
    const { band, token } = await setupBandWithMember('-default');
    const song = await createSong(band, { title: 'Defaulted' });
    await putChart(token, band._id, song._id, { enteredKey: 'Numbers', body: '[1]Hi [4]there' });
    const playlist = await Playlist.create({
      band: band._id,
      name: 'Default Set',
      songs: [{ song: song._id, playedKey: 'G' }],
    });

    // Empty selections → default Numbers; keyLabel still follows playedKey (G).
    const res = await authed(
      request(app).post(`/playlists/${playlist._id}/charts`),
      token,
      band._id
    ).send({ selections: [] });

    expect(res.status).toBe(200);
    const chart = res.body.charts[0].chart;
    expect(chart.mode).toBe('Numbers');
    expect(chart.keyLabel).toBe('G');
    expect(chart.sections[0].lines[0].segments.map((s) => s.chord)).toEqual(['1', '4']);
  });

  it('is band-scoped: a playlist in another band under the current scope returns 404 NOT_FOUND', async () => {
    const adminA = await createUser('ac-admin-a@example.com');
    const adminB = await createUser('ac-admin-b@example.com');
    const bandA = await createBand(adminA, 'AC Band A');
    const bandB = await createBand(adminB, 'AC Band B');
    const user = await createUser('ac-cross@example.com');
    await membershipService.addMember(bandA._id, user._id, { isAdmin: false });
    await membershipService.addMember(bandB._id, user._id, { isAdmin: false });
    const token = await tokenFor(user._id);

    const song = await createSong(bandA, { title: 'A Song' });
    const playlistInA = await Playlist.create({
      band: bandA._id,
      name: 'A Set',
      songs: [{ song: song._id }],
    });

    const res = await authed(
      request(app).post(`/playlists/${playlistInA._id}/charts`),
      token,
      bandB._id
    ).send({ selections: [] });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('POST /playlists/:id/charts/pdf — combined PDF', () => {
  async function seedPdfPlaylist(suffix = '') {
    const { band, token } = await setupBandWithMember(suffix);
    const charted = await createSong(band, { title: 'Charted' });
    const noChart = await createSong(band, { title: 'No Chart' });
    await putChart(token, band._id, charted._id, {
      enteredKey: 'Numbers',
      body: 'VERSE 1\n[1]Almost [4]heaven [5]West Virginia',
    });
    const playlist = await Playlist.create({
      band: band._id,
      name: 'PDF Set',
      songs: [{ song: charted._id, playedKey: 'G' }, { song: noChart._id }],
    });
    return { band, token, playlist, charted, noChart };
  }

  it('streams a valid application/pdf starting with %PDF (charted + no-chart songs)', async () => {
    const { band, token, playlist, charted, noChart } = await seedPdfPlaylist('-pdf');

    const res = await authed(
      request(app).post(`/playlists/${playlist._id}/charts/pdf`),
      token,
      band._id
    ).send({
      selections: [
        { songId: charted._id.toString(), mode: 'Chords' },
        { songId: noChart._id.toString(), mode: 'Numbers' },
      ],
    }).buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body.slice(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('is band-scoped: another band under the current scope returns 404 NOT_FOUND', async () => {
    const adminA = await createUser('pdf-admin-a@example.com');
    const adminB = await createUser('pdf-admin-b@example.com');
    const bandA = await createBand(adminA, 'PDF Band A');
    const bandB = await createBand(adminB, 'PDF Band B');
    const user = await createUser('pdf-cross@example.com');
    await membershipService.addMember(bandA._id, user._id, { isAdmin: false });
    await membershipService.addMember(bandB._id, user._id, { isAdmin: false });
    const token = await tokenFor(user._id);

    const song = await createSong(bandA, { title: 'A Song' });
    const playlistInA = await Playlist.create({
      band: bandA._id,
      name: 'A Set',
      songs: [{ song: song._id }],
    });

    const res = await authed(
      request(app).post(`/playlists/${playlistInA._id}/charts/pdf`),
      token,
      bandB._id
    ).send({ selections: [] });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('POST /playlists/:id/charts/pdf-zip — zipped per-song PDFs', () => {
  it('streams a zip (PK magic bytes) with content-type application/zip', async () => {
    const { band, token } = await setupBandWithMember('-zip');
    const s1 = await createSong(band, { title: 'First Song' });
    const s2 = await createSong(band, { title: 'First Song' }); // duplicate title → de-dup
    const s3 = await createSong(band, { title: 'No Chart Here' });
    await putChart(token, band._id, s1._id, { enteredKey: 'Numbers', body: 'V1\n[1]Hi [4]there' });
    await putChart(token, band._id, s2._id, { enteredKey: 'Numbers', body: 'V1\n[5]Yo [1]now' });
    const playlist = await Playlist.create({
      band: band._id,
      name: 'Zip Set',
      songs: [{ song: s1._id, playedKey: 'G' }, { song: s2._id }, { song: s3._id }],
    });

    const res = await authed(
      request(app).post(`/playlists/${playlist._id}/charts/pdf-zip`),
      token,
      band._id
    ).send({
      selections: [
        { songId: s1._id.toString(), mode: 'Chords' },
        { songId: s2._id.toString(), mode: 'Numbers' },
      ],
    }).buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/zip/);
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    // Every ZIP archive begins with the local file header signature PK\x03\x04.
    expect(res.body.slice(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  });

  it('is band-scoped: another band under the current scope returns 404 NOT_FOUND', async () => {
    const adminA = await createUser('zip-admin-a@example.com');
    const adminB = await createUser('zip-admin-b@example.com');
    const bandA = await createBand(adminA, 'Zip Band A');
    const bandB = await createBand(adminB, 'Zip Band B');
    const user = await createUser('zip-cross@example.com');
    await membershipService.addMember(bandA._id, user._id, { isAdmin: false });
    await membershipService.addMember(bandB._id, user._id, { isAdmin: false });
    const token = await tokenFor(user._id);

    const song = await createSong(bandA, { title: 'A Song' });
    const playlistInA = await Playlist.create({
      band: bandA._id,
      name: 'A Set',
      songs: [{ song: song._id }],
    });

    const res = await authed(
      request(app).post(`/playlists/${playlistInA._id}/charts/pdf-zip`),
      token,
      bandB._id
    ).send({ selections: [] });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
