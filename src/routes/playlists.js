const express = require('express');
const PDFDocument = require('pdfkit');
const archiver = require('archiver');
const Playlist = require('../models/Playlist');
const Song = require('../models/Song');
const Chart = require('../models/Chart');
const authenticate = require('../middleware/authenticate');
const bandScope = require('../middleware/bandScope');
const { numbersToNames, renderModel } = require('../services/chartTranspose');
const { isSupportedKey } = require('../services/chartSpelling');
const { paginate } = require('../services/chartLayout');
const { layoutChartPdf, sanitizePdfFilename } = require('../services/chartPdf');

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

/* ------------------------------------------------------------------------- *
 * Gig "all charts" rendering (frontend #85 / this issue #77).
 *
 * Per-song rules, independent header vs body:
 *   HEADER keyLabel: the song's playedKey for this setlist if set, else
 *     'Numbers' (the no-key default). Does NOT depend on the Numbers/Chords
 *     body choice.
 *   BODY:
 *     - mode 'Numbers' -> chord tokens stay as Nashville numbers.
 *     - mode 'Chords'  -> transpose numbers -> names in the playedKey.
 *     - mode 'Chords' but NO playedKey -> cannot transpose; fall back to
 *       Numbers (and keyLabel becomes 'Numbers').
 * ------------------------------------------------------------------------- */

// Normalize a requested body mode to 'Numbers' | 'Chords' (default Numbers).
function normalizeMode(mode) {
  return String(mode || '').trim().toLowerCase() === 'chords' ? 'Chords' : 'Numbers';
}

// Resolve how a single song's chart should render given its chosen mode and its
// setlist playedKey. Returns { keyLabel, numbers } where `numbers` is true when
// the BODY should render as numbers (either Numbers mode, or Chords with no
// usable key). `keyLabel` is the header label.
function resolveSongRender(mode, playedKey) {
  const m = normalizeMode(mode);
  const hasKey = typeof playedKey === 'string' && playedKey.trim() !== '' && isSupportedKey(playedKey.trim());
  const key = hasKey ? playedKey.trim() : '';
  // Header always shows the played key when there is one, else 'Numbers'.
  const keyLabel = key || 'Numbers';
  // Body is numbers unless Chords AND we have a key to transpose into.
  const numbers = !(m === 'Chords' && key);
  return { keyLabel, numbers, key };
}

