const express = require('express');
const Playlist = require('../models/Playlist');
const Song = require('../models/Song');
const authenticate = require('../middleware/authenticate');
const bandScope = require('../middleware/bandScope');

const router = express.Router();

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
