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

module.exports = mongoose.model('Playlist', playlistSchema);
