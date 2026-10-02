const request = require('supertest');
const mongoose = require('mongoose');

const app = require('../app');
const User = require('../models/User');
const Band = require('../models/Band');
const Song = require('../models/Song');
const Chart = require('../models/Chart');
const authService = require('../services/authService');
const membershipService = require('../services/membershipService');

// Integration tests for the chart view/render endpoints (task 4.3):
//   - GET  /songs/:id/chart/view?key=<Numbers|KEY>  (persisted render)
//   - POST /songs/:id/chart/view                    (un-persisted preview)
//
// These exercise the real Express app via supertest against the in-memory
// MongoDB started by the shared test infra (src/config/testSetup.js sets
// process.env.MONGODB_URI). The token / X-Band-Id setup mirrors
// invites.bands.test.js: a real User is created, their bands are populated,
// and authService.generateAccessToken(user) mints a token whose bands[] claim
// carries the id/name/isAdmin that bandScope reads. The chart routes are
// band-scoped via the song, so X-Band-Id is set to the band id.
//
// NOTE: this file is deliberately named chartView.routes.test.js (separate
// from charts.routes.test.js, task 3.3) and keeps its setup self-contained so
// the two files can land in parallel on the same branch without colliding.

const PASSWORD = 'password123';

// Mint a signed access token for a persisted user, mirroring /auth/login
// (populate bands.band -> name so the bands[] claim is complete).
async function tokenFor(userId) {
  const user = await User.findById(userId).populate('bands.band', 'name');
  return authService.generateAccessToken(user);
}

async function createUser(email, role = 'user') {
  const passwordHash = await authService.hashPassword(PASSWORD);
  return User.create({ email: email.toLowerCase(), passwordHash, role });
}

// Create a band administered by `adminUser` (single-admin invariant via
// membershipService.setAdministrator), returning the band.
async function createBandWithAdmin(adminUser, name = 'Chart Band') {
  const band = await Band.create({ name, administrator: adminUser._id });
  await membershipService.setAdministrator(band._id, adminUser._id);
  return band;
}

// Create a non-admin member user in `band` and return the user doc.
async function createMember(band, email) {
  const member = await createUser(email);
  await membershipService.addMember(band._id, member._id, { isAdmin: false });
  return member;
}

async function createSong(band, title = 'Test Song', artist = 'Test Artist') {
  return Song.create({ band: band._id, title, artist });
}

// A member token + its X-Band-Id for the given band, applied to a request.
function auth(req, token, band) {
  return req
    .set('Authorization', `Bearer ${token}`)
    .set('X-Band-Id', band._id.toString());
}

beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await Promise.all([
    User.syncIndexes(),
    Band.syncIndexes(),
    Song.syncIndexes(),
    Chart.syncIndexes(),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
});

afterEach(async () => {
  await Promise.all([
    User.deleteMany({}),
    Band.deleteMany({}),
    Song.deleteMany({}),
    Chart.deleteMany({}),
  ]);
});

// Shared harness for the GET-view suite: a band, a member token, and a song
// with a stored numbers chart (PUT with enteredKey:'Numbers').
async function seedChartedSong() {
  const admin = await createUser('admin@example.com');
  const band = await createBandWithAdmin(admin);
  const member = await createMember(band, 'member@example.com');
  const token = await tokenFor(member._id);
  const song = await createSong(band);

  const put = await auth(
    request(app).put(`/songs/${song._id}/chart`),
    token,
    band
  ).send({ enteredKey: 'Numbers', body: 'VERSE 1\n[1]Hi [4]there' });
  expect(put.status).toBe(200);

  return { admin, band, member, token, song };
}