// Build a chart Render_Representation for one song entry under the gig rules.
// Returns the chart object (title/artist from the song, keyLabel per header
// rule, playedKey, formatting, sections, pages) or null when the song has no
// stored chart (caller renders a "no chart" placeholder that still shows the
// header).
function buildSongChart(song, chartDoc, mode) {
  const playedKey = song && song.__playedKey; // caller stashes the entry's key
  const { keyLabel, numbers, key } = resolveSongRender(mode, playedKey);
  if (!chartDoc) {
    return null;
  }
  const rendered = numbers
    ? renderModel(chartDoc.body)
    : renderModel(numbersToNames(chartDoc.body, key, { lenient: true }));
  const { pages } = paginate(rendered, { formatting: chartDoc.formatting });
  return {
    title: song ? song.title : '',
    artist: song ? song.artist : '',
    keyLabel,
    playedKey: playedKey || '',
    mode: normalizeMode(mode),
    formatting: chartDoc.formatting,
    sections: rendered.sections,
    pages,
  };
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

/* ------------------------------------------------------------------------- *
 * Gig "all charts" POST endpoints (issue #77).
 *
 * All three accept a per-song mode selection in the body:
 *   { selections: [ { songId, mode }, ... ] }  where mode is 'Numbers'|'Chords'
 * A song not present in `selections` defaults to 'Numbers'. The playedKey used
 * for the header / transpose is the song's playedKey stored on the playlist
 * entry (NOT part of the request), per the locked rules in buildSongChart.
 *
 * All are band-scoped via the playlist (an absent/cross-band playlist yields
 * the playlist's 404) and honor the MAX_BATCH size cap with a `truncated`
 * flag (for the JSON endpoint) / silent truncation (for the binary ones).
 * ------------------------------------------------------------------------- */

// Build a Map(songId -> 'Numbers'|'Chords') from a request body's `selections`
// array. Entries are tolerant: a missing/blank mode normalizes to 'Numbers'.
function selectionsToModeMap(body) {
  const map = new Map();
  const selections = body && Array.isArray(body.selections) ? body.selections : [];
  for (const sel of selections) {
    if (sel && sel.songId !== undefined && sel.songId !== null && sel.songId !== '') {
      map.set(String(sel.songId), normalizeMode(sel.mode));
    }
  }
  return map;
}

// Resolve the current-band playlist for a charts request, or send its 404.
// Returns the playlist document, or null after having called next(err).
async function loadScopedPlaylist(req, next) {
  const playlist = await Playlist.findOne({ _id: req.params.id, band: req.currentBand });
  if (!playlist) {
    const err = new Error('Playlist not found');
    err.status = 404;
    err.code = 'NOT_FOUND';
    next(err);
    return null;
  }
  return playlist;
}

// Load the capped, ordered setlist for a playlist and assemble the per-entry
// render inputs. Returns { items, truncated } where each item is
// { songId, song, chartDoc, mode, entry } in setlist order. The song object
// has `__playedKey` stashed on it so buildSongChart can read the entry's key.
async function loadSetlistItems(playlist, modeMap, currentBand) {
  const truncated = playlist.songs.length > MAX_BATCH;
  const entries = playlist.songs.slice(0, MAX_BATCH);
  const songIds = entries.map((e) => e.song);

  const [songs, charts] = await Promise.all([
    Song.find({ _id: { $in: songIds }, band: currentBand }),
    Chart.find({ song: { $in: songIds } }),
  ]);
  const songById = new Map(songs.map((s) => [s._id.toString(), s]));
  const chartBySong = new Map(charts.map((c) => [c.song.toString(), c]));

  const items = entries.map((entry) => {
    const songId = String(entry.song);
    const song = songById.get(songId) || null;
    const chartDoc = chartBySong.get(songId) || null;
    const mode = modeMap.get(songId) || 'Numbers';
    if (song) song.__playedKey = entry.playedKey || '';
    return { songId, song, chartDoc, mode, entry };
  });

  return { items, truncated };
}

// Build a one-page "No chart for this song" placeholder representation that
// still carries the standard header (title + keyLabel per the locked rules)
// and footer (band name). Reuses layoutChartPdf by handing it a representation
// whose single page holds one content line.
function placeholderRepresentation(item, bandName) {
  const { keyLabel } = resolveSongRender(item.mode, item.song && item.song.__playedKey);
  return {
    title: item.song ? item.song.title : '',
    artist: item.song ? item.song.artist : '',
    bandName: bandName || '',
    keyLabel,
    formatting: { font: 'monospace', size: 11, chordColor: 'blue', columns: 1 },
    sections: [],
    pages: [
      {
        columns: [
          { lines: [{ segments: [{ chord: null, lyric: 'No chart for this song' }] }] },
        ],
      },
    ],
  };
}

// Build the per-song PDF representation for the binary endpoints: either the
// real chart (via buildSongChart) with the band-name footer attached, or the
// "no chart" placeholder. Always returns a drawable representation.
function pdfRepresentationFor(item, bandName) {
  const chart = buildSongChart(item.song, item.chartDoc, item.mode);
  if (!chart) return placeholderRepresentation(item, bandName);
  return { ...chart, bandName: bandName || '' };
}

// POST /playlists/:id/charts — same shape as GET /:id/charts, but each song is
// rendered per its selected mode ('Numbers'|'Chords') via buildSongChart. The
// header keyLabel always follows the song's playedKey (independent of mode);
// 'Chords' with no key falls back to numbers. A song with no stored chart
// yields chart: null. Band-scoped via the playlist; honors MAX_BATCH.
router.post('/:id/charts', async (req, res, next) => {
  try {
    const playlist = await loadScopedPlaylist(req, next);
    if (!playlist) return;

    const modeMap = selectionsToModeMap(req.body);
    const { items, truncated } = await loadSetlistItems(playlist, modeMap, req.currentBand);

    const charts = items.map((item) => ({
      songId: item.songId,
      title: item.song ? item.song.title : '',
      playedKey: (item.entry && item.entry.playedKey) || '',
      chart: buildSongChart(item.song, item.chartDoc, item.mode),
    }));

    res.json({ playlistId: playlist._id, charts, truncated });
  } catch (err) {
    next(err);
  }
});

// POST /playlists/:id/charts/pdf — a single COMBINED PDF of every song in
// setlist order. Each song starts on a fresh page; a song with no chart gets a
// one-page "No chart for this song" placeholder (header still shown). Streams
// application/pdf with an attachment filename from the playlist name.
router.post('/:id/charts/pdf', async (req, res, next) => {
  try {
    const playlist = await loadScopedPlaylist(req, next);
    if (!playlist) return;

    const modeMap = selectionsToModeMap(req.body);
    const { items } = await loadSetlistItems(playlist, modeMap, req.currentBand);

    const filename = sanitizePdfFilename(playlist.name);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // Same doc options as the single-chart route: LETTER, bottom margin 0 so
    // the near-bottom band-name footer never trips an automatic page break.
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: 48, left: 48, right: 48, bottom: 0 },
      autoFirstPage: true,
    });
    doc.on('error', (streamErr) => {
      if (!res.headersSent) next(streamErr); else res.destroy(streamErr);
    });
    doc.pipe(res);

    // Each song begins on a fresh page: layoutChartPdf draws onto the current
    // page first and addPage()s between its OWN pages, so we only need to
    // addPage() between songs (not before the first).
    items.forEach((item, index) => {
      if (index > 0) doc.addPage();
      const representation = pdfRepresentationFor(item, req.currentBandName);
      layoutChartPdf(doc, representation);
    });

    // An empty playlist still yields a valid (blank) one-page PDF from
    // autoFirstPage; no special-casing needed.
    doc.end();
  } catch (err) {
    next(err);
  }
});

