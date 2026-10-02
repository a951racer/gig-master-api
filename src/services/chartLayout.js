/**
 * Chart layout / pagination service.
 *
 * Pure, synchronous, DB-free. Turns the flat `sections` list produced by
 * `renderModel` into a PAGINATED, COLUMNIZED structure laid out against a
 * virtual US-Letter portrait page (8.5x11in). This single implementation is
 * shared by the web viewer (GET /songs/:id/chart/view), the PDF generator
 * (GET /songs/:id/chart/pdf), and the playlist batch endpoint, so every
 * surface breaks columns/pages in exactly the same place.
 *
 * ----------------------------------------------------------------------------
 * Virtual page model (CSS px at 96dpi; pt->px uses px = pt * 96/72)
 * ----------------------------------------------------------------------------
 *   PAGE_W = 816   (8.5in * 96)
 *   PAGE_H = 1056  (11in  * 96)
 *   MARGIN = 48    (0.5in)
 *   COLUMN_GAP = 24
 *   Page-1 header reserve: 72px (~0.75in banner: title + artist).
 *   Pages 2+ header reserve: 2 * lyricLineHeight (condensed 2-line header).
 *
 * Line heights are derived from formatting.size (pt): a content line that
 * carries any chord occupies a chord row + a lyric row + a gap; a lyric-only
 * line occupies a lyric row + gap; a blank line is a fractional spacer; a
 * section header and a transpose marker have their own heights. These mirror
 * the PDF layout constants so web and PDF agree.
 *
 * ----------------------------------------------------------------------------
 * Flow rules
 * ----------------------------------------------------------------------------
 *   - columns = formatting.columns (clamped to >= 1).
 *   - Lines fill column 0 top-to-bottom; when the next line would exceed the
 *     usable column height, flow to the next column; after the last column,
 *     start a new page (which re-reserves a condensed header).
 *   - A COLUMN_BREAK directive forces a jump to the next column immediately
 *     (or a new page if already in the last column). When columns === 1 a
 *     COLUMN_BREAK is IGNORED entirely. COLUMN_BREAK is NEVER emitted as a
 *     visible line.
 *   - A PAGE_BREAK directive forces a new page. Also never emitted as a line.
 *   - A TRANSPOSE_KEY directive IS a visible marker line and is kept.
 *   - A section header "sticks" to the content that follows it: if a header
 *     would be the last thing to fit in a column (orphan), it moves with the
 *     first content line to the next column/page.
 *
 * ----------------------------------------------------------------------------
 * Output shape
 * ----------------------------------------------------------------------------
 *   {
 *     pages: [
 *       { columns: [ { lines: [ RenderLine, ... ] }, ... ] },
 *       ...
 *     ]
 *   }
 * where each RenderLine is the SAME shape renderModel produces
 * ({ segments, directive, transposeShift }) EXCEPT that PAGE_BREAK and
 * COLUMN_BREAK directive lines never appear (they are consumed as flow
 * controls). A section header is carried as a content line augmented with
 * `sectionLabel` / `sectionRepeat` so a column that starts mid-section can be
 * rendered without a header while a column that starts a section shows it.
 * To keep the renderer simple we instead emit explicit header lines:
 *
 *   { header: { label, repeat } }                       // a section header
 *   { segments, directive: null, transposeShift: null } // content / blank
 *   { directive: 'TRANSPOSE_KEY', transposeShift }       // transpose marker
 * ----------------------------------------------------------------------------
 */

'use strict';

// --- Virtual page geometry (CSS px @ 96dpi) --------------------------------
const PAGE_W = 816;
const PAGE_H = 1056;
const MARGIN = 48;
const COLUMN_GAP = 24;
const PInit = 72; // page-1 banner header reserve (~0.75in)

const USABLE_W = PAGE_W - MARGIN * 2;
const USABLE_H = PAGE_H - MARGIN * 2;

/**
 * Convert a point size to CSS px at 96dpi.
 * @param {number} pt
 * @returns {number}
 */
function ptToPx(pt) {
  const size = Number(pt) || 11;
  return (size * 96) / 72;
}

/**
 * Derive the per-line-type heights (px) from formatting.size.
 * @param {number} sizePt
 */
function metricsFor(sizePt) {
  const lyricPx = ptToPx(sizePt);
  const lyricLine = lyricPx * 1.25;      // lyric row w/ leading
  const chordLine = ptToPx(sizePt * 0.85) * 1.25; // chord row (smaller)
  const gap = 4;
  return {
    lyricPx,
    // a content line with chords stacks a chord row over a lyric row
    contentWithChord: chordLine + lyricLine + gap,
    // a lyric-only / chord-only content line
    contentPlain: lyricLine + gap,
    // a blank stanza spacer
    blank: lyricLine * 0.6,
    // a section header line
    header: lyricLine + 8,
    // a transpose marker line
    transpose: chordLine + 6,
    // condensed subsequent-page header reserve = 2 lyric lines
    condensedHeader: lyricLine * 2,
  };
}

