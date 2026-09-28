const mongoose = require('mongoose');

const joinRequestSchema = new mongoose.Schema(
  {
    band: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Band',
      required: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'denied'],
      default: 'pending',
    },
  },
  { timestamps: true }
);

// Prevent duplicate *pending* requests for the same (band, user) while still
// allowing a user to re-request after a denial.
joinRequestSchema.index(
  { band: 1, user: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } }
);

// Admin queue lookups: pending requests for a band.
joinRequestSchema.index({ band: 1, status: 1 });

module.exports = mongoose.model('JoinRequest', joinRequestSchema);
