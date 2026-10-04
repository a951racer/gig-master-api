const mongoose = require('mongoose');

const Band = require('../models/Band');
const Playlist = require('../models/Playlist');
const { runMigration } = require('../scripts/migratePlaylistSongsToPlayedKey');

// Exercises src/scripts/migratePlaylistSongsToPlayedKey.js against the in-memory
// MongoDB (src/config/testSetup.js sets process.env.MONGODB_URI). We seed a
// LEGACY playlist (songs = flat array of ObjectIds) via the raw collection to
// mimic pre-#72 data, run runMigration() on the live connection, and assert the
// songs are converted to [{ song, playedKey: '' }] — and that it's idempotent.

const oid = () => new mongoose.Types.ObjectId();

beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await Promise.all([Band.syncIndexes(), Playlist.syncIndexes()]);
});

afterAll(async () => {
  await mongoose.disconnect();
});

afterEach(async () => {
  await Promise.all([Band.deleteMany({}), Playlist.deleteMany({})]);
});

// Insert a raw playlist doc with the LEGACY flat-id songs shape, bypassing the
// Mongoose model (which would cast to the new subdoc shape).
async function insertLegacyPlaylist(name, songIds) {
  const bandId = oid();
  const res = await Playlist.collection.insertOne({
    band: bandId,
    name,
    description: '',
    songs: songIds, // bare ObjectIds — the OLD shape
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return res.insertedId;
}

describe('migratePlaylistSongsToPlayedKey', () => {
  it('converts legacy flat-id songs to [{ song, playedKey: "" }] preserving order', async () => {
    const a = oid();
    const b = oid();
    const c = oid();
    const id = await insertLegacyPlaylist('Legacy Set', [a, b, c]);

    const summary = await runMigration();
    expect(summary.migrated).toBeGreaterThanOrEqual(1);

    const raw = await Playlist.collection.findOne({ _id: id });
    expect(raw.songs).toHaveLength(3);
    expect(raw.songs.map((e) => String(e.song))).toEqual([String(a), String(b), String(c)]);
    expect(raw.songs.every((e) => e.playedKey === '')).toBe(true);
  });

  it('is idempotent — a second run makes no further changes', async () => {
    await insertLegacyPlaylist('Legacy Set', [oid(), oid()]);

    const first = await runMigration();
    expect(first.migrated).toBe(1);

    const second = await runMigration();
    expect(second.migrated).toBe(0); // already migrated → no-op
  });

  it('leaves already-migrated playlists untouched', async () => {
    const song = oid();
    // Create via the model so it is already in the new subdoc shape.
    await Playlist.create({ band: oid(), name: 'New Shape', songs: [{ song, playedKey: 'G' }] });

    const summary = await runMigration();
    expect(summary.migrated).toBe(0);

    const raw = await Playlist.collection.findOne({ name: 'New Shape' });
    expect(raw.songs[0].playedKey).toBe('G'); // preserved
  });
});
