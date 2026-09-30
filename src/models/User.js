const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    firstName: {
      type: String,
      trim: true,
      default: '',
    },
    lastName: {
      type: String,
      trim: true,
      default: '',
    },
    passwordHash: {
      type: String,
      required: true,
    },
    resetToken: {
      type: String,
      default: null,
    },
    resetTokenExpiry: {
      type: Date,
      default: null,
    },
    role: {
      type: String,
      enum: ['user', 'system_administrator'],
      default: 'user',
    },
    bands: [
      {
        band: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Band',
          required: true,
        },
        isAdmin: {
          type: Boolean,
          default: false,
        },
      },
    ],
  },
  { timestamps: true }
);

// Multikey index so "members of band X" is an indexed lookup, not a collection scan
userSchema.index({ 'bands.band': 1 });

module.exports = mongoose.model('User', userSchema);
