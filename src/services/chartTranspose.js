/**
 * Chart transposition service.
 *
 * Pure, synchronous, DB-free. This is the single implementation behind chart
 * writing (names -> numbers), viewing (numbers -> names-in-key), and PDF
 * rendering (design.md — "Transposition Service (API)", R6.4).
 *
 * The full service surface (per design.md) is:
 *
 *   parseChord(token)         -> parsed chord token  | throws on malformed
 *   namesToNumbers(body, key) -> numbers body                      // task 1.3
 *   numbersToNames(body, key) -> names body in key                 // task 1.3
 *   renderModel(body)         -> Render_Representation              // task 1.4
 *
 * This file currently implements ONLY `parseChord` and its small internal
 * helpers (task 1.2). The remaining functions are added by later tasks in
 * this SAME file; they will build on `parseChord` to transform chord tokens
 * while leaving lyric text / headers / directives / markup untouched.
 *
 * Chord token grammar (design.md — "Authoring grammar"):
 *
 *   <root><quality?><extension?>(/<bassRoot>)?
 *
 *   - root (numbers representation): a scale degree 1-7 with an optional
 *     leading accidental `b` or `#` for non-diatonic roots (e.g. `b3`, `#4`).
 *   - root (names representation): a letter A-G with an optional `b`/`#`.
 *   - quality/extension: a free suffix carried VERBATIM / opaque (`m`,
 *     `maj7`, `7`, `sus4`, `add9`, `dim`, `aug`, and the symbol forms
 *     `°`, `ø`, `Δ`, ...). The service never interprets it; it only
 *     transposes the root(s). Treating quality as opaque supports arbitrary
 *     chords (R3.2) and guarantees round-trip fidelity (R5.3) because the
 *     suffix is re-emitted unchanged.
 *   - slash/bass: an optional `/<bassRoot>`, a degree (numbers) or letter
 *     (names), parsed exactly like the root.
 */

'use strict';

const {
  getSpelling,
  isSupportedKey,
  normalizeKey,
  degreeToSemitone,
  getSupportedKeys,
} = require('./chartSpelling');

/**
 * A parsed chord root — the degree-or-letter plus any single accidental.
 *
 * @typedef {Object} ChordRoot
 * @property {('numbers'|'names')} mode  Which representation the root was
 *   parsed in. Determined by whether the root is a digit (numbers) or a
 *   letter (names).
 * @property {string} root  The bare root WITHOUT its accidental: a scale
 *   degree `'1'`-`'7'` in numbers mode, or a letter `'A'`-`'G'` in names mode.
 * @property {(''|'b'|'#')} accidental  The leading accidental, or `''` when
 *   the root is natural/diatonic.
 */

/**
 * A parsed chord token.
 *
 * The returned shape is:
 *
 *   {
 *     mode:       'numbers' | 'names',   // representation of the roots
 *     root:       '1'..'7' | 'A'..'G',   // bare root, no accidental
 *     accidental: '' | 'b' | '#',        // root accidental
 *     quality:    string,                // opaque suffix, '' when none
 *     bass:       { root, accidental } | null  // slash/bass root, or null
 *   }
 *
 * `mode` is also surfaced for the root so later transposition code can tell
 * numbers from names without re-sniffing. The `bass` object (when present)
 * carries the same `root`/`accidental` pair; its mode always matches the
 * chord's `mode`.
 *
 * @typedef {Object} ParsedChord
 * @property {('numbers'|'names')} mode
 * @property {string} root
 * @property {(''|'b'|'#')} accidental
 * @property {string} quality
 * @property {?{root: string, accidental: ('' | 'b' | '#')}} bass
 */

/**
 * Matches a NUMBERS root at the START of a string: an optional LEADING
 * accidental (`b`/`#`) followed by a scale degree 1-7. Capture groups:
 *   1 = accidental (`b` | `#` | empty)
 *   2 = degree (a single digit 1-7)
 *
 * Non-diatonic roots are written with a leading accidental, e.g. `b3`, `#4`
 * (design.md — "Authoring grammar").
 */
