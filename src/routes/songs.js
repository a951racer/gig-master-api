const express = require('express');
const mongoose = require('mongoose');
const PDFDocument = require('pdfkit');
const Song = require('../models/Song');
const Genre = require('../models/Genre');
const Chart = require('../models/Chart');
const authenticate = require('../middleware/authenticate');
const bandScope = require('../middleware/bandScope');
const { namesToNumbers, numbersToNames, renderModel } = require('../services/chartTranspose');
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

// GET /songs/:id/chart/view — render the chart in a chosen representation.
// Query `key`: omitted or 'Numbers' renders the stored numbers body as-is;
// a key value transposes numbers -> names in that key. Returns the
// Render_Representation (title/artistLabel/keyLabel/formatting/sections).
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

    // Resolve the requested display representation. A missing/blank `key`, or
    // the literal 'Numbers', renders the stored numbers body directly; any
    // other value is a target key and must be a supported major key.
    const requested = typeof req.query.key === 'string' ? req.query.key.trim() : '';
    const isNumbers = requested === '' || requested === 'Numbers';

    let rendered;
    let keyLabel;
    if (isNumbers) {
      rendered = renderModel(chart.body);
      keyLabel = 'Numbers';
    } else {
      if (!isSupportedKey(requested)) {
        const err = new Error(
          `Unsupported or invalid key "${requested}". Supply a supported major key or "Numbers".`
        );
        err.status = 422;
        err.code = 'KEY_INVALID';
        err.fields = { key: 'unsupported or invalid key' };
        return next(err);
      }
      rendered = renderModel(numbersToNames(chart.body, requested));
      keyLabel = requested;
    }

    // Wrap the rendered { sections } with the metadata the viewer needs,
    // matching the Render_Representation shape in design.md.
    res.json({
      title: chart.title,
      artistLabel: chart.artistLabel,
      keyLabel,
      formatting: chart.formatting,
      sections: rendered.sections,
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------------- *
 * PDF generation (task 5.1, R9)
 *
 * GET /songs/:id/chart/pdf?key=<Numbers|KEY> builds the SAME
 * Render_Representation as GET /:id/chart/view (reusing renderModel /
 * numbersToNames) and lays it out as a PDF with pdfkit (pure-JS, Heroku
 * friendly). Chord tokens are drawn ABOVE the lyric syllable they attach to in
 * a monospaced font; `formatting.columns` (1 or 2) and `formatting.chordColor`
 * are honored; `PAGE_BREAK`/`COLUMN_BREAK` directive lines force a new
 * page/column; a `TRANSPOSE_KEY` directive renders as a small "Transpose +n"
 * marker. Long content flows onto additional pages. The result streams back as
 * `application/pdf` with a sanitized attachment filename from the song title.
 * ------------------------------------------------------------------------- */

// Map a stored formatting.chordColor to something pdfkit's fillColor accepts.
// Named CSS colors and #rrggbb both work; fall back to blue on anything odd.
function resolveChordColor(chordColor) {
  if (typeof chordColor !== 'string' || chordColor.trim() === '') return 'blue';
  const c = chordColor.trim();
  // Allow a bare hex (#abc / #aabbcc) or a simple color word.
  if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c)) return c;
  if (/^[a-zA-Z]+$/.test(c)) return c;
  return 'blue';
}

