const express = require('express');
const mongoose = require('mongoose');
const Song = require('../models/Song');
const Genre = require('../models/Genre');
const Chart = require('../models/Chart');
const authenticate = require('../middleware/authenticate');
const bandScope = require('../middleware/bandScope');
const { namesToNumbers } = require('../services/chartTranspose');
const { validateChartBody } = require('../services/chartGrammar');
const { isSupportedKey } = require('../services/chartSpelling');

const router = express.Router();

router.use(authenticate);
router.use(bandScope);

// GET /songs — list with optional filters
router.get('/', async (req, res, next) => {
  try {
    const { title, genre, tags } = req.query;
    const filter = { band: req.currentBand };

    if (title) {
      filter.title = { $regex: title, $options: 'i' };
    }

    if (genre) {
      filter.genre = genre;
    }

    if (tags) {
      const tagsArray = tags.split(',').map((t) => t.trim()).filter(Boolean);
      if (tagsArray.length > 0) {
        filter.tags = { $all: tagsArray };
      }
    }

    const songs = await Song.find(filter).populate('genre', '_id name slug');
    res.json(songs);
  } catch (err) {
    next(err);
  }
});

// POST /songs — create
router.post('/', async (req, res, next) => {
  try {
    const { title, artist, genre, tags, originalKey, performedKey } = req.body;

    if (!title) {
      const err = new Error('title is required');
      err.status = 422;
      err.code = 'VALIDATION_ERROR';
      err.fields = { title: 'required' };
      return next(err);
    }

    if (!artist) {
      const err = new Error('artist is required');
      err.status = 422;
      err.code = 'VALIDATION_ERROR';
      err.fields = { artist: 'required' };
      return next(err);
    }

    if (genre) {
      const genreDoc = await Genre.findOne({ _id: genre, band: req.currentBand });
      if (!genreDoc) {
        const err = new Error('Invalid genre');
        err.status = 422;
        err.code = 'VALIDATION_ERROR';
        err.fields = { genre: 'Invalid genre' };
        return next(err);
      }
    }

    const song = new Song({ band: req.currentBand, title, artist, genre: genre || null, tags, originalKey, performedKey });
    await song.save();
    await song.populate('genre', '_id name slug');

    res.status(201).json(song);
  } catch (err) {
    next(err);
  }
});

// GET /songs/:id
router.get('/:id', async (req, res, next) => {
  try {
    const song = await Song.findOne({ _id: req.params.id, band: req.currentBand }).populate('genre', '_id name slug');
    if (!song) {
      const err = new Error('Song not found');
      err.status = 404;
      err.code = 'NOT_FOUND';
      return next(err);
    }
    res.json(song);
  } catch (err) {
    next(err);
  }
});

// PATCH /songs/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const song = await Song.findOne({ _id: req.params.id, band: req.currentBand });
    if (!song) {
      const err = new Error('Song not found');
      err.status = 404;
      err.code = 'NOT_FOUND';
      return next(err);
    }

    const { title, artist, genre, tags, originalKey, performedKey } = req.body;

    if ('genre' in req.body && genre !== null && genre !== undefined) {
      const genreDoc = await Genre.findOne({ _id: genre, band: req.currentBand });
      if (!genreDoc) {
        const err = new Error('Invalid genre');
        err.status = 422;
        err.code = 'VALIDATION_ERROR';
        err.fields = { genre: 'Invalid genre' };
        return next(err);
      }
    }

    if (title !== undefined) song.title = title;
    if (artist !== undefined) song.artist = artist;
    if ('genre' in req.body) song.genre = genre || null;
    if (tags !== undefined) song.tags = tags;
    if (originalKey !== undefined) song.originalKey = originalKey;
    if (performedKey !== undefined) song.performedKey = performedKey;

    await song.save();
    await song.populate('genre', '_id name slug');

    res.json(song);
  } catch (err) {
    next(err);
  }
});

// DELETE /songs/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const song = await Song.findOne({ _id: req.params.id, band: req.currentBand });
    if (!song) {
      const err = new Error('Song not found');
      err.status = 404;
      err.code = 'NOT_FOUND';
      return next(err);
    }

    await song.deleteOne();
    res.json({ message: 'Song deleted' });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------------- *
 * Chart CRUD — nested under a song, scoped via its band (task 3.1).
 *
 * Every handler loads the song with `Song.findOne({ _id, band: req.currentBand })`
 * so a cross-band or absent song yields the song's own 404 (NOT_FOUND); this is
 * how chart access is authorized (R2 — band confinement). A chart has no `band`
 * field of its own; ownership is derived from the song.
 *
 * These `/:id/chart` paths are more specific than the `/:id` song paths above
 * and so are matched distinctly by Express (GET `/:id/chart` is NOT shadowed by
 * GET `/:id`). They are declared after the song routes for readability only.
 *
 * Status-code / behavior choices (the task left these to decide):
 *   - PUT returns 200 for BOTH create and replace (a single consistent code;
 *     the one-to-one upsert makes "created vs replaced" an internal detail).
 *   - DELETE is idempotent: 200 with a message whether or not a chart existed.
 *   - A missing/blank `enteredKey` means "Numbers" (store the body as-is).
 * ------------------------------------------------------------------------- */

