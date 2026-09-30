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

module.exports = mongoose.model('Band', bandSchema);