describe('GET /songs/:id/chart/view', () => {
  it('Property 7 (Numbers passthrough): key=Numbers returns the stored NUMBER tokens unchanged', async () => {
    const { token, band, song } = await seedChartedSong();

    const res = await auth(
      request(app).get(`/songs/${song._id}/chart/view?key=Numbers`),
      token,
      band
    );

    expect(res.status).toBe(200);
    expect(res.body.keyLabel).toBe('Numbers');

    // Shape: one section (VERSE 1) holding one content line whose segments are
    // the two [chord]lyric fragments.
    expect(Array.isArray(res.body.sections)).toBe(true);
    expect(res.body.sections).toHaveLength(1);

    const section = res.body.sections[0];
    expect(section.label).toBe('VERSE 1');
    expect(section.repeat).toBeNull();
    expect(section.lines).toHaveLength(1);

    const segments = section.lines[0].segments;
    // Property 7: the chord segments are the STORED number tokens, unchanged.
    expect(segments).toMatchObject([
      { chord: '1', lyric: 'Hi ' },
      { chord: '4', lyric: 'there' },
    ]);
    // Explicitly: no transposition to names happened — tokens are still 1 and 4.
    expect(segments.map((s) => s.chord)).toEqual(['1', '4']);
  });

  it('derives title/artist from the SONG and returns a paginated pages structure', async () => {
    const { token, band, song } = await seedChartedSong();

    const res = await auth(
      request(app).get(`/songs/${song._id}/chart/view?key=Numbers`),
      token,
      band
    );

    expect(res.status).toBe(200);
    // Title/artist come from the Song (createSong defaults), NOT the chart.
    expect(res.body.title).toBe('Test Song');
    expect(res.body.artist).toBe('Test Artist');
    // The chart carries no title/artistLabel of its own.
    expect(res.body.artistLabel).toBeUndefined();

    // Paginated structure: pages -> columns -> lines.
    expect(Array.isArray(res.body.pages)).toBe(true);
    expect(res.body.pages.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(res.body.pages[0].columns)).toBe(true);
    // Single-column default.
    expect(res.body.pages[0].columns).toHaveLength(1);
  });

  it('two-column formatting + COLUMN_BREAK splits content across columns and emits no COLUMN_BREAK line', async () => {
    const admin = await createUser('cols-admin@example.com');
    const band = await createBandWithAdmin(admin, 'Cols Band');
    const member = await createMember(band, 'cols-member@example.com');
    const token = await tokenFor(member._id);
    const song = await createSong(band);

    // Save a 2-column chart with a COLUMN_BREAK between two verses.
    const put = await auth(request(app).put(`/songs/${song._id}/chart`), token, band).send({
      enteredKey: 'Numbers',
      body: 'VERSE 1\n[1]A\nCOLUMN_BREAK\nVERSE 2\n[5]B',
      formatting: { font: 'monospace', size: 11, chordColor: 'blue', columns: 2 },
    });
    expect(put.status).toBe(200);

    const res = await auth(
      request(app).get(`/songs/${song._id}/chart/view?key=Numbers`),
      token,
      band
    );
    expect(res.status).toBe(200);
    expect(res.body.pages[0].columns).toHaveLength(2);
    // No COLUMN_BREAK leaks into any rendered line.
    expect(JSON.stringify(res.body.pages)).not.toContain('COLUMN_BREAK');
    const col0Headers = res.body.pages[0].columns[0].lines.filter((l) => l.header).map((l) => l.header.label);
    const col1Headers = res.body.pages[0].columns[1].lines.filter((l) => l.header).map((l) => l.header.label);
    expect(col0Headers).toContain('VERSE 1');
    expect(col1Headers).toContain('VERSE 2');
  });

    it('key=KEY transposes numbers to names in that key (G): 1->G, 4->C, keyLabel=G', async () => {
    const { token, band, song } = await seedChartedSong();

    const res = await auth(
      request(app).get(`/songs/${song._id}/chart/view?key=G`),
      token,
      band
    );

    expect(res.status).toBe(200);
    expect(res.body.keyLabel).toBe('G');

    const segments = res.body.sections[0].lines[0].segments;
    expect(segments).toMatchObject([
      { chord: 'G', lyric: 'Hi ' },
      { chord: 'C', lyric: 'there' },
    ]);
  });

  it('returns 422 KEY_INVALID for an unsupported/invalid key', async () => {
    const { token, band, song } = await seedChartedSong();

    const res = await auth(
      request(app).get(`/songs/${song._id}/chart/view?key=H`),
      token,
      band
    );

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('KEY_INVALID');
  });

  it('returns 404 CHART_NOT_FOUND for a song with no chart', async () => {
    const admin = await createUser('admin2@example.com');
    const band = await createBandWithAdmin(admin);
    const member = await createMember(band, 'member2@example.com');
    const token = await tokenFor(member._id);
    const song = await createSong(band); // no chart stored

    const res = await auth(
      request(app).get(`/songs/${song._id}/chart/view?key=Numbers`),
      token,
      band
    );

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CHART_NOT_FOUND');
  });

  it('returns the song 404 (NOT_FOUND) for a song outside the current band (band confinement)', async () => {
    // Band A has the song + chart; a member of band B cannot view it.
    const { song } = await seedChartedSong();

    const otherAdmin = await createUser('otheradmin@example.com');
    const otherBand = await createBandWithAdmin(otherAdmin, 'Other Band');
    const otherMember = await createMember(otherBand, 'othermember@example.com');
    const otherToken = await tokenFor(otherMember._id);

    const res = await auth(
      request(app).get(`/songs/${song._id}/chart/view?key=Numbers`),
      otherToken,
      otherBand
    );

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('POST /songs/:id/chart/view — un-persisted preview', () => {
  it('renders the working body WITHOUT persisting (displayedKey=Numbers): [G] in key G -> chord 1, and no chart is saved', async () => {
    const admin = await createUser('admin3@example.com');
    const band = await createBandWithAdmin(admin);
    const member = await createMember(band, 'member3@example.com');
    const token = await tokenFor(member._id);
    const song = await createSong(band); // no chart saved

    const res = await auth(
      request(app).post(`/songs/${song._id}/chart/view`),
      token,
      band
    ).send({ body: '[G]Hi', enteredKey: 'G', displayedKey: 'Numbers' });

    expect(res.status).toBe(200);
    expect(res.body.keyLabel).toBe('Numbers');
    // [G] interpreted in key G is degree 1, rendered as numbers.
    const segments = res.body.sections[0].lines[0].segments;
    expect(segments).toMatchObject([{ chord: '1', lyric: 'Hi' }]);

    // Nothing was persisted: a GET of the stored chart must still 404.
    const getChart = await auth(
      request(app).get(`/songs/${song._id}/chart`),
      token,
      band
    );
    expect(getChart.status).toBe(404);
    expect(getChart.body.error.code).toBe('CHART_NOT_FOUND');

    // And directly: no Chart document exists for this song.
    const stored = await Chart.findOne({ song: song._id });
    expect(stored).toBeNull();
  });

  it('renders names in the displayed key (displayedKey=D): [G] entered in G -> degree 1 -> name D', async () => {
    const admin = await createUser('admin4@example.com');
    const band = await createBandWithAdmin(admin);
    const member = await createMember(band, 'member4@example.com');
    const token = await tokenFor(member._id);
    const song = await createSong(band);

    const res = await auth(
      request(app).post(`/songs/${song._id}/chart/view`),
      token,
      band
    ).send({ body: '[G]Hi', enteredKey: 'G', displayedKey: 'D' });

    expect(res.status).toBe(200);
    expect(res.body.keyLabel).toBe('D');
    const segments = res.body.sections[0].lines[0].segments;
    expect(segments).toMatchObject([{ chord: 'D', lyric: 'Hi' }]);
  });

  it('LENIENTLY renders a mix of valid and unparseable tokens — valid ones convert, bad ones stay verbatim', async () => {
    const admin = await createUser('lenient-admin@example.com');
    const band = await createBandWithAdmin(admin, 'Lenient Band');
    const member = await createMember(band, 'lenient-member@example.com');
    const token = await tokenFor(member._id);
    const song = await createSong(band);

    // Entered in A: [A] -> 1, [C5] -> b35 (power chord), but [Verse 1] is not a
    // chord. Displayed as Numbers. The request must succeed (200), convert the
    // valid chords, and keep the bad token's text verbatim.
    const res = await auth(
      request(app).post(`/songs/${song._id}/chart/view`),
      token,
      band
    ).send({ body: '[A]Hi [C5]there [Verse 1]x', enteredKey: 'A', displayedKey: 'Numbers' });

    expect(res.status).toBe(200);
    const segments = res.body.sections[0].lines[0].segments;
    // Valid chords converted to numbers; the unparseable token left verbatim.
    const chords = segments.map((s) => s.chord).filter(Boolean);
    expect(chords).toContain('1');       // [A] -> 1
    expect(chords).toContain('b35');     // [C5] -> b35
    expect(chords).toContain('Verse 1'); // unparseable, verbatim
  });

    it('returns 422 KEY_INVALID for a bad enteredKey', async () => {
    const admin = await createUser('admin5@example.com');
    const band = await createBandWithAdmin(admin);
    const member = await createMember(band, 'member5@example.com');
    const token = await tokenFor(member._id);
    const song = await createSong(band);

    const res = await auth(
      request(app).post(`/songs/${song._id}/chart/view`),
      token,
      band
    ).send({ body: '[G]Hi', enteredKey: 'H', displayedKey: 'Numbers' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('KEY_INVALID');
  });
});