// Load the current-band song for a chart request, or send the song's 404.
// Returns the song document, or null after having called next(err).
async function loadScopedSong(req, next) {
  const song = await Song.findOne({ _id: req.params.id, band: req.currentBand });
  if (!song) {
    const err = new Error('Song not found');
    err.status = 404;
    err.code = 'NOT_FOUND';
    next(err);
    return null;
  }
  return song;
}

// Serialize a Chart document to the stored-chart response shape: the canonical
// numbers `body` plus its metadata.
function serializeChart(chart) {
  return {
    song: chart.song,
    body: chart.body,
    title: chart.title,
    artistLabel: chart.artistLabel,
    formatting: chart.formatting,
    createdAt: chart.createdAt,
    updatedAt: chart.updatedAt,
  };
}

// GET /songs/:id/chart — stored canonical chart, or 404 CHART_NOT_FOUND.
router.get('/:id/chart', async (req, res, next) => {
  try {
    const song = await loadScopedSong(req, next);
    if (!song) return;

    const chart = await Chart.findOne({ song: song._id });
    if (!chart) {
      const err = new Error('This song has no chart');
      err.status = 404;
      err.code = 'CHART_NOT_FOUND';
      return next(err);
    }

    res.json(serializeChart(chart));
  } catch (err) {
    next(err);
  }
});

// PUT /songs/:id/chart — create or replace the song's chart.
// Body: { enteredKey, body, title?, artistLabel?, formatting? }.
router.put('/:id/chart', async (req, res, next) => {
  try {
    const song = await loadScopedSong(req, next);
    if (!song) return;

    const { enteredKey, body, title, artistLabel, formatting } = req.body;

    if (typeof body !== 'string') {
      const err = new Error('body is required and must be a string');
      err.status = 422;
      err.code = 'CHART_INVALID';
      err.fields = { body: 'required' };
      return next(err);
    }

    // Validate the submitted body against the ChordPro-like grammar. This runs
    // for both numbers and names input (names tokens still parse as chords).
    const { valid, fields } = validateChartBody(body);
    if (!valid) {
      const err = new Error('Chart body is invalid');
      err.status = 422;
      err.code = 'CHART_INVALID';
      err.fields = fields;
      return next(err);
    }

    // Determine whether the body is already numbers or needs names->numbers.
    // A missing/blank enteredKey, or the literal 'Numbers', means numbers mode.
    const entered = typeof enteredKey === 'string' ? enteredKey.trim() : '';
    const isNumbersMode = entered === '' || entered === 'Numbers';

    let numbersBody;
    if (isNumbersMode) {
      // Already numbers (and already grammar-validated): store as-is.
      numbersBody = body;
    } else {
      // enteredKey names a key: it must be a supported major key.
      if (!isSupportedKey(entered)) {
        const err = new Error(
          `Unsupported or invalid key "${entered}". Supply a supported major key or "Numbers".`
        );
        err.status = 422;
        err.code = 'KEY_INVALID';
        err.fields = { enteredKey: 'unsupported or invalid key' };
        return next(err);
      }

      // Convert names -> canonical numbers. A conversion failure (e.g. a token
      // in the wrong representation) is a 422 against the body/key.
      try {
        numbersBody = namesToNumbers(body, entered);
      } catch (convErr) {
        const err = new Error(convErr.message || 'Could not convert chart to numbers');
        err.status = 422;
        err.code = 'KEY_INVALID';
        err.fields = { body: convErr.message || 'conversion failed' };
        return next(err);
      }
    }

    // Build the fields to persist. Upsert on `song` so a repeat PUT replaces
    // the existing chart, preserving the 1:1 (R7.4). Only set metadata that was
    // provided so an omitted field falls back to the schema default on insert.
    const update = { song: song._id, body: numbersBody };
    if (title !== undefined) update.title = title;
    if (artistLabel !== undefined) update.artistLabel = artistLabel;
    if (formatting !== undefined) update.formatting = formatting;

    const chart = await Chart.findOneAndUpdate(
      { song: song._id },
      { $set: update },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    );

    // 200 for both create and replace (documented choice above).
    res.json(serializeChart(chart));
  } catch (err) {
    next(err);
  }
});

// DELETE /songs/:id/chart — remove the song's chart (idempotent, 200).
router.delete('/:id/chart', async (req, res, next) => {
  try {
    const song = await loadScopedSong(req, next);
    if (!song) return;

    await Chart.deleteOne({ song: song._id });
    res.json({ message: 'Chart deleted' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
