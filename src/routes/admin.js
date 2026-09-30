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

// GET /admin/bands — list all bands for admin UIs (e.g. band pickers).
// Sysadmin-only. Returns { id, name, administrator } sorted by name.
router.get('/bands', async (req, res, next) => {
  try {
    const bands = await Band.find({}, { name: 1, administrator: 1 }).sort({ name: 1 });
    return res.status(200).json(
      bands.map((b) => ({ id: b._id, name: b.name, administrator: b.administrator }))
    );
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
