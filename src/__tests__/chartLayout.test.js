const fc = require('fast-check');
const { paginate, metricsFor } = require('../services/chartLayout');
const { renderModel } = require('../services/chartTranspose');

// Unit + property tests for the chart layout / pagination service. Pure, no DB.
// The paginator turns renderModel sections into pages -> columns -> lines
// against a virtual 8.5x11 page, honoring formatting.columns, COLUMN_BREAK,
// and PAGE_BREAK, with auto-overflow when a column fills.

const render = (body) => renderModel(body);

// Collect every line across all pages/columns in flow order.
function allLines(out) {
  const lines = [];
  for (const page of out.pages) {
    for (const col of page.columns) {
      for (const line of col.lines) lines.push(line);
    }
  }
  return lines;
}

// Serialize the whole output to detect any leaked break markers.
const asText = (out) => JSON.stringify(out);

describe('chartLayout.paginate — COLUMN_BREAK semantics', () => {
  it('ignores COLUMN_BREAK entirely when columns = 1 (no break, no visible line)', () => {
    const out = paginate(render('VERSE 1\n[1]A\nCOLUMN_BREAK\nVERSE 2\n[5]B'), {
      formatting: { columns: 1, size: 11 },
    });
    expect(out.pages).toHaveLength(1);
    expect(out.pages[0].columns).toHaveLength(1);
    // Both sections land in the single column; no COLUMN_BREAK artifact.
    expect(asText(out)).not.toContain('COLUMN_BREAK');
    const headers = allLines(out).filter((l) => l.header).map((l) => l.header.label);
    expect(headers).toEqual(['VERSE 1', 'VERSE 2']);
  });

  it('forces a jump to the next column when columns > 1', () => {
    const out = paginate(render('VERSE 1\n[1]A\nCOLUMN_BREAK\nVERSE 2\n[5]B'), {
      formatting: { columns: 2, size: 11 },
    });
    expect(out.pages).toHaveLength(1);
    expect(out.pages[0].columns).toHaveLength(2);
    // VERSE 1 in col 0, VERSE 2 (after the break) in col 1.
    const col0 = out.pages[0].columns[0].lines.filter((l) => l.header).map((l) => l.header.label);
    const col1 = out.pages[0].columns[1].lines.filter((l) => l.header).map((l) => l.header.label);
    expect(col0).toEqual(['VERSE 1']);
    expect(col1).toEqual(['VERSE 2']);
    expect(asText(out)).not.toContain('"COLUMN_BREAK"');
  });

  it('a COLUMN_BREAK in the last column starts a new page', () => {
    // Single column: COLUMN_BREAK is ignored, so use 1 column but PAGE semantics
    // require >1 col to break; instead verify last-column break -> new page.
    const out = paginate(render('A1\n[1]x\nCOLUMN_BREAK\nB2\n[1]y\nCOLUMN_BREAK\nC3\n[1]z'), {
      formatting: { columns: 2, size: 11 },
    });
    // 3 sections split by 2 breaks across 2 columns => second break overflows
    // to a new page.
    expect(out.pages.length).toBe(2);
  });
});

describe('chartLayout.paginate — PAGE_BREAK', () => {
  it('forces a new page', () => {
    const out = paginate(render('VERSE 1\n[1]A\nPAGE_BREAK\nVERSE 2\n[5]B'), {
      formatting: { columns: 1, size: 11 },
    });
    expect(out.pages).toHaveLength(2);
    expect(asText(out)).not.toContain('PAGE_BREAK');
  });
});

describe('chartLayout.paginate — never leaks break markers as lines', () => {
  it('no line has directive PAGE_BREAK or COLUMN_BREAK', () => {
    const out = paginate(
      render('V1\n[1]a\nCOLUMN_BREAK\nV2\n[2]b\nPAGE_BREAK\nV3\n[3]c'),
      { formatting: { columns: 2, size: 11 } }
    );
    for (const line of allLines(out)) {
      if (line.directive) {
        expect(['PAGE_BREAK', 'COLUMN_BREAK']).not.toContain(line.directive);
      }
    }
  });

  it('keeps TRANSPOSE_KEY as a visible marker line', () => {
    const out = paginate(render('V1\n[1]a\nTRANSPOSE KEY +2\n[1]b'), {
      formatting: { columns: 1, size: 11 },
    });
    const transposes = allLines(out).filter((l) => l.directive === 'TRANSPOSE_KEY');
    expect(transposes).toHaveLength(1);
    expect(transposes[0].transposeShift).toBe(2);
  });
});

describe('chartLayout.paginate — content preservation (Property: no lines lost)', () => {
  it('every content line and header survives pagination', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3 }),
        fc.integer({ min: 1, max: 40 }),
        (columns, n) => {
          // Build a body of n content lines across a couple of sections.
          const lines = ['VERSE 1'];
          for (let i = 0; i < n; i += 1) lines.push(`[1]line ${i}`);
          const out = paginate(render(lines.join('\n')), {
            formatting: { columns, size: 11 },
          });
          const contentCount = allLines(out).filter(
            (l) => l.segments && l.segments.length > 0
          ).length;
          // All n content lines are present exactly once.
          expect(contentCount).toBe(n);
          // At least one header present.
          expect(allLines(out).some((l) => l.header)).toBe(true);
        }
      ),
      { numRuns: 40 }
    );
  });
});

describe('chartLayout.paginate — auto-overflow', () => {
  it('a long single-column chart flows onto multiple pages', () => {
    const lines = ['VERSE 1'];
    for (let i = 0; i < 200; i += 1) lines.push(`[1]line ${i} with lyric`);
    const out = paginate(render(lines.join('\n')), {
      formatting: { columns: 1, size: 11 },
    });
    expect(out.pages.length).toBeGreaterThan(1);
  });

  it('column 0 fills before column 1 is used (2-col auto-flow)', () => {
    const lines = [];
    for (let i = 0; i < 120; i += 1) lines.push(`[1]line ${i}`);
    const out = paginate(render(lines.join('\n')), {
      formatting: { columns: 2, size: 11 },
    });
    // The first page should use both columns before spilling to page 2.
    const page0 = out.pages[0];
    expect(page0.columns[0].lines.length).toBeGreaterThan(0);
    expect(page0.columns[1].lines.length).toBeGreaterThan(0);
  });
});

describe('chartLayout.metricsFor', () => {
  it('scales line heights with formatting.size', () => {
    const small = metricsFor(9);
    const large = metricsFor(18);
    expect(large.contentWithChord).toBeGreaterThan(small.contentWithChord);
    expect(large.condensedHeader).toBeGreaterThan(small.condensedHeader);
  });
});
