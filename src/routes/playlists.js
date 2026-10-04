const express = require('express');
const Playlist = require('../models/Playlist');
const Song = require('../models/Song');
const Chart = require('../models/Chart');
const authenticate = require('../middleware/authenticate');
const bandScope = require('../middleware/bandScope');
const { numbersToNames, renderModel } = require('../services/chartTranspose');
const { isSupportedKey } = require('../services/chartSpelling');
const { paginate } = require('../services/chartLayout');

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

// Validate a playedKey value: it must be empty ('' / unset = no played key) or
// one of the 12 supported MAJOR keys. "Numbers" is a display mode, not a key,
// so it is NOT accepted here. Returns the normalized value ('' or the key), or
// throws a 422 KEY_INVALID-style error for the caller to forward.
function normalizePlayedKey(value, field = 'playedKey') {
  if (value === undefined || value === null || value === '') return '';
  const v = String(value).trim();
  if (v === '') return '';
  if (!isSupportedKey(v)) {
    const err = new Error(
      `Invalid playedKey "${v}". Supply one of the 12 supported major keys, or leave it empty.`
    );
    err.status = 422;
    err.code = 'KEY_INVALID';
    err.fields = { [field]: 'unsupported or invalid key' };
    throw err;
  }
  return v;
}

// Normalize a single `songs` input entry into { song, playedKey }. Each entry
// may be a bare song id (string) or an object { song, playedKey }. We treat it
// as the object form only when it's a plain object carrying a `song` key;
// anything else is taken as a bare id. Throws 422 on a malformed entry or an
// invalid playedKey.
function isObjectEntry(entry) {
  return (
    entry !== null &&
    typeof entry === 'object' &&
    !Array.isArray(entry) &&
    Object.prototype.hasOwnProperty.call(entry, 'song')
  );
}

