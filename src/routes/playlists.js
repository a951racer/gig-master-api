const express = require('express');
const Playlist = require('../models/Playlist');
const Song = require('../models/Song');
const Chart = require('../models/Chart');
const authenticate = require('../middleware/authenticate');
const bandScope = require('../middleware/bandScope');
const { numbersToNames, renderModel } = require('../services/chartTranspose');
const { isSupportedKey } = require('../services/chartSpelling');

const router = express.Router();

// Size cap for the playlist batch chart endpoint (R10.5). We process at most
// this many songs from the playlist (in order) in a single request and signal
// via a top-level `truncated` flag when the playlist held more. This keeps the
// endpoint simple and bounded now; true pagination is a documented follow-up
// (design.md — "Playlist batch (R10)"). Chosen generously since real set lists
// are well under 100 songs.
const MAX_BATCH = 100;

// A MongoDB duplicate-key error (E11000) on the { band, name } unique index
// means a playlist with this name already exists in the band. Surface it as a
// 409 with a user-friendly message rather than a 500.
function isDuplicateNameError(err) {
  return err && (err.code === 11000 || err.code === 11001);
}

function duplicateNameError() {
  const err = new Error('A playlist with that name already exists in this band');
  err.status = 409;
  err.code = 'DUPLICATE_NAME';
  return err;
}

router.use(authenticate);
router.use(bandScope);

