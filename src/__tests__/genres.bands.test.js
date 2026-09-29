const mongoose = require('mongoose');
const fc = require('fast-check');

const Genre = require('../models/Genre');
const { seedBandGenres, DEFAULT_GENRES } = require('../config/seedGenres');

// Per-band genre seeding and isolation tests. Like the model tests, these run
// against the in-memory MongoDB started by the shared test infra
// (src/config/testSetup.js sets process.env.MONGODB_URI). We connect mongoose
// here and build the Genre indexes with syncIndexes(), because the per-band
// compound unique indexes ({ band, name } / { band, slug }) that seedBandGenres
// relies on are not guaranteed to exist before the first insert otherwise.

const oid = () => new mongoose.Types.ObjectId();

beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await Genre.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
});

afterEach(async () => {
  await Genre.deleteMany({});
});

describe('Per-band genre seeding (Requirements 1.5, 10.1)', () => {
  it('seeds the full default genre list scoped to the band', async () => {
    const bandId = oid();
    await seedBandGenres(bandId);

    const genres = await Genre.find({ band: bandId });
    expect(genres).toHaveLength(DEFAULT_GENRES.length);

    const names = genres.map((g) => g.name).sort();
    expect(names).toEqual([...DEFAULT_GENRES].sort());

    // Every seeded genre references the owning band.
    expect(genres.every((g) => g.band.toString() === bandId.toString())).toBe(true);
  });

  // Feature: bands, Property 3: New band genre list equals the seed list
  // Validates: Requirements 1.5, 10.1
  //
  // numRuns kept modest (40): each run inserts ~18 docs then clears them, so a
  // high iteration count adds runtime without exercising new input space (the
  // band id is the only varying input and is an opaque fresh ObjectId).
  it('Property 3: new band genre list equals the seed list', async () => {
    const seedNames = [...DEFAULT_GENRES].sort();

    await fc.assert(
      fc.asyncProperty(
        // Generate a fresh, distinct band id per run.
        fc.constant(null).map(() => oid()),
        async (bandId) => {
          await seedBandGenres(bandId);

          const genres = await Genre.find({ band: bandId });

          // The set of genre NAMES scoped to the band equals the seed names.
          const names = genres.map((g) => g.name).sort();
          const namesMatch =
            names.length === seedNames.length &&
            names.every((n, i) => n === seedNames[i]);

          // Every seeded genre references THIS band.
          const allReferenceBand = genres.every(
            (g) => g.band.toString() === bandId.toString()
          );

          // Clean up within the run so iterations stay isolated.
          await Genre.deleteMany({ band: bandId });

          return namesMatch && allReferenceBand;
        }
      ),
      { numRuns: 40 }
    );
  });
});

describe('Per-band genre isolation (Requirement 10.2)', () => {
  it('mutating one band genre list leaves another unchanged', async () => {
    const bandA = oid();
    const bandB = oid();
    await seedBandGenres(bandA);
    await seedBandGenres(bandB);

    // Delete one genre from band A.
    await Genre.deleteOne({ band: bandA, name: 'Rock' });

    // Band B is untouched.
    const bNames = (await Genre.find({ band: bandB })).map((g) => g.name).sort();
    expect(bNames).toEqual([...DEFAULT_GENRES].sort());
  });

  // Feature: bands, Property 13: Genre edits are isolated per band
  // Validates: Requirements 10.2
  it('Property 13: genre edits are isolated per band', async () => {
    const seedNames = [...DEFAULT_GENRES].sort();

    await fc.assert(
      fc.asyncProperty(
        // Two distinct fresh band ids.
        fc.constant(null).map(() => ({ a: oid(), b: oid() })),
        // A mutation to apply to band A: delete, rename, or add a genre.
        fc.constantFrom('delete', 'rename', 'add'),
        // Which of the default genres the mutation targets.
        fc.nat({ max: DEFAULT_GENRES.length - 1 }),
        async ({ a: bandA, b: bandB }, mutation, targetIndex) => {
          await seedBandGenres(bandA);
          await seedBandGenres(bandB);

          const targetName = DEFAULT_GENRES[targetIndex];

          if (mutation === 'delete') {
            await Genre.deleteOne({ band: bandA, name: targetName });
          } else if (mutation === 'rename') {
            await Genre.updateOne(
              { band: bandA, name: targetName },
              { $set: { name: `${targetName} (A only)`, slug: `${targetName.toLowerCase()}-a-only` } }
            );
          } else {
            // add a genre unique to band A
            await Genre.create({ band: bandA, name: 'A-Exclusive', slug: 'a-exclusive' });
          }

          // Band B's set of names still equals the seed list.
          const bNames = (await Genre.find({ band: bandB })).map((g) => g.name).sort();
          const bUnchanged =
            bNames.length === seedNames.length &&
            bNames.every((n, i) => n === seedNames[i]);

          await Genre.deleteMany({ band: { $in: [bandA, bandB] } });

          return bUnchanged;
        }
      ),
      { numRuns: 40 }
    );
  });
});
