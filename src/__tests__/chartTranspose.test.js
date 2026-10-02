const fc = require('fast-check');

const {
  parseChord,
  namesToNumbers,
  numbersToNames,
} = require('../services/chartTranspose');
const { getSupportedKeys } = require('../services/chartSpelling');

// These are PURE unit/property tests for the transposition service
// (src/services/chartTranspose.js). The service is synchronous and DB-free —
// no mongoose connection, model, or supertest here. We exercise the public
// namesToNumbers / numbersToNames round-trip, the per-key spelling tables, the
// opaque quality/extension handling, and the running TRANSPOSE KEY offset.
//
// Task 1.5 (song-charts spec). Correctness Properties validated:
//   Property 3  Round-trip fidelity        (Requirements 5.3)
//   Property 4  Transpose correctness       (Requirements 6.2)
//   Property 5  Quality opacity             (Requirements 3.2)
//   Property 11 Mid-song transpose          (Requirements 5.3, 3.1)

// -------------------------------------------------------------------------
// fast-check generators
// -------------------------------------------------------------------------

// A number chord root as the canonical body stores it: a bare diatonic degree
// 1-7, or a non-diatonic degree spelled as a diatonic degree + single
// accidental, matching OFFSET_TO_NUMBER_ROOT in the service
// (b2, b3, #4, b6, b7). We draw from the exact 12 canonical number roots so
// generated bodies are always valid canonical numbers input.
const CANONICAL_NUMBER_ROOTS = [
  '1', 'b2', '2', 'b3', '3', '4', '#4', '5', 'b6', '6', 'b7', '7',
];
const numberRootArb = fc.constantFrom(...CANONICAL_NUMBER_ROOTS);

// Opaque quality/extension suffixes carried verbatim by the service. Includes
// the empty string (plain major/root) and the symbol forms from the grammar.
const qualityArb = fc.constantFrom(
  '', 'm', 'maj7', '7', 'sus4', 'sus2', 'add9', 'dim', 'aug', '°', 'ø', 'Δ', 'm7b5',
);

// A full number chord token: root + opaque quality + optional /bass. Rendered
// as the text that goes inside [...].
const numberChordArb = fc
  .record({
    root: numberRootArb,
    quality: qualityArb,
    bass: fc.option(numberRootArb, { nil: null }),
  })
  .map(({ root, quality, bass }) => `${root}${quality}${bass ? `/${bass}` : ''}`);

// A supported major key.
const keyArb = fc.constantFrom(...getSupportedKeys());

// Build a chart body from a list of number chord tokens, interleaved with some
// lyric text / headers / blank lines so the "leave non-chord content alone"
// paths are also exercised. Returns the numbers body string.
function buildNumbersBody(tokens) {
  const lines = ['VERSE 1'];
  tokens.forEach((tok, i) => {
    lines.push(`[${tok}]lyric word ${i}`);
    if (i % 3 === 2) lines.push(''); // occasional blank line
  });
  return lines.join('\n');
}

const numbersBodyArb = fc
  .array(numberChordArb, { minLength: 1, maxLength: 10 })
  .map(buildNumbersBody);

// -------------------------------------------------------------------------
// Property 3: Round-trip fidelity
//   numbersToNames(namesToNumbers(body, K), K) reproduces the original chords.
// We start from a canonical NUMBERS body, render it to names-in-K, convert
// back to numbers, and require the numbers body to be identical. That composed
// round-trip (numbers -> names -> numbers) exercises both directions and is
// the strongest statement of fidelity for canonical storage.
// -------------------------------------------------------------------------
describe('chartTranspose — Property 3: Round-trip fidelity', () => {
  // Validates: Requirements 5.3
  it('Property 3: numbers -> names-in-K -> numbers is identity across supported keys', () => {
    fc.assert(
      fc.property(keyArb, numbersBodyArb, (key, numbersBody) => {
        const names = numbersToNames(numbersBody, key);
        const back = namesToNumbers(names, key);
        expect(back).toBe(numbersBody);
      }),
      { numRuns: 100 }
    );
  });

  // Validates: Requirements 5.3
  it('Property 3: names -> numbers -> names-in-K reproduces the authored names', () => {
    // Author directly in names: render a numbers body to names in K first to
    // obtain a known-good names body, then assert names -> numbers -> names is
    // stable (idempotent) in that key.
    fc.assert(
      fc.property(keyArb, numbersBodyArb, (key, numbersBody) => {
        const names = numbersToNames(numbersBody, key);
        const numbers = namesToNumbers(names, key);
        const namesAgain = numbersToNames(numbers, key);
        expect(namesAgain).toBe(names);
      }),
      { numRuns: 100 }
    );
  });
});

