const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const SALT_ROUNDS = 10;
const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'dev-access-secret';

async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function buildBandsClaim(user) {
  // Exclude memberships whose band is unpopulated/missing or archived: archived
  // bands must not appear in the token claim (they drop out of the switcher and
  // can't be selected as the current band). Callers populate bands.band with at
  // least { name, archivedAt } for this filter to work.
  return (user.bands || [])
    .filter((m) => m.band && m.band._id && !m.band.archivedAt)
    .map((m) => ({
      id: m.band._id.toString(),
      name: m.band.name,
      isAdmin: m.isAdmin,
    }));
}

function generateAccessToken(user) {
  return jwt.sign(
    {
      sub: user._id.toString(),
      role: user.role,
      bands: buildBandsClaim(user),
    },
    ACCESS_TOKEN_SECRET,
    { expiresIn: '24h' }
  );
}

function generateRefreshToken() {
  return crypto.randomBytes(40).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = {
  hashPassword,
  comparePassword,
  buildBandsClaim,
  generateAccessToken,
  generateRefreshToken,
  hashToken,
};
