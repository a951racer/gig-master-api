const Genre = require('../models/Genre');
const SeedGenreList = require('../models/SeedGenreList');

const DEFAULT_GENRES = [
  'Rock', 'Pop', 'Jazz', 'Blues', 'Country', 'Classical',
  'Hip-Hop', 'R&B', 'Folk', 'Electronic', 'Reggae', 'Soul',
  'Funk', 'Metal', 'Punk', 'Latin', 'Gospel', 'World',
];

function generateSlug(name) {
  return name.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

async function seedGenres() {
  const count = await Genre.countDocuments();
  if (count > 0) {
    console.log('Genres already seeded');
    return;
  }

  const docs = DEFAULT_GENRES.map((name) => ({ name, slug: generateSlug(name) }));
  await Genre.insertMany(docs);
  console.log(`Seeded ${docs.length} genres`);
}

/**
 * Return the persisted master Seed_Genre_List (#41) as an ordered array of
 * names. Lazily initializes the singleton document from DEFAULT_GENRES the
 * first time it is read (when the collection is empty), so a fresh database
 * starts from the built-in defaults. The persisted list is the source of truth
 * for new-band seeding.
 *
 * @returns {Promise<string[]>} ordered seed genre names
 */
async function getSeedGenreList() {
  let doc = await SeedGenreList.findOne({ key: 'master' });
  if (!doc) {
    // First use: seed the singleton from the built-in defaults.
    doc = await SeedGenreList.create({ key: 'master', genres: [...DEFAULT_GENRES] });
  }
  return [...doc.genres];
}

/**
 * Replace the persisted master Seed_Genre_List with `names` (ordered). Upserts
 * the singleton so a PUT is a single atomic replace. Returns the stored names.
 *
 * @param {string[]} names - the new ordered list of seed genre names
 * @returns {Promise<string[]>} the stored names
 */
async function setSeedGenreList(names) {
  const doc = await SeedGenreList.findOneAndUpdate(
    { key: 'master' },
    { $set: { genres: names } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return [...doc.genres];
}

/**
 * Seed a per-band copy of the master seed list at band creation.
 * Inserts a fresh copy of the PERSISTED seed list (getSeedGenreList) tagged
 * with the given band id so each band owns its own genre list (later edits to
 * the master seed list are not retroactive). Relies on the Genre model's
 * per-band compound unique indexes ({ band, name } and { band, slug }) to
 * prevent intra-band dupes.
 *
 * @param {import('mongoose').Types.ObjectId|string} bandId - the owning band's id
 * @returns {Promise<Array>} the inserted genre documents
 */
async function seedBandGenres(bandId) {
  const names = await getSeedGenreList();
  const docs = names.map((name) => ({
    band: bandId,
    name,
    slug: generateSlug(name),
  }));
  return Genre.insertMany(docs);
}

// Preserve back-compat: server.js does `const seedGenres = require('./config/seedGenres')`
// then calls `seedGenres()`, so the default export must remain the callable
// global seeder. Attach the new per-band helper as a property.
module.exports = seedGenres;
module.exports.seedBandGenres = seedBandGenres;
module.exports.getSeedGenreList = getSeedGenreList;
module.exports.setSeedGenreList = setSeedGenreList;
module.exports.seedGenres = seedGenres;
module.exports.DEFAULT_GENRES = DEFAULT_GENRES;
module.exports.generateSlug = generateSlug;
