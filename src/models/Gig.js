const mongoose = require('mongoose');

const gigSchema = new mongoose.Schema(
  {
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

gigSchema.index({ date: -1 });

module.exports = mongoose.model('Gig', gigSchema);
