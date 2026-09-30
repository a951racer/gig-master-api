// src/routes/admin.js
//
// System-administrator router (Task 9.1 — Requirements 3.3, 11.1–11.5).
//
// Every route in this router is band-independent and gated by
// `authenticate → requireSystemAdmin`, so only a caller whose token carries
// `role === 'system_administrator'` may reach any handler (Req 3.4, 11.5).
// The router is mounted under `/admin` (mounting is Task 11.1, not done here).
//
// Error responses follow the project convention `{ error: { code, message } }`
// with 422 carrying `error.fields` (see middleware/errorHandler + validate).
//
// Seed genre list store (Req 11.4 / 10.4): the master `Seed_Genre_List` is
// currently a hardcoded `DEFAULT_GENRES` array in `config/seedGenres.js`. A
// persistent store is out of scope for this task, so this router keeps a
// pragmatic module-level (in-memory) copy of the list, initialized from
// `seedGenres.DEFAULT_GENRES`. `GET /admin/seed-genres` returns the current
// maintained list and `PUT /admin/seed-genres` validates and replaces it. The
// list is used to seed NEW bands; because `seedBandGenres` reads from the
// config array, edits made here affect this router's view of the list rather
// than retroactively rewriting existing bands, which matches Req 10.4 (seed
// edits are not retroactive). This is intentionally simple — persisting the
// list (e.g. a SeedGenre collection) is deferred.

const express = require('express');

const User = require('../models/User');
const Band = require('../models/Band');
const Song = require('../models/Song');
const Playlist = require('../models/Playlist');
const Gig = require('../models/Gig');
const Genre = require('../models/Genre');
const JoinRequest = require('../models/JoinRequest');
const Invite = require('../models/Invite');
const authService = require('../services/authService');
const membershipService = require('../services/membershipService');
const seedGenres = require('../config/seedGenres');
const authenticate = require('../middleware/authenticate');
const { requireSystemAdmin } = require('../middleware/authorize');
const { validateFields } = require('../middleware/validate');

const router = express.Router();

const ROLES = ['user', 'system_administrator'];

// In-memory maintained copy of the master Seed_Genre_List (see header note).
let seedGenreList = [...seedGenres.DEFAULT_GENRES];

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// All admin routes are band-independent and require the system_administrator role.
router.use(authenticate, requireSystemAdmin);

// GET /admin/users — list all users for admin UIs (e.g. the assign-role picker).
// Sysadmin-only (gated by the router-level requireSystemAdmin). Returns a lean
// projection sorted by email; no password or token fields are exposed.
router.get('/users', async (req, res, next) => {
  try {
    const users = await User.find({}, { email: 1, role: 1, firstName: 1, lastName: 1 }).sort({ email: 1 });
    return res.status(200).json(
      users.map((u) => ({
        id: u._id,
        email: u.email,
        role: u.role,
        firstName: u.firstName,
        lastName: u.lastName,
      }))
    );
  } catch (err) {
    next(err);
  }
});

