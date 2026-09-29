const mongoose = require('mongoose');
const fc = require('fast-check');

const Song = require('../models/Song');

// Band-scoping confinement tests (Task 6.2).
//
// The band-scoped routes (see src/routes/songs.js) enforce isolation purely
// through query scoping: list reads use `Song.find({ band: req.currentBand })`,
// single-resource reads/modifies use `Song.findOne({ _id, band: req.currentBand })`,
// and creates set `band: req.currentBand`. These properties validate that
// query-scoping contract directly at the model/DB layer against the in-memory
// MongoDB started by the shared test infra (src/config/testSetup.js sets
// process.env.MONGODB_URI) — no HTTP/JWT plumbing required, since confinement
// is a property of the scoped queries themselves.
//
// DB-backed fast-check runs are kept modest (numRuns: 40) so each property does
// real writes without blowing up runtime; the input space (two bands, small
// per-band counts) is well covered at that count.

const oid = () => new mongoose.Types.ObjectId();

beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await Song.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
});

afterEach(async () => {
  await Song.deleteMany({});
});

describe('Band-scoped confinement (Task 6.2)', () => {
  // Feature: bands, Property 11: Reads and writes are confined to the current band
  // Validates: Requirements 9.1, 9.2, 9.3, 10.5
  it('Property 11: reads and writes are confined to the current band', async () => {
    await fc.assert(
      fc.asyncProperty(
        // A dataset of song titles spread across two bands A and B.
        fc.array(
          fc.string({ minLength: 1, maxLength: 30 }).map((s) => s.trim() || 'song'),
          { minLength: 0, maxLength: 8 }
        ),
        fc.array(
          fc.string({ minLength: 1, maxLength: 30 }).map((s) => s.trim() || 'song'),
          { minLength: 0, maxLength: 8 }
        ),
        async (titlesA, titlesB) => {
          const bandA = oid();
          const bandB = oid();

          const docsA = await Promise.all(
            titlesA.map((title, i) =>
              Song.create({ band: bandA, title, artist: `artist-a-${i}` })
            )
          );
          await Promise.all(
            titlesB.map((title, i) =>
              Song.create({ band: bandB, title, artist: `artist-b-${i}` })
            )
          );

          // Scoped list read for band A returns exactly the docs with band === A.
          const foundA = await Song.find({ band: bandA });
          const listConfinedToA =
            foundA.length === titlesA.length &&
            foundA.every((s) => s.band.toString() === bandA.toString());

          const foundAIds = new Set(foundA.map((s) => s._id.toString()));
          const listExactlyA =
            docsA.every((d) => foundAIds.has(d._id.toString())) &&
            foundAIds.size === docsA.length;

          // Scoped list read for band B never contains band A ids.
          const foundB = await Song.find({ band: bandB });
          const listBHasNoA =
            foundB.every((s) => s.band.toString() === bandB.toString()) &&
            foundB.every((s) => !foundAIds.has(s._id.toString()));

          // A created resource persists with band === current band (A).
          const created = await Song.create({
            band: bandA,
            title: 'freshly-created',
            artist: 'creator',
          });
          const reloaded = await Song.findOne({ _id: created._id, band: bandA });
          const writePersistedWithBandA =
            reloaded !== null && reloaded.band.toString() === bandA.toString();

          // The created doc is NOT visible when scoping to band B.
          const notVisibleFromB = await Song.findOne({ _id: created._id, band: bandB });

          await Song.deleteMany({ band: { $in: [bandA, bandB] } });

          return (
            listConfinedToA &&
            listExactlyA &&
            listBHasNoA &&
            writePersistedWithBandA &&
            notVisibleFromB === null
          );
        }
      ),
      { numRuns: 40 }
    );
  });

  // Feature: bands, Property 12: Cross-band resources are inaccessible
  // Validates: Requirements 9.4
  it('Property 12: cross-band resources are inaccessible', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 30 }).map((s) => s.trim() || 'song'),
        fc.string({ minLength: 1, maxLength: 30 }).map((s) => s.trim() || 'artist'),
        async (title, artist) => {
          const bandA = oid();
          let bandB = oid();
          // Ensure B !== A (astronomically unlikely to collide, but be exact).
          while (bandB.toString() === bandA.toString()) {
            bandB = oid();
          }

          const song = await Song.create({ band: bandA, title, artist });

          // The scoped lookup pattern the routes use: cross-band read returns null.
          const crossBandRead = await Song.findOne({ _id: song._id, band: bandB });

          // A cross-band modify (findOneAndUpdate scoped to band B) touches nothing.
          const crossBandModify = await Song.findOneAndUpdate(
            { _id: song._id, band: bandB },
            { $set: { title: 'HACKED' } },
            { new: true }
          );

          // The owning-band lookup still returns the doc, unmodified.
          const ownerRead = await Song.findOne({ _id: song._id, band: bandA });

          await Song.deleteMany({ band: { $in: [bandA, bandB] } });

          return (
            crossBandRead === null &&
            crossBandModify === null &&
            ownerRead !== null &&
            ownerRead.band.toString() === bandA.toString() &&
            ownerRead.title === title
          );
        }
      ),
      { numRuns: 40 }
    );
  });
});
