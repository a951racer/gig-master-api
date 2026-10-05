const path = require('path');

// Embedded body font for the PDF: DejaVu Sans Mono (a SANS-SERIF MONOSPACE
// face). Bundled under src/assets/fonts so it is available in every deploy
// environment regardless of system fonts. Registered on each PDFDocument as
// 'mono' / 'mono-bold' (see layoutChartPdf). Headers stay on the built-in
// Helvetica. (DejaVu fonts: free, Bitstream Vera-derived license — see
// src/assets/fonts/LICENSE.txt.)
//
// This file lives in src/services; the fonts are in src/assets/fonts, so the
// relative path from here (`.. / assets / fonts`) resolves the same as it did
// from src/routes (both are one level under src/).
const MONO_REGULAR_PATH = path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSansMono.ttf');
const MONO_BOLD_PATH = path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSansMono-Bold.ttf');

/* ------------------------------------------------------------------------- *
 * Shared PDF layout service (extracted from routes/songs.js — issue #77).
 *
 * `layoutChartPdf(doc, representation)` consumes the SAME paginated layout the
 * web viewer uses (via chartLayout.paginate) and draws it with pdfkit on the
 * provided US-Letter document so the PDF matches the web viewer page-for-page.
 * Chord tokens are drawn ABOVE the lyric syllable they attach to in a
 * monospaced font; `formatting.columns` and `formatting.chordColor` are
 * honored; COLUMN_BREAK/PAGE_BREAK are already resolved by the paginator (they
 * never appear as drawable lines). A TRANSPOSE_KEY line renders as a small
 * marker. Title/artist come from the SONG. The CALLER owns the PDFDocument
 * (creation, margins, piping, doc.end) — the service only lays out onto it.
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
    // Tint the banner from the chart's chord color at low opacity (a light
    // wash over the white page), so the header accent follows formatting.
    // chordColor. save()/restore() scopes the fillOpacity so later draws are
    // fully opaque again.
    doc.save();
    doc.fillOpacity(0.25);
    doc.rect(MARGIN, bannerTop, usableWidth, bannerH).fill(chordColor);
    doc.restore();
    doc.fillColor('black').font('Helvetica-Bold').fontSize(18)
      .text(titleText, MARGIN + 12, bannerTop + 8, { width: usableWidth - 24, lineBreak: false });
    if (representation.artist) {
      doc.font('Helvetica-Bold').fontSize(10)
        .text(representation.artist, MARGIN + 12, bannerTop + 34, { width: usableWidth - 24, lineBreak: false });
    }
    return bannerTop + bannerH + 12;
  }
  // Condensed header on subsequent pages: title on the left, page number
  // right-justified on the same baseline.
  doc.fillColor('black').font('Helvetica-Bold').fontSize(11);
  doc.text(titleText, MARGIN, MARGIN, { width: usableWidth, lineBreak: false });
  const totalPages = (representation.pages && representation.pages.length) || 1;
  doc.font('Helvetica').fontSize(10).fillColor('#555555')
    .text(`Page ${pageIndex + 1} of ${totalPages}`, MARGIN, MARGIN, { width: usableWidth, align: 'right', lineBreak: false });
  doc.fillColor('black');
  return MARGIN + 22;
}

// Draw a centered footer (the band name) in the bottom page margin — same on
// every page. Lives inside the margin so it does not affect content height.
function drawFooter(doc, representation, geom) {
  const bandName = representation.bandName;
  if (!bandName) return;
  const { MARGIN, usableWidth } = geom;
  const footerY = doc.page.height - 30; // within the ~48pt bottom margin
  doc.font('Helvetica').fontSize(9).fillColor('#777777')
    .text(bandName, MARGIN, footerY, { width: usableWidth, align: 'center', lineBreak: false });
  doc.fillColor('black');
}

// Lay a paginated representation out onto a pdfkit Letter document.
function layoutChartPdf(doc, representation) {
  // Register the embedded sans-serif monospace body font on this document.
  doc.registerFont('mono', MONO_REGULAR_PATH);
  doc.registerFont('mono-bold', MONO_BOLD_PATH);

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

  // Fonts: lyrics and chords use DejaVu Sans Mono — a SANS-SERIF MONOSPACE
  // face registered above as 'mono' / 'mono-bold'. The title / artist / section
  // headers remain Helvetica (set at their own draw sites). All horizontal
  // advances are MEASURED with doc.widthOfString(...) — correct for any font —
  // so chords stay aligned over the lyric syllable they sit on and chord-only
  // lines keep their spacing.
  const LYRIC_FONT = 'mono';
  const CHORD_FONT = 'mono-bold';
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
    // next segment over instead of overlapping it. Measuring the drawn widths
    // keeps chords aligned over their syllable (correct for any font).
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
    drawFooter(doc, representation, geom);

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

module.exports = {
  layoutChartPdf,
  sanitizePdfFilename,
};
