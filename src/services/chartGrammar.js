/**
 * Chart body grammar validation.
 *
 * Pure, synchronous, DB-free. A sibling of `chartTranspose.js` (design.md
 * explicitly allows the validator to live "in chartTranspose.js or a
 * sibling") so it can be developed independently of the transposition work.
 *
 * This module exports `validateChartBody(body)`, used by the chart write path
 * (`PUT /songs/:id/chart`, task 3.1) for BOTH numbers-entry and names-entry
 * input. It tokenizes the ChordPro-like body line by line and checks each
 * line against the authoring grammar (design.md — "Authoring grammar"),
 * collecting field-level problems that a route turns into a 422
 * `CHART_INVALID` with `error.fields` (design.md — "Error Handling", R4.2).
 *
 * Chord parsing is NOT reimplemented here: every inline `[...]` token is
 * handed to `parseChord` from `./chartTranspose`, which is the single source
 * of truth for chord-token well-formedness (and which already rejects mixing
 * numbers and names within one token). The body may be entirely in the
 * numbers representation OR entirely in names; this validator does not force a
 * single representation across the body — it only verifies each token parses.
 *
 * ----------------------------------------------------------------------------
 * VALIDATION CONTRACT (relied on by the route task 3.1)
 * ----------------------------------------------------------------------------
 * `validateChartBody(body)` RETURNS a plain result object and NEVER throws for
 * grammar problems (it only throws `TypeError` if `body` is not a string,
 * which is a programming error, not user input — the route should pass a
 * string it has already type-checked):
 *
 *   {
 *     valid:  boolean,           // true when `fields` is empty
 *     fields: Array<{            // field-level problems, empty when valid
 *       line:    number,         // 1-based line number of the problem
 *       token:   string | null,  // the offending `[...]` token WITHOUT the
 *                                 //   brackets, or the raw line text for a
 *                                 //   line-level problem; null if N/A
 *       message: string          // human-readable description
 *     }>
 *   }
 *
 * A route can therefore do, roughly:
 *
 *   const { valid, fields } = validateChartBody(body);
 *   if (!valid) {
 *     return res.status(422).json({
 *       error: { code: 'CHART_INVALID', message: 'Chart body is invalid.', fields }
 *     });
 *   }
 *
 * The `fields` array shape (`{ line, token, message }`) is designed to drop
 * straight into the 422 `error.fields` envelope.
 * ----------------------------------------------------------------------------
 */

'use strict';

const { parseChord } = require('./chartTranspose');

/**
 * A section header on its own line: a bare uppercase label, optionally
 * followed by a repeat suffix `X<n>` (e.g. `VERSE 1`, `CHORUS X2`,
 * `PRE-CHORUS`). Matches the whole line (design.md — "Authoring grammar").
 *
 * Note: because `X\d+` is also matchable by the general label class
 * (`[A-Z0-9 \-]`), a label like `CHORUS X2` is accepted either way; the
 * suffix is not required and carries no extra validation here.
 */
const SECTION_HEADER_RE = /^[A-Z][A-Z0-9 \-]*(X\d+)?$/;

/**
 * A `TRANSPOSE KEY <±n>` directive line, where n is a signed integer
 * (design.md — "Mid-song key changes"). The sign is required per the grammar
 * (`±n`); e.g. `TRANSPOSE KEY +1`, `TRANSPOSE KEY -2`.
 */
const TRANSPOSE_DIRECTIVE_RE = /^TRANSPOSE KEY [+-]\d+$/;

/**
 * The standalone directive lines that are not `TRANSPOSE KEY`.
 */
const SIMPLE_DIRECTIVES = new Set(['PAGE_BREAK', 'COLUMN_BREAK']);

/**
 * Pull every inline `[...]` chord token out of a lyric+chord line.
 *
 * Scans the line left to right tracking bracket state so an unterminated `[`
 * (a `[` with no closing `]`) is reported precisely rather than silently
 * swallowing the rest of the line. A stray closing `]` with no open `[` is
 * also flagged. Returns the extracted inner token texts (without brackets)
 * plus any structural bracket problems found.
 *
 * Note: nested `[` inside an open token is treated as a malformed token (the
 * grammar has no nested chords) — the first `[` is reported as unterminated
 * at its own column so the author can see where the imbalance starts.
 *
 * @param {string} line  A single body line.
 * @returns {{ tokens: string[], errors: Array<{ token: (string|null), message: string }> }}
 */
function extractChordTokens(line) {
  const tokens = [];
  const errors = [];

  let open = false; // are we currently inside a `[...]`?
  let start = -1; // index just after the opening `[`

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '[') {
      if (open) {
        // A second `[` before the first was closed: the first is unterminated.
        errors.push({
          token: null,
          message:
            `Unterminated chord bracket "[" at column ${start}; a "[" must ` +
            `be closed by a "]" before the next "[".`,
        });
        // Restart the token at this new `[` so we can keep reporting usefully.
        start = i + 1;
      } else {
        open = true;
        start = i + 1;
      }
    } else if (ch === ']') {
      if (open) {
        tokens.push(line.slice(start, i));
        open = false;
        start = -1;
      } else {
        errors.push({
          token: null,
          message:
            `Unexpected closing bracket "]" at column ${i + 1} with no ` +
            `matching opening "[".`,
        });
      }
    }
  }

  if (open) {
    errors.push({
      token: null,
      message:
        `Unterminated chord bracket "[" at column ${start}; it is never ` +
        `closed by a "]".`,
    });
  }

  return { tokens, errors };
}

