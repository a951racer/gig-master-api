'use strict';

const Chart = require('../models/Chart');

/**
 * Chart presence helper.
 *
 * Answers "which of these songs have a chart?" with a single query, so list
 * endpoints can stamp a lightweight `hasChart` boolean onto each song without
 * an N+1 lookup or a schema change (charts live in their own collection, 1:1
 * per song via Chart.song).
 */

/**
 * Given a list of song ids, return a Set (of string ids) for those that have a
 * stored chart. One `$in` query over the Chart collection.
 *
 * @param {Array<string|import('mongoose').Types.ObjectId>} songIds
 * @returns {Promise<Set<string>>} set of charted song ids (as strings)
 */
async function chartedSongIdSet(songIds) {
  const ids = (songIds || []).filter(Boolean);
  if (ids.length === 0) return new Set();
  const charts = await Chart.find({ song: { $in: ids } }).select('song').lean();
  return new Set(charts.map((c) => String(c.song)));
}

module.exports = { chartedSongIdSet };
