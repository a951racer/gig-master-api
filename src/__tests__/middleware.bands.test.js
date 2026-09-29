const fc = require('fast-check');

const bandScope = require('../middleware/bandScope');
const { requireSystemAdmin, requireBandAdmin } = require('../middleware/authorize');

// These are PURE decision-function tests. bandScope, requireSystemAdmin, and
// requireBandAdmin make an authorization decision purely from
// req.tokenClaims / req.currentBandIsAdmin and either call next() or respond
// 403. They touch no database, so we drive them directly with fake
// req/res/next objects — no mongoose connection is opened in this file.

// A fake Express response that captures the status code and JSON body and
// records whether a response was sent. status() returns `this` so the common
// res.status(403).json({...}) chain works.
function makeRes() {
  const res = {
    statusCode: undefined,
    body: undefined,
    responded: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.responded = true;
      return this;
    },
  };
  return res;
}

// A next() spy recording whether it was called.
function makeNext() {
  const next = () => {
    next.called = true;
  };
  next.called = false;
  return next;
}

// Arbitrary for a single membership entry as it appears in the token claim.
const bandEntryArb = fc.record({
  id: fc.string({ minLength: 1, maxLength: 24 }),
  name: fc.string({ maxLength: 40 }),
  isAdmin: fc.boolean(),
});

// A bands[] claim with unique ids (the real claim is a projection of the
// user's distinct memberships, so ids are unique per band).
const bandsClaimArb = fc.uniqueArray(bandEntryArb, {
  maxLength: 6,
  selector: (b) => b.id,
});

const roleArb = fc.constantFrom('user', 'system_administrator', 'other_role', undefined);

describe('bandScope / requireSystemAdmin / requireBandAdmin decision functions', () => {
  // Feature: bands, Property 10: Band-scope decision function
  // Validates: Requirements 6.2, 6.3, 6.4, 6.5, 14.1, 14.3
  it('Property 10: bandScope authorizes and sets req.currentBand iff X-Band-Id matches a member band', () => {
    // Header-value generator covering: missing/undefined, empty string, a value
    // present in bands[], and a value NOT in bands[].
    const headerVariantArb = (bands) =>
      fc.oneof(
        fc.constant(undefined), // missing header
        fc.constant(''), // empty header
        // A value present in the claim (only when the claim is non-empty).
        bands.length > 0
          ? fc.constantFrom(...bands.map((b) => b.id))
          : fc.constant('__no_members__'),
        // A value that is NOT in the claim (stale / non-member).
        fc
          .string({ minLength: 1, maxLength: 24 })
          .filter((s) => !bands.some((b) => b.id === s))
      );

    fc.assert(
      fc.property(
        bandsClaimArb.chain((bands) =>
          fc.record({ bands: fc.constant(bands), header: headerVariantArb(bands) })
        ),
        ({ bands, header }) => {
          const req = {
            headers: header === undefined ? {} : { 'x-band-id': header },
            tokenClaims: { bands },
          };
          const res = makeRes();
          const next = makeNext();

          bandScope(req, res, next);

          const matched =
            typeof header === 'string' &&
            header !== '' &&
            bands.find((b) => b.id === header);

          if (matched) {
            // Authorized: next() called, currentBand set, no response sent.
            expect(next.called).toBe(true);
            expect(res.responded).toBe(false);
            expect(req.currentBand).toBe(header);
            expect(req.currentBandIsAdmin).toBe(matched.isAdmin === true);
          } else {
            // Rejected: 403, next() not called, currentBand unset.
            expect(next.called).toBe(false);
            expect(res.responded).toBe(true);
            expect(res.statusCode).toBe(403);
            expect(req.currentBand).toBeUndefined();
            // Missing header -> BAND_REQUIRED; otherwise BAND_NOT_A_MEMBER.
            const expectedCode =
              header === undefined || header === ''
                ? 'BAND_REQUIRED'
                : 'BAND_NOT_A_MEMBER';
            expect(res.body.error.code).toBe(expectedCode);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  // Feature: bands, Property 7
  // Validates: Requirements 3.4, 3.5, 11.5
  it('Property 7: requireSystemAdmin authorizes iff role === system_administrator, regardless of X-Band-Id', () => {
    fc.assert(
      fc.property(
        roleArb,
        // Presence/value of X-Band-Id must not affect the decision.
        fc.option(fc.string({ maxLength: 24 }), { nil: undefined }),
        fc.oneof(fc.constant(undefined), bandsClaimArb),
        (role, header, bands) => {
          const req = {
            headers: header === undefined ? {} : { 'x-band-id': header },
            tokenClaims: { role, bands: bands || [] },
          };
          const res = makeRes();
          const next = makeNext();

          requireSystemAdmin(req, res, next);

          if (role === 'system_administrator') {
            expect(next.called).toBe(true);
            expect(res.responded).toBe(false);
          } else {
            expect(next.called).toBe(false);
            expect(res.statusCode).toBe(403);
            expect(res.body.error.code).toBe('FORBIDDEN');
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  // Feature: bands, Property 8
  // Validates: Requirements 4.1, 4.2, 4.4, 8.5
  it('Property 8: requireBandAdmin authorizes iff currentBandIsAdmin OR role === system_administrator', () => {
    fc.assert(
      fc.property(
        roleArb,
        // currentBandIsAdmin as set by bandScope: a boolean, or absent.
        fc.oneof(fc.boolean(), fc.constant(undefined)),
        (role, currentBandIsAdmin) => {
          const req = {
            tokenClaims: { role },
            currentBandIsAdmin,
          };
          const res = makeRes();
          const next = makeNext();

          requireBandAdmin(req, res, next);

          const shouldAuthorize =
            currentBandIsAdmin === true || role === 'system_administrator';

          if (shouldAuthorize) {
            expect(next.called).toBe(true);
            expect(res.responded).toBe(false);
          } else {
            expect(next.called).toBe(false);
            expect(res.statusCode).toBe(403);
            expect(res.body.error.code).toBe('FORBIDDEN');
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});