// Render a single song's chart to a self-contained PDF Buffer (same layout as
// the single-chart route). Used by the zip endpoint. Resolves once the pdfkit
// stream finishes.
function renderSongPdfBuffer(item, bandName) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: 48, left: 48, right: 48, bottom: 0 },
      autoFirstPage: true,
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      layoutChartPdf(doc, pdfRepresentationFor(item, bandName));
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// POST /playlists/:id/charts/pdf-zip — one PDF per song, bundled as a .zip.
// Songs with no chart are INCLUDED as a one-page "No chart for this song" PDF
// (chosen so the zip reflects the full setlist, not a silently shorter set).
// Filenames come from the song title via sanitizePdfFilename, de-duplicated
// with -2/-3 suffixes when two songs share a title. Streams application/zip
// with an attachment filename from the playlist name.
router.post('/:id/charts/pdf-zip', async (req, res, next) => {
  try {
    const playlist = await loadScopedPlaylist(req, next);
    if (!playlist) return;

    const modeMap = selectionsToModeMap(req.body);
    const { items } = await loadSetlistItems(playlist, modeMap, req.currentBand);

    const zipName = sanitizePdfFilename(playlist.name).replace(/\.pdf$/i, '.zip');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (archiveErr) => {
      if (!res.headersSent) next(archiveErr); else res.destroy(archiveErr);
    });
    archive.pipe(res);

    // De-duplicate filenames: a repeated base gets -2, -3, ... before .pdf.
    const usedNames = new Map();
    const uniqueName = (title) => {
      const base = sanitizePdfFilename(title); // e.g. "Song.pdf"
      const stem = base.replace(/\.pdf$/i, '');
      const seen = usedNames.get(stem) || 0;
      usedNames.set(stem, seen + 1);
      return seen === 0 ? `${stem}.pdf` : `${stem}-${seen + 1}.pdf`;
    };

    // Buffers are built sequentially so pdfkit documents don't interleave, then
    // appended to the archive. finalize() flushes it to the response stream.
    for (const item of items) {
      const buffer = await renderSongPdfBuffer(item, req.currentBandName);
      const name = uniqueName(item.song ? item.song.title : '');
      archive.append(buffer, { name });
    }

    await archive.finalize();
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
