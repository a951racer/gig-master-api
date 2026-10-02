const request = require('supertest');
const mongoose = require('mongoose');

const app = require('../app');
const User = require('../models/User');
const Band = require('../models/Band');
const Song = require('../models/Song');
const Playlist = require('../models/Playlist');
const authService = require('../services/authService');
const membershipService = require('../services/membershipService');

// Integration tests for POST /playlists accepting an optional songs[] (used by
// the copy-playlist feature). Band-scoped: the X-Band-Id header selects the
// current band, and song ids must belong to it. Mirrors the token/band setup
// used by the other *.bands.test.js files.

const PASSWORD = 'password123';

async function tokenFor(userId) {
  const user = await User.findById(userId).populate('bands.band', 'name');
  return authService.generateAccessToken(user);
}

beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await Promise.all([
    User.syncIndexes(),
    Band.syncIndexes(),
    Song.syncIndexes(),
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
    Playlist.deleteMany({}),
  ]);
});

// Build a band with an admin user + token, and some songs in that band.
async function setup() {
  const passwordHash = await authService.hashPassword(PASSWORD);
  const admin = await User.create({ email: 'pl-admin@example.com', passwordHash });
  const band = await Band.create({ name: 'PL Band', administrator: admin._id });
  await membershipService.setAdministrator(band._id, admin._id);
  const token = await tokenFor(admin._id);

  const s1 = await Song.create({ band: band._id, title: 'One', artist: 'A' });
  const s2 = await Song.create({ band: band._id, title: 'Two', artist: 'B' });
  const s3 = await Song.create({ band: band._id, title: 'Three', artist: 'C' });

  return { band, token, songs: [s1, s2, s3] };
}

describe('POST /playlists with songs[] (copy support)', () => {
  it('creates a playlist with the given songs in order', async () => {
    const { band, token, songs } = await setup();
    const order = [songs[2]._id.toString(), songs[0]._id.toString(), songs[1]._id.toString()];

    const res = await request(app)
      .post('/playlists')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Band-Id', band._id.toString())
      .send({ name: 'Copy of Set', description: 'copied', songs: order });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Copy of Set');
    expect(res.body.description).toBe('copied');
    expect(res.body.songs.map(String)).toEqual(order);
  });

  it('still creates an empty playlist when songs is omitted (back-compat)', async () => {
    const { band, token } = await setup();
    const res = await request(app)
      .post('/playlists')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Band-Id', band._id.toString())
      .send({ name: 'Empty' });

    expect(res.status).toBe(201);
    expect(res.body.songs).toEqual([]);
  });

  it('dedupes repeated song ids while preserving order', async () => {
    const { band, token, songs } = await setup();
    const a = songs[0]._id.toString();
    const b = songs[1]._id.toString();

    const res = await request(app)
      .post('/playlists')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Band-Id', band._id.toString())
      .send({ name: 'Deduped', songs: [a, b, a, b, a] });

    expect(res.status).toBe(201);
    expect(res.body.songs.map(String)).toEqual([a, b]);
  });

  it('rejects songs from another band with 422', async () => {
    const { band, token } = await setup();
    // A song in a DIFFERENT band.
    const otherBand = await Band.create({ name: 'Other', administrator: new mongoose.Types.ObjectId() });
    const foreign = await Song.create({ band: otherBand._id, title: 'Foreign', artist: 'X' });

    const res = await request(app)
      .post('/playlists')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Band-Id', band._id.toString())
      .send({ name: 'Bad', songs: [foreign._id.toString()] });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(await Playlist.countDocuments({ band: band._id })).toBe(0);
  });

  it('rejects a non-array songs value with 422', async () => {
    const { band, token } = await setup();
    const res = await request(app)
      .post('/playlists')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Band-Id', band._id.toString())
      .send({ name: 'Bad', songs: 'not-an-array' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('Playlist name uniqueness within a band', () => {
  it('rejects a duplicate name in the same band with 409 DUPLICATE_NAME', async () => {
    const { band, token } = await setup();

    const first = await request(app)
      .post('/playlists')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Band-Id', band._id.toString())
      .send({ name: 'Our Stuff' });
    expect(first.status).toBe(201);

    const dup = await request(app)
      .post('/playlists')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Band-Id', band._id.toString())
      .send({ name: 'Our Stuff' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_NAME');

    expect(await Playlist.countDocuments({ band: band._id })).toBe(1);
  });

  it('treats names case-insensitively ("Our Stuff" vs "our stuff")', async () => {
    const { band, token } = await setup();

    await request(app)
      .post('/playlists')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Band-Id', band._id.toString())
      .send({ name: 'Our Stuff' });

    const dup = await request(app)
      .post('/playlists')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Band-Id', band._id.toString())
      .send({ name: 'our stuff' });

    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_NAME');
  });

  it('allows the SAME name in a different band', async () => {
    const { band, token } = await setup();

    await request(app)
      .post('/playlists')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Band-Id', band._id.toString())
      .send({ name: 'Shared Name' });

    // A second band with its own admin/token.
    const passwordHash = await authService.hashPassword(PASSWORD);
    const admin2 = await User.create({ email: 'pl-admin2@example.com', passwordHash });
    const band2 = await Band.create({ name: 'PL Band 2', administrator: admin2._id });
    await membershipService.setAdministrator(band2._id, admin2._id);
    const token2 = await tokenFor(admin2._id);

    const res = await request(app)
      .post('/playlists')
      .set('Authorization', `Bearer ${token2}`)
      .set('X-Band-Id', band2._id.toString())
      .send({ name: 'Shared Name' });

    expect(res.status).toBe(201);
  });

  it('rejects renaming a playlist to a name already used in the band (409)', async () => {
    const { band, token } = await setup();

    await request(app).post('/playlists').set('Authorization', `Bearer ${token}`).set('X-Band-Id', band._id.toString()).send({ name: 'Alpha' });
    const bRes = await request(app).post('/playlists').set('Authorization', `Bearer ${token}`).set('X-Band-Id', band._id.toString()).send({ name: 'Beta' });

    const rename = await request(app)
      .patch(`/playlists/${bRes.body._id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Band-Id', band._id.toString())
      .send({ name: 'Alpha' });

    expect(rename.status).toBe(409);
    expect(rename.body.error.code).toBe('DUPLICATE_NAME');
  });
});
