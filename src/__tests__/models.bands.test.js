const mongoose = require('mongoose');
const fc = require('fast-check');

const Band = require('../models/Band');
const JoinRequest = require('../models/JoinRequest');
const Genre = require('../models/Genre');
const Song = require('../models/Song');
const Playlist = require('../models/Playlist');
const Gig = require('../models/Gig');

// These model tests exercise Mongoose validation and the DB-level unique /
// partial indexes against the in-memory MongoDB started by the shared test
// infra (src/config/testSetup.js sets process.env.MONGODB_URI). We connect
// mongoose here and explicitly build indexes with syncIndexes(), because
// mongodb-memory-server does not guarantee indexes are built before the first
// insert — the unique / partial-unique constraints under test depend on them.

const oid = () => new mongoose.Types.ObjectId();

beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  // Build indexes for every model whose constraints we rely on below.
  await Promise.all([
    Band.syncIndexes(),
    JoinRequest.syncIndexes(),
    Genre.syncIndexes(),
    Song.syncIndexes(),
    Playlist.syncIndexes(),
    Gig.syncIndexes(),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
});

afterEach(async () => {
  // Isolate tests: clear the collections we touch.
  await Promise.all([
    Band.deleteMany({}),
    JoinRequest.deleteMany({}),
    Genre.deleteMany({}),
    Song.deleteMany({}),
    Playlist.deleteMany({}),
    Gig.deleteMany({}),
  ]);
});

describe('Band model (Requirements 1.1, 1.3)', () => {
  it('requires name and administrator', async () => {
    await expect(Band.create({})).rejects.toThrow(mongoose.Error.ValidationError);

    // name only -> still invalid (missing administrator)
    await expect(Band.create({ name: 'No Admin' })).rejects.toThrow(
      mongoose.Error.ValidationError
    );

    // administrator only -> still invalid (missing name)
    await expect(Band.create({ administrator: oid() })).rejects.toThrow(
      mongoose.Error.ValidationError
    );
  });

  it('persists a band with a name and a single administrator ObjectId', async () => {
    const adminId = oid();
    const band = await Band.create({ name: 'The Testers', administrator: adminId });

    expect(band.name).toBe('The Testers');
    // administrator is exactly one ObjectId by construction (not an array).
    expect(Array.isArray(band.administrator)).toBe(false);
    expect(band.administrator).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(band.administrator.toString()).toBe(adminId.toString());
  });
});

describe('JoinRequest model — partial unique pending index (Requirement 8.1)', () => {
  it('blocks a second PENDING request for the same (band, user)', async () => {
    const band = oid();
    const user = oid();

    await JoinRequest.create({ band, user }); // defaults to status 'pending'

    await expect(JoinRequest.create({ band, user, status: 'pending' })).rejects.toMatchObject({
      code: 11000, // MongoServerError duplicate key
    });
  });

  it('allows a new request once the first is denied', async () => {
    const band = oid();
    const user = oid();

    const first = await JoinRequest.create({ band, user });

    // Deny the first request; it leaves the partial (status: 'pending') index.
    first.status = 'denied';
    await first.save();

    // A brand new pending request for the same (band, user) is now allowed.
    const second = await JoinRequest.create({ band, user });
    expect(second.status).toBe('pending');

    // Sanity: two records now exist for this (band, user) pair.
    const count = await JoinRequest.countDocuments({ band, user });
    expect(count).toBe(2);
  });

  it('allows pending requests for different users in the same band', async () => {
    const band = oid();
    await JoinRequest.create({ band, user: oid() });
    await expect(JoinRequest.create({ band, user: oid() })).resolves.toBeDefined();
  });
});

describe('Genre per-band uniqueness (Requirement 10.3)', () => {
  it('rejects the same name twice within one band', async () => {
    const band = oid();
    await Genre.create({ band, name: 'Rock', slug: 'rock' });
    await expect(
      Genre.create({ band, name: 'Rock', slug: 'rock' })
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('allows the same name in two different bands', async () => {
    const bandA = oid();
    const bandB = oid();
    await Genre.create({ band: bandA, name: 'Jazz', slug: 'jazz' });
    await expect(
      Genre.create({ band: bandB, name: 'Jazz', slug: 'jazz' })
    ).resolves.toBeDefined();
  });

  // Feature: bands, Property 14: Genre uniqueness is per-band, not global
  // Validates: Requirements 10.3
  it('Property 14: genre uniqueness is per-band, not global', async () => {
    await fc.assert(
      fc.asyncProperty(
        // A genre name: non-empty, trimmed, no leading/trailing whitespace so it
        // survives the schema's `trim: true` unchanged and stays a stable key.
        fc
          .string({ minLength: 1, maxLength: 40 })
          .map((s) => s.replace(/\s+/g, ' ').trim())
          .filter((s) => s.length > 0),
        async (name) => {
          const bandA = oid();
          const bandB = oid();
          const slug = `${name.toLowerCase()}-${oid().toString()}`; // unique-ish slug so name is the constraint under test

          // Same name in two DIFFERENT bands: both succeed.
          await Genre.create({ band: bandA, name, slug: `a-${slug}` });
          await Genre.create({ band: bandB, name, slug: `b-${slug}` });

          // Same name twice in ONE band: rejected with duplicate key.
          let duplicateRejected = false;
          try {
            await Genre.create({ band: bandA, name, slug: `a2-${slug}` });
          } catch (err) {
            duplicateRejected = err && err.code === 11000;
          }

          // Cleanup within the property run so iterations don't collide.
          await Genre.deleteMany({ band: { $in: [bandA, bandB] } });

          return duplicateRejected === true;
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Required `band` ref on band-scoped resources (Requirement 9.1)', () => {
  it('rejects Song without a band', async () => {
    await expect(
      Song.create({ title: 'Bandless', artist: 'Nobody' })
    ).rejects.toThrow(mongoose.Error.ValidationError);
  });

  it('rejects Playlist without a band', async () => {
    await expect(Playlist.create({ name: 'Bandless List' })).rejects.toThrow(
      mongoose.Error.ValidationError
    );
  });

  it('rejects Gig without a band', async () => {
    await expect(
      Gig.create({ name: 'Bandless Gig', date: new Date() })
    ).rejects.toThrow(mongoose.Error.ValidationError);
  });

  it('rejects Genre without a band', async () => {
    await expect(Genre.create({ name: 'Bandless', slug: 'bandless' })).rejects.toThrow(
      mongoose.Error.ValidationError
    );
  });

  it('accepts each resource when a band is provided', async () => {
    const band = oid();
    await expect(
      Song.create({ band, title: 'Has Band', artist: 'Someone' })
    ).resolves.toBeDefined();
    await expect(Playlist.create({ band, name: 'Has Band List' })).resolves.toBeDefined();
    await expect(
      Gig.create({ band, name: 'Has Band Gig', date: new Date() })
    ).resolves.toBeDefined();
    await expect(
      Genre.create({ band, name: 'Blues', slug: 'blues' })
    ).resolves.toBeDefined();
  });
});
