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

module.exports = {
  parseChord,
};
