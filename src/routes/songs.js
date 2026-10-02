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
function buildRepresentation(song, chart, numbersOrNamesBody, keyLabel) {
  const rendered = renderModel(numbersOrNamesBody);
  const formatting = chart.formatting;
  const { pages } = paginate(rendered, { formatting });
  return {
    title: song.title,
    artist: song.artist,
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

    res.json(buildRepresentation(song, chart, keyed.body, keyed.keyLabel));
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
 * Chord tokens are drawn ABOVE the lyric syllable they attach to in a
 * monospaced font; `formatting.columns` and `formatting.chordColor` are
 * honored; COLUMN_BREAK/PAGE_BREAK are already resolved by the paginator (they
 * never appear as drawable lines). A TRANSPOSE_KEY line renders as a small
 * marker. Title/artist come from the SONG. Streams `application/pdf`.
 * ------------------------------------------------------------------------- */

// Map a stored formatting.chordColor to something pdfkit's fillColor accepts.
function resolveChordColor(chordColor) {
  if (typeof chordColor !== 'string' || chordColor.trim() === '') return 'blue';
  const c = chordColor.trim();
  if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c)) return c;
  if (/^[a-zA-Z]+$/.test(c)) return c;
  return 'blue';
}

// Turn a title into a safe, non-empty PDF filename.
function sanitizePdfFilename(title) {
  const base = (typeof title === 'string' ? title : '').trim() || 'chart';
  const cleaned = base
    .replace(/[^A-Za-z0-9 ._-]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/_+/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .trim();
  return (cleaned || 'chart') + '.pdf';
}

// Draw a page header. Page 1 gets the tall banner (title [key] + artist on a
// shaded block); later pages get a condensed single-line "title [key]".
function drawHeader(doc, representation, pageIndex, geom) {
  const { MARGIN, usableWidth, chordColor } = geom;
  const keyPart = representation.keyLabel && representation.keyLabel !== 'Numbers'
    ? ` [${representation.keyLabel}]`
    : representation.keyLabel === 'Numbers' ? ' [Numbers]' : '';
  const titleText = `${representation.title || 'Untitled'}${keyPart}`;
  if (pageIndex === 0) {
    const bannerTop = MARGIN;
    const bannerH = 56;
    doc.save();
    doc.rect(MARGIN, bannerTop, usableWidth, bannerH).fill('#e5e5e5');
    doc.restore();
    doc.fillColor('black').font('Helvetica-Bold').fontSize(18)
      .text(titleText, MARGIN + 12, bannerTop + 8, { width: usableWidth - 24, lineBreak: false });
    if (representation.artist) {
      doc.font('Helvetica-Bold').fontSize(10)
        .text(`[${representation.artist}]`, MARGIN + 12, bannerTop + 34, { width: usableWidth - 24, lineBreak: false });
    }
    return bannerTop + bannerH + 12;
  }
  // Condensed header on subsequent pages.
  doc.fillColor('black').font('Helvetica-Bold').fontSize(11)
    .text(titleText, MARGIN, MARGIN, { width: usableWidth, lineBreak: false });
  return MARGIN + 22;
}

// Lay a paginated representation out onto a pdfkit Letter document.
function layoutChartPdf(doc, representation) {
  const MARGIN = 48;
  const BODY_SIZE = Number(representation.formatting && representation.formatting.size) || 11;
  const CHORD_SIZE = Math.max(7, Math.round(BODY_SIZE * 0.85));
  const LINE_GAP = 3;
  const chordColor = resolveChordColor(
    representation.formatting && representation.formatting.chordColor
  );
  const columns = Math.max(1, Number(representation.formatting && representation.formatting.columns) || 1);

  const pageWidth = doc.page.width;
  const usableWidth = pageWidth - MARGIN * 2;
  const COLUMN_GAP = 18;
  const colWidth = columns > 1 ? (usableWidth - COLUMN_GAP * (columns - 1)) / columns : usableWidth;

  const geom = { MARGIN, usableWidth, chordColor };
  const colX = (c) => MARGIN + c * (colWidth + COLUMN_GAP);

  // Fonts: use a SANS-SERIF family throughout (Helvetica), matching the title /
  // artist / section headers. Lyrics are Helvetica; chords Helvetica-Bold; the
  // superscript quality is a smaller Helvetica-Bold. Because Helvetica is
  // PROPORTIONAL (unlike the old Courier), we cannot assume a fixed character
  // width — every advance is MEASURED with doc.widthOfString(...) so chords stay
  // aligned over the lyric syllable they sit on.
  const LYRIC_FONT = 'Helvetica';
  const CHORD_FONT = 'Helvetica-Bold';
  const SUP_SIZE = Math.max(6, Math.round(CHORD_SIZE * 0.7)); // superscript quality

  // Measure a string's drawn width at a given font/size.
  const measure = (text, font, size) => {
    doc.font(font).fontSize(size);
    return doc.widthOfString(text || '');
  };

  // Width of a single space at chord size — the minimum gap enforced after a
  // chord on a chord-only line so adjacent chords never touch.
  const chordSpace = measure(' ', CHORD_FONT, CHORD_SIZE);

  // The display parts of a segment's chord. Segments carry parsed
  // root/quality/bass; fall back to the raw chord string for verbatim tokens.
  const chordDisplay = (seg) => {
    if (!seg.chord) return null;
    const root = seg.root != null ? seg.root : seg.chord;
    const quality = seg.quality || '';
    const bass = seg.bass || null;
    return { root, quality, bass };
  };

  // Measured drawn width of a chord: root (chord size) + superscript quality
  // (sup size) + optional /bass (chord size).
  const chordWidth = (parts) => {
    if (!parts) return 0;
    let w = measure(parts.root, CHORD_FONT, CHORD_SIZE);
    if (parts.quality) w += measure(parts.quality, CHORD_FONT, SUP_SIZE);
    if (parts.bass) w += measure('/' + parts.bass, CHORD_FONT, CHORD_SIZE);
    return w;
  };

  // Draw a chord at (x, y): root at CHORD_SIZE, quality SUPERSCRIPTED (smaller,
  // raised), then optional /bass. Returns the x advanced past what was drawn.
  const drawChord = (parts, x, y) => {
    doc.fillColor(chordColor);
    let cx = x;
    doc.font(CHORD_FONT).fontSize(CHORD_SIZE).text(parts.root, cx, y, { lineBreak: false });
    cx += measure(parts.root, CHORD_FONT, CHORD_SIZE);
    if (parts.quality) {
      const supY = y - SUP_SIZE * 0.35; // raise the superscript near the glyph top
      doc.font(CHORD_FONT).fontSize(SUP_SIZE).text(parts.quality, cx, supY, { lineBreak: false });
      cx += measure(parts.quality, CHORD_FONT, SUP_SIZE);
    }
    if (parts.bass) {
      doc.font(CHORD_FONT).fontSize(CHORD_SIZE).text('/' + parts.bass, cx, y, { lineBreak: false });
      cx += measure('/' + parts.bass, CHORD_FONT, CHORD_SIZE);
    }
    doc.fillColor('black');
    return cx;
  };

  const drawContentLine = (segments, x0, y) => {
    const anyChord = segments.some((s) => s.chord);
    const chordRowH = anyChord ? CHORD_SIZE + 2 : 0;
    const lyricY = y + chordRowH;

    // Walk segments left-to-right. Each segment advances x by the GREATER of
    // its MEASURED lyric width and its MEASURED chord width (+ a space gap) so a
    // chord wider than its lyric — e.g. a chord-only INTRO line — pushes the
    // next segment over instead of overlapping it. Measuring (vs assuming a
    // fixed char width) keeps chords aligned over their syllable in the
    // proportional sans-serif font.
    let x = x0;
    for (const seg of segments) {
      const lyric = seg.lyric || '';
      const parts = chordDisplay(seg);

      if (lyric !== '') {
        doc.font(LYRIC_FONT).fontSize(BODY_SIZE).fillColor('black').text(lyric, x, lyricY, { lineBreak: false });
      }
      if (parts) drawChord(parts, x, y);

      const lyricW = measure(lyric, LYRIC_FONT, BODY_SIZE);
      const chW = parts ? chordWidth(parts) + chordSpace : 0; // + one space gap
      x += Math.max(lyricW, chW);
    }

    return chordRowH + BODY_SIZE + 2 + LINE_GAP;
  };

  const pages = representation.pages || [];
  pages.forEach((page, pageIndex) => {
    if (pageIndex > 0) doc.addPage();
    const contentTop = drawHeader(doc, representation, pageIndex, geom);

    (page.columns || []).forEach((column, c) => {
      let y = contentTop;
      const x0 = colX(c);
      for (const line of column.lines || []) {
        if (line.header) {
          const text = (line.header.label || '') + (line.header.repeat ? `  x${line.header.repeat}` : '');
          doc.font('Helvetica-Bold').fontSize(BODY_SIZE + 1).fillColor('black')
            .text(text, x0, y, { width: colWidth, lineBreak: false });
          y += BODY_SIZE + 8;
          continue;
        }
        if (line.directive === 'TRANSPOSE_KEY') {
          const shift = line.transposeShift || 0;
          const sign = shift > 0 ? `+${shift}` : `${shift}`;
          doc.font('Helvetica-Oblique').fontSize(CHORD_SIZE + 1).fillColor(chordColor)
            .text(`Transpose ${sign}`, x0, y, { width: colWidth, lineBreak: false });
          doc.fillColor('black');
          y += CHORD_SIZE + 6;
          continue;
        }
        if (!line.segments || line.segments.length === 0) {
          y += BODY_SIZE * 0.6;
          continue;
        }
        y += drawContentLine(line.segments, x0, y);
      }
    });
  });
}

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

    const representation = buildRepresentation(song, chart, keyed.body, keyed.keyLabel);

    const filename = sanitizePdfFilename(song.title);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const doc = new PDFDocument({ size: 'LETTER', margin: 48, autoFirstPage: true });
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
