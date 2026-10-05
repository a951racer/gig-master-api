const express = require('express');
const mongoose = require('mongoose');
const PDFDocument = require('pdfkit');
const Song = require('../models/Song');
const Genre = require('../models/Genre');
const Chart = require('../models/Chart');
const authenticate = require('../middleware/authenticate');
const bandScope = require('../middleware/bandScope');
const { namesToNumbers, numbersToNames, renderModel } = require('../services/chartTranspose');
const { isSupportedKey } = require('../services/chartSpelling');
const { paginate } = require('../services/chartLayout');
// PDF layout lives in a shared service (issue #77) so the single-chart route
// here and the playlist combined/zip routes draw identical pages.
const { layoutChartPdf, sanitizePdfFilename } = require('../services/chartPdf');

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
    const { title, artist, genre, tags, originalKey } = req.body;

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

    const song = new Song({ band: req.currentBand, title, artist, genre: genre || null, tags, originalKey });
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

    const { title, artist, genre, tags, originalKey } = req.body;

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

    // Cascade: a chart is owned by its song (R1.6), so remove it when the song
    // is removed. Independent collections, so either order is fine.
    await song.deleteOne();
    await Chart.deleteOne({ song: song._id });
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
// numbers `body` plus its presentation formatting. Title/artist are NOT part
// of the chart — they belong to the Song and are added by the render paths.
function serializeChart(chart) {
  return {
    song: chart.song,
    body: chart.body,
    formatting: chart.formatting,
    createdAt: chart.createdAt,
    updatedAt: chart.updatedAt,
  };
}

// Build the full Render_Representation for a chart body in a chosen key,
// deriving the display title/artist from the SONG (R: title/artist are song
// properties, not chart-overridable). Returns both the flat `sections` (for
// simple consumers / back-compat) and the paginated `pages` (virtual
// 8.5x11 layout honoring formatting.columns + COLUMN_BREAK/PAGE_BREAK), so the
// web viewer and PDF render identical breaks.
function buildRepresentation(song, chart, numbersOrNamesBody, keyLabel, bandName) {
  const rendered = renderModel(numbersOrNamesBody);
  const formatting = chart.formatting;
  const { pages } = paginate(rendered, { formatting });
  return {
    title: song.title,
    artist: song.artist,
    bandName: bandName || '',
    keyLabel,
    formatting,
    sections: rendered.sections,
    pages,
  };
}

// Resolve the `key` query param to a { body, keyLabel } pair, or signal a
// 422 KEY_INVALID via next(err) and return null. '' / 'Numbers' => stored
// numbers; a supported major key => numbers->names in that key.
function resolveKeyedBody(chart, req, next, field = 'key') {
  const requested = typeof req.query.key === 'string' ? req.query.key.trim() : '';
  const isNumbers = requested === '' || requested === 'Numbers';
  if (isNumbers) {
    return { body: chart.body, keyLabel: 'Numbers' };
  }
  if (!isSupportedKey(requested)) {
    const err = new Error(
      `Unsupported or invalid key "${requested}". Supply a supported major key or "Numbers".`
    );
    err.status = 422;
    err.code = 'KEY_INVALID';
    err.fields = { [field]: 'unsupported or invalid key' };
    next(err);
    return null;
  }
  // Lenient: an unparseable stored token (shouldn't normally happen, but a
  // lenient save can persist one) is left verbatim rather than failing the view.
  return { body: numbersToNames(chart.body, requested, { lenient: true }), keyLabel: requested };
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

    // Include the song-derived title/artist so the editor can display them
    // (read-only) without a second request.
    res.json({ ...serializeChart(chart), title: song.title, artist: song.artist });
  } catch (err) {
    next(err);
  }
});

// GET /songs/:id/chart/view — render the chart in a chosen representation.
// Query `key`: omitted or 'Numbers' renders the stored numbers body as-is; a
// key value transposes numbers -> names in that key. Returns the
// Render_Representation (title/artist from the SONG, keyLabel, formatting,
// flat `sections`, and paginated `pages`).
router.get('/:id/chart/view', async (req, res, next) => {
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

    const keyed = resolveKeyedBody(chart, req, next);
    if (!keyed) return;

    res.json(buildRepresentation(song, chart, keyed.body, keyed.keyLabel, req.currentBandName));
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------------- *
 * PDF generation (R9)
 *
 * GET /songs/:id/chart/pdf?key=<Numbers|KEY> consumes the SAME paginated
 * layout as GET /:id/chart/view (via chartLayout.paginate) and draws it with
 * pdfkit on US-Letter pages so the PDF matches the web viewer page-for-page.
 * The layout itself (header/footer/body drawing + font registration) lives in
 * the shared ../services/chartPdf service (layoutChartPdf), reused by the
 * playlist combined/zip PDF routes. This route owns only the PDFDocument
 * (creation, margins, piping) and streams `application/pdf`.
 * ------------------------------------------------------------------------- */

// GET /songs/:id/chart/pdf — render the chart to a downloadable PDF.
router.get('/:id/chart/pdf', async (req, res, next) => {
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

    const keyed = resolveKeyedBody(chart, req, next);
    if (!keyed) return;

    const representation = buildRepresentation(song, chart, keyed.body, keyed.keyLabel, req.currentBandName);

    const filename = sanitizePdfFilename(song.title);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // We position every element manually and handle our own pagination via the
    // representation's `pages` array. pdfkit auto-adds a page whenever a text
    // draw lands below the bottom margin — which the band-name footer (near the
    // page bottom) was tripping, pushing all content onto a phantom page 2. Set
    // the bottom margin to 0 so our near-bottom footer stays inside the content
    // box and never triggers an automatic page break. (top/left/right keep 48.)
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: 48, left: 48, right: 48, bottom: 0 },
      autoFirstPage: true,
    });
    doc.on('error', (streamErr) => {
      if (!res.headersSent) next(streamErr); else res.destroy(streamErr);
    });
    doc.pipe(res);
    layoutChartPdf(doc, representation);
    doc.end();
  } catch (err) {
    next(err);
  }
});

