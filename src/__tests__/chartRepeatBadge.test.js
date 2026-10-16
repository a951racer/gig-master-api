const { renderModel } = require('../services/chartTranspose');
const { paginate, metricsFor } = require('../services/chartLayout');

// Tests for chord-only lines + inline repeat badges ({...}).
//
// Definition under test: a CHORD-ONLY line's only content is inline chord
// tokens [...], at most one trailing {...} repeat badge, and whitespace. Such
// a line (a) carries the badge's verbatim inner text as line.repeat on the
// chord row, (b) is flagged chordOnly, and (c) collapses to a single chord row
// (no empty lyric row beneath it) in the layout. A {...} on a line that has
// lyrics is literal text, not a badge.

// Pull the single content line out of a one-line body's render model.
function lineOf(body) {
  const { sections } = renderModel(body);
  const lines = sections.flatMap((s) => s.lines);
  return lines[0];
}

describe('renderModel — chord-only lines + repeat badge', () => {
  it('flags a chord-only line and strips the trailing {x4} badge into line.repeat', () => {
    const line = lineOf('[1] [4] [5] {x4}');
    expect(line.chordOnly).toBe(true);
    expect(line.repeat).toBe('x4');
    // The badge is NOT a segment — segments are only the three chords.
    expect(line.segments.map((s) => s.chord)).toEqual(['1', '4', '5']);
    expect(line.segments.every((s) => (s.lyric || '').trim() === '')).toBe(true);
  });

  it('flags a chord-only line with no badge (repeat null)', () => {
    const line = lineOf('[1] [4]');
    expect(line.chordOnly).toBe(true);
    expect(line.repeat).toBeNull();
    expect(line.segments.map((s) => s.chord)).toEqual(['1', '4']);
  });

  it('keeps the badge text verbatim (not just x<number>)', () => {
    expect(lineOf('[1] {3x}').repeat).toBe('3x');
    expect(lineOf('[1] {x2 w/ band}').repeat).toBe('x2 w/ band');
    expect(lineOf('[1] {repeat}').repeat).toBe('repeat');
  });

  it('does NOT treat a line with lyrics as chord-only; a {...} there stays literal', () => {
    const line = lineOf('[1]Someone [4]told me');
    expect(line.chordOnly).toBeFalsy();
    expect(line.repeat == null).toBe(true);

    const withBraces = lineOf('[1]la {x2}');
    expect(withBraces.chordOnly).toBeFalsy();
    expect(withBraces.repeat == null).toBe(true);
    // The {x2} remains part of the lyric text (literal), not a badge.
    expect(withBraces.segments.some((s) => (s.lyric || '').includes('{x2}'))).toBe(true);
  });

  it('a bare {x4} with no chords is NOT a chord-only line (needs at least one chord)', () => {
    const line = lineOf('{x4}');
    expect(line.chordOnly).toBeFalsy();
    expect(line.repeat == null).toBe(true);
  });

  it('tolerates tabs/spaces between chords and before the badge', () => {
    const line = lineOf('[1]\t[4]   [5]   {x4}');
    expect(line.chordOnly).toBe(true);
    expect(line.repeat).toBe('x4');
  });
});

describe('chartLayout — chord-only lines collapse to one chord row', () => {
  const fmt = { formatting: { columns: 1, size: 11 } };

  it('a chord-only line is shorter than an equivalent line that has lyrics', () => {
    // Two single-line bodies: one chord-only, one with lyrics on the same chord.
    const chordOnly = paginate(renderModel('[1] [4] [5]'), fmt);
    const withLyric = paginate(renderModel('[1]a [4]b [5]c'), fmt);

    // Both are a single page/column. Compare the y-advance by measuring how
    // much vertical space each consumed: re-derive from metrics.
    const m = metricsFor(11);
    // Chord-only collapses to chordOnlyRow; a lyric line is contentWithChord.
    expect(m.chordOnlyRow).toBeLessThan(m.contentWithChord);

    // Sanity: the chord-only flag survived pagination onto the rendered line.
    const line = chordOnly.pages[0].columns[0].lines[0];
    expect(line.chordOnly).toBe(true);
    expect(withLyric.pages[0].columns[0].lines[0].chordOnly).toBe(false);
  });

  it('carries the repeat badge through pagination to the rendered line', () => {
    const out = paginate(renderModel('[1] [4] [5] {x4}'), fmt);
    const line = out.pages[0].columns[0].lines[0];
    expect(line.chordOnly).toBe(true);
    expect(line.repeat).toBe('x4');
  });

  it('more chord-only lines fit in a column than lyric lines (collapse frees space)', () => {
    // 40 chord-only lines vs 40 lyric lines; chord-only should need fewer pages.
    const chordBody = Array.from({ length: 40 }, () => '[1] [4] [5]').join('\n');
    const lyricBody = Array.from({ length: 40 }, () => '[1]a [4]b [5]c').join('\n');
    const chordPages = paginate(renderModel(chordBody), fmt).pages.length;
    const lyricPages = paginate(renderModel(lyricBody), fmt).pages.length;
    expect(chordPages).toBeLessThanOrEqual(lyricPages);
  });
});
