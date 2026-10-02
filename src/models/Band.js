const mongoose = require('mongoose');

const bandSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    administrator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Soft-delete / archive (stage 1 of the two-stage delete). A band must be
    // archived before it can be hard-deleted. Archived bands are filtered out
    // of members' band lists / token claim so they drop out of normal use,
    // while their data stays intact and archiving is fully reversible.
    archivedAt: {
      type: Date,
      default: null,
    },
    archivedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

bandSchema.index({ administrator: 1 });

// Band names must be unique across the whole app, case-insensitively ("The
// Owls" and "the owls" collide). Case-insensitivity comes from the collation
// (locale 'en', strength 2 = compare ignoring case/diacritics). Archived bands
// still occupy their name (an archived band can be unarchived, which would
// otherwise collide), so the index intentionally has no archive filter.
bandSchema.index(
  { name: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 } }
);

module.exports = mongoose.model('Band', bandSchema);