// POST /admin/users — create a user, optionally with a role (Req 11.1, 3.3).
router.post('/users', async (req, res, next) => {
  try {
    const { email, password, role, firstName, lastName } = req.body;
    const errors = {};

    if (!email || !isValidEmail(email)) errors.email = 'Must be a valid email address';
    if (!password || password.length < 8) errors.password = 'Must be at least 8 characters';
    if (role !== undefined && !ROLES.includes(role)) {
      errors.role = `Must be one of: ${ROLES.join(', ')}`;
    }

    if (Object.keys(errors).length) {
      validateFields(errors);
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ error: { code: 'EMAIL_TAKEN', message: 'Email already in use' } });
    }

    const passwordHash = await authService.hashPassword(password);
    const user = await User.create({
      email: email.toLowerCase(),
      passwordHash,
      role: role === 'system_administrator' ? 'system_administrator' : 'user',
      firstName: (firstName || '').trim(),
      lastName: (lastName || '').trim(),
    });

    return res.status(201).json({
      id: user._id,
      email: user.email,
      role: user.role,
      firstName: user.firstName,
      lastName: user.lastName,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/users/:id/role — assign a role to an existing user (Req 11.1, 3.3).
router.patch('/users/:id/role', async (req, res, next) => {
  try {
    const { role } = req.body;

    if (!ROLES.includes(role)) {
      validateFields({ role: `Must be one of: ${ROLES.join(', ')}` });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
    }

    user.role = role;
    await user.save();

    return res.status(200).json({ id: user._id, email: user.email, role: user.role });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/users/:id — system-administrator edit of any user (Req 11.1).
//
// Accepts any subset of { email, firstName, lastName, role, newPassword }.
// Sysadmin-gated by the router-level requireSystemAdmin. Because this is an
// admin action, a password (re)set does NOT require the target's current
// password. Email uniqueness is enforced (409 EMAIL_TAKEN) and role is
// validated against ROLES. To avoid locking everyone out, a role change that
// would leave the system with zero system administrators is rejected
// (409 LAST_ADMIN) — self-demotion is allowed as long as another sysadmin
// remains. Complements PATCH /admin/users/:id/role, which is kept for the
// role-only convenience path.
router.patch('/users/:id', async (req, res, next) => {
  try {
    const { email, firstName, lastName, role, newPassword } = req.body;
    const errors = {};

    if (email !== undefined && !isValidEmail(email)) {
      errors.email = 'Must be a valid email address';
    }
    if (role !== undefined && !ROLES.includes(role)) {
      errors.role = `Must be one of: ${ROLES.join(', ')}`;
    }
    if (newPassword !== undefined && (!newPassword || newPassword.length < 8)) {
      errors.newPassword = 'Must be at least 8 characters';
    }
    if (Object.keys(errors).length) {
      validateFields(errors);
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
    }

    if (email !== undefined) {
      const existing = await User.findOne({ email: email.toLowerCase(), _id: { $ne: user._id } });
      if (existing) {
        return res.status(409).json({ error: { code: 'EMAIL_TAKEN', message: 'Email already in use' } });
      }
      user.email = email.toLowerCase();
    }

    if (firstName !== undefined) {
      user.firstName = (firstName || '').trim();
    }
    if (lastName !== undefined) {
      user.lastName = (lastName || '').trim();
    }

    // Guard against demoting the last remaining system administrator (Req 11.5
    // safety): if this user is currently a sysadmin and the change would drop
    // that role, ensure at least one other sysadmin exists first.
    if (role !== undefined && role !== user.role && user.role === 'system_administrator') {
      const otherAdmins = await User.countDocuments({
        role: 'system_administrator',
        _id: { $ne: user._id },
      });
      if (otherAdmins === 0) {
        return res.status(409).json({
          error: {
            code: 'LAST_ADMIN',
            message: 'Cannot remove the last system administrator',
          },
        });
      }
    }
    if (role !== undefined) {
      user.role = role;
    }

    if (newPassword !== undefined) {
      user.passwordHash = await authService.hashPassword(newPassword);
    }

    await user.save();

    return res.status(200).json({
      id: user._id,
      email: user.email,
      role: user.role,
      firstName: user.firstName,
      lastName: user.lastName,
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/bands — list all bands for admin UIs (e.g. band pickers).
// Sysadmin-only. Returns { id, name, administrator } sorted by name.
router.get('/bands', async (req, res, next) => {
  try {
    const bands = await Band.find({}, { name: 1, administrator: 1, archivedAt: 1 }).sort({ name: 1 });
    return res.status(200).json(
      bands.map((b) => ({
        id: b._id,
        name: b.name,
        administrator: b.administrator,
        archivedAt: b.archivedAt || null,
      }))
    );
  } catch (err) {
    next(err);
  }
});

// GET /admin/bands/:id/members — list any band's members (sysadmin).
//
// Unlike GET /bands/:id/members (band-scoped to the caller's current band),
// this is band-independent: a sysadmin can view the membership of any band by
// id from the admin UI. Members are found via the indexed `bands.band` lookup;
// the `bands.$` projection returns the matching membership entry so each
// member's isAdmin flag (the band-administrator designator) comes back too.
// Returns [{ id, email, firstName, lastName, isAdmin }] sorted by email.
router.get('/bands/:id/members', async (req, res, next) => {
  try {
    const band = await Band.findById(req.params.id);
    if (!band) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Band not found' } });
    }

    const users = await User.find(
      { 'bands.band': band._id },
      { email: 1, firstName: 1, lastName: 1, 'bands.$': 1 }
    ).sort({ email: 1 });

    const members = users.map((u) => ({
      id: u._id,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      isAdmin: !!(u.bands && u.bands[0] && u.bands[0].isAdmin),
    }));

    return res.status(200).json(members);
  } catch (err) {
    next(err);
  }
});

// POST /admin/bands — create a band for any user and make them its administrator (Req 11.2).
router.post('/bands', async (req, res, next) => {
  try {
    const { name, administrator } = req.body;
    const errors = {};

    if (!name || !name.trim()) errors.name = 'Name is required';
    if (!administrator) errors.administrator = 'Administrator user id is required';

    if (Object.keys(errors).length) {
      validateFields(errors);
    }

    const adminUser = await User.findById(administrator);
    if (!adminUser) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Administrator user not found' } });
    }

    // Band.administrator is required at creation; create it pointing at the
    // target user, then run setAdministrator to establish the single-admin
    // membership invariant (adds the membership with isAdmin: true).
    const band = await Band.create({ name: name.trim(), administrator: adminUser._id });
    await membershipService.setAdministrator(band._id, adminUser._id);
    await seedGenres.seedBandGenres(band._id);

    return res.status(201).json({ id: band._id, name: band.name });
  } catch (err) {
    next(err);
  }
});

// POST /admin/bands/:id/members — add a member directly, no join request (Req 11.3).
router.post('/bands/:id/members', async (req, res, next) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      validateFields({ userId: 'User id is required' });
    }

    const band = await Band.findById(req.params.id);
    if (!band) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Band not found' } });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
    }

    await membershipService.addMember(band._id, user._id);

    return res.status(200).json({ message: 'Member added' });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/bands/:id/administrator — designate/reassign the administrator (Req 11.3).
router.patch('/bands/:id/administrator', async (req, res, next) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      validateFields({ userId: 'User id is required' });
    }

    const band = await Band.findById(req.params.id);
    if (!band) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Band not found' } });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
    }

    await membershipService.setAdministrator(band._id, user._id);

    return res.status(200).json({ message: 'Administrator updated' });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/bands/:id — rename any band (sysadmin). Unlike the band-admin
// PATCH /bands/:id (which is scoped to the caller's current band), this looks
// up the band by :id directly so a sysadmin can rename any band from the
// admin UI without it being their current band.
router.patch('/bands/:id', async (req, res, next) => {
  try {
    const { name } = req.body;

    if (!name || !name.trim()) {
      validateFields({ name: 'Name is required' });
    }

    const band = await Band.findById(req.params.id);
    if (!band) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Band not found' } });
    }

    band.name = name.trim();
    await band.save();

    return res.status(200).json({ id: band._id, name: band.name });
  } catch (err) {
    next(err);
  }
});

// Two-stage band deletion (#42). A band must be ARCHIVED (soft delete) before
// it can be hard-deleted with cascade. Both stages are sysadmin-only.

// POST /admin/bands/:id/archive — stage 1: soft-delete / archive a band.
//
// Sets archivedAt/archivedBy. Archived bands are filtered out of members' band
// lists and the token claim (see authService.buildBandsClaim and
// GET /me/bands), so they drop out of the switcher on the next token refresh
// and can no longer be selected as a current band — while their data stays
// intact and archiving is fully reversible (see unarchive). Returns 409 if the
// band is already archived.
router.post('/bands/:id/archive', async (req, res, next) => {
  try {
    const band = await Band.findById(req.params.id);
    if (!band) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Band not found' } });
    }
    if (band.archivedAt) {
      return res.status(409).json({ error: { code: 'ALREADY_ARCHIVED', message: 'Band is already archived' } });
    }

    band.archivedAt = new Date();
    band.archivedBy = req.user._id;
    await band.save();

    return res.status(200).json({ id: band._id, name: band.name, archivedAt: band.archivedAt });
  } catch (err) {
    next(err);
  }
});

// POST /admin/bands/:id/unarchive — reverse an archive, restoring the band to
// normal use. Clears archivedAt/archivedBy. Returns 409 if not archived.
router.post('/bands/:id/unarchive', async (req, res, next) => {
  try {
    const band = await Band.findById(req.params.id);
    if (!band) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Band not found' } });
    }
    if (!band.archivedAt) {
      return res.status(409).json({ error: { code: 'NOT_ARCHIVED', message: 'Band is not archived' } });
    }

    band.archivedAt = null;
    band.archivedBy = null;
    await band.save();

    return res.status(200).json({ id: band._id, name: band.name, archivedAt: null });
  } catch (err) {
    next(err);
  }
});

// DELETE /admin/bands/:id — stage 2: hard-delete a band with cascade.
//
// Only permitted once the band is ARCHIVED (409 NOT_ARCHIVED otherwise), so a
// destructive cascade always follows a deliberate archive step. Atomically
// (inside a transaction where the deployment supports one — see
// membershipService.withOptionalTransaction) deletes all resources the band
// owns — Songs, Playlists, Gigs, Genres, JoinRequests, Invites — removes the
// band from every user's bands[] membership, and finally deletes the Band.
router.delete('/bands/:id', async (req, res, next) => {
  try {
    const band = await Band.findById(req.params.id);
    if (!band) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Band not found' } });
    }
    if (!band.archivedAt) {
      return res.status(409).json({
        error: {
          code: 'NOT_ARCHIVED',
          message: 'Band must be archived before it can be deleted',
        },
      });
    }

    const bandId = band._id;

    await membershipService.withOptionalTransaction(async (session) => {
      const opts = session ? { session } : {};
      // Delete all band-owned resources.
      await Promise.all([
        Song.deleteMany({ band: bandId }, opts),
        Playlist.deleteMany({ band: bandId }, opts),
        Gig.deleteMany({ band: bandId }, opts),
        Genre.deleteMany({ band: bandId }, opts),
        JoinRequest.deleteMany({ band: bandId }, opts),
        Invite.deleteMany({ band: bandId }, opts),
      ]);
      // Remove the band from every user's membership list.
      await User.updateMany(
        { 'bands.band': bandId },
        { $pull: { bands: { band: bandId } } },
        opts
      );
      // Finally remove the band itself.
      await Band.deleteOne({ _id: bandId }, opts);
    });

    return res.status(200).json({ message: 'Band deleted' });
  } catch (err) {
    next(err);
  }
});

// GET /admin/seed-genres — return the current master Seed_Genre_List (Req 11.4, 10.4).
router.get('/seed-genres', (req, res) => {
  return res.status(200).json({ genres: [...seedGenreList] });
});

// PUT /admin/seed-genres — replace the maintained Seed_Genre_List (Req 11.4, 10.4).
router.put('/seed-genres', (req, res, next) => {
  try {
    const { genres } = req.body;

    if (!Array.isArray(genres)) {
      validateFields({ genres: 'Must be an array of genre names' });
    }

    const cleaned = genres
      .map((g) => (typeof g === 'string' ? g.trim() : ''))
      .filter((g) => g.length > 0);

    if (cleaned.length !== genres.length) {
      validateFields({ genres: 'Every genre must be a non-empty string' });
    }

    seedGenreList = cleaned;

    return res.status(200).json({ genres: [...seedGenreList] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
