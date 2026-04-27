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

module.exports = seedGenres;