// Turn a song title into a safe, non-empty PDF filename (no path separators,
// control chars, or characters that break Content-Disposition).
function sanitizePdfFilename(title) {
  const base = (typeof title === 'string' ? title : '').trim() || 'chart';
  // Replace anything that isn't a safe filename char with an underscore and
  // collapse runs; strip leading/trailing dots and underscores.
  const cleaned = base
    .replace(/[^A-Za-z0-9 ._-]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/_+/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .trim();
  return (cleaned || 'chart') + '.pdf';
}

// Lay a Render_Representation out onto a pdfkit document. Pure drawing: no I/O.
// The doc is assumed already created; the caller owns piping/ending it.
function layoutChartPdf(doc, rendered) {
  const MARGIN = 48;
  const CHORD_SIZE = 9; // chords slightly smaller, sitting above lyrics
  const BODY_SIZE = Number(rendered.formatting && rendered.formatting.size) || 11;
  const LINE_GAP = 4; // extra space between stacked chord/lyric rows
  const chordColor = resolveChordColor(
    rendered.formatting && rendered.formatting.chordColor
  );
  const columns = rendered.formatting && rendered.formatting.columns === 2 ? 2 : 1;

  const pageWidth = doc.page.width;
  const pageBottom = doc.page.height - MARGIN;
  const usableWidth = pageWidth - MARGIN * 2;
  const COLUMN_GAP = 24;
  const colWidth =
    columns === 2 ? (usableWidth - COLUMN_GAP) / 2 : usableWidth;

  // Column cursor state. `col` is the active column index (0-based); `y` is the
  // current vertical cursor shared across the helpers below.
  let col = 0;
  let y = MARGIN;

  const colX = (c) => MARGIN + c * (colWidth + COLUMN_GAP);

  // Monospaced metrics: with Courier, every glyph is the same advance width, so
  // a chord placed at the pixel offset of its lyric segment sits exactly over
  // the right syllable.
  const charWidth = (size) => {
    doc.font('Courier').fontSize(size);
    return doc.widthOfString('M'); // monospace: any char works
  };

  // Start a fresh page and reset the cursor to the first column top.
  const newPage = () => {
    doc.addPage();
    col = 0;
    y = MARGIN;
  };

  // Move to the next column, or to a new page if already in the last column.
  const nextColumn = () => {
    if (col < columns - 1) {
      col += 1;
      y = MARGIN;
    } else {
      newPage();
    }
  };

  // Ensure `height` px fit before pageBottom; advance column/page if not.
  const ensureSpace = (height) => {
    if (y + height > pageBottom) {
      nextColumn();
    }
  };

  // Draw a chord-over-lyric content line. A line is a list of segments, each
  // `{ chord, lyric }`. We render the lyric text left-to-right in a monospaced
  // font and place each chord just above the first character of its segment.
  const drawContentLine = (segments) => {
    const cw = charWidth(BODY_SIZE);
    const chordRowH = CHORD_SIZE + 2;
    const lyricRowH = BODY_SIZE + 2;
    const anyChord = segments.some((s) => s.chord);
    const rowH = (anyChord ? chordRowH : 0) + lyricRowH + LINE_GAP;

    ensureSpace(rowH);

    const x0 = colX(col);
    const lyricY = y + (anyChord ? chordRowH : 0);

    // First pass: lyrics on the lyric row, tracking each segment's start X.
    let x = x0;
    const segStartX = [];
    doc.font('Courier').fontSize(BODY_SIZE).fillColor('black');
    for (const seg of segments) {
      segStartX.push(x);
      const lyric = seg.lyric || '';
      if (lyric !== '') {
        doc.text(lyric, x, lyricY, { lineBreak: false });
      }
      x += lyric.length * cw;
    }

    // Second pass: chords on the chord row, above their segment's start X.
    if (anyChord) {
      doc.font('Courier-Bold').fontSize(CHORD_SIZE).fillColor(chordColor);
      segments.forEach((seg, i) => {
        if (seg.chord) {
          doc.text(seg.chord, segStartX[i], y, { lineBreak: false });
        }
      });
      doc.fillColor('black');
    }

    y += rowH;
  };

  // Draw a blank (stanza) spacer.
  const drawBlankLine = () => {
    ensureSpace(BODY_SIZE);
    y += BODY_SIZE * 0.6;
  };

  // Draw a section header (label + optional "x<repeat>").
  const drawSectionHeader = (label, repeat) => {
    const text = (label || '') + (repeat ? `  x${repeat}` : '');
    if (text.trim() === '') return;
    const headerH = BODY_SIZE + 6;
    ensureSpace(headerH + 2);
    doc
      .font('Helvetica-Bold')
      .fontSize(BODY_SIZE + 1)
      .fillColor('black')
      .text(text, colX(col), y, { width: colWidth, lineBreak: false });
    y += headerH;
  };

  // Draw a small "Transpose +n" marker for a TRANSPOSE_KEY directive line.
  const drawTransposeMarker = (shift) => {
    const sign = shift > 0 ? `+${shift}` : `${shift}`;
    const markerH = CHORD_SIZE + 6;
    ensureSpace(markerH);
    doc
      .font('Helvetica-Oblique')
      .fontSize(CHORD_SIZE + 1)
      .fillColor(chordColor)
      .text(`Transpose ${sign}`, colX(col), y, { width: colWidth, lineBreak: false });
    doc.fillColor('black');
    y += markerH;
  };

  // --- Header block: title, artist, key label ------------------------------
  if (rendered.title) {
    doc.font('Helvetica-Bold').fontSize(18).fillColor('black');
    doc.text(rendered.title, MARGIN, y, { width: usableWidth });
    y = doc.y + 2;
  }
  if (rendered.artistLabel) {
    doc.font('Helvetica').fontSize(12).fillColor('black');
    doc.text(rendered.artistLabel, MARGIN, y, { width: usableWidth });
    y = doc.y + 2;
  }
  doc.font('Helvetica-Oblique').fontSize(10).fillColor('black');
  doc.text(`Key: ${rendered.keyLabel}`, MARGIN, y, { width: usableWidth });
  y = doc.y + 10;

  // --- Sections ------------------------------------------------------------
  for (const section of rendered.sections || []) {
    drawSectionHeader(section.label, section.repeat);

    for (const line of section.lines || []) {
      if (line.directive === 'PAGE_BREAK') {
        newPage();
        continue;
      }
      if (line.directive === 'COLUMN_BREAK') {
        nextColumn();
        continue;
      }
      if (line.directive === 'TRANSPOSE_KEY') {
        drawTransposeMarker(line.transposeShift || 0);
        continue;
      }
      // Content line: a blank line has no segments.
      if (!line.segments || line.segments.length === 0) {
        drawBlankLine();
        continue;
      }
      drawContentLine(line.segments);
    }

    // A little breathing room after each section.
    y += BODY_SIZE * 0.5;
  }
}

// GET /songs/:id/chart/pdf — render the chart to a downloadable PDF.
// Query `key`: omitted or 'Numbers' renders the stored numbers body as-is; a
// key value transposes numbers -> names in that key (422 KEY_INVALID on a bad
// key). Band-scoped via the song (R9.5). Streams `application/pdf`.
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

    // Resolve the requested representation exactly like GET /:id/chart/view.
    const requested = typeof req.query.key === 'string' ? req.query.key.trim() : '';
    const isNumbers = requested === '' || requested === 'Numbers';

    let rendered;
    let keyLabel;
    if (isNumbers) {
      rendered = renderModel(chart.body);
      keyLabel = 'Numbers';
    } else {
      if (!isSupportedKey(requested)) {
        const err = new Error(
          `Unsupported or invalid key "${requested}". Supply a supported major key or "Numbers".`
        );
        err.status = 422;
        err.code = 'KEY_INVALID';
        err.fields = { key: 'unsupported or invalid key' };
        return next(err);
      }
      rendered = renderModel(numbersToNames(chart.body, requested));
      keyLabel = requested;
    }

    // Assemble the full Render_Representation (metadata + sections) the layout
    // consumes, matching the shape returned by GET /:id/chart/view.
    const representation = {
      title: chart.title,
      artistLabel: chart.artistLabel,
      keyLabel,
      formatting: chart.formatting,
      sections: rendered.sections,
    };

    // Stream the PDF. Set headers before piping; pdfkit writes incrementally.
    const filename = sanitizePdfFilename(chart.title || song.title);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const doc = new PDFDocument({ size: 'A4', margin: 48, autoFirstPage: true });
    // If the document errors mid-stream, surface it (headers may already be
    // sent, in which case we can only abort the response).
    doc.on('error', (streamErr) => {
      if (!res.headersSent) {
        next(streamErr);
      } else {
        res.destroy(streamErr);
      }
    });
    doc.pipe(res);

    layoutChartPdf(doc, representation);

    doc.end();
  } catch (err) {
    next(err);
  }
});