// GET /playlists — all playlists with song count (no full song docs)
router.get('/', async (req, res, next) => {
  try {
    const playlists = await Playlist.find({ band: req.currentBand }).lean();
    const result = playlists.map((p) => ({ ...p, songCount: p.songs.length }));
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /playlists — create. Optionally accepts `songs` (an ordered array of
// song ids) so a playlist can be created pre-populated — e.g. copying an
// existing playlist in one atomic request. Each song id is validated to belong
// to the current band; duplicates are removed while order is preserved. Unknown
// or out-of-band ids are rejected (422) so a copy can't smuggle in other bands'
// songs.
router.post('/', async (req, res, next) => {
  try {
    const { name, description, songs } = req.body;

    if (!name) {
      const err = new Error('name is required');
      err.status = 422;
      err.code = 'VALIDATION_ERROR';
      err.fields = { name: 'required' };
      return next(err);
    }

    let songIds = [];
    if (songs !== undefined) {
      if (!Array.isArray(songs)) {
        const err = new Error('songs must be an array of song ids');
        err.status = 422;
        err.code = 'VALIDATION_ERROR';
        err.fields = { songs: 'must be an array' };
        return next(err);
      }

      // Dedupe while preserving the first-seen order.
      const seen = new Set();
      const ordered = [];
      for (const id of songs) {
        const key = String(id);
        if (!seen.has(key)) {
          seen.add(key);
          ordered.push(id);
        }
      }

      if (ordered.length > 0) {
        // Every song must belong to the current band.
        const found = await Song.find(
          { _id: { $in: ordered }, band: req.currentBand },
          { _id: 1 }
        );
        const foundSet = new Set(found.map((d) => d._id.toString()));
        const invalid = ordered.filter((id) => !foundSet.has(String(id)));
        if (invalid.length > 0) {
          const err = new Error('One or more songs do not belong to the current band');
          err.status = 422;
          err.code = 'VALIDATION_ERROR';
          err.fields = { songs: 'contains unknown or out-of-band song ids' };
          return next(err);
        }
      }

      songIds = ordered;
    }

    const playlist = new Playlist({ band: req.currentBand, name, description, songs: songIds });
    try {
      await playlist.save();
    } catch (err) {
      if (isDuplicateNameError(err)) return next(duplicateNameError());
      throw err;
    }
    res.status(201).json(playlist);
  } catch (err) {
    next(err);
  }
});

// GET /playlists/:id — with songs fully populated (including genre)
router.get('/:id', async (req, res, next) => {
  try {
    const playlist = await Playlist.findOne({ _id: req.params.id, band: req.currentBand }).populate({
      path: 'songs',
      populate: { path: 'genre', select: '_id name slug' },
    });
    if (!playlist) {
      const err = new Error('Playlist not found');
      err.status = 404;
      err.code = 'NOT_FOUND';
      return next(err);
    }
    res.json(playlist);
  } catch (err) {
    next(err);
  }
});

// GET /playlists/:id/charts?key=<Numbers|KEY> — batch chart retrieval for a
// playlist (R10). Returns the Render_Representation of each song's chart, in
// playlist order, so a client (e.g. the future mobile app) can render a whole
// set in one request.
//
// Response shape (a wrapping object, chosen over a bare array so metadata like
// the size-cap flag has somewhere to live and the contract can grow):
//   {
//     playlistId: <id>,
//     charts: [ { songId, title, chart: Render_Representation | null }, ... ],
//     truncated: <boolean>
//   }
// where `chart` is the same shape as GET /songs/:id/chart/view
// ({ title, artistLabel, keyLabel, formatting, sections }), or null when the
// song has no chart (R10.3 — explicitly flagged, not failing the request).
//
// The `key` param is validated ONCE up front (R10.2): omitted/'Numbers' renders
// stored numbers; any other value must be a supported major key, else a single
// 422 KEY_INVALID (rather than a per-song error). Band-scoped via the playlist
// (R10.4): an absent/cross-band playlist yields the playlist's 404.
//
// Size cap (R10.5): at most MAX_BATCH songs are processed; `truncated` is true
// when the playlist held more. Pagination is a documented follow-up.
router.get('/:id/charts', async (req, res, next) => {
  try {
    const playlist = await Playlist.findOne({ _id: req.params.id, band: req.currentBand });
    if (!playlist) {
      const err = new Error('Playlist not found');
      err.status = 404;
      err.code = 'NOT_FOUND';
      return next(err);
    }

    // Resolve + validate the requested display representation ONCE. A
    // missing/blank `key`, or the literal 'Numbers', renders stored numbers;
    // any other value is a target key and must be supported.
    const requested = typeof req.query.key === 'string' ? req.query.key.trim() : '';
    const isNumbers = requested === '' || requested === 'Numbers';
    if (!isNumbers && !isSupportedKey(requested)) {
      const err = new Error(
        `Unsupported or invalid key "${requested}". Supply a supported major key or "Numbers".`
      );
      err.status = 422;
      err.code = 'KEY_INVALID';
      err.fields = { key: 'unsupported or invalid key' };
      return next(err);
    }
    const keyLabel = isNumbers ? 'Numbers' : requested;

    // Apply the size cap, preserving playlist order.
    const truncated = playlist.songs.length > MAX_BATCH;
    const songIds = playlist.songs.slice(0, MAX_BATCH);

    // Load the songs (band-scoped) and their charts, then assemble in playlist
    // order. Both lookups are keyed by id so we can map back to the order.
    const [songs, charts] = await Promise.all([
      Song.find({ _id: { $in: songIds }, band: req.currentBand }),
      Chart.find({ song: { $in: songIds } }),
    ]);
    const songById = new Map(songs.map((s) => [s._id.toString(), s]));
    const chartBySong = new Map(charts.map((c) => [c.song.toString(), c]));

    const result = songIds.map((songId) => {
      const key = songId.toString();
      const song = songById.get(key);
      const chartDoc = chartBySong.get(key);

      let chart = null;
      if (chartDoc) {
        const rendered = isNumbers
          ? renderModel(chartDoc.body)
          : renderModel(numbersToNames(chartDoc.body, requested));
        chart = {
          title: chartDoc.title,
          artistLabel: chartDoc.artistLabel,
          keyLabel,
          formatting: chartDoc.formatting,
          sections: rendered.sections,
        };
      }

      return {
        songId: key,
        title: song ? song.title : '',
        chart,
      };
    });

    res.json({ playlistId: playlist._id, charts: result, truncated });
  } catch (err) {
    next(err);
  }
});

// PATCH /playlists/:id — update metadata (songs NOT populated)
router.patch('/:id', async (req, res, next) => {
  try {
    const playlist = await Playlist.findOne({ _id: req.params.id, band: req.currentBand });
    if (!playlist) {
      const err = new Error('Playlist not found');
      err.status = 404;
      err.code = 'NOT_FOUND';
      return next(err);
    }

    const { name, description } = req.body;
    if (name !== undefined) playlist.name = name;
    if (description !== undefined) playlist.description = description;

    try {
      await playlist.save();
    } catch (err) {
      if (isDuplicateNameError(err)) return next(duplicateNameError());
      throw err;
    }
    res.json(playlist);
  } catch (err) {
    next(err);
  }
});

// DELETE /playlists/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const playlist = await Playlist.findOne({ _id: req.params.id, band: req.currentBand });
    if (!playlist) {
      const err = new Error('Playlist not found');
      err.status = 404;
      err.code = 'NOT_FOUND';
      return next(err);
    }

    await playlist.deleteOne();
    res.json({ message: 'Playlist deleted' });
  } catch (err) {
    next(err);
  }
});

// POST /playlists/:id/songs — add a song
router.post('/:id/songs', async (req, res, next) => {
  try {
    const playlist = await Playlist.findOne({ _id: req.params.id, band: req.currentBand });
    if (!playlist) {
      const err = new Error('Playlist not found');
      err.status = 404;
      err.code = 'NOT_FOUND';
      return next(err);
    }

    const { songId } = req.body;
    const song = await Song.findOne({ _id: songId, band: req.currentBand });
    if (!song) {
      const err = new Error('Song not found');
      err.status = 404;
      err.code = 'NOT_FOUND';
      return next(err);
    }

    playlist.songs.push(songId);
    await playlist.save();
    res.json(playlist);
  } catch (err) {
    next(err);
  }
});

// DELETE /playlists/:id/songs/:songId — remove a song
router.delete('/:id/songs/:songId', async (req, res, next) => {
  try {
    const playlist = await Playlist.findOne({ _id: req.params.id, band: req.currentBand });
    if (!playlist) {
      const err = new Error('Playlist not found');
      err.status = 404;
      err.code = 'NOT_FOUND';
      return next(err);
    }

    playlist.songs.pull(req.params.songId);
    await playlist.save();
    res.json({ message: 'Song removed from playlist' });
  } catch (err) {
    next(err);
  }
});

// PUT /playlists/:id/songs — reorder (full replacement, must match current set)
router.put('/:id/songs', async (req, res, next) => {
  try {
    const playlist = await Playlist.findOne({ _id: req.params.id, band: req.currentBand });
    if (!playlist) {
      const err = new Error('Playlist not found');
      err.status = 404;
      err.code = 'NOT_FOUND';
      return next(err);
    }

    const { songs } = req.body;
    const currentIds = playlist.songs.map((id) => id.toString()).sort();
    const submittedIds = (songs || []).map((id) => id.toString()).sort();

    if (
      currentIds.length !== submittedIds.length ||
      currentIds.some((id, i) => id !== submittedIds[i])
    ) {
      const err = new Error('Song list does not match current playlist songs');
      err.status = 422;
      err.code = 'SONGS_MISMATCH';
      return next(err);
    }

    playlist.songs = songs;
    await playlist.save();
    res.json(playlist);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