// POST /songs/:id/chart/view — render an UN-PERSISTED working body for the
// editor's live preview. Title/artist are taken from the SONG (not the
// request). Body: { body, enteredKey, displayedKey, formatting? }.
router.post('/:id/chart/view', async (req, res, next) => {
  try {
    const song = await loadScopedSong(req, next);
    if (!song) return;

    const { body, enteredKey, displayedKey, formatting } = req.body;

    if (typeof body !== 'string') {
      const err = new Error('body is required and must be a string');
      err.status = 422;
      err.code = 'CHART_INVALID';
      err.fields = { body: 'required' };
      return next(err);
    }

    // The preview is intentionally LENIENT (R: render the valid parts, show the
    // unparseable bits verbatim). We do NOT reject the whole body on a bad chord
    // token — only an unsupported KEY is a real error, since without a valid key
    // we don't know how to interpret/spell the names. Each conversion runs in
    // lenient mode so a malformed [token] is left exactly as typed while the
    // chords around it convert normally.
    const entered = typeof enteredKey === 'string' ? enteredKey.trim() : '';
    const isNumbersMode = entered === '' || entered === 'Numbers';
    let numbersBody;
    if (isNumbersMode) {
      numbersBody = body;
    } else {
      if (!isSupportedKey(entered)) {
        const err = new Error(
          `Unsupported or invalid key "${entered}". Supply a supported major key or "Numbers".`
        );
        err.status = 422;
        err.code = 'KEY_INVALID';
        err.fields = { enteredKey: 'unsupported or invalid key' };
        return next(err);
      }
      numbersBody = namesToNumbers(body, entered, { lenient: true });
    }

    // Render per displayedKey (also lenient).
    const displayed = typeof displayedKey === 'string' ? displayedKey.trim() : '';
    const isDisplayNumbers = displayed === '' || displayed === 'Numbers';
    let displayBody;
    let keyLabel;
    if (isDisplayNumbers) {
      displayBody = numbersBody;
      keyLabel = 'Numbers';
    } else {
      if (!isSupportedKey(displayed)) {
        const err = new Error(
          `Unsupported or invalid key "${displayed}". Supply a supported major key or "Numbers".`
        );
        err.status = 422;
        err.code = 'KEY_INVALID';
        err.fields = { displayedKey: 'unsupported or invalid key' };
        return next(err);
      }
      displayBody = numbersToNames(numbersBody, displayed, { lenient: true });
      keyLabel = displayed;
    }

    const defaultFormatting = { font: 'monospace', size: 11, chordColor: 'blue', columns: 1 };
    const fmt = formatting !== undefined ? formatting : defaultFormatting;
    const rendered = renderModel(displayBody);
    const { pages } = paginate(rendered, { formatting: fmt });

    res.json({
      title: song.title,
      artist: song.artist,
      bandName: req.currentBandName || '',
      keyLabel,
      formatting: fmt,
      sections: rendered.sections,
      pages,
    });
  } catch (err) {
    next(err);
  }
});

// PUT /songs/:id/chart — create or replace the song's chart.
// Body: { enteredKey, body, formatting? }. Title/artist are NOT accepted —
// they belong to the Song.
router.put('/:id/chart', async (req, res, next) => {
  try {
    const song = await loadScopedSong(req, next);
    if (!song) return;

    const { enteredKey, body, formatting } = req.body;

    if (typeof body !== 'string') {
      const err = new Error('body is required and must be a string');
      err.status = 422;
      err.code = 'CHART_INVALID';
      err.fields = { body: 'required' };
      return next(err);
    }

    // Saving is LENIENT and consistent with the preview: we never refuse to
    // save a chart because of a bad chord token. An unsupported KEY is still a
    // real error (we can't interpret names without one), but a malformed
    // [token] is left verbatim in the stored body so a work-in-progress always
    // saves and the author can fix the token later.
    const entered = typeof enteredKey === 'string' ? enteredKey.trim() : '';
    const isNumbersMode = entered === '' || entered === 'Numbers';
    let numbersBody;
    if (isNumbersMode) {
      numbersBody = body;
    } else {
      if (!isSupportedKey(entered)) {
        const err = new Error(
          `Unsupported or invalid key "${entered}". Supply a supported major key or "Numbers".`
        );
        err.status = 422;
        err.code = 'KEY_INVALID';
        err.fields = { enteredKey: 'unsupported or invalid key' };
        return next(err);
      }
      numbersBody = namesToNumbers(body, entered, { lenient: true });
    }

    const update = { song: song._id, body: numbersBody };
    if (formatting !== undefined) update.formatting = formatting;

    const chart = await Chart.findOneAndUpdate(
      { song: song._id },
      { $set: update },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    );

    res.json({ ...serializeChart(chart), title: song.title, artist: song.artist });
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
