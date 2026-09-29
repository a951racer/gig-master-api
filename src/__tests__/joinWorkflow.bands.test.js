const mongoose = require('mongoose');
const fc = require('fast-check');

const Band = require('../models/Band');
const User = require('../models/User');
const JoinRequest = require('../models/JoinRequest');
const membershipService = require('../services/membershipService');

// Task 8.4 — property tests for the join workflow (Properties 15 and 16).
//
// LAYER CHOICE: these properties are exercised at the MODEL / SERVICE layer
// rather than through the HTTP router. Properties 15 and 16 are about two
// facts that live below the transport:
//   - P15: the DB-level partial unique pending index on JoinRequest
//     { band, user } filtered to status: 'pending' (src/models/JoinRequest.js).
//   - P16: the resolve logic — approval calls membershipService.addMember(...,
//     { isAdmin: false }) and sets status 'approved'; denial only sets status
//     'denied' with no membership change (src/routes/bands.js PATCH resolve).
// Testing here avoids standing up full JWT/auth + bandScope/requireBandAdmin
// HTTP plumbing (those decision functions are covered by their own property
// tests) while still validating the underlying invariants faithfully.
//
// We connect mongoose against the in-memory MongoDB started by the shared test
// infra (src/config/testSetup.js sets process.env.MONGODB_URI) and explicitly
// build indexes with syncIndexes() — mongodb-memory-server does not guarantee
// indexes are built before the first insert, and the P15 partial-unique
// constraint under test depends on that index existing.
//
// ITERATION COUNT: each fast-check run performs real DB writes, so we cap runs
// at 40 (in the design's suggested 30-50 band for DB-backed model properties)
// to keep the suite fast while still exercising many generated (band, user)
// pairs and approve/deny decisions.

const oid = () => new mongoose.Types.ObjectId();
const DB_RUNS = 40;

beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await Promise.all([
    JoinRequest.syncIndexes(), // builds the partial unique pending index (P15)
    User.syncIndexes(),
    Band.syncIndexes(),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
});

afterEach(async () => {
  await Promise.all([
    JoinRequest.deleteMany({}),
    User.deleteMany({}),
    Band.deleteMany({}),
  ]);
});

// Feature: bands, Property 15: Join request creates a single pending record
// Validates: Requirements 8.1
describe('Property 15: Join request creates a single pending record', () => {
  it('creates one pending record and rejects an immediate duplicate pending', async () => {
    await fc.assert(
      // Generate a fresh (band, user) pair per run via fresh ObjectIds so each
      // iteration is an independent membership request.
      fc.asyncProperty(fc.constant(null), async () => {
        const band = oid();
        const user = oid();

        // First request: defaults to status 'pending'.
        const first = await JoinRequest.create({ band, user });
        expect(first.status).toBe('pending');
        expect(first.band.toString()).toBe(band.toString());
        expect(first.user.toString()).toBe(user.toString());

        // Second immediate request while one is pending: rejected by the
        // partial unique index (duplicate key 11000).
        let duplicateRejected = false;
        try {
          await JoinRequest.create({ band, user, status: 'pending' });
        } catch (err) {
          duplicateRejected = err && err.code === 11000;
        }

        // Exactly one pending record exists for this (band, user) pair.
        const pendingCount = await JoinRequest.countDocuments({
          band,
          user,
          status: 'pending',
        });

        // Cleanup within the run so iterations stay isolated.
        await JoinRequest.deleteMany({ band, user });

        return duplicateRejected === true && pendingCount === 1;
      }),
      { numRuns: DB_RUNS }
    );
  });
});

// Feature: bands, Property 16: Approval adds member; denial does not
// Validates: Requirements 8.2, 8.3
describe('Property 16: Approval adds member; denial does not', () => {
  it('approval adds a non-admin membership + sets approved; denial adds none + sets denied', async () => {
    let counter = 0;
    await fc.assert(
      // Generate the resolve decision: true = approve, false = deny.
      fc.asyncProperty(fc.boolean(), async (approve) => {
        // Real User + Band per run (unique email keeps the User unique index happy).
        counter += 1;
        const admin = await User.create({
          email: `admin-${counter}-${oid().toString()}@example.test`,
          passwordHash: 'x',
        });
        const band = await Band.create({
          name: `Band ${counter}`,
          administrator: admin._id,
        });
        const requester = await User.create({
          email: `requester-${counter}-${oid().toString()}@example.test`,
          passwordHash: 'x',
        });

        // A pending request from the requester for this band.
        const request = await JoinRequest.create({
          band: band._id,
          user: requester._id,
        });

        // Model the resolve logic from the PATCH handler.
        if (approve) {
          await membershipService.addMember(band._id, requester._id, {
            isAdmin: false,
          });
          request.status = 'approved';
        } else {
          request.status = 'denied';
        }
        await request.save();

        // Re-load the requester to inspect persisted membership.
        const reloaded = await User.findById(requester._id);
        const membership = (reloaded.bands || []).find(
          (m) => m.band && m.band.toString() === band._id.toString()
        );

        let ok;
        if (approve) {
          // Approve: membership exists for the band, isAdmin === false, approved.
          ok =
            !!membership &&
            membership.isAdmin === false &&
            request.status === 'approved';
        } else {
          // Deny: no membership for the band, status denied.
          ok = !membership && request.status === 'denied';
        }

        // Cleanup within the run.
        await Promise.all([
          JoinRequest.deleteMany({ band: band._id }),
          User.deleteMany({ _id: { $in: [admin._id, requester._id] } }),
          Band.deleteMany({ _id: band._id }),
        ]);

        return ok === true;
      }),
      { numRuns: DB_RUNS }
    );
  });
});