/**
 * Strip inline presentation markup `<b>…</b>` / `<i>…</i>` from a lyric line.
 *
 * The markup is permitted within lyric text and passed through by the renderer
 * (design.md — "Authoring grammar"); it is not musically meaningful and must
 * not interfere with bracket/chord scanning. Removing the tag markers (not the
 * wrapped text) before scanning keeps column-based bracket checks sane while
 * leaving the actual lyric characters in place.
 *
 * @param {string} line
 * @returns {string}
 */
function stripMarkup(line) {
  return line.replace(/<\/?[bi]>/g, '');
}

/**
 * Classify and validate a single body line, pushing any problems onto
 * `fields` with the given 1-based `lineNo`.
 *
 * Line types (design.md — "Authoring grammar"):
 *   - blank line                 -> always valid (stanza separator)
 *   - section header             -> `SECTION_HEADER_RE`
 *   - directive line             -> PAGE_BREAK / COLUMN_BREAK / TRANSPOSE KEY ±n
 *   - lyric+chord line           -> free text with zero or more `[chord]`s
 *
 * A lyric+chord line is the permissive fallback: any line that is not blank,
 * not a recognized header, and not a directive is treated as lyric text, and
 * the only thing validated is that its inline chord tokens are well-formed
 * and its brackets balanced. This matches PCO's permissive text model — we do
 * not reject arbitrary lyric characters.
 *
 * @param {string} rawLine  The original line text (markup intact).
 * @param {number} lineNo   1-based line number.
 * @param {Array<{line:number, token:(string|null), message:string}>} fields
 *   Accumulator the function appends problems to.
 */
function validateLine(rawLine, lineNo, fields) {
  // A blank line (empty or whitespace only) is a stanza separator — valid.
  if (rawLine.trim() === '') {
    return;
  }

  // Directive lines. These are checked BEFORE the section-header pattern
  // because a directive like `TRANSPOSE KEY 3` is itself all uppercase
  // letters/digits/spaces and would otherwise be swallowed by the permissive
  // section-header class and silently accepted.
  if (SIMPLE_DIRECTIVES.has(rawLine)) {
    return;
  }
  if (rawLine.startsWith('TRANSPOSE KEY')) {
    // Looks like a transpose directive — hold it to the strict `±n` shape so a
    // malformed one (missing sign, non-integer) is reported rather than being
    // misread as a section header or lyric text.
    if (!TRANSPOSE_DIRECTIVE_RE.test(rawLine)) {
      fields.push({
        line: lineNo,
        token: rawLine,
        message:
          'Invalid TRANSPOSE KEY directive; expected "TRANSPOSE KEY <±n>" ' +
          'with a signed integer, e.g. "TRANSPOSE KEY +1" or "TRANSPOSE KEY -2".',
      });
    }
    return;
  }

  // Section header: a bare uppercase label on its own line. We test the line
  // as-is (no trim) because the grammar anchors the whole line; a header with
  // stray leading/trailing spaces simply falls through to lyric handling,
  // which is harmless (it has no brackets).
  if (SECTION_HEADER_RE.test(rawLine)) {
    return;
  }

  // Otherwise: a lyric+chord line. Strip presentation markup, then extract and
  // validate every inline chord token.
  const line = stripMarkup(rawLine);
  const { tokens, errors } = extractChordTokens(line);

  // Structural bracket problems (unterminated/stray brackets) come first.
  for (const err of errors) {
    fields.push({ line: lineNo, token: err.token, message: err.message });
  }

  // Each extracted token must parse via the shared chord parser.
  for (const token of tokens) {
    try {
      parseChord(token);
    } catch (e) {
      fields.push({
        line: lineNo,
        token,
        message: e && e.message ? e.message : `Invalid chord token "${token}".`,
      });
    }
  }
}

/**
 * Validate a chart body against the ChordPro-like authoring grammar.
 *
 * See the VALIDATION CONTRACT comment at the top of this file for the exact
 * return shape. In short: returns `{ valid, fields }`, never throwing for
 * grammar problems. Only throws `TypeError` when `body` is not a string, which
 * is a caller programming error (the route is expected to pass a string).
 *
 * @param {string} body  The raw chart body text (numbers OR names representation).
 * @returns {{ valid: boolean, fields: Array<{line:number, token:(string|null), message:string}> }}
 * @throws {TypeError} If `body` is not a string.
 */
function validateChartBody(body) {
  if (typeof body !== 'string') {
    throw new TypeError(
      `validateChartBody expected a string body but received ${typeof body}.`
    );
  }

  /** @type {Array<{line:number, token:(string|null), message:string}>} */
  const fields = [];

  // Split on \n, tolerating \r\n (Windows) line endings by trimming a trailing
  // \r. Line numbers are 1-based for human-facing error reporting.
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i].replace(/\r$/, '');
    validateLine(rawLine, i + 1, fields);
  }

  return { valid: fields.length === 0, fields };
}

module.exports = {
  validateChartBody,
};
