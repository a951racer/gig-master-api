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

// Tests for the lightweight `hasChart` flag the list endpoints stamp onto
// songs so the UI can show a "charted" indicator:
//   GET /songs          -> each song carries hasChart
//   GET /playlists/:id   -> each populated songs[].song carries hasChart

const PASSWORD = 'password123';

async function tokenFor(userId) {
  const user = await User.findById(userId).populate('bands.band', 'name');
  return authService.generateAccessToken(user);
}

async function setup() {
  const passwordHash = await authService.hashPassword(PASSWORD);
  const admin = await User.create({ email: 'hc-admin@example.com', passwordHash });
  const band = await Band.create({ name: 'Chart Band', administrator: admin._id });
  await membershipService.setAdministrator(band._id, admin._id);
  const token = await tokenFor(admin._id);

  // Two songs: one charted, one not.
  const charted = await Song.create({ band: band._id, title: 'Has Chart', artist: 'A' });
  const uncharted = await Song.create({ band: band._id, title: 'No Chart', artist: 'B' });
  await Chart.create({ song: charted._id, body: '[1] [4] [5]' });

  return { band, token, charted, uncharted };
}

const authed = (req, token, bandId) =>
  req.set('Authorization', `Bearer ${token}`).set('X-Band-Id', bandId.toString());

beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await Promise.all([
    User.syncIndexes(), Band.syncIndexes(), Song.syncIndexes(),
    Chart.syncIndexes(), Playlist.syncIndexes(),
  ]);
});
afterAll(async () => { await mongoose.disconnect(); });
afterEach(async () => {
  await Promise.all([
    User.deleteMany({}), Band.deleteMany({}), Song.deleteMany({}),
    Chart.deleteMany({}), Playlist.deleteMany({}),
  ]);
});

describe('GET /songs — hasChart flag', () => {
  it('marks only the songs that have a stored chart', async () => {
    const { band, token, charted, uncharted } = await setup();

    const res = await authed(request(app).get('/songs'), token, band._id);
    expect(res.status).toBe(200);

    const byId = Object.fromEntries(res.body.map((s) => [s._id, s]));
    expect(byId[charted._id.toString()].hasChart).toBe(true);
    expect(byId[uncharted._id.toString()].hasChart).toBe(false);
  });
});

describe('GET /playlists/:id — hasChart on populated songs', () => {
  it('marks each setlist song by whether it has a chart', async () => {
    const { band, token, charted, uncharted } = await setup();
    const playlist = await Playlist.create({
      band: band._id,
      name: 'Set A',
      songs: [{ song: charted._id, playedKey: 'A' }, { song: uncharted._id, playedKey: '' }],
    });

    const res = await authed(request(app).get(`/playlists/${playlist._id}`), token, band._id);
    expect(res.status).toBe(200);

    const songs = res.body.songs;
    expect(songs).toHaveLength(2);
    const byId = Object.fromEntries(songs.map((e) => [e.song._id, e.song]));
    expect(byId[charted._id.toString()].hasChart).toBe(true);
    expect(byId[uncharted._id.toString()].hasChart).toBe(false);
  });
});
