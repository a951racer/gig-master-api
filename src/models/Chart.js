const mongoose = require('mongoose');

const chartSchema = new mongoose.Schema(
  {
    song: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Song',
      required: true,
    },
    body: {
      type: String,
      required: true,
    },
    title: {
      type: String,
      default: '',
    },
    artistLabel: {
      type: String,
      default: '',
    },
    formatting: {
      font: {
        type: String,
        default: 'monospace',
      },
      size: {
        type: Number,
        default: 11,
      },
      chordColor: {
        type: String,
        default: 'blue',
      },
      columns: {
        type: Number,
        default: 1,
      },
    },
  },
  { timestamps: true }
);

// Enforce the one-to-one relationship between Chart and Song: a Song has at
// most one Chart. Band ownership is derived from the Song (no `band` field).
chartSchema.index({ song: 1 }, { unique: true });

module.exports = mongoose.model('Chart', chartSchema);
