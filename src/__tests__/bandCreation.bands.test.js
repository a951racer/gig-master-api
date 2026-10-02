const request = require('supertest');
const mongoose = require('mongoose');
const fc = require('fast-check');

const app = require('../app');
const Band = require('../models/Band');
const User = require('../models/User');
const Genre = require('../models/Genre');
const membershipService = require('../services/membershipService');
const authService = require('../services/authService');
const seedGenres = require('../config/seedGenres');

// Property tests for band creation (Task 8.2 — Requirements 1.2, 1.6).
//
// These run against the in-memory MongoDB started by the shared test infra
// (src/config/testSetup.js sets process.env.MONGODB_URI). We connect mongoose
// in beforeAll (mirroring models.bands.test.js / auth.bands.test.js) and build
// the indexes the constraints under test rely on.
//
// Two layers are used deliberately:
//   - Property 1 is tested at the SERVICE/MODEL layer: it exercises the exact
//     create flow POST /bands performs (Band.create -> setAdministrator ->
//     seedBandGenres) without full auth plumbing. This is the simplest, most
//     robust way to assert the persisted membership invariant.
//   - Property 4 is tested via the ROUTE (supertest against ../app), because
//     the 422 whitespace/empty-name validation lives in the route handler
//     (validateFields). We mint a real, cryptographically valid Bearer token
//     with authService.generateAccessToken(user) — mirroring what /auth/login
//     does — so the request passes `authenticate` and reaches the guard.
//
// Because every property iteration performs real DB writes, run counts are
// kept modest (min 30 runs) to keep the suite fast while still covering a
// broad input space.

const oid = () => new mongoose.Types.ObjectId();

beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await Promise.all([
    Band.syncIndexes(),
    User.syncIndexes(),
    Genre.syncIndexes(),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
});

afterEach(async () => {
  await Promise.all([
    Band.deleteMany({}),
    User.deleteMany({}),
    Genre.deleteMany({}),
  ]);
});

/**
 * Create a real User document each run. Email must be unique per run so the
 * User `unique` email index does not collide across iterations.
 */
async function createUser() {
  return User.create({
    email: `creator-${oid().toString()}@example.com`,
    passwordHash: 'x'.repeat(20),
  });
}

/**
 * Run the exact create flow that POST /bands performs, at the service/model
 * layer: create the Band pointing at the creator, establish the single-admin
 * membership invariant via setAdministrator, then seed the band's genres.
 */
async function runCreateFlow(name, userId) {
  const band = await Band.create({ name: name.trim(), administrator: userId });
  await membershipService.setAdministrator(band._id, userId);
  await seedGenres.seedBandGenres(band._id);
  return band;
}

describe('Band creation — Property 1 (Requirement 1.2)', () => {
  // Feature: bands, Property 1: Band creation makes creator administrator and member
  // Validates: Requirements 1.2
  //
  // For any user, after the create flow the band's administrator is the creator
  // AND the creator's bands[] contains an entry for that band with isAdmin true.
  // Min 30 runs: each iteration creates a User + Band + seeds genres (real DB
  // writes), so we keep the count modest while still exercising many inputs.
  it('Property 1: creating a band makes the creator administrator and member', async () => {
    await fc.assert(
      fc.asyncProperty(
        // A valid, non-whitespace band name that survives `trim()` unchanged.
        fc
          .string({ minLength: 1, maxLength: 60 })
          .map((s) => s.replace(/\s+/g, ' ').trim())
          .filter((s) => s.length > 0),
        async (name) => {
          const user = await createUser();
          const band = await runCreateFlow(name, user._id);

          // Reload the persisted band and user (canonical DB state).
          const savedBand = await Band.findById(band._id);
          const savedUser = await User.findById(user._id);

          // Band.administrator is the creator.
          const adminMatches =
            savedBand.administrator.toString() === user._id.toString();

          // The creator has exactly one membership entry for this band with
          // isAdmin === true.
          const entries = (savedUser.bands || []).filter(
            (m) => m.band && m.band.toString() === band._id.toString()
          );
          const membershipOk =
            entries.length === 1 && entries[0].isAdmin === true;

          // Cleanup within the run so iterations do not accumulate/collide.
          await Promise.all([
            Band.deleteMany({}),
            User.deleteMany({}),
            Genre.deleteMany({ band: band._id }),
          ]);

          return adminMatches && membershipOk;
        }
      ),
      { numRuns: 30 }
    );
  });
});

