/**
 * One-off data migration: convert each Playlist's `songs` from the old flat
 * array of Song ObjectIds to the new subdocument array
 * `[{ song: <ObjectId>, playedKey: '' }]` introduced for per-(song↔playlist)
 * Played Key (#72).
 *
 * Idempotent: entries already in `{ song, playedKey }` shape are left as-is, so
 * re-running converges to the same state and is a no-op on already-migrated or
 * fresh databases.
 *
 * We operate on the RAW collection (via the native driver) rather than through
 * the Mongoose model, because the model now casts `songs` to the new subdoc
 * shape — reading legacy docs through it would hide/garble the old form. Working
 * on raw documents lets us detect and rewrite the legacy shape faithfully.
 *
 * Runnable directly:  `node src/scripts/migratePlaylistSongsToPlayedKey.js`
 * Also exported (module.exports = main) and guarded by `require.main === module`
 * so requiring it for tests does NOT connect or run the migration.
 */

require('dotenv').config();

const mongoose = require('mongoose');

const connectDB = require('../config/db');
const Playlist = require('../models/Playlist');

// Decide whether a raw `songs` entry is already in the new { song, playedKey }
// shape. A legacy entry is a bare ObjectId (or a string/`_bsontype` value); a
// migrated entry is a plain object carrying a `song` field.
function isNewShapeEntry(entry) {
  return (
    entry !== null &&
    typeof entry === 'object' &&
    !(entry instanceof mongoose.Types.ObjectId) &&
    entry._bsontype !== 'ObjectID' &&
    Object.prototype.hasOwnProperty.call(entry, 'song')
  );
}

// Convert a single legacy entry (bare id) to the new shape. Already-new entries
// pass through unchanged (preserving any existing playedKey).
function toNewEntry(entry) {
  if (isNewShapeEntry(entry)) {
    return { song: entry.song, playedKey: entry.playedKey || '' };
  }
  return { song: entry, playedKey: '' };
}

/**
 * Run the migration against a live connection. Returns a summary.
 * @returns {Promise<{ scanned: number, migrated: number }>}
 */
async function runMigration() {
  const collection = Playlist.collection;
  const cursor = collection.find({});

  let scanned = 0;
  let migrated = 0;

  // eslint-disable-next-line no-await-in-loop
  for await (const doc of cursor) {
    scanned += 1;
    const songs = Array.isArray(doc.songs) ? doc.songs : [];

    // Already fully migrated? (every entry is the new shape) → skip.
    const needsMigration = songs.some((e) => !isNewShapeEntry(e));
    if (!needsMigration) continue;

    const converted = songs.map(toNewEntry);
    // eslint-disable-next-line no-await-in-loop
    await collection.updateOne({ _id: doc._id }, { $set: { songs: converted } });
    migrated += 1;
  }

  return { scanned, migrated };
}

async function main() {
  let failed = false;
  try {
    await connectDB();
    const summary = await runMigration();
    // eslint-disable-next-line no-console
    console.log(
      `migratePlaylistSongsToPlayedKey: done — scanned ${summary.scanned} playlist(s), ` +
        `migrated ${summary.migrated}.`
    );
    return summary;
  } catch (err) {
    failed = true;
    // eslint-disable-next-line no-console
    console.error(`migratePlaylistSongsToPlayedKey: FAILED — ${err.message}`);
    if (err.stack) console.error(err.stack);
    throw err;
  } finally {
    try {
      if (mongoose.connection && mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
      }
    } catch (disconnectErr) {
      // eslint-disable-next-line no-console
      console.error(
        `migratePlaylistSongsToPlayedKey: error while disconnecting — ${disconnectErr.message}`
      );
    }
    if (require.main === module) process.exit(failed ? 1 : 0);
  }
}

if (require.main === module) {
  main();
}

module.exports = main;
module.exports.runMigration = runMigration;
module.exports.isNewShapeEntry = isNewShapeEntry;
module.exports.toNewEntry = toNewEntry;
