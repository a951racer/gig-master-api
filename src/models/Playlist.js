const mongoose = require('mongoose');

const playlistSchema = new mongoose.Schema(
  {
    band: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Band',
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: '',
    },
    songs: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Song' }],
      default: [],
    },
  },
  { timestamps: true }
);

playlistSchema.index({ band: 1 });

// Playlist names must be unique within a band, case-insensitively ("Our Stuff"
// and "our stuff" collide), while the SAME name is allowed across different
// bands (the index includes `band`). Case-insensitivity comes from the
// collation (locale 'en', strength 2 = compare ignoring case/diacritics).
playlistSchema.index(
  { band: 1, name: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 } }
);

module.exports = mongoose.model('Playlist', playlistSchema);
