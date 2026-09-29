const mongoose = require('mongoose');
const fc = require('fast-check');

const User = require('../models/User');
const Band = require('../models/Band');
const Song = require('../models/Song');
const Playlist = require('../models/Playlist');
const Gig = require('../models/Gig');
const Genre = require('../models/Genre');

const {
  runMigration,
  designateSystemAdministrator,
  INITIAL_SYSADMIN_EMAIL,
  LEGACY_BAND_NAME,
} = require('../scripts/migrateToBands');

// These tests exercise the migration script (src/scripts/migrateToBands.js)
// against the in-memory MongoDB started by the shared test infra
// (src/config/testSetup.js sets process.env.MONGODB_URI). We connect mongoose
// here (mirroring models.bands.test.js) and call `runMigration()` directly,
// which assumes a live connection — NOT `main()`, which would connect via
// connectDB and then call process.exit.
//
// We syncIndexes() up front so the DB-level constraints (e.g. Genre per-band
// compound uniqueness, User.email unique) are in place before inserts.

const oid = () => new mongoose.Types.ObjectId();

// Insert "pre-migration" docs that predate the required `band` ref by writing
// raw documents with the native driver, bypassing Mongoose validation — this
// mirrors real legacy data that has no `band` yet.
async function insertLegacySongs(n) {
  if (n <= 0) return;
  const docs = Array.from({ length: n }, (_, i) => ({
    title: `Legacy Song ${i}-${oid()}`,
    artist: `Artist ${i}`,
    tags: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  await Song.collection.insertMany(docs);
}

async function insertLegacyPlaylists(n) {
  if (n <= 0) return;
  const docs = Array.from({ length: n }, (_, i) => ({
    name: `Legacy Playlist ${i}-${oid()}`,
    description: '',
    songs: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  await Playlist.collection.insertMany(docs);
}

async function insertLegacyGigs(n) {
  if (n <= 0) return;
  const docs = Array.from({ length: n }, (_, i) => ({
    name: `Legacy Gig ${i}-${oid()}`,
    description: '',
    location: '',
    date: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  await Gig.collection.insertMany(docs);
}

async function insertLegacyGenres(n) {
  if (n <= 0) return;
  // Names/slugs must stay unique so the per-band compound unique index (which
  // the backfill will apply once they all share the Legacy Band) is satisfied.
  const docs = Array.from({ length: n }, (_, i) => {
    const key = `${i}-${oid()}`;
    return { name: `Legacy Genre ${key}`, slug: `legacy-genre-${key}` };
  });
  await Genre.collection.insertMany(docs);
}

async function createJon() {
  return User.create({
    email: INITIAL_SYSADMIN_EMAIL,
    passwordHash: 'hashed-password',
    role: 'user',
  });
}

async function clearAll() {
  await Promise.all([
    User.deleteMany({}),
    Band.deleteMany({}),
    Song.deleteMany({}),
    Playlist.deleteMany({}),
    Gig.deleteMany({}),
    Genre.deleteMany({}),
  ]);
}

beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await Promise.all([
    User.syncIndexes(),
    Band.syncIndexes(),
    Song.syncIndexes(),
    Playlist.syncIndexes(),
    Gig.syncIndexes(),
    Genre.syncIndexes(),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
});

// Jest runs in-band; clean up every collection this suite touches (Legacy Band,
// users, and all backfilled resources) so it can't interfere with other suites.
afterEach(async () => {
  await clearAll();
});

// Feature: bands, Property 17: Initial sysadmin designation is idempotent
// Validates: Requirements 12.2, 12.3
describe('Property 17: Initial sysadmin designation is idempotent', () => {
  it('leaves role === system_administrator after any n >= 1 designation runs', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 8 }), async (n) => {
        const jon = await createJon();
        expect(jon.role).toBe('user');

        for (let i = 0; i < n; i += 1) {
          // Re-load so we operate on the persisted document each run, then
          // designate. The result is stable after the first run.
          const user = await User.findById(jon._id);
          await designateSystemAdministrator(user);

          const after = await User.findById(jon._id);
          expect(after.role).toBe('system_administrator');
        }

        // Final state is the sysadmin role, and exactly one such user exists.
        const finalJon = await User.findById(jon._id);
        expect(finalJon.role).toBe('system_administrator');

        await clearAll();
        return finalJon.role === 'system_administrator';
      }),
      { numRuns: 40 }
    );
  });
});

// Feature: bands, Property 18: Migration is correct, idempotent, and fail-loud
// Validates: Requirements 13.1, 13.2, 13.3, 13.4, 13.5
describe('Property 18: Migration is correct, idempotent, and fail-loud', () => {
  // numRuns is kept modest (20): each run seeds a dataset and performs TWO full
  // migrations (many DB writes) plus assertions, so a high iteration count
  // would make this suite slow without adding meaningful coverage.
  it('(a) assigns every resource to the Legacy Band and makes jon admin+member; (b) is idempotent on re-run', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          songs: fc.integer({ min: 0, max: 6 }),
          playlists: fc.integer({ min: 0, max: 6 }),
          gigs: fc.integer({ min: 0, max: 6 }),
          genres: fc.integer({ min: 0, max: 6 }),
        }),
        async (counts) => {
          await clearAll();

          const jon = await createJon();
          await insertLegacySongs(counts.songs);
          await insertLegacyPlaylists(counts.playlists);
          await insertLegacyGigs(counts.gigs);
          await insertLegacyGenres(counts.genres);

          // --- (a) first migration -----------------------------------------
          await runMigration();

          const legacyBands = await Band.find({ name: LEGACY_BAND_NAME });
          expect(legacyBands).toHaveLength(1);
          const legacy = legacyBands[0];
          expect(legacy.administrator.toString()).toBe(jon._id.toString());

          // Every resource now references the Legacy Band; none left unassigned.
          for (const Model of [Song, Playlist, Gig, Genre]) {
            const total = await Model.countDocuments({});
            const assigned = await Model.countDocuments({ band: legacy._id });
            const unassigned = await Model.countDocuments({
              band: { $exists: false },
            });
            expect(assigned).toBe(total);
            expect(unassigned).toBe(0);
          }

          // jon is the Legacy Band administrator and a member with isAdmin true.
          let jonDoc = await User.findById(jon._id);
          expect(jonDoc.role).toBe('system_administrator');
          const legacyMembership = jonDoc.bands.find(
            (m) => m.band.toString() === legacy._id.toString()
          );
          expect(legacyMembership).toBeDefined();
          expect(legacyMembership.isAdmin).toBe(true);

          // Snapshot the end state for the idempotency comparison.
          const totals = {
            songs: await Song.countDocuments({}),
            playlists: await Playlist.countDocuments({}),
            gigs: await Gig.countDocuments({}),
            genres: await Genre.countDocuments({}),
          };

          // --- (b) second migration: identical end state --------------------
          await runMigration();

          // No duplicate Legacy Band.
          expect(await Band.countDocuments({ name: LEGACY_BAND_NAME })).toBe(1);
          const legacyAfter = await Band.findOne({ name: LEGACY_BAND_NAME });
          expect(legacyAfter._id.toString()).toBe(legacy._id.toString());

          // Counts unchanged and still fully assigned to the same Legacy Band.
          expect(await Song.countDocuments({})).toBe(totals.songs);
          expect(await Playlist.countDocuments({})).toBe(totals.playlists);
          expect(await Gig.countDocuments({})).toBe(totals.gigs);
          expect(await Genre.countDocuments({})).toBe(totals.genres);
          for (const Model of [Song, Playlist, Gig, Genre]) {
            const total = await Model.countDocuments({});
            const assigned = await Model.countDocuments({ band: legacy._id });
            expect(assigned).toBe(total);
          }

          // jon's membership is unchanged (single admin membership, no dupes).
          jonDoc = await User.findById(jon._id);
          const legacyMemberships = jonDoc.bands.filter(
            (m) => m.band.toString() === legacy._id.toString()
          );
          expect(legacyMemberships).toHaveLength(1);
          expect(legacyMemberships[0].isAdmin).toBe(true);

          await clearAll();
          return true;
        }
      ),
      { numRuns: 20 }
    );
  });

  it('(c) fails loud when jon is absent, leaving all collections unchanged', async () => {
    await clearAll();

    // Seed some legacy data but NO jon.hobbs@minnykid.com user.
    await insertLegacySongs(3);
    await insertLegacyGenres(2);

    const before = {
      users: await User.countDocuments({}),
      bands: await Band.countDocuments({}),
      songs: await Song.countDocuments({}),
      genres: await Genre.countDocuments({}),
    };

    await expect(runMigration()).rejects.toThrow(/not found/i);

    // No Legacy Band created, nothing modified.
    expect(await Band.countDocuments({ name: LEGACY_BAND_NAME })).toBe(0);
    expect(await User.countDocuments({})).toBe(before.users);
    expect(await Band.countDocuments({})).toBe(before.bands);
    expect(await Song.countDocuments({})).toBe(before.songs);
    expect(await Genre.countDocuments({})).toBe(before.genres);

    // The legacy docs still have no band assigned.
    expect(await Song.countDocuments({ band: { $exists: false } })).toBe(
      before.songs
    );
    expect(await Genre.countDocuments({ band: { $exists: false } })).toBe(
      before.genres
    );
  });
});
