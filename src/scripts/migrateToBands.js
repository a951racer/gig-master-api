/**
 * One-off data migration: move all pre-existing global resources into a
 * Legacy Band, and designate the initial system administrator.
 *
 * Design reference: design.md — "Data Migration + Seeding".
 * Requirements: 12.1, 12.2, 12.3, 13.1, 13.2, 13.3, 13.4, 13.5.
 *
 * Properties this script is built to satisfy:
 *   - Idempotent: re-running converges to the same end state (Req 12.3, 13.3).
 *       * Role is only saved when it actually changes.
 *       * Legacy Band is found-or-created (never duplicated).
 *       * setAdministrator is itself idempotent (keeps exactly one admin).
 *       * Backfill targets only docs missing `band`, so re-runs are no-ops.
 *   - Fail-loud: if the initial sysadmin user does not exist, abort with a
 *     descriptive error, make NO changes, disconnect, and exit non-zero
 *     (Req 13.4).
 *
 * Runnable directly:  `node src/scripts/migrateToBands.js`
 * Also exported (module.exports = main) so it can be tested. The auto-run is
 * guarded by `require.main === module`, so requiring this file does NOT connect
 * to the database or run the migration.
 */

// Load environment variables (e.g. MONGODB_URI) when run standalone via
// `node src/scripts/migrateToBands.js`, mirroring server.js. Without this the
// script's connectDB() sees an undefined MONGODB_URI.
require('dotenv').config();

const mongoose = require('mongoose');

const connectDB = require('../config/db');
const User = require('../models/User');
const Band = require('../models/Band');
const Song = require('../models/Song');
const Playlist = require('../models/Playlist');
const Gig = require('../models/Gig');
const Genre = require('../models/Genre');
const membershipService = require('../services/membershipService');

const INITIAL_SYSADMIN_EMAIL = 'jon.hobbs@minnykid.com';
const LEGACY_BAND_NAME = 'Legacy Band';

// Collections that carry a `band` ref and need backfilling into the Legacy Band.
const BACKFILL_MODELS = [
  ['Song', Song],
  ['Playlist', Playlist],
  ['Gig', Gig],
  ['Genre', Genre],
];

/**
 * Set the user's role to `system_administrator`, only saving when it changes.
 * Idempotent (Req 12.2, 12.3).
 *
 * @returns {Promise<boolean>} whether the role was changed
 */
async function designateSystemAdministrator(user) {
  if (user.role === 'system_administrator') {
    return false;
  }
  user.role = 'system_administrator';
  await user.save();
  return true;
}

/**
 * Find or create the Legacy Band administered by `admin`, then ensure the
 * admin is an admin+member via the membership service. Idempotent (Req 13.1,
 * 13.5).
 *
 * @returns {Promise<{ legacyBand: object, created: boolean }>}
 */
async function findOrCreateLegacyBand(admin) {
  let legacyBand = await Band.findOne({ name: LEGACY_BAND_NAME });
  let created = false;

  if (!legacyBand) {
    legacyBand = await Band.create({
      name: LEGACY_BAND_NAME,
      administrator: admin._id,
    });
    created = true;
  }

  // Idempotently ensure the admin is the band's administrator + member with
  // isAdmin: true (adds the membership if absent, promotes if present).
  await membershipService.setAdministrator(legacyBand._id, admin._id);

  return { legacyBand, created };
}

/**
 * Backfill every band-scoped collection: assign the Legacy Band to any document
 * that has no `band` yet. Only untouched docs are affected, so re-runs are
 * no-ops (Req 13.2, 13.3).
 *
 * @returns {Promise<Record<string, number>>} counts of docs updated per collection
 */
async function backfillResources(legacyBandId) {
  const counts = {};
  for (const [name, Model] of BACKFILL_MODELS) {
    const result = await Model.updateMany(
      { band: { $exists: false } },
      { $set: { band: legacyBandId } }
    );
    // Mongoose returns `modifiedCount` on modern drivers.
    counts[name] =
      (result && (result.modifiedCount ?? result.nModified)) || 0;
  }
  return counts;
}

/**
 * Drop stale global-unique indexes on the `genres` collection that predate the
 * Bands feature. Before Bands, Genre had global unique indexes on `name` and
 * `slug` (name_1 / slug_1). The schema now uses per-band compound unique
 * indexes ({ band, name } / { band, slug }), but Mongoose never drops indexes
 * that already exist in the DB — so the old global-unique indexes linger and
 * wrongly reject per-band duplicate genre names (every band gets its own copy
 * of the seed genres, e.g. "Rock").
 *
 * Idempotent: only drops an index if it is present; safe to re-run and safe on
 * fresh databases that never had the old indexes.
 *
 * @returns {Promise<string[]>} names of indexes that were dropped
 */
