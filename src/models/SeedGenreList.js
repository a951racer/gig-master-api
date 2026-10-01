const mongoose = require('mongoose');

// Persistent master Seed_Genre_List (#41). A singleton: exactly one document
// holds the ordered list of seed genre names a sysadmin maintains, and from
// which new bands are seeded. Stored as an ordered [String] array because the
// API contract (GET/PUT /admin/seed-genres) exchanges an ordered list of names,
// so a single document maps directly and makes replace-on-PUT atomic.
//
// The `key` field enforces the singleton: a fixed value with a unique index so
// there is never more than one list document.
const seedGenreListSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      default: 'master',
      unique: true,
    },
    genres: {
      type: [String],
      default: [],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SeedGenreList', seedGenreListSchema);
