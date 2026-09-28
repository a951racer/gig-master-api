const mongoose = require('mongoose');

const genreSchema = new mongoose.Schema({
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
  slug: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
  },
});

genreSchema.index({ band: 1, name: 1 }, { unique: true });
genreSchema.index({ band: 1, slug: 1 }, { unique: true });

module.exports = mongoose.model('Genre', genreSchema);