async function dropStaleGenreIndexes() {
  const STALE_INDEXES = ['name_1', 'slug_1'];
  const collection = Genre.collection;
  const dropped = [];

  let existing;
  try {
    existing = await collection.indexes();
  } catch (err) {
    // If the collection does not exist yet (fresh DB), there is nothing to drop.
    return dropped;
  }
  const existingNames = new Set(existing.map((i) => i.name));

  for (const name of STALE_INDEXES) {
    if (existingNames.has(name)) {
      await collection.dropIndex(name);
      dropped.push(name);
    }
  }
  return dropped;
}

/**
 * Run the migration. Assumes a live mongoose connection.
 *
 * @returns {Promise<object>} a summary of what changed (useful for tests/logs)
 */
async function runMigration() {
  // 1 + 2. Preflight (fail-loud): the initial sysadmin user must exist.
  const admin = await User.findOne({ email: INITIAL_SYSADMIN_EMAIL });
  if (!admin) {
    throw new Error(
      `Migration aborted: required user '${INITIAL_SYSADMIN_EMAIL}' not found. ` +
        'No changes were made. Create the user, then re-run the migration.'
    );
  }

  // 3. Initial sysadmin designation (idempotent).
  const roleChanged = await designateSystemAdministrator(admin);

  // 4. Find-or-create the Legacy Band and ensure admin membership (idempotent).
  const { legacyBand, created: legacyBandCreated } =
    await findOrCreateLegacyBand(admin);

  // 4b. Drop stale pre-Bands global-unique genre indexes (idempotent) so that
  //     per-band duplicate genre names are allowed.
  const droppedGenreIndexes = await dropStaleGenreIndexes();

  // 5. Backfill resources missing a `band` into the Legacy Band (idempotent).
  const backfillCounts = await backfillResources(legacyBand._id);

  return {
    adminEmail: admin.email,
    adminId: admin._id.toString(),
    roleChanged,
    legacyBandId: legacyBand._id.toString(),
    legacyBandCreated,
    droppedGenreIndexes,
    backfillCounts,
  };
}

/**
 * Entry point: connect, run the migration, log a concise summary, and
 * disconnect cleanly. Exits non-zero on any failure (including the fail-loud
 * missing-user case).
 */
async function main() {
  let failed = false;
  try {
    await connectDB();
    const summary = await runMigration();

    // eslint-disable-next-line no-console
    console.log('migrateToBands: migration completed successfully.');
    // eslint-disable-next-line no-console
    console.log(
      `  initial sysadmin: ${summary.adminEmail} (${summary.adminId}) — ` +
        `role ${summary.roleChanged ? 'changed to system_administrator' : 'already system_administrator'}`
    );
    // eslint-disable-next-line no-console
    console.log(
      `  Legacy Band: ${summary.legacyBandId} — ` +
        `${summary.legacyBandCreated ? 'created' : 'found existing'}`
    );
    // eslint-disable-next-line no-console
    console.log(
      `  dropped stale genre indexes: ` +
        (summary.droppedGenreIndexes.length
          ? summary.droppedGenreIndexes.join(', ')
          : 'none')
    );
    const { backfillCounts } = summary;
    // eslint-disable-next-line no-console
    console.log(
      `  backfilled documents into Legacy Band: ` +
        Object.entries(backfillCounts)
          .map(([name, count]) => `${name}=${count}`)
          .join(', ')
    );

    return summary;
  } catch (err) {
    failed = true;
    // eslint-disable-next-line no-console
    console.error(`migrateToBands: FAILED — ${err.message}`);
    if (err.stack) {
      // eslint-disable-next-line no-console
      console.error(err.stack);
    }
    throw err;
  } finally {
    // Always disconnect if a connection was established.
    try {
      if (mongoose.connection && mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
      }
    } catch (disconnectErr) {
      // eslint-disable-next-line no-console
      console.error(
        `migrateToBands: error while disconnecting — ${disconnectErr.message}`
      );
    }

    // When invoked directly, translate the outcome into a process exit code.
    if (require.main === module) {
      process.exit(failed ? 1 : 0);
    }
  }
}

// Auto-run only when executed directly (e.g. `node src/scripts/migrateToBands.js`).
// Requiring the module (for tests) must NOT connect or run the migration.
if (require.main === module) {
  main();
}

module.exports = main;
module.exports.runMigration = runMigration;
module.exports.designateSystemAdministrator = designateSystemAdministrator;
module.exports.findOrCreateLegacyBand = findOrCreateLegacyBand;
module.exports.backfillResources = backfillResources;
module.exports.dropStaleGenreIndexes = dropStaleGenreIndexes;
module.exports.INITIAL_SYSADMIN_EMAIL = INITIAL_SYSADMIN_EMAIL;
module.exports.LEGACY_BAND_NAME = LEGACY_BAND_NAME;
