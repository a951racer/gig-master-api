/**
 * Major-key spelling tables for the chart transposition service.
 *
 * This module is pure: it has no database access and imports no models. It owns
 * the two musical lookup facts the transposition service (chartTranspose.js)
 * builds on — see design.md, "ChordPro-Like Format and Nashville Numbering":
 *
 *   1. The diatonic degree -> semitone table for major keys
 *      (design.md, "Diatonic mapping (major keys)").
 *   2. A per-key, 12-entry spelling table mapping a chromatic semitone offset
 *      (0-11, relative to that key's tonic) to the canonical spelled chord root
 *      — a letter plus an optional single accidental
 *      (design.md, "Accidental & enharmonic spelling (major keys)").
 *
 * Scope is major keys only (minor/modal deferred). Satisfies Requirement 6.3:
 * "THE Transposition_Service SHALL apply consistent accidental and enharmonic
 * spelling rules per major Key as defined in design."
 */

/**
 * Diatonic degree -> semitone offset from the tonic (major scale).
 *
 *   degree:    1  2  3  4  5  6  7
 *   semitones: 0  2  4  5  7  9  11
 *
 * (design.md, "Diatonic mapping (major keys)".)
 * @type {Readonly<Record<number, number>>}
 */
const DEGREE_TO_SEMITONE = Object.freeze({
  1: 0,
  2: 2,
  3: 4,
  4: 5,
  5: 7,
  6: 9,
  7: 11,
});

/**
 * The 12 supported major keys, in chromatic order from C.
 *
 * The enharmonic pair F#/Gb is resolved to a SINGLE canonical key entry: `Gb`.
 * Gb is chosen as the canonical flat-side spelling (its signature spells raised
 * chromatic tones as flats, which composes cleanly with the flat keys around
 * it). Callers that validate a key string should accept `Gb` (and may normalize
 * an incoming `F#` to `Gb` — see `normalizeKey`).
 *
 * @type {ReadonlyArray<string>}
 */
const SUPPORTED_KEYS = Object.freeze([
  'C',
  'Db',
  'D',
  'Eb',
  'E',
  'F',
  'Gb', // canonical spelling for the F#/Gb enharmonic key
  'G',
  'Ab',
  'A',
  'Bb',
  'B',
]);

/**
 * Each supported major key's 12-entry spelling table, indexed by the chromatic
 * semitone offset (0-11) ABOVE that key's tonic. Index 0 is always the tonic
 * itself.
 *
 * Exactly one canonical spelling is chosen per pitch per key. Each spelling is a
 * letter A-G plus an optional SINGLE accidental (`b` or `#`) — never a double
 * accidental (design.md: "Non-diatonic roots use a diatonic degree plus a single
 * accidental (never doubles); number->name->number round-trips.").
 *
 * The canonical choice is DEGREE-BASED so that the number<->name conversion
 * round-trips (design.md, "Number -> name"):
 *   - The seven diatonic degrees use that key's proper key-signature letters.
 *     This yields the theoretically-correct spellings even where they look
 *     unusual, e.g. B major's 4th degree is E# (offset 5), and the lowered 7th
 *     of a flat key keeps its letter, e.g. b7 of Db is Cb (offset 10).
 *   - The five non-diatonic (chromatic) pitches are spelled as a diatonic degree
 *     plus one accidental, keeping that degree's letter: b2 (offset 1),
 *     b3 (offset 3), #4 (offset 6), b6 (offset 8), b7 (offset 10). So in G the
 *     minor third above the tonic is `Bb` (lowered 3, letter B), NOT `A#`, and
 *     the raised fourth is `C#`; in Bb the same minor third is `Db`. These match
 *     the worked examples in design.md ("Accidental & enharmonic spelling").
 *
 * Where a degree-based spelling would require a double accidental, the table
 * falls back to the single-accidental enharmonic on the key's signature side
 * (sharp keys -> sharps, flat keys -> flats). With the choices above no such
 * fallback is actually needed, but the rule keeps every entry a single
 * accidental by construction.
 *
 * (Tables generated from the rule above; see the module header for provenance.)
 *
 * @type {Readonly<Record<string, ReadonlyArray<string>>>}
 */
