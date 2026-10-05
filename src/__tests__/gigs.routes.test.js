const request = require('supertest');
const mongoose = require('mongoose');

const app = require('../app');
const User = require('../models/User');
const Band = require('../models/Band');
const Song = require('../models/Song');
const Playlist = require('../models/Playlist');
const Gig = require('../models/Gig');
const authService = require('../services/authService');
const membershipService = require('../services/membershipService');

// Gig route tests. The focus is GET /gigs/:id correctly populating the gig's
// setlist songs now that Playlist.songs is a subdocument array
// [{ song, playedKey }] (#72) — the populate path is `songs.song`, and each
// entry carries the populated song + its playedKey. (Regression guard: the
// gig detail page showed blank song titles when this wasn't updated.)

const PASSWORD = 'password123';

async function tokenFor(userId) {
  const user = await User.findById(userId).populate('bands.band', 'name');
  return authService.generateAccessToken(user);
}

async function setup() {
  const passwordHash = await authService.hashPassword(PASSWORD);
  const admin = await User.create({ email: 'gig-admin@example.com', passwordHash });
  const band = await Band.create({ name: 'Gig Band', administrator: admin._id });
  await membershipService.setAdministrator(band._id, admin._id);
  const token = await tokenFor(admin._id);
  const s1 = await Song.create({ band: band._id, title: 'Bye Bye Love', artist: 'Everly Brothers' });
  const s2 = await Song.create({ band: band._id, title: 'Sweet Caroline', artist: 'Neil Diamond' });
  const playlist = await Playlist.create({
    band: band._id,
    name: 'Nursing Home Gigs',
    songs: [{ song: s1._id, playedKey: 'A' }, { song: s2._id, playedKey: 'G' }],
  });
  const gig = await Gig.create({ band: band._id, name: 'Elder Care', date: new Date('2026-05-06'), playlist: playlist._id });
  return { band, token, s1, s2, playlist, gig };
}

const authed = (req, token, bandId) =>
  req.set('Authorization', `Bearer ${token}`).set('X-Band-Id', bandId.toString());

beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await Promise.all([
    User.syncIndexes(), Band.syncIndexes(), Song.syncIndexes(),
    Playlist.syncIndexes(), Gig.syncIndexes(),
  ]);
});
afterAll(async () => { await mongoose.disconnect(); });
afterEach(async () => {
  await Promise.all([
    User.deleteMany({}), Band.deleteMany({}), Song.deleteMany({}),
    Playlist.deleteMany({}), Gig.deleteMany({}),
  ]);
});

describe('GET /gigs/:id — setlist songs populated', () => {
  it('populates each setlist entry as { song: <populated>, playedKey } in order', async () => {
    const { band, token, s1, s2, gig } = await setup();

    const res = await authed(request(app).get(`/gigs/${gig._id}`), token, band._id);

    expect(res.status).toBe(200);
    expect(res.body.playlist).toBeTruthy();
    expect(res.body.playlist.name).toBe('Nursing Home Gigs');

    const songs = res.body.playlist.songs;
    expect(songs).toHaveLength(2);

    // Each entry carries a populated song doc under `.song` (not a bare id) +
    // its playedKey, in setlist order.
    expect(songs[0].playedKey).toBe('A');
    expect(songs[0].song._id).toBe(s1._id.toString());
    expect(songs[0].song.title).toBe('Bye Bye Love');
    expect(songs[0].song.artist).toBe('Everly Brothers');

    expect(songs[1].playedKey).toBe('G');
    expect(songs[1].song.title).toBe('Sweet Caroline');
  });

  it('returns 404 for a gig outside the current band', async () => {
    const { gig } = await setup();
    // A second band whose member tries to read band A's gig under their own scope.
    const passwordHash = await authService.hashPassword(PASSWORD);
    const otherAdmin = await User.create({ email: 'other@example.com', passwordHash });
    const otherBand = await Band.create({ name: 'Other', administrator: otherAdmin._id });
    await membershipService.setAdministrator(otherBand._id, otherAdmin._id);
    const otherToken = await tokenFor(otherAdmin._id);

    const res = await authed(request(app).get(`/gigs/${gig._id}`), otherToken, otherBand._id);
    expect(res.status).toBe(404);
  });
});