// -------------------------------------------------------------------------
// Property 4: Transpose correctness
//   numbersToNames(body, K) yields the musically-expected names per key.
// Table-driven, hand-checked against the design's spelling rules.
// -------------------------------------------------------------------------
describe('chartTranspose — Property 4: Transpose correctness', () => {
  // Each case: a numbers body line, a key, and the expected names line.
  const cases = [
    // G: diatonic I-IV-V-vi -> G C D Em
    { key: 'G', numbers: '[1][4][5][6m]', names: '[G][C][D][Em]' },
    // Bb: I and vi -> Bb Gm
    { key: 'Bb', numbers: '[1][6m]', names: '[Bb][Gm]' },
    // C: diatonic I-IV-V-vi -> C F G Am
    { key: 'C', numbers: '[1][4][5][6m]', names: '[C][F][G][Am]' },
    // D: V/VII slash chord -> A/C# ; vi -> Bm
    { key: 'D', numbers: '[5/7][6m]', names: '[A/C#][Bm]' },
    // G: non-diatonic lowered third -> Bb (letter B, degree-based spelling)
    { key: 'G', numbers: '[b3]', names: '[Bb]' },
    // Bb: the same lowered third is Db in a flat key
    { key: 'Bb', numbers: '[b3]', names: '[Db]' },
    // G: raised fourth -> C#
    { key: 'G', numbers: '[#4]', names: '[C#]' },
    // G: V/VII slash chord -> D/F# (design's canonical example)
    { key: 'G', numbers: '[5/7]', names: '[D/F#]' },
  ];

  cases.forEach(({ key, numbers, names }) => {
    // Validates: Requirements 6.2
    it(`Property 4: numbersToNames("${numbers}", "${key}") -> "${names}"`, () => {
      expect(numbersToNames(numbers, key)).toBe(names);
    });
  });

  // Validates: Requirements 6.2 — the reverse direction for the same facts.
  it('Property 4: namesToNumbers reverses the table-driven cases', () => {
    cases.forEach(({ key, numbers, names }) => {
      expect(namesToNumbers(names, key)).toBe(numbers);
    });
  });
});

// -------------------------------------------------------------------------
// Property 5: Quality opacity
//   Qualities/extensions and /bass survive name<->number conversion unchanged.
// -------------------------------------------------------------------------
describe('chartTranspose — Property 5: Quality opacity', () => {
  // Validates: Requirements 3.2
  it('Property 5: opaque quality suffixes survive numbers -> names -> numbers unchanged', () => {
    fc.assert(
      fc.property(keyArb, numberRootArb, qualityArb, (key, root, quality) => {
        const numbers = `[${root}${quality}]`;
        const names = numbersToNames(numbers, key);
        // The quality suffix must appear verbatim in the names output.
        expect(names.endsWith(`${quality}]`)).toBe(true);
        // And the full round-trip restores the exact token.
        expect(namesToNumbers(names, key)).toBe(numbers);
      }),
      { numRuns: 100 }
    );
  });

  // Validates: Requirements 3.2 — explicit symbol-form and /bass examples.
  it('Property 5: maj7, sus4, add9, °, ø, Δ and a /bass are carried verbatim (key G)', () => {
    const samples = [
      { numbers: '[1maj7]', names: '[Gmaj7]' },
      { numbers: '[5sus4]', names: '[Dsus4]' },
      { numbers: '[1add9]', names: '[Gadd9]' },
      { numbers: '[7°]', names: '[F#°]' },
      { numbers: '[7ø]', names: '[F#ø]' },
      { numbers: '[1Δ]', names: '[GΔ]' },
      { numbers: '[1maj7/3]', names: '[Gmaj7/B]' },
    ];
    samples.forEach(({ numbers, names }) => {
      expect(numbersToNames(numbers, 'G')).toBe(names);
      expect(namesToNumbers(names, 'G')).toBe(numbers);
    });
  });

  // Validates: Requirements 3.2 — the quality is attached to the chord root,
  // not the bass, and the bass transposes independently.
  it('Property 5: quality on root with an independent /bass round-trips', () => {
    fc.assert(
      fc.property(keyArb, numberRootArb, qualityArb, numberRootArb, (key, root, quality, bass) => {
        const numbers = `[${root}${quality}/${bass}]`;
        const names = numbersToNames(numbers, key);
        expect(namesToNumbers(names, key)).toBe(numbers);
      }),
      { numRuns: 100 }
    );
  });
});

