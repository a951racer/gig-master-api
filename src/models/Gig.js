const mongoose = require('mongoose');

const gigSchema = new mongoose.Schema(
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
    location: {
      type: String,
      default: '',
    },
    date: {
      type: Date,
      required: true,
    },
    playlist: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Playlist',
      default: null,
    },
  },
  { timestamps: true }
);

gigSchema.index({ band: 1 });
gigSchema.index({ date: -1 });

module.exports = mongoose.model('Gig', gigSchema);
