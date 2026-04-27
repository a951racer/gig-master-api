const mongoose = require('mongoose');

const songSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    artist: {
      type: String,
      required: true,
      trim: true,
    },
    genre: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Genre',
      default: null,
    },
    tags: {
      type: [String],
      default: [],
    },
    originalKey: {
      type: String,
      default: '',
    },
    performedKey: {
      type: String,
      default: '',
    },
  },
  { timestamps: true }
);

songSchema.index({ title: 'text' });
songSchema.index({ genre: 1 });
songSchema.index({ tags: 1 });

module.exports = mongoose.model('Song', songSchema);