const NUMBER_ROOT_RE = /^([b#]?)([1-7])/;

/**
 * Matches a NAMES root at the START of a string: a letter A-G followed by an
 * optional TRAILING accidental (`b`/`#`). Capture groups:
 *   1 = letter (a single letter A-G)
 *   2 = accidental (`b` | `#` | empty)
 *
 * Note names carry the accidental after the letter, e.g. `F#`, `Bb`
 * (canonical example `D/F#` in design.md — "Authoring grammar").
 */
const NAME_ROOT_RE = /^([A-G])([b#]?)/;

/**
 * Detect the representation of a token from its first meaningful character.
 * A leading `b`/`#` or digit means numbers; a letter A-G means names.
 *
 * @param {string} text  The (trimmed) token.
 * @returns {('numbers'|'names'|null)}  The detected mode, or null if neither.
 */
function detectMode(text) {
  if (/^[b#]?[1-7]/.test(text)) {
    return 'numbers';
  }
  if (/^[A-G]/.test(text)) {
    return 'names';
  }
  return null;
}

/**
 * Parse a single chord root from the front of `rest`, in a fixed `mode`.
 *
 * Enforces that the root uses the representation implied by `mode` (so a
 * numbers chord cannot have a names bass, and vice versa). Returns the parsed
 * root plus the remaining, unconsumed suffix. Accidentals lead the root in
 * numbers mode (`b3`) and trail it in names mode (`F#`).
 *
 * @param {string} rest  Text beginning with a root (e.g. `"b3m"`, `"F#"`).
 * @param {('numbers'|'names')} mode  Required representation for the root.
 * @param {string} token  The full original token (for error messages).
 * @param {string} what   Label for error messages, e.g. `"root"` or `"bass"`.
 * @returns {{ parsedRoot: ChordRoot, remainder: string }}
 * @throws {Error} When no valid root is found or it is in the wrong mode.
 */
function parseRoot(rest, mode, token, what) {
  // Reject a root that is clearly in the OTHER representation, so we can give
  // a precise "cannot mix numbers and names" error rather than a generic one.
  const foundMode = detectMode(rest);
  if (foundMode && foundMode !== mode) {
    throw new Error(
      `Invalid chord token "${token}": the ${what} is a ${foundMode} root ` +
        `but the chord is a ${mode} chord; a chord cannot mix numbers and names.`
    );
  }

  const re = mode === 'numbers' ? NUMBER_ROOT_RE : NAME_ROOT_RE;
  const match = re.exec(rest);
  if (!match) {
    throw new Error(
      `Invalid chord token "${token}": expected a ${mode} ${what} ` +
        (mode === 'numbers'
          ? '(a scale degree 1-7 with an optional leading b/#)'
          : '(a letter A-G with an optional trailing b/#)') +
        ` but found "${rest}".`
    );
  }

  const consumed = match[0];
  // Group order differs by representation: [accidental, degree] for numbers,
  // [letter, accidental] for names.
  const root = mode === 'numbers' ? match[2] : match[1];
  const accidental = (mode === 'numbers' ? match[1] : match[2]) || '';

  return {
    parsedRoot: {
      mode,
      root,
      accidental,
    },
    remainder: rest.slice(consumed.length),
  };
}

/**
 * Parse a chord token into its structured parts.
 *
 * Representation is AUTO-DETECTED from the root: a leading digit (after an
 * optional accidental) means the numbers representation; a leading letter
 * means names. The detected mode is then required consistently across the
 * token's bass root as well.
 *
 * Quality/extension is captured opaquely: everything between the root and an
 * optional `/<bass>` is returned verbatim as `quality` without interpretation.
 *
 * @param {string} token  The text inside `[...]`, e.g. `"6m"`, `"5sus4"`,
 *   `"5/7"`, `"#1dim"`, `"D/F#"`, `"Cmaj7"`.
 * @returns {ParsedChord}
 * @throws {Error} With a descriptive message on a malformed token.
 */
function parseChord(token) {
  if (typeof token !== 'string') {
    throw new Error(
      `Invalid chord token: expected a string but received ${typeof token}.`
    );
  }

  const trimmed = token.trim();
  if (trimmed === '') {
    throw new Error('Invalid chord token: token is empty.');
  }

  // Auto-detect representation from the start of the token: a leading b/#
  // or digit means numbers; a letter A-G means names.
  const mode = detectMode(trimmed);
  if (!mode) {
    throw new Error(
      `Invalid chord token "${token}": must start with a root — a scale ` +
        `degree 1-7 (numbers, with an optional leading b/#) or a letter A-G ` +
        `(names, with an optional trailing b/#).`
    );
  }

  // Parse the main root.
  const { parsedRoot, remainder } = parseRoot(trimmed, mode, token, 'root');

  // Split any slash/bass from the quality. Only the FIRST `/` is treated as
  // the bass separator; `quality` is whatever precedes it (opaque), and the
  // bass root is parsed from what follows.
  const slashIndex = remainder.indexOf('/');

  let quality;
  let bass = null;

  if (slashIndex === -1) {
    quality = remainder;
  } else {
    quality = remainder.slice(0, slashIndex);
    const bassText = remainder.slice(slashIndex + 1);

    if (bassText === '') {
      throw new Error(
        `Invalid chord token "${token}": a slash chord must specify a bass ` +
          `root after "/".`
      );
    }

    const bassResult = parseRoot(bassText, mode, token, 'bass');
    if (bassResult.remainder !== '') {
      // The bass root must be the LAST thing in the token — anything trailing
      // (e.g. a second slash, or extra characters) is malformed.
      throw new Error(
        `Invalid chord token "${token}": unexpected characters ` +
          `"${bassResult.remainder}" after the bass root.`
      );
    }
    bass = {
      root: bassResult.parsedRoot.root,
      accidental: bassResult.parsedRoot.accidental,
    };
  }

  return {
    mode,
    root: parsedRoot.root,
    accidental: parsedRoot.accidental,
    quality,
    bass,
  };
}

/* ------------------------------------------------------------------------- *
 * Running-transpose conversion (task 1.3)
 *
 * namesToNumbers(body, key) and numbersToNames(body, key) walk the body one
 * line at a time, maintaining a running semitone offset that starts at 0 and
 * is bumped by each `TRANSPOSE KEY <±n>` directive line (cumulative, affecting
 * all SUBSEQUENT lines — design.md, "Mid-song key changes"). The "active
 * tonic" for a line is the base `key` transposed up by that running offset
 * (mod 12). Only the chord tokens inside `[...]` are transformed; lyric text,
 * section headers, directive lines (incl. the preserved `TRANSPOSE KEY` line),
 * blank lines, and `<b>`/`<i>` markup pass through verbatim.
 * ------------------------------------------------------------------------- */

/**
 * Pitch class (0-11, C = 0) of a bare note LETTER A-G, before any accidental.
 * @type {Readonly<Record<string, number>>}
 */
const LETTER_TO_PITCH_CLASS = Object.freeze({
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
});

/**
 * Signed semitone shift for an accidental: `b` = -1, `#` = +1, none = 0.
 *
 * @param {(''|'b'|'#')} accidental
 * @returns {number}
 */
function accidentalShift(accidental) {
  if (accidental === 'b') return -1;
  if (accidental === '#') return 1;
  return 0;
}

/**
 * The chromatic pitch class (0-11) of a names-mode root (letter + accidental).
 *
 * @param {string} letter  A letter A-G.
 * @param {(''|'b'|'#')} accidental
 * @returns {number} pitch class 0-11
 */
function namePitchClass(letter, accidental) {
  const base = LETTER_TO_PITCH_CLASS[letter];
  return (((base + accidentalShift(accidental)) % 12) + 12) % 12;
}

/**
 * Map a chromatic semitone offset (0-11, above the tonic) to its Nashville
 * degree root in the NUMBERS representation: a bare degree for the seven
 * diatonic offsets, else a diatonic degree with a single leading accidental
 * (design.md — "Name -> number", "Diatonic mapping"). This is the exact
 * inverse of `degreeToSemitone(degree) ± accidental`, and is key-independent
 * (the degree numbering does not depend on the key's spelling).
 *
 *   0->1  1->b2  2->2  3->b3  4->3  5->4  6->#4  7->5  8->b6  9->6  10->b7  11->7
 *
 * @type {ReadonlyArray<string>}
 */
const OFFSET_TO_NUMBER_ROOT = Object.freeze([
  '1', 'b2', '2', 'b3', '3', '4', '#4', '5', 'b6', '6', 'b7', '7',
]);

/**
 * Pitch class (0-11) of a supported major key's tonic. Reuses the key's own
 * spelling table: offset 0 is always the tonic, so its pitch class equals the
 * tonic's letter+accidental pitch class.
 *
 * @param {string} key  A supported major key (already validated by caller).
 * @returns {number} pitch class 0-11 of the key's tonic
 */
function keyTonicPitchClass(key) {
  const tonicSpelling = getSpelling(key, 0); // e.g. 'G', 'Bb', 'F#'
  const letter = tonicSpelling[0];
  const accidental = tonicSpelling.slice(1); // '', 'b', or '#'
  return namePitchClass(letter, accidental);
}

/**
 * Parse a `TRANSPOSE KEY <±n>` directive line, returning the signed shift `n`,
 * or `null` if the (trimmed) line is not such a directive.
 *
 * @param {string} line
 * @returns {number|null}
 */
function parseTransposeDirective(line) {
  const match = /^TRANSPOSE KEY\s+([+-]?\d+)$/.exec(line.trim());
  if (!match) return null;
  return parseInt(match[1], 10);
}

/**
 * Transform every inline `[chord]` token on a line, leaving everything else
 * (lyric text, markup, surrounding characters) untouched. The chord text
 * between the brackets is handed to `transformToken`; a thrown error from the
 * transform propagates (so a malformed token fails the conversion).
 *
 * @param {string} line
 * @param {(token: string) => string} transformToken
 * @returns {string}
 */
function transformChordTokens(line, transformToken, lenient = false) {
  return line.replace(/\[([^\]]*)\]/g, (whole, inner) => {
    try {
      const converted = transformToken(inner);
      return `[${converted}]`;
    } catch (err) {
      // In lenient mode a token we cannot parse/convert is left EXACTLY as the
      // author typed it (brackets preserved), so the valid chords around it
      // still render while the bad one shows verbatim. In strict mode the
      // error propagates (used by the save path when it must be canonical).
      if (lenient) return whole;
      throw err;
    }
  });
}

/**
 * Split a body into lines while remembering the exact line terminators so the
 * output preserves the original `\n` / `\r\n` style and trailing newline.
 *
 * @param {string} body
 * @returns {{ lines: string[], eols: string[] }} parallel arrays; `eols[i]` is
 *   the terminator that followed `lines[i]` (`''` for the final line when the
 *   body had no trailing newline).
 */
function splitLines(body) {
  const lines = [];
  const eols = [];
  const re = /\r\n|\n|\r/g;
  let lastIndex = 0;
  let match;
  while ((match = re.exec(body)) !== null) {
    lines.push(body.slice(lastIndex, match.index));
    eols.push(match[0]);
    lastIndex = re.lastIndex;
  }
  lines.push(body.slice(lastIndex));
  eols.push('');
  return { lines, eols };
}

/**
 * Convert one names-mode root (letter + accidental) to its NUMBERS root
 * relative to an active tonic pitch class.
 *
 * @param {{root: string, accidental: ('' | 'b' | '#')}} nameRoot
 * @param {number} activeTonicPc  pitch class 0-11 of the active tonic
 * @returns {string} the numbers root (bare degree or accidental+degree)
 */
function nameRootToNumber(nameRoot, activeTonicPc) {
  const pc = namePitchClass(nameRoot.root, nameRoot.accidental);
  const offset = ((pc - activeTonicPc) % 12 + 12) % 12;
  return OFFSET_TO_NUMBER_ROOT[offset];
}

/**
 * Convert one numbers-mode root (degree + accidental) to its NAMES spelling
 * for the base `key` plus a running offset.
 *
 * @param {{root: string, accidental: ('' | 'b' | '#')}} numberRoot
 * @param {string} key  base major key (validated by caller)
 * @param {number} runningOffset  cumulative TRANSPOSE KEY offset for this line
 * @returns {string} the spelled note name (letter + optional single accidental)
 */
function numberRootToName(numberRoot, key, runningOffset) {
  const degree = parseInt(numberRoot.root, 10);
  const semitone = degreeToSemitone(degree) + accidentalShift(numberRoot.accidental);
  const offset = ((semitone + runningOffset) % 12 + 12) % 12;
  return getSpelling(key, offset);
}

/**
 * Convert a chart body from the NAMES representation to the canonical NUMBERS
 * representation, relative to `key` and any mid-song `TRANSPOSE KEY` shifts.
 *
 * Each `[chord]` token is parsed in names mode; its root (and `/bass`, if any)
 * is numbered against the active tonic (`key` transposed up the running offset)
 * while its opaque quality/extension suffix is carried through unchanged. All
 * non-chord content — lyrics, headers, directives (including the preserved
 * `TRANSPOSE KEY` lines), blank lines, and `<b>`/`<i>` markup — is untouched.
 *
 * @param {string} body  the chart body typed as chord names in `key`
 * @param {string} key   the (major) key the names are written in; required
 * @returns {string} the equivalent numbers body
 * @throws {Error} if `key` is unsupported, or a token is malformed / in the
 *   wrong (numbers) representation.
 */
function namesToNumbers(body, key, options = {}) {
  if (typeof body !== 'string') {
    throw new Error(
      `Invalid chart body: expected a string but received ${typeof body}.`
    );
  }
  if (!isSupportedKey(key)) {
    throw new Error(
      `namesToNumbers requires a supported major key but received ` +
        `${JSON.stringify(key)}. Supported keys: ${getSupportedKeys().join(', ')} ` +
        `(F# accepted as Gb).`
    );
  }

  const lenient = options.lenient === true;
  const canonicalKey = normalizeKey(key);
  const baseTonicPc = keyTonicPitchClass(canonicalKey);
  const { lines, eols } = splitLines(body);

  let runningOffset = 0;
  const out = lines.map((line, i) => {
    const shift = parseTransposeDirective(line);
    if (shift !== null) {
      // Preserve the directive verbatim; apply it to SUBSEQUENT lines.
      runningOffset += shift;
      return line + eols[i];
    }

    const activeTonicPc = ((baseTonicPc + runningOffset) % 12 + 12) % 12;
    const converted = transformChordTokens(line, (tokenText) => {
      const parsed = parseChord(tokenText);
      if (parsed.mode !== 'names') {
        throw new Error(
          `Invalid chord token "${tokenText}": expected a names chord ` +
            `(letter A-G root) when converting names to numbers.`
        );
      }
      const rootNum = nameRootToNumber(
        { root: parsed.root, accidental: parsed.accidental },
        activeTonicPc
      );
      let result = rootNum + parsed.quality;
      if (parsed.bass) {
        result += '/' + nameRootToNumber(parsed.bass, activeTonicPc);
      }
      return result;
    }, lenient);
    return converted + eols[i];
  });

  return out.join('');
}

/**
 * Convert a chart body from the canonical NUMBERS representation to the NAMES
 * representation spelled for `key`, honoring mid-song `TRANSPOSE KEY` shifts.
 *
 * Each `[chord]` token is parsed in numbers mode; its root (and `/bass`, if
 * any) is spelled against the base `key` plus the running offset for that line,
 * via the per-key spelling table, while its opaque quality/extension suffix is
 * carried through unchanged. Non-chord content is left untouched and the
 * `TRANSPOSE KEY` directive lines are preserved verbatim.
 *
 * @param {string} body  the canonical numbers body
 * @param {string} key   the target (major) key to spell names in; required
 * @returns {string} the equivalent names-in-`key` body
 * @throws {Error} if `key` is unsupported, or a token is malformed / in the
 *   wrong (names) representation.
 */
function numbersToNames(body, key, options = {}) {
  if (typeof body !== 'string') {
    throw new Error(
      `Invalid chart body: expected a string but received ${typeof body}.`
    );
  }
  if (!isSupportedKey(key)) {
    throw new Error(
      `numbersToNames requires a supported major key but received ` +
        `${JSON.stringify(key)}. Supported keys: ${getSupportedKeys().join(', ')} ` +
        `(F# accepted as Gb).`
    );
  }

  const lenient = options.lenient === true;
  const canonicalKey = normalizeKey(key);
  const { lines, eols } = splitLines(body);

  let runningOffset = 0;
  const out = lines.map((line, i) => {
    const shift = parseTransposeDirective(line);
    if (shift !== null) {
      runningOffset += shift;
      return line + eols[i];
    }

    const offsetForLine = runningOffset;
    const converted = transformChordTokens(line, (tokenText) => {
      const parsed = parseChord(tokenText);
      if (parsed.mode !== 'numbers') {
        throw new Error(
          `Invalid chord token "${tokenText}": expected a numbers chord ` +
            `(scale degree 1-7 root) when converting numbers to names.`
        );
      }
      const rootName = numberRootToName(
        { root: parsed.root, accidental: parsed.accidental },
        canonicalKey,
        offsetForLine
      );
      let result = rootName + parsed.quality;
      if (parsed.bass) {
        result += '/' + numberRootToName(parsed.bass, canonicalKey, offsetForLine);
      }
      return result;
    }, lenient);
    return converted + eols[i];
  });

  return out.join('');
}

/* ------------------------------------------------------------------------- *
 * Render model (task 1.4)
 *
 * renderModel(body) turns a NUMBERS body into the structured
 * Render_Representation consumed by the viewer, PDF generator, and playlist
 * batch endpoint (design.md — "Render_Representation", R8.4). Chord tokens are
 * emitted AS-IS (numbers); a caller that wants names-in-key runs
 * numbersToNames(body, key) first and feeds the resulting names body here —
 * segmentation and structure are representation-agnostic.
 *
 * This builder only partitions the already-prepared body into sections, lines,
 * segments, and directives; it does NOT transpose. It is pure and synchronous.
 * ------------------------------------------------------------------------- */

/**
 * One ordered chord/lyric fragment of a rendered line.
 *
 * @typedef {Object} RenderSegment
 * @property {?string} chord  The chord token text (numbers or names), or null
 *   for a leading lyric fragment that has no chord above it.
 * @property {string} lyric  The lyric text that follows the chord (possibly
 *   empty when a chord has no trailing lyric). `<b>`/`<i>` markup is preserved.
 */

/**
 * One rendered line: either content (ordered `segments`, `directive: null`) or
 * a directive marker (`segments: []`, `directive` set). A blank line is encoded
 * as a content line with no segments (`segments: []`, `directive: null`) so
 * stanza spacing is preserved for the renderer.
 *
 * @typedef {Object} RenderLine
 * @property {RenderSegment[]} segments
 * @property {(null|'PAGE_BREAK'|'COLUMN_BREAK'|'TRANSPOSE_KEY')} directive
 * @property {?number} transposeShift  Signed semitones when
 *   `directive === 'TRANSPOSE_KEY'`, else null.
 */

/**
 * One rendered section: a (possibly synthetic) label, an optional repeat count,
 * and its ordered lines.
 *
 * @typedef {Object} RenderSection
 * @property {string} label   The header label with any trailing `X<n>` repeat
 *   stripped. The implicit section holding content BEFORE the first header uses
 *   the empty string `''` as its label.
 * @property {?number} repeat  Repeat count from a trailing `X<n>` on the header,
 *   else null.
 * @property {RenderLine[]} lines
 */

/**
 * Matches a section header line (design.md — "Authoring grammar"):
 * `^[A-Z][A-Z0-9 \-]*(X\d+)?$`. The optional trailing `X<n>` repeat suffix is
 * captured in group 1 (the digits only) when present.
 *
 * Note: a bare `PAGE_BREAK` / `COLUMN_BREAK` also matches this uppercase shape,
 * so directive lines MUST be checked before header lines when classifying.
 */
const SECTION_HEADER_RE = /^[A-Z][A-Z0-9 \-]*?(?:\s*X(\d+))?$/;

/**
 * Split one lyric+chord line into ordered `{ chord, lyric }` segments.
 *
 * An inline `[chord]` attaches to the lyric text that follows it, up to the
 * next `[` or end of line. Lyric text appearing before the first chord becomes
 * a leading segment with `chord: null`. A chord with no following lyric yields
 * `{ chord, lyric: '' }`. Chord token text is emitted verbatim (no transpose);
 * `<b>`/`<i>` markup inside lyric text is preserved as-is.
 *
 * @param {string} line  A single content line (no trailing EOL).
 * @returns {RenderSegment[]}
 */
// Break a chord token into display parts { root, quality, bass } so the UI can
// render the ROOT (degree or note name) at normal size and SUPERSCRIPT the
// quality/extension (e.g. the "5" in "D5", the "maj7" in "1maj7") — on a number
// chart "45" is ambiguous, so the quality must be visually distinct. Uses the
// shared parseChord; a token that doesn't parse is treated as an opaque root
// with no quality (so verbatim/unparseable tokens still render as-is).
function chordParts(token) {
  if (token == null) return null;
  try {
    const p = parseChord(token);
    const root = (p.mode === 'numbers' ? p.accidental + p.root : p.root + p.accidental);
    const bass = p.bass
      ? (p.mode === 'numbers' ? p.bass.accidental + p.bass.root : p.bass.root + p.bass.accidental)
      : null;
    return { root, quality: p.quality || '', bass };
  } catch (e) {
    // Unparseable (e.g. a verbatim passthrough token): show it as-is.
    return { root: token, quality: '', bass: null };
  }
}

function segmentLine(line) {
  // Collect every inline [chord] with its position so we can slice the lyric
  // span that follows each one.
  const re = /\[([^\]]*)\]/g;
  const chordMatches = [];
  let match;
  while ((match = re.exec(line)) !== null) {
    chordMatches.push({ chord: match[1], start: match.index, end: re.lastIndex });
  }

  // No chords on the line: a single lyric-only segment (chord: null).
  if (chordMatches.length === 0) {
    return [{ chord: null, lyric: line }];
  }

  const segments = [];

  // Leading lyric before the first chord (if any) is a chord-less segment.
  if (chordMatches[0].start > 0) {
    segments.push({ chord: null, lyric: line.slice(0, chordMatches[0].start) });
  }

  // Each chord takes the lyric span from just after its `]` up to the next
  // chord's `[` (or end of line). A chord with no trailing lyric gets ''.
  for (let i = 0; i < chordMatches.length; i += 1) {
    const current = chordMatches[i];
    const lyricEnd =
      i + 1 < chordMatches.length ? chordMatches[i + 1].start : line.length;
    segments.push({ chord: current.chord, ...chordParts(current.chord), lyric: line.slice(current.end, lyricEnd) });
  }

  return segments;
}

/**
 * Classify and build a single RenderLine from a raw body line (no EOL).
 * Directive lines map to a directive marker with empty segments; everything
 * else (including blank lines) is a content line with its segments.
 *
 * @param {string} line
 * @returns {RenderLine}
 */
function buildLine(line) {
  const trimmed = line.trim();

  // Directives first — `PAGE_BREAK`/`COLUMN_BREAK` otherwise look like headers.
  if (trimmed === 'PAGE_BREAK') {
    return { segments: [], directive: 'PAGE_BREAK', transposeShift: null };
  }
  if (trimmed === 'COLUMN_BREAK') {
    return { segments: [], directive: 'COLUMN_BREAK', transposeShift: null };
  }
  const shift = parseTransposeDirective(line);
  if (shift !== null) {
    return { segments: [], directive: 'TRANSPOSE_KEY', transposeShift: shift };
  }

  // Blank line: a content line with no segments (preserves stanza spacing).
  if (trimmed === '') {
    return { segments: [], directive: null, transposeShift: null };
  }

  // Lyric+chord content line.
  return { segments: segmentLine(line), directive: null, transposeShift: null };
}

/**
 * Try to classify a line as a section header, returning `{ label, repeat }` or
 * null when the line is not a header. Directive lines are excluded by the
 * caller before this is reached (they share the uppercase shape).
 *
 * @param {string} line
 * @returns {{ label: string, repeat: (number|null) }|null}
 */
function parseSectionHeader(line) {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  const match = SECTION_HEADER_RE.exec(trimmed);
  if (!match) return null;

  let repeat = null;
  let label = trimmed;
  if (match[1] !== undefined) {
    repeat = parseInt(match[1], 10);
    // Strip the trailing `X<n>` (and any whitespace before it) from the label.
    label = trimmed.replace(/\s*X\d+$/, '').trim();
  }
  return { label, repeat };
}

/**
 * Build the structured Render_Representation sections from a NUMBERS body.
 *
 * Partitions the body into sections delimited by header lines. Content that
 * appears BEFORE the first header lives in an implicit leading section whose
 * `label` is the empty string `''` and whose `repeat` is null. A header line
 * matching `^[A-Z][A-Z0-9 \-]*(X\d+)?$` starts a new section; a trailing
 * `X<n>` sets `repeat` and is stripped from `label`. Directive lines
 * (`PAGE_BREAK`, `COLUMN_BREAK`, `TRANSPOSE KEY <±n>`) and blank lines are kept
 * as lines within the current section. Chord tokens are emitted as-is.
 *
 * The leading implicit section is only included when it actually holds lines,
 * so a body that opens with a header produces no empty synthetic section.
 *
 * @param {string} body  a chart body (chords in numbers, or names if a caller
 *   ran numbersToNames first)
 * @returns {{ sections: RenderSection[] }}
 * @throws {Error} if `body` is not a string.
 */
function renderModel(body) {
  if (typeof body !== 'string') {
    throw new Error(
      `Invalid chart body: expected a string but received ${typeof body}.`
    );
  }

  const { lines } = splitLines(body);

  const sections = [];
  // Implicit leading section for content before the first header.
  let current = { label: '', repeat: null, lines: [] };
  let currentHasHeader = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // A header is an uppercase line that is NOT one of the directive lines.
    const isDirective =
      trimmed === 'PAGE_BREAK' ||
      trimmed === 'COLUMN_BREAK' ||
      parseTransposeDirective(line) !== null;

    const header = isDirective ? null : parseSectionHeader(line);

    if (header) {
      // Flush the current section if it has content or is a real (header)
      // section; the implicit leading section is dropped when empty.
      if (current.lines.length > 0 || currentHasHeader) {
        sections.push(current);
      }
      current = { label: header.label, repeat: header.repeat, lines: [] };
      currentHasHeader = true;
      continue;
    }

    current.lines.push(buildLine(line));
  }

  // Flush the final section (keep it if it has content or came from a header).
  if (current.lines.length > 0 || currentHasHeader) {
    sections.push(current);
  }

  return { sections };
}

module.exports = {
  parseChord,
  namesToNumbers,
  numbersToNames,
  renderModel,
};
