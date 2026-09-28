// src/routes/bands.js
//
// Bands router (Task 8.1 — Requirements 1.2, 1.5, 1.6, 8.6).
//
// This task implements the three "no join-request" endpoints from the design's
// API Surface:
//   - POST /bands              (authenticate)            create a band; creator
//                                                        becomes admin+member;
//                                                        seeds genres.
//   - GET  /me/bands           (authenticate)            caller's canonical
//                                                        memberships from the DB.
//   - GET  /bands/:id/members  (authenticate, bandScope) current band's members
//                                                        via the indexed User
//                                                        lookup.
//
// POST /bands and GET /me/bands use ONLY authenticate, because a user may have
// no band yet (see design Middleware ordering table). GET /bands/:id/members
// adds bandScope so only members of the selected current band may view it.
//
// The join-request endpoints (POST/GET /bands/:id/join-requests, PATCH resolve,
// GET /me/join-requests) are a SEPARATE later task (8.3) and are intentionally
// NOT implemented here — they will extend this same file.
//
// Error responses follow the project convention `{ error: { code, message } }`
// with 422 carrying `error.fields` via the `validateFields` helper.
//
// This router is NOT mounted here; wiring into app.js is Task 11.1.

const express = require('express');

const Band = require('../models/Band');
const User = require('../models/User');
const membershipService = require('../services/membershipService');
const seedGenres = require('../config/seedGenres');
const authenticate = require('../middleware/authenticate');
const bandScope = require('../middleware/bandScope');
const { validateFields } = require('../middleware/validate');

const router = express.Router();

// POST /bands — create a band with the current user as its administrator.
//
// The creator becomes administrator + member atomically: create the Band
// pointing at req.user, then setAdministrator establishes the single-admin
// membership invariant (adds the creator's membership with isAdmin: true), then
// seed the new band's genres from the master Seed_Genre_List (Req 1.2, 1.5).
router.post('/', authenticate, async (req, res, next) => {
  try {
    const { name } = req.body;

    if (!name || !name.trim()) {
      validateFields({ name: 'Name is required' });
    }

    // Band.administrator is required at creation; create it pointing at the
    // creator, then run setAdministrator to establish the single-admin
    // membership invariant (adds the membership with isAdmin: true) — Req 1.6.
    const band = await Band.create({ name: name.trim(), administrator: req.user._id });
    await membershipService.setAdministrator(band._id, req.user._id);
    await seedGenres.seedBandGenres(band._id);

    return res.status(201).json({ id: band._id, name: band.name });
  } catch (err) {
    next(err);
  }
});

// GET /me/bands — the caller's canonical memberships, read from the DB (Req 8.6).
//
// This is the authoritative membership list (used for admin/debug); the client
// switcher relies on the token claim instead. Load the user with bands.band
// populated for the band name and project to [{ id, name, isAdmin }].
router.get('/me/bands', authenticate, async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).populate('bands.band', 'name');
    const bands = (user && user.bands ? user.bands : [])
      .filter((m) => m.band)
      .map((m) => ({ id: m.band._id, name: m.band.name, isAdmin: m.isAdmin === true }));

    return res.status(200).json(bands);
  } catch (err) {
    next(err);
  }
});

// GET /bands/:id/members — list the current band's members (Req 8.6).
//
// bandScope confines this to members of the selected current band. The member
// set is an indexed lookup on User (`bands.band` multikey index); the `bands.$`
// projection returns the matching membership entry so isAdmin comes back too.
router.get('/:id/members', authenticate, bandScope, async (req, res, next) => {
  try {
    const users = await User.find(
      { 'bands.band': req.currentBand },
      { email: 1, 'bands.$': 1 }
    );

    const members = users.map((u) => ({
      id: u._id,
      email: u.email,
      isAdmin: !!(u.bands && u.bands[0] && u.bands[0].isAdmin),
    }));

    return res.status(200).json(members);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
