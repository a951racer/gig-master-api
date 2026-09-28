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
  },
  { timestamps: true }
);

bandSchema.index({ administrator: 1 });

module.exports = mongoose.model('Band', bandSchema);
