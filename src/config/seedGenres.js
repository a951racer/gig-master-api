const Genre = require('../models/Genre');

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
 * Seed a per-band copy of the default genre list at band creation.
 * Inserts a fresh copy of DEFAULT_GENRES tagged with the given band id so
 * each band owns its own genre list (later edits to the master seed list are
 * not retroactive). Relies on the Genre model's per-band compound unique
 * indexes ({ band, name } and { band, slug }) to prevent intra-band dupes.
 *
 * @param {import('mongoose').Types.ObjectId|string} bandId - the owning band's id
 * @returns {Promise<Array>} the inserted genre documents
 */
async function seedBandGenres(bandId) {
  const docs = DEFAULT_GENRES.map((name) => ({
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
module.exports.seedGenres = seedGenres;
module.exports.DEFAULT_GENRES = DEFAULT_GENRES;
module.exports.generateSlug = generateSlug;