// -------------------------------------------------------------------------
// Property 11: Mid-song transpose consistency
//   TRANSPOSE KEY <±n> directives apply a cumulative running offset to all
//   subsequent lines; round-trip holds across key changes; directive lines are
//   preserved verbatim in output.
// -------------------------------------------------------------------------
describe('chartTranspose — Property 11: Mid-song transpose consistency', () => {
  // Validates: Requirements 5.3, 3.1
  it('Property 11: a single +2 directive shifts subsequent chords up two semitones (key C)', () => {
    const numbers = ['[1]', 'TRANSPOSE KEY +2', '[1]'].join('\n');
    // Before the directive the tonic of C is C; after +2 it renders as D.
    const names = numbersToNames(numbers, 'C');
    expect(names).toBe(['[C]', 'TRANSPOSE KEY +2', '[D]'].join('\n'));
    // Directive line preserved and full round-trip restores the numbers body.
    expect(names).toContain('TRANSPOSE KEY +2');
    expect(namesToNumbers(names, 'C')).toBe(numbers);
  });

  // Validates: Requirements 5.3, 3.1
  it('Property 11: two directives (+2 then -1) accumulate (key C -> D -> Db)', () => {
    const numbers = [
      '[1]',
      'TRANSPOSE KEY +2',
      '[1]',
      'TRANSPOSE KEY -1',
      '[1]',
    ].join('\n');
    const names = numbersToNames(numbers, 'C');
    // Running offset: 0 -> C, +2 -> D, +2-1=+1 -> Db.
    expect(names).toBe([
      '[C]',
      'TRANSPOSE KEY +2',
      '[D]',
      'TRANSPOSE KEY -1',
      '[Db]',
    ].join('\n'));
    expect(namesToNumbers(names, 'C')).toBe(numbers);
  });

  // Validates: Requirements 5.3, 3.1 — round-trip holds across key changes for
  // randomized bodies that include two directives in the middle.
  it('Property 11: round-trip holds across two mid-song key changes', () => {
    const segmentArb = fc.array(numberChordArb, { minLength: 1, maxLength: 4 });
    fc.assert(
      fc.property(
        keyArb,
        segmentArb,
        segmentArb,
        segmentArb,
        fc.integer({ min: -5, max: 5 }),
        fc.integer({ min: -5, max: 5 }),
        (key, segA, segB, segC, shift1, shift2) => {
          const lineOf = (toks) => toks.map((t) => `[${t}]`).join(' ');
          const numbers = [
            lineOf(segA),
            `TRANSPOSE KEY ${shift1 >= 0 ? '+' : ''}${shift1}`,
            lineOf(segB),
            `TRANSPOSE KEY ${shift2 >= 0 ? '+' : ''}${shift2}`,
            lineOf(segC),
          ].join('\n');

          const names = numbersToNames(numbers, key);
          // Both directive lines are preserved verbatim.
          expect(names).toContain(`TRANSPOSE KEY ${shift1 >= 0 ? '+' : ''}${shift1}`);
          expect(names).toContain(`TRANSPOSE KEY ${shift2 >= 0 ? '+' : ''}${shift2}`);
          // Round-trip in the entry key reproduces the canonical numbers body.
          expect(namesToNumbers(names, key)).toBe(numbers);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// -------------------------------------------------------------------------
// Focused edge-case unit tests seen in the service / spelling code.
// -------------------------------------------------------------------------
describe('chartTranspose — edge cases', () => {
  it('throws on an unsupported key', () => {
    expect(() => numbersToNames('[1]', 'H')).toThrow(/supported major key/i);
    expect(() => namesToNumbers('[C]', 'Zz')).toThrow(/supported major key/i);
  });

  it('accepts F# as the canonical Gb key', () => {
    // F# must be normalized to Gb and spell identically.
    expect(numbersToNames('[1][4][5]', 'F#')).toBe(numbersToNames('[1][4][5]', 'Gb'));
    // In Gb/F#, degree 1 is Gb.
    expect(numbersToNames('[1]', 'F#')).toBe('[Gb]');
  });

  it('spells a flat-key non-diatonic root with flats (b3 in Bb = Db)', () => {
    expect(numbersToNames('[b3]', 'Bb')).toBe('[Db]');
    // Sanity: same degree in a sharp-leaning key (G) stays Bb.
    expect(numbersToNames('[b3]', 'G')).toBe('[Bb]');
  });

  it('rejects a names token when converting numbers -> names (wrong token mode)', () => {
    expect(() => numbersToNames('[C]', 'G')).toThrow(/expected a numbers chord/i);
  });

  it('rejects a numbers token when converting names -> numbers (wrong token mode)', () => {
    expect(() => namesToNumbers('[1]', 'G')).toThrow(/expected a names chord/i);
  });

  it('parseChord splits root, quality, and bass for a numbers slash chord', () => {
    expect(parseChord('5/7')).toEqual({
      mode: 'numbers',
      root: '5',
      accidental: '',
      quality: '',
      bass: { root: '7', accidental: '' },
    });
  });

  it('parseChord captures a leading accidental and opaque quality in numbers mode', () => {
    expect(parseChord('b3m7')).toEqual({
      mode: 'numbers',
      root: '3',
      accidental: 'b',
      quality: 'm7',
      bass: null,
    });
  });

  it('parseChord captures a trailing accidental in names mode (F#)', () => {
    expect(parseChord('D/F#')).toEqual({
      mode: 'names',
      root: 'D',
      accidental: '',
      quality: '',
      bass: { root: 'F', accidental: '#' },
    });
  });

  it('parseChord throws on a malformed / mixed-representation token', () => {
    expect(() => parseChord('')).toThrow(/empty/i);
    expect(() => parseChord('X')).toThrow(/must start with a root/i);
    // Mixing a names bass onto a numbers chord is rejected.
    expect(() => parseChord('5/F')).toThrow(/cannot mix numbers and names/i);
  });
});