const KEY_SPELLINGS = Object.freeze({
  // offset:        0    1     2    3     4     5     6     7    8     9     10    11
  C: Object.freeze(['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']),
  Db: Object.freeze(['Db', 'D', 'Eb', 'Fb', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'Cb', 'C']),
  D: Object.freeze(['D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B', 'C', 'C#']),
  Eb: Object.freeze(['Eb', 'Fb', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'Cb', 'C', 'Db', 'D']),
  E: Object.freeze(['E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B', 'C', 'C#', 'D', 'D#']),
  F: Object.freeze(['F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B', 'C', 'Db', 'D', 'Eb', 'E']),
  // Gb is the canonical spelling of the F#/Gb enharmonic key.
  Gb: Object.freeze(['Gb', 'G', 'Ab', 'A', 'Bb', 'Cb', 'C', 'Db', 'D', 'Eb', 'Fb', 'F']),
  G: Object.freeze(['G', 'Ab', 'A', 'Bb', 'B', 'C', 'C#', 'D', 'Eb', 'E', 'F', 'F#']),
  Ab: Object.freeze(['Ab', 'A', 'Bb', 'Cb', 'C', 'Db', 'D', 'Eb', 'Fb', 'F', 'Gb', 'G']),
  A: Object.freeze(['A', 'Bb', 'B', 'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#']),
  Bb: Object.freeze(['Bb', 'Cb', 'C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A']),
  B: Object.freeze(['B', 'C', 'C#', 'D', 'D#', 'E', 'E#', 'F#', 'G', 'G#', 'A', 'A#']),
});

/**
 * Normalize an incoming key string to its canonical supported form.
 *
 * Trims surrounding whitespace and resolves the `F#` spelling of the F#/Gb
 * enharmonic key to the canonical `Gb`. Any other value is returned trimmed and
 * unchanged (it may or may not be a supported key — use `isSupportedKey` to
 * check). Non-string input yields `null`.
 *
 * @param {string} key
 * @returns {string|null} the canonical key string, or null for non-string input
 */
function normalizeKey(key) {
  if (typeof key !== 'string') return null;
  const trimmed = key.trim();
  if (trimmed === 'F#') return 'Gb';
  return trimmed;
}

/**
 * Validate whether `key` names a supported major key.
 *
 * Accepts the canonical spellings in `SUPPORTED_KEYS` as well as the `F#`
 * spelling of the F#/Gb enharmonic key (normalized to `Gb`).
 *
 * @param {string} key
 * @returns {boolean} true if `key` is a supported major key
 */
function isSupportedKey(key) {
  const normalized = normalizeKey(key);
  return normalized !== null && Object.prototype.hasOwnProperty.call(KEY_SPELLINGS, normalized);
}

/**
 * The list of supported major keys (canonical spellings).
 *
 * Returns a fresh array copy so callers cannot mutate the module's internal
 * ordering.
 *
 * @returns {string[]}
 */
function getSupportedKeys() {
  return SUPPORTED_KEYS.slice();
}

/**
 * Look up the canonical spelled chord root for a chromatic semitone offset in a
 * given major key.
 *
 * @param {string} key - a supported major key (e.g. 'G', 'Bb'; 'F#' accepted as 'Gb')
 * @param {number} offset - chromatic semitone offset 0-11 above the key's tonic
 * @returns {string} the canonical root spelling (letter + optional single accidental)
 * @throws {Error} if the key is unsupported or the offset is not an integer 0-11
 */
function getSpelling(key, offset) {
  const normalized = normalizeKey(key);
  if (normalized === null || !Object.prototype.hasOwnProperty.call(KEY_SPELLINGS, normalized)) {
    throw new Error(`Unsupported major key: ${JSON.stringify(key)}`);
  }
  if (!Number.isInteger(offset) || offset < 0 || offset > 11) {
    throw new Error(`Semitone offset out of range (expected integer 0-11): ${JSON.stringify(offset)}`);
  }
  return KEY_SPELLINGS[normalized][offset];
}

/**
 * The semitone offset for a diatonic scale degree (1-7).
 *
 * @param {number} degree - a diatonic degree 1-7
 * @returns {number} the semitone offset from the tonic (0,2,4,5,7,9,11)
 * @throws {Error} if `degree` is not an integer 1-7
 */
function degreeToSemitone(degree) {
  if (!Object.prototype.hasOwnProperty.call(DEGREE_TO_SEMITONE, degree)) {
    throw new Error(`Diatonic degree out of range (expected integer 1-7): ${JSON.stringify(degree)}`);
  }
  return DEGREE_TO_SEMITONE[degree];
}

module.exports = {
  DEGREE_TO_SEMITONE,
  SUPPORTED_KEYS,
  KEY_SPELLINGS,
  normalizeKey,
  isSupportedKey,
  getSupportedKeys,
  getSpelling,
  degreeToSemitone,
};