// POST /songs/:id/chart/view — render an UN-PERSISTED working body for the
// editor's live preview. Unlike GET /:id/chart/view, this reads/writes nothing:
// it interprets a body supplied in the request and renders it on the fly.
// Body: { body, enteredKey, displayedKey, title?, artistLabel?, formatting? }.
//   - enteredKey:   how to interpret `body` — ''/'Numbers' = already numbers;
//                   a key = names (names->numbers via namesToNumbers first).
//   - displayedKey: how to render — ''/'Numbers' = numbers form; a key =
//                   numbers->names in that key.
// Returns the same Render_Representation shape as GET /:id/chart/view. Since
// nothing is persisted, metadata (title/artistLabel/formatting) is echoed from
// the request when provided, else defaulted to the Chart schema defaults.
router.post('/:id/chart/view', async (req, res, next) => {
  try {
    const song = await loadScopedSong(req, next);
    if (!song) return;

    const { body, enteredKey, displayedKey, title, artistLabel, formatting } = req.body;

    // The working body is required and must be a string (same as the PUT route).
    if (typeof body !== 'string') {
      const err = new Error('body is required and must be a string');
      err.status = 422;
      err.code = 'CHART_INVALID';
      err.fields = { body: 'required' };
      return next(err);
    }

    // Grammar-validate the submitted body (runs for both numbers and names
    // input; names tokens still parse as chords) — mirrors the PUT route.
    const { valid, fields } = validateChartBody(body);
    if (!valid) {
      const err = new Error('Chart body is invalid');
      err.status = 422;
      err.code = 'CHART_INVALID';
      err.fields = fields;
      return next(err);
    }

    // --- Interpret `body` per enteredKey -> canonical numbers --------------
    // A missing/blank enteredKey, or the literal 'Numbers', means numbers mode.
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

    // --- Render per displayedKey -> Render_Representation -------------------
    // A missing/blank displayedKey, or 'Numbers', renders the numbers form; any
    // other value is a target key and must be a supported major key.
    const displayed = typeof displayedKey === 'string' ? displayedKey.trim() : '';
    const isDisplayNumbers = displayed === '' || displayed === 'Numbers';

    let rendered;
    let keyLabel;
    if (isDisplayNumbers) {
      rendered = renderModel(numbersBody);
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
      rendered = renderModel(numbersToNames(numbersBody, displayed));
      keyLabel = displayed;
    }

    // Nothing is persisted, so echo provided metadata or fall back to the
    // Chart schema defaults (title '', artistLabel '', formatting defaults).
    const defaultFormatting = { font: 'monospace', size: 11, chordColor: 'blue', columns: 1 };

    res.json({
      title: title !== undefined ? title : '',
      artistLabel: artistLabel !== undefined ? artistLabel : '',
      keyLabel,
      formatting: formatting !== undefined ? formatting : defaultFormatting,
      sections: rendered.sections,
    });
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
