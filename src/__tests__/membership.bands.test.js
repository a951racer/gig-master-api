const mongoose = require('mongoose');
const fc = require('fast-check');

const Band = require('../models/Band');
const User = require('../models/User');
const membershipService = require('../services/membershipService');

// Task 2.2 — property tests for membership invariants (Properties 2 and 5).
//
// LAYER CHOICE: these properties live at the SERVICE / model layer.
//   - P2 (Exactly one administrator per band) is about membershipService
//     .setAdministrator keeping exactly one { isAdmin: true } membership per
//     band across all users, consistent with Band.administrator.
//   - P5 (Membership set is faithful and unbounded from zero) is about
//     membershipService.addMember deduping band entries so a user's bands[]
//     length equals the distinct set of bands added (empty set allowed).
// Testing here exercises the real service logic against real User/Band docs
// without standing up JWT/auth + bandScope HTTP plumbing.
//
// We connect mongoose against the in-memory MongoDB started by the shared test
// infra (src/config/testSetup.js sets process.env.MONGODB_URI) and explicitly
// build indexes with syncIndexes() — mongodb-memory-server does not guarantee
// indexes are built before the first insert.
//
// ITERATION COUNT: each fast-check run performs real DB writes, so we cap runs
// at 30 (in the design's suggested 30-50 band for DB-backed model properties)
// to keep the suite fast while still exercising many generated sequences.

const oid = () => new mongoose.Types.ObjectId();
const DB_RUNS = 30;

beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await Promise.all([User.syncIndexes(), Band.syncIndexes()]);
});

afterAll(async () => {
  await mongoose.disconnect();
});

afterEach(async () => {
  await Promise.all([User.deleteMany({}), Band.deleteMany({})]);
});

// Feature: bands, Property 2: Exactly one administrator per band
// Validates: Requirements 1.3
describe('Property 2: Exactly one administrator per band', () => {
  it('after any sequence of setAdministrator reassignments, exactly one membership has isAdmin === true and it matches Band.administrator', async () => {
    let counter = 0;
    await fc.assert(
      // A small pool of users (2-4) and a non-empty sequence of admin picks
      // (indices into that pool). Each pick reassigns the band's administrator.
      fc.asyncProperty(
        fc
          .integer({ min: 2, max: 4 })
          .chain((poolSize) =>
            fc.record({
              poolSize: fc.constant(poolSize),
              picks: fc.array(fc.integer({ min: 0, max: poolSize - 1 }), {
                minLength: 1,
                maxLength: 8,
              }),
            })
          ),
        async ({ poolSize, picks }) => {
          counter += 1;

          // Create a pool of real users.
          const users = [];
          for (let i = 0; i < poolSize; i += 1) {
            users.push(
              await User.create({
                email: `p2-${counter}-${i}-${oid().toString()}@example.test`,
                passwordHash: 'x',
              })
            );
          }

          // Create the band administered initially by the first user.
          const band = await Band.create({
            name: `P2 Band ${counter}`,
            administrator: users[0]._id,
          });
          // Reflect that initial designation in membership too.
          await membershipService.setAdministrator(band._id, users[0]._id);

          // Apply the generated sequence of admin reassignments.
          for (const idx of picks) {
            await membershipService.setAdministrator(band._id, users[idx]._id);
          }

          // Re-load band + every user in the pool.
          const reloadedBand = await Band.findById(band._id);
          const reloadedUsers = await User.find({
            _id: { $in: users.map((u) => u._id) },
          });

          // Count memberships across ALL pool users with isAdmin === true for
          // this band.
          let adminCount = 0;
          let adminUserId = null;
          for (const u of reloadedUsers) {
            const entry = (u.bands || []).find(
              (m) => m.band && m.band.toString() === band._id.toString()
            );
            if (entry && entry.isAdmin === true) {
              adminCount += 1;
              adminUserId = u._id.toString();
            }
          }

          const expectedAdmin = users[picks[picks.length - 1]]._id.toString();

          // Cleanup within the run.
          await Promise.all([
            User.deleteMany({ _id: { $in: users.map((u) => u._id) } }),
            Band.deleteMany({ _id: band._id }),
          ]);

          return (
            adminCount === 1 &&
            adminUserId === expectedAdmin &&
            reloadedBand.administrator.toString() === expectedAdmin
          );
        }
      ),
      { numRuns: DB_RUNS }
    );
  });
});

// Feature: bands, Property 5: Membership set is faithful and unbounded from zero
// Validates: Requirements 2.1, 2.3
describe('Property 5: Membership set is faithful and unbounded from zero', () => {
  it('bands[] length equals the distinct set of bands added (empty set allowed); addMember is idempotent per band', async () => {
    let counter = 0;
    await fc.assert(
      // A set of band ids to add, drawn from a pool of fresh ObjectIds with
      // deliberate repeats so we exercise the dedup / idempotency guard. We
      // generate indices (possibly repeated, possibly empty) into a fresh pool.
      fc.asyncProperty(
        fc
          .integer({ min: 1, max: 6 })
          .chain((poolSize) =>
            fc.record({
              poolSize: fc.constant(poolSize),
              addIndices: fc.array(fc.integer({ min: 0, max: poolSize - 1 }), {
                minLength: 0,
                maxLength: 12,
              }),
            })
          ),
        async ({ poolSize, addIndices }) => {
          counter += 1;

          // Fresh band ObjectIds pool (not persisted — addMember only touches
          // the User doc's bands[] and does not require a Band doc to exist).
          const pool = Array.from({ length: poolSize }, () => oid());

          const user = await User.create({
            email: `p5-${counter}-${oid().toString()}@example.test`,
            passwordHash: 'x',
          });

          // Add each band (with repeats) — addMember must dedup per band.
          // Signature is addMember(bandId, userId, { isAdmin }).
          for (const idx of addIndices) {
            await membershipService.addMember(pool[idx], user._id);
          }

          // Distinct set of band ids that were actually added.
          const distinct = new Set(
            addIndices.map((idx) => pool[idx].toString())
          );

          const reloaded = await User.findById(user._id);
          const bandEntries = reloaded.bands || [];
          const bandIds = bandEntries.map((m) => m.band.toString());
          const uniqueBandIds = new Set(bandIds);

          // Idempotency: adding the same band twice does not duplicate.
          await membershipService.addMember(
            addIndices.length > 0 ? pool[addIndices[0]] : pool[0],
            user._id
          );
          const afterReadd = await User.findById(user._id);
          const afterReaddCount = (afterReadd.bands || []).length;
          const expectedAfterReadd =
            addIndices.length > 0 ? distinct.size : 1; // empty set -> the single re-added band

          // Cleanup within the run.
          await User.deleteMany({ _id: user._id });

          return (
            // length equals size of distinct set (empty set -> 0 before re-add)
            bandEntries.length === distinct.size &&
            // no duplicate band entries
            bandIds.length === uniqueBandIds.size &&
            // idempotent re-add did not create a duplicate
            afterReaddCount === expectedAfterReadd
          );
        }
      ),
      { numRuns: DB_RUNS }
    );
  });

  it('the empty set yields an empty bands[]', async () => {
    const user = await User.create({
      email: `p5-empty-${oid().toString()}@example.test`,
      passwordHash: 'x',
    });
    const reloaded = await User.findById(user._id);
    expect((reloaded.bands || []).length).toBe(0);
  });
});
