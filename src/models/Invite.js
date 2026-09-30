const mongoose = require('mongoose');

// A band invitation sent to an email address. The raw token is emailed to the
// invitee (in the accept link); only its hash is stored, mirroring how reset/
// refresh tokens are handled. Accepting adds the invitee to the band.
const inviteSchema = new mongoose.Schema(
  {
    band: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Band',
      required: true,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    tokenHash: {
      type: String,
      required: true,
      index: true,
    },
    invitedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'revoked', 'expired'],
      default: 'pending',
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true }
);

// Prevent duplicate *pending* invites for the same (band, email) while still
// allowing a fresh invite after a previous one is accepted/revoked/expired.
inviteSchema.index(
  { band: 1, email: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } }
);
// Admin queue lookups: pending invites for a band.
inviteSchema.index({ band: 1, status: 1 });

module.exports = mongoose.model('Invite', inviteSchema);