/**
 * Does a RenderLine carry at least one chord?
 * @param {object} line
 */
function lineHasChord(line) {
  return Array.isArray(line.segments) && line.segments.some((s) => s.chord);
}

/**
 * Flatten renderModel sections into an ordered list of "flow items", each
 * tagged with its kind and measured height. Section headers become `header`
 * items; PAGE_BREAK / COLUMN_BREAK become `pageBreak` / `columnBreak` control
 * items (zero height); TRANSPOSE_KEY stays a visible `transpose` item;
 * everything else is a `content` item (including blank lines).
 *
 * @param {Array} sections  renderModel(...).sections
 * @param {object} m        metrics from metricsFor
 * @returns {Array<{kind:string, height:number, line?:object, header?:object}>}
 */
function flattenToItems(sections, m) {
  const items = [];
  for (const section of sections || []) {
    // A section with a (non-empty) label emits a header item that should stick
    // to the first following content line.
    if (section.label) {
      items.push({
        kind: 'header',
        height: m.header,
        header: { label: section.label, repeat: section.repeat || null },
        sticky: true,
      });
    }
    for (const line of section.lines || []) {
      if (line.directive === 'PAGE_BREAK') {
        items.push({ kind: 'pageBreak', height: 0 });
        continue;
      }
      if (line.directive === 'COLUMN_BREAK') {
        items.push({ kind: 'columnBreak', height: 0 });
        continue;
      }
      if (line.directive === 'TRANSPOSE_KEY') {
        items.push({
          kind: 'transpose',
          height: m.transpose,
          line: { segments: [], directive: 'TRANSPOSE_KEY', transposeShift: line.transposeShift },
        });
        continue;
      }
      const isBlank = !line.segments || line.segments.length === 0;
      const height = isBlank
        ? m.blank
        : lineHasChord(line)
          ? m.contentWithChord
          : m.contentPlain;
      items.push({
        kind: 'content',
        height,
        line: { segments: line.segments || [], directive: null, transposeShift: null },
      });
    }
  }
  return items;
}

/**
 * Paginate + columnize a Render_Representation's sections.
 *
 * @param {object} rendered  { sections } from renderModel (chords already in
 *   the desired representation).
 * @param {object} opts
 * @param {object} opts.formatting  { size, columns, ... }
 * @returns {{ pages: Array<{ columns: Array<{ lines: Array }> }> }}
 */
function paginate(rendered, opts = {}) {
  const formatting = opts.formatting || {};
  const columns = Math.max(1, Number(formatting.columns) || 1);
  const m = metricsFor(formatting.size);

  const items = flattenToItems(rendered.sections, m);

  // Column usable height depends on which page we're on (page 1 reserves the
  // tall banner; later pages reserve a condensed 2-line header).
  const usableHeight = (pageIndex) =>
    USABLE_H - (pageIndex === 0 ? PInit : m.condensedHeader);

  const pages = [];
  let pageIndex = -1;
  let colIndex = 0;
  let y = 0;
  let currentPage = null;
  let currentCol = null;

  const startPage = () => {
    pageIndex += 1;
    currentPage = { columns: [] };
    for (let c = 0; c < columns; c += 1) currentPage.columns.push({ lines: [] });
    pages.push(currentPage);
    colIndex = 0;
    currentCol = currentPage.columns[0];
    y = 0;
  };

  const nextColumn = () => {
    if (colIndex < columns - 1) {
      colIndex += 1;
      currentCol = currentPage.columns[colIndex];
      y = 0;
    } else {
      startPage();
    }
  };

  startPage();

  const pushLine = (line) => currentCol.lines.push(line);

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];

    if (item.kind === 'pageBreak') {
      startPage();
      continue;
    }
    if (item.kind === 'columnBreak') {
      // Ignored entirely in single-column mode (never a visible line either).
      if (columns > 1) nextColumn();
      continue;
    }

    // Sticky header: measure header + the next content/transpose item so an
    // orphaned header moves to the next column with its content.
    let needed = item.height;
    if (item.kind === 'header' && item.sticky) {
      const next = items[i + 1];
      if (next && (next.kind === 'content' || next.kind === 'transpose')) {
        needed += next.height;
      }
    }

    // Auto-overflow: if this item (plus a stuck-to-it line) won't fit in the
    // remaining column height, flow to the next column/page first. The first
    // item on a fresh column is always placed even if taller than usable.
    if (y > 0 && y + needed > usableHeight(pageIndex)) {
      nextColumn();
    }

    if (item.kind === 'header') {
      pushLine({ header: item.header });
    } else {
      pushLine(item.line);
    }
    y += item.height;
  }

  return { pages };
}

module.exports = {
  paginate,
  // exported for tests / reuse
  metricsFor,
  ptToPx,
  PAGE_W,
  PAGE_H,
  MARGIN,
  COLUMN_GAP,
};