function normalizeSongEntry(entry) {
  if (isObjectEntry(entry)) {
    const songId = entry.song;
    if (songId === undefined || songId === null || songId === '') {
      const err = new Error('Each song entry must have a song id');
      err.status = 422;
      err.code = 'VALIDATION_ERROR';
      err.fields = { songs: 'entry missing song id' };
      throw err;
    }
    return { song: songId, playedKey: normalizePlayedKey(entry.playedKey) };
  }
  // Bare id form.
  return { song: entry, playedKey: '' };
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

    let songEntries = [];
    if (songs !== undefined) {
      if (!Array.isArray(songs)) {
        const err = new Error('songs must be an array of song ids or { song, playedKey } objects');
        err.status = 422;
        err.code = 'VALIDATION_ERROR';
        err.fields = { songs: 'must be an array' };
        return next(err);
      }

      // Normalize each entry (id OR { song, playedKey }) and validate playedKey.
      let normalized;
      try {
        normalized = songs.map(normalizeSongEntry);
      } catch (e) {
        return next(e);
      }

      // Dedupe by song id, preserving first-seen order (keeps that entry's key).
      const seen = new Set();
      const ordered = [];
      for (const entry of normalized) {
        const key = String(entry.song);
        if (!seen.has(key)) {
          seen.add(key);
          ordered.push(entry);
        }
      }

      if (ordered.length > 0) {
        // Every song must belong to the current band.
        const ids = ordered.map((e) => e.song);
        const found = await Song.find(
          { _id: { $in: ids }, band: req.currentBand },
          { _id: 1 }
        );
        const foundSet = new Set(found.map((d) => d._id.toString()));
        const invalid = ordered.filter((e) => !foundSet.has(String(e.song)));
        if (invalid.length > 0) {
          const err = new Error('One or more songs do not belong to the current band');
          err.status = 422;
          err.code = 'VALIDATION_ERROR';
          err.fields = { songs: 'contains unknown or out-of-band song ids' };
          return next(err);
        }
      }

      songEntries = ordered;
    }

    const playlist = new Playlist({ band: req.currentBand, name, description, songs: songEntries });
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
      path: 'songs.song',
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
    // Whether the caller explicitly asked for a key. When they did NOT, each
    // song falls back to its own `playedKey` for THIS playlist (if set),
    // otherwise Numbers.
    const keyExplicit = requested !== '';

    // Apply the size cap, preserving playlist order. Entries are now
    // { song, playedKey } subdocuments.
    const truncated = playlist.songs.length > MAX_BATCH;
    const entries = playlist.songs.slice(0, MAX_BATCH);
    const songIds = entries.map((e) => e.song);

    // Load the songs (band-scoped) and their charts, then assemble in playlist
    // order. Both lookups are keyed by id so we can map back to the order.
    const [songs, charts] = await Promise.all([
      Song.find({ _id: { $in: songIds }, band: req.currentBand }),
      Chart.find({ song: { $in: songIds } }),
    ]);
    const songById = new Map(songs.map((s) => [s._id.toString(), s]));
    const chartBySong = new Map(charts.map((c) => [c.song.toString(), c]));

    const result = entries.map((entry) => {
      const key = String(entry.song);
      const song = songById.get(key);
      const chartDoc = chartBySong.get(key);

      // Resolve the render key for THIS song: an explicit request key wins;
      // otherwise use the song's playedKey for this playlist; otherwise Numbers.
      let songKey; // '' or 'Numbers' => numbers; else a supported major key
      if (keyExplicit) {
        songKey = requested;
      } else if (entry.playedKey && isSupportedKey(entry.playedKey)) {
        songKey = entry.playedKey;
      } else {
        songKey = '';
      }
      const songIsNumbers = songKey === '' || songKey === 'Numbers';
      const songKeyLabel = songIsNumbers ? 'Numbers' : songKey;

      let chart = null;
      if (chartDoc) {
        const rendered = songIsNumbers
          ? renderModel(chartDoc.body)
          : renderModel(numbersToNames(chartDoc.body, songKey, { lenient: true }));
        const { pages } = paginate(rendered, { formatting: chartDoc.formatting });
        chart = {
          // Title/artist are song properties, not chart-overridable.
          title: song ? song.title : '',
          artist: song ? song.artist : '',
          keyLabel: songKeyLabel,
          playedKey: entry.playedKey || '',
          formatting: chartDoc.formatting,
          sections: rendered.sections,
          pages,
        };
      }

      return {
        songId: key,
        title: song ? song.title : '',
        playedKey: entry.playedKey || '',
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

    let playedKey;
    try {
      playedKey = normalizePlayedKey(req.body.playedKey);
    } catch (e) {
      return next(e);
    }

    // Keep at most one entry per song (idempotent add); update its key if the
    // song is already present rather than duplicating it.
    const existing = playlist.songs.find((e) => String(e.song) === String(songId));
    if (existing) {
      existing.playedKey = playedKey;
    } else {
      playlist.songs.push({ song: songId, playedKey });
    }
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

    const before = playlist.songs.length;
    playlist.songs = playlist.songs.filter((e) => String(e.song) !== String(req.params.songId));
    if (playlist.songs.length === before) {
      const err = new Error('Song not in playlist');
      err.status = 404;
      err.code = 'NOT_FOUND';
      return next(err);
    }
    await playlist.save();
    res.json({ message: 'Song removed from playlist' });
  } catch (err) {
    next(err);
  }
});

// PATCH /playlists/:id/songs/:songId — set/update a song's Played Key for THIS
// playlist. Body: { playedKey } where playedKey is one of the 12 supported
// major keys or '' to clear it ("Numbers" is not accepted — it's a display
// mode, not a key).
router.patch('/:id/songs/:songId', async (req, res, next) => {
  try {
    const playlist = await Playlist.findOne({ _id: req.params.id, band: req.currentBand });
    if (!playlist) {
      const err = new Error('Playlist not found');
      err.status = 404;
      err.code = 'NOT_FOUND';
      return next(err);
    }

    const entry = playlist.songs.find((e) => String(e.song) === String(req.params.songId));
    if (!entry) {
      const err = new Error('Song not in playlist');
      err.status = 404;
      err.code = 'NOT_FOUND';
      return next(err);
    }

    let playedKey;
    try {
      playedKey = normalizePlayedKey(req.body.playedKey);
    } catch (e) {
      return next(e);
    }

    entry.playedKey = playedKey;
    await playlist.save();
    res.json(playlist);
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

    // The reorder payload is the full ordered list of song ids (bare ids). It
    // must be a permutation of the current set; we reorder the existing
    // subdocument entries so each song keeps its playedKey.
    const { songs } = req.body;
    const submitted = (songs || []).map((id) => String(id));
    const currentById = new Map(playlist.songs.map((e) => [String(e.song), e]));

    const sameSize = submitted.length === playlist.songs.length;
    const sameSet = sameSize && [...submitted].sort().join(',') === [...currentById.keys()].sort().join(',');
    if (!sameSet) {
      const err = new Error('Song list does not match current playlist songs');
      err.status = 422;
      err.code = 'SONGS_MISMATCH';
      return next(err);
    }

    playlist.songs = submitted.map((id) => currentById.get(id));
    await playlist.save();
    res.json(playlist);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