describe('Band creation — Property 4 (Requirement 1.6)', () => {
  // Feature: bands, Property 4: Invalid band name is rejected
  // Validates: Requirements 1.6
  //
  // For any name that is empty or whitespace-only, POST /bands is rejected with
  // a 422 and no band is persisted. Tested via the route because the whitespace
  // guard lives in the handler (validateFields). We authenticate with a real
  // token minted the same way /auth/login does.
  it('Property 4: whitespace/empty band names yield 422 and persist no band', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Names made entirely of whitespace (including empty). Drawn from a set
        // of whitespace characters so `name.trim()` is always empty.
        fc.stringOf(fc.constantFrom(' ', '\t', '\n', '\r', '\f', '\v'), {
          minLength: 0,
          maxLength: 12,
        }),
        async (whitespaceName) => {
          // A real user + membership-populated token, minted like /auth/login.
          const user = await createUser();
          const populated = await User.findById(user._id).populate(
            'bands.band',
            'name'
          );
          const token = authService.generateAccessToken(populated);

          const before = await Band.countDocuments();

          const res = await request(app)
            .post('/bands')
            .set('Authorization', `Bearer ${token}`)
            .send({ name: whitespaceName });

          const after = await Band.countDocuments();

          // Cleanup within the run.
          await User.deleteMany({});

          return (
            res.status === 422 &&
            res.body &&
            res.body.error &&
            after === before // no band persisted
          );
        }
      ),
      { numRuns: 30 }
    );
  });

  it('rejects a missing name field with 422 and persists no band', async () => {
    const user = await createUser();
    const populated = await User.findById(user._id).populate('bands.band', 'name');
    const token = authService.generateAccessToken(populated);

    const before = await Band.countDocuments();
    const res = await request(app)
      .post('/bands')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.error).toBeDefined();
    expect(await Band.countDocuments()).toBe(before);
  });
});

// Global unique band name guard (case-insensitive across the whole app).
describe('Band name uniqueness (global, case-insensitive)', () => {
  async function tokenForNewUser() {
    const user = await createUser();
    const populated = await User.findById(user._id).populate('bands.band', 'name');
    return { user, token: authService.generateAccessToken(populated) };
  }

  it('POST /bands rejects a duplicate name with 409 DUPLICATE_BAND_NAME', async () => {
    const { token } = await tokenForNewUser();

    const first = await request(app)
      .post('/bands')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'The Owls' });
    expect(first.status).toBe(201);

    // A different user tries to create a band with the same name.
    const { token: token2 } = await tokenForNewUser();
    const dup = await request(app)
      .post('/bands')
      .set('Authorization', `Bearer ${token2}`)
      .send({ name: 'The Owls' });

    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_BAND_NAME');
    expect(await Band.countDocuments()).toBe(1);
  });

  it('is case-insensitive ("The Owls" vs "the owls")', async () => {
    const { token } = await tokenForNewUser();
    await request(app).post('/bands').set('Authorization', `Bearer ${token}`).send({ name: 'The Owls' });

    const { token: token2 } = await tokenForNewUser();
    const dup = await request(app)
      .post('/bands')
      .set('Authorization', `Bearer ${token2}`)
      .send({ name: 'the owls' });

    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_BAND_NAME');
  });

  it('PATCH /bands/:id rejects renaming to an existing band name (409)', async () => {
    // User A creates "Alpha".
    const { token: tokenA } = await tokenForNewUser();
    await request(app).post('/bands').set('Authorization', `Bearer ${tokenA}`).send({ name: 'Alpha' });

    // User B creates "Beta", then re-mints a token carrying the Beta membership
    // (so bandScope + requireBandAdmin pass) and tries to rename Beta -> Alpha.
    const { user: userB } = await tokenForNewUser();
    const betaRes = await (async () => {
      const populated = await User.findById(userB._id).populate('bands.band', 'name');
      const token = authService.generateAccessToken(populated);
      return request(app).post('/bands').set('Authorization', `Bearer ${token}`).send({ name: 'Beta' });
    })();
    const betaId = betaRes.body.id;

    const populatedB = await User.findById(userB._id).populate('bands.band', 'name');
    const tokenB = authService.generateAccessToken(populatedB);

    const rename = await request(app)
      .patch(`/bands/${betaId}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .set('X-Band-Id', betaId)
      .send({ name: 'Alpha' });

    expect(rename.status).toBe(409);
    expect(rename.body.error.code).toBe('DUPLICATE_BAND_NAME');
  });
});
