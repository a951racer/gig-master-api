const fc = require('fast-check');
const jwt = require('jsonwebtoken');

const { generateAccessToken, buildBandsClaim } = require('../services/authService');

// These are PURE unit/property tests for the token-claim builder. Both
// generateAccessToken(user) and buildBandsClaim(user) operate on a plain
// user-like object and touch no database, so we construct fake "user"
// objects that mimic a User loaded with `bands.band` populated. No mongoose
// connection is opened in this file.

const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'dev-access-secret';

// A stub ObjectId-like value whose toString() returns the given hex id, matching
// how a populated Mongoose document exposes _id.
function fakeObjectId(hex) {
  return { toString: () => hex };
}

// Build a fake populated user from generated primitives:
//   - subId: the user's _id (hex string)
//   - role: 'user' | 'system_administrator'
//   - memberships: [{ bandId, name, isAdmin }] mimicking populated bands entries
function makeUser(subId, role, memberships) {
  return {
    _id: fakeObjectId(subId),
    role,
    bands: memberships.map((m) => ({
      band: { _id: fakeObjectId(m.bandId), name: m.name },
      isAdmin: m.isAdmin,
    })),
  };
}

// The expected bands[] projection for a given membership set.
function expectedClaim(memberships) {
  return memberships.map((m) => ({ id: m.bandId, name: m.name, isAdmin: m.isAdmin }));
}

// Hex-string id generator (non-empty).
const idArb = fc.hexaString({ minLength: 1, maxLength: 24 });
const roleArb = fc.constantFrom('user', 'system_administrator');

const membershipArb = fc.record({
  bandId: idArb,
  name: fc.string({ maxLength: 40 }),
  isAdmin: fc.boolean(),
});

// A membership set (may be empty) with unique band ids, mirroring a real
// projection of distinct memberships.
const membershipsArb = fc.uniqueArray(membershipArb, {
  maxLength: 6,
  selector: (m) => m.bandId,
});

describe('authService token claim (Property 9)', () => {
  // Feature: bands, Property 9: Token carries authoritative role and membership claim
  // Validates: Requirements 5.1, 5.2, 5.4, 5.6, 7.2
  it('Property 9: decoding generateAccessToken(user) yields sub, role, and the bands[] projection', () => {
    fc.assert(
      fc.property(idArb, roleArb, membershipsArb, (subId, role, memberships) => {
        const user = makeUser(subId, role, memberships);

        const token = generateAccessToken(user);
        const payload = jwt.verify(token, ACCESS_TOKEN_SECRET);

        expect(payload.sub).toBe(subId);
        expect(payload.role).toBe(role);
        expect(payload.bands).toEqual(expectedClaim(memberships));
      }),
      { numRuns: 200 }
    );
  });

  // Feature: bands, Property 9: Token carries authoritative role and membership claim
  // Validates: Requirements 5.1, 5.2, 5.4, 5.6, 7.2
  it('Property 9: the refresh path (re-loaded user) decodes to the same role and bands[]', () => {
    // The refresh path loads the user with bands.band populated and calls the
    // same generateAccessToken(user). Signing the same user twice must yield
    // tokens that decode to identical role and bands[] claims.
    fc.assert(
      fc.property(idArb, roleArb, membershipsArb, (subId, role, memberships) => {
        const user = makeUser(subId, role, memberships);

        const loginToken = generateAccessToken(user);
        const refreshToken = generateAccessToken(user);

        const loginPayload = jwt.verify(loginToken, ACCESS_TOKEN_SECRET);
        const refreshPayload = jwt.verify(refreshToken, ACCESS_TOKEN_SECRET);

        expect(refreshPayload.sub).toBe(loginPayload.sub);
        expect(refreshPayload.role).toBe(loginPayload.role);
        expect(refreshPayload.bands).toEqual(loginPayload.bands);
        expect(refreshPayload.bands).toEqual(expectedClaim(memberships));
      }),
      { numRuns: 200 }
    );
  });

  // Explicit empty-bands example: a no-band user yields an empty bands[] claim.
  it('Property 9 (empty case): a user with no memberships yields bands: []', () => {
    const user = makeUser('abc123', 'user', []);

    const payload = jwt.verify(generateAccessToken(user), ACCESS_TOKEN_SECRET);

    expect(payload.sub).toBe('abc123');
    expect(payload.role).toBe('user');
    expect(payload.bands).toEqual([]);
    expect(buildBandsClaim(user)).toEqual([]);
  });
});
