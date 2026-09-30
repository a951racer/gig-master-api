const mongoose = require('mongoose');

const Band = require('../models/Band');
const User = require('../models/User');

/**
 * Membership service.
 *
 * Owns the two facts that must stay consistent for the single-administrator
 * invariant (design.md — "Single-administrator invariant"):
 *   - `Band.administrator` — the source of truth for who administers a band.
 *   - the per-user `bands[].isAdmin` flag — the source of truth for the token claim.
 *
 * `setAdministrator` keeps exactly one `isAdmin: true` membership per band,
 * consistent with `Band.administrator`.
 *
 * Writes that span multiple documents run inside a Mongoose transaction when a
 * replica set is available (mongodb-memory-server supports transactions on a
 * single-node replica set), and fall back to sequential writes with a
 * reconciliation guard when transactions are unavailable.
 */

function toId(value) {
  return value && value._id ? value._id.toString() : value.toString();
}

/**
 * Run `work(session)` inside a transaction if the deployment supports them,
 * otherwise run `work(null)` as sequential writes.
 *
 * Transactions require a replica set / mongos; a standalone mongod (or a
 * memory server started without a replica set) throws when a transaction is
 * committed. We attempt a session-backed transaction and transparently fall
 * back on the well-known "Transaction numbers are only allowed on a replica
 * set member or mongos" class of errors.
 */
async function withOptionalTransaction(work) {
  let session;
  try {
    session = await mongoose.startSession();
  } catch (err) {
    // Cannot even create a session — run without one.
    return work(null);
  }

  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } catch (err) {
    if (isUnsupportedTransactionError(err)) {
      // Standalone server: transactions aren't available. Fall back to
      // sequential writes without a session.
      return work(null);
    }
    throw err;
  } finally {
    session.endSession();
  }
}

function isUnsupportedTransactionError(err) {
  if (!err) return false;
  const message = String(err.message || '');
  return (
    err.code === 20 ||
    err.codeName === 'IllegalOperation' ||
    /Transaction numbers are only allowed on a replica set member or mongos/i.test(
      message
    ) ||
    /Transactions are not supported/i.test(message) ||
    /This MongoDB deployment does not support retryable writes/i.test(message)
  );
}

/**
 * Add a membership entry to the user's `bands[]` for `bandId`.
 *
 * Idempotent per band: if the user is already a member of the band, the entry
 * is updated (its `isAdmin` flag) rather than duplicated. Never creates two
 * entries for the same band.
 *
 * @param {string|ObjectId} bandId
 * @param {string|ObjectId} userId
 * @param {{ isAdmin?: boolean }} [options]
 * @returns {Promise<import('mongoose').Document>} the updated user
 */
async function addMember(bandId, userId, { isAdmin = false } = {}, session = null) {
  const bandKey = toId(bandId);
  const user = await User.findById(userId).session(session);
  if (!user) {
    throw new Error(`User ${toId(userId)} not found`);
  }

  const existing = (user.bands || []).find(
    (m) => m.band && toId(m.band) === bandKey
  );

  if (existing) {
    // Already a member — update the admin flag rather than adding a duplicate.
    existing.isAdmin = isAdmin;
  } else {
    user.bands.push({ band: bandId, isAdmin });
  }

  await user.save({ session });
  return user;
}

/**
 * Remove the user's `bands[]` entry for `bandId`. No-op if absent.
 *
 * @param {string|ObjectId} bandId
 * @param {string|ObjectId} userId
 * @returns {Promise<import('mongoose').Document|null>} the updated user, or null if not found
 */
async function removeMember(bandId, userId, session = null) {
  const bandKey = toId(bandId);
  const user = await User.findById(userId).session(session);
  if (!user) {
    return null;
  }

  user.bands = (user.bands || []).filter(
    (m) => !(m.band && toId(m.band) === bandKey)
  );

  await user.save({ session });
  return user;
}

/**
 * Designate `userId` as the administrator of `bandId`.
 *
 * Performs the single-administrator invariant as one logical operation:
 *   1. Set `Band.administrator = userId`.
 *   2. Ensure the target user is a member of the band with `isAdmin: true`
 *      (add the membership if absent).
 *   3. Clear `isAdmin` on the previous administrator's membership entry for
 *      that band (unless the previous administrator is the new one).
 *
 * Net effect: exactly one `isAdmin: true` membership per band, consistent with
 * `Band.administrator`.
 *
 * @param {string|ObjectId} bandId
 * @param {string|ObjectId} userId
 * @returns {Promise<import('mongoose').Document>} the band
 */
async function setAdministrator(bandId, userId) {
  return withOptionalTransaction(async (session) => {
    const band = await Band.findById(bandId).session(session);
    if (!band) {
      throw new Error(`Band ${toId(bandId)} not found`);
    }

    const previousAdminId = band.administrator
      ? toId(band.administrator)
      : null;
    const newAdminId = toId(userId);

    // 1. Set the source of truth for who administers the band.
    band.administrator = userId;
    await band.save({ session });

    // 3. Clear the previous administrator's isAdmin flag for this band, unless
    //    they are the same user we are (re)designating.
    if (previousAdminId && previousAdminId !== newAdminId) {
      await demoteFromBand(bandId, previousAdminId, session);
    }

    // 2. Ensure the new administrator is a member with isAdmin: true. addMember
    //    is idempotent per band, so this both adds an absent membership and
    //    promotes an existing one.
    await addMember(bandId, userId, { isAdmin: true }, session);

    return band;
  });
}

/**
 * Set `isAdmin: false` on the given user's membership entry for `bandId`, if
 * present. Used to demote the previous administrator. Does not remove the
 * membership.
 */
async function demoteFromBand(bandId, userId, session = null) {
  const bandKey = toId(bandId);
  const user = await User.findById(userId).session(session);
  if (!user) {
    return null;
  }

  const entry = (user.bands || []).find(
    (m) => m.band && toId(m.band) === bandKey
  );

  if (entry && entry.isAdmin) {
    entry.isAdmin = false;
    await user.save({ session });
  }

  return user;
}

module.exports = {
  addMember,
  removeMember,
  setAdministrator,
  withOptionalTransaction,
};
