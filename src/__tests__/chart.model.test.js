const mongoose = require('mongoose');

const Chart = require('../models/Chart');
const Song = require('../models/Song');
const { validateChartBody } = require('../services/chartGrammar');

// Model tests exercise the Chart schema defaults and the DB-level unique index
// `{ song: 1 }` that enforces the 1:1 Chart<->Song relationship, against the
// in-memory MongoDB started by the shared test infra (src/config/testSetup.js
// sets process.env.MONGODB_URI). We connect mongoose here and explicitly build
// indexes with syncIndexes(), because mongodb-memory-server does not guarantee
// indexes are built before the first insert — the unique constraint under test
// depends on it. Mirrors the setup in models.bands.test.js.

const oid = () => new mongoose.Types.ObjectId();

beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await Promise.all([Chart.syncIndexes(), Song.syncIndexes()]);
});

afterAll(async () => {
  await mongoose.disconnect();
});

afterEach(async () => {
  await Promise.all([Chart.deleteMany({}), Song.deleteMany({})]);
});

// ---------------------------------------------------------------------------
// Property 1: One chart per song (Validates Requirements 1.2)
// ---------------------------------------------------------------------------
describe('Chart model — Property 1: one chart per song (Requirement 1.2)', () => {
  it('rejects a second chart for the same song via the unique index', async () => {
    const songId = oid();

    await Chart.create({ song: songId, body: 'VERSE\n[1]Hello [4]world' });

    // A second chart for the SAME song is rejected by the unique { song: 1 }
    // index with a MongoServerError duplicate-key error (code 11000).
    await expect(
      Chart.create({ song: songId, body: 'CHORUS\n[5]Again' })
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('allows a chart for a different song', async () => {
    const songA = oid();
    const songB = oid();

    await Chart.create({ song: songA, body: '[1]First' });

    // A chart for a DIFFERENT song succeeds — the constraint is per-song.
    await expect(
      Chart.create({ song: songB, body: '[1]Second' })
    ).resolves.toBeDefined();

    expect(await Chart.countDocuments({})).toBe(2);
  });

  it('requires song and body', async () => {
    await expect(Chart.create({ body: '[1]No song' })).rejects.toThrow(
      mongoose.Error.ValidationError
    );
    await expect(Chart.create({ song: oid() })).rejects.toThrow(
      mongoose.Error.ValidationError
    );
  });
});

describe('Chart model — field defaults (Requirements 1.3, 1.4)', () => {
  it('defaults title and artistLabel to empty strings', async () => {
    const chart = await Chart.create({ song: oid(), body: '[1]Default test' });

    expect(chart.title).toBe('');
    expect(chart.artistLabel).toBe('');
  });

  it('defaults formatting to font monospace / size 11 / chordColor blue / columns 1', async () => {
    const chart = await Chart.create({ song: oid(), body: '[1]Formatting test' });

    expect(chart.formatting.font).toBe('monospace');
    expect(chart.formatting.size).toBe(11);
    expect(chart.formatting.chordColor).toBe('blue');
    expect(chart.formatting.columns).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Property 10: Grammar validation (Validates Requirements 4.2)
//
// These are PURE (no DB) — validateChartBody tokenizes a ChordPro-like body
// and returns { valid, fields } with field-level detail (1-based line) for
// malformed tokens/lines, used by the write path to produce 422s.
// ---------------------------------------------------------------------------
describe('validateChartBody — Property 10: grammar validation (Requirement 4.2)', () => {
  describe('valid bodies return { valid: true, fields: [] }', () => {
    it('accepts a numbers body with sections, directives, markup, blanks', () => {
      const body = [
        'VERSE 1',
        '[1]Almost Heaven, [6m]West Virginia,',
        '',
        'CHORUS X2',
        '[4]Country <b>roads</b>, [5/7]take me [1]home',
        'TRANSPOSE KEY +1',
        '[b3]Non-diatonic [#4dim]passing',
        'PAGE_BREAK',
        'COLUMN_BREAK',
        '[1maj7]To the <i>place</i> I belong',
      ].join('\n');

      const result = validateChartBody(body);

      expect(result.valid).toBe(true);
      expect(result.fields).toEqual([]);
    });

    it('accepts a names body with sections, directives, markup, blanks', () => {
      const body = [
        'INTRO',
        '[G]Almost [Em]Heaven',
        '',
        'VERSE 1',
        '[C]Country <b>roads</b>, [D/F#]take me [G]home',
        'TRANSPOSE KEY -2',
        '[Bb]After the <i>change</i>',
        'PAGE_BREAK',
        'COLUMN_BREAK',
        '[Cmaj7]West Virginia',
      ].join('\n');

      const result = validateChartBody(body);

      expect(result.valid).toBe(true);
      expect(result.fields).toEqual([]);
    });
  });

  describe('malformed bodies return valid: false with field detail carrying a 1-based line', () => {
    it('rejects a malformed chord token [8x]', () => {
      const body = 'VERSE\n[8x]Out of range';
      const result = validateChartBody(body);

      expect(result.valid).toBe(false);
      expect(result.fields.length).toBeGreaterThan(0);
      const field = result.fields.find((f) => f.token === '8x');
      expect(field).toBeDefined();
      expect(field.line).toBe(2);
      expect(typeof field.message).toBe('string');
    });

    it('rejects an unterminated bracket', () => {
      const body = 'line one\n[1 never closed';
      const result = validateChartBody(body);

      expect(result.valid).toBe(false);
      const field = result.fields.find((f) => /[Uu]nterminated/.test(f.message));
      expect(field).toBeDefined();
      expect(field.line).toBe(2);
    });

    it('rejects a stray closing bracket ]', () => {
      const body = 'ok line\nstray ] bracket';
      const result = validateChartBody(body);

      expect(result.valid).toBe(false);
      const field = result.fields.find((f) =>
        /closing bracket|no .*matching/.test(f.message)
      );
      expect(field).toBeDefined();
      expect(field.line).toBe(2);
    });

    it('rejects a mixed numbers/names token [1/F#]', () => {
      const body = '[1/F#]Mixed representation';
      const result = validateChartBody(body);

      expect(result.valid).toBe(false);
      const field = result.fields.find((f) => f.token === '1/F#');
      expect(field).toBeDefined();
      expect(field.line).toBe(1);
      expect(/mix numbers and names/.test(field.message)).toBe(true);
    });

    it('rejects a malformed TRANSPOSE KEY directive (no sign)', () => {
      const body = 'VERSE\nTRANSPOSE KEY 3\n[1]body';
      const result = validateChartBody(body);

      expect(result.valid).toBe(false);
      const field = result.fields.find((f) => /TRANSPOSE KEY/.test(f.message));
      expect(field).toBeDefined();
      expect(field.line).toBe(2);
      expect(field.token).toBe('TRANSPOSE KEY 3');
    });
  });

  it('throws TypeError for a non-string body (programming error, not grammar)', () => {
    expect(() => validateChartBody(null)).toThrow(TypeError);
    expect(() => validateChartBody(42)).toThrow(TypeError);
  });
});
