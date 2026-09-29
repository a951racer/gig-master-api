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
// Task 8.3 extends this file with the join-request endpoints:
//   - POST  /bands/:id/join-requests          (authenticate)                request to join
//   - GET   /bands/:id/join-requests          (authenticate, bandScope,     list pending
//                                              requireBandAdmin)
//   - PATCH /bands/:id/join-requests/:reqId    (authenticate, bandScope,     approve/deny
//                                              requireBandAdmin)
//   - GET   /me/join-requests                 (authenticate)                caller statuses
//
// POST create and GET /me/join-requests use ONLY authenticate: the requester
// need not (yet) be a member of the band, and a caller listing their own
// requests has no current band context (see design Middleware ordering table).
// The admin list/resolve endpoints add bandScope + requireBandAdmin so only an
// administrator of the current band (or a system_administrator override) may
// see or resolve its queue (Req 8.2, 8.3, 8.5).
//
// Error responses follow the project convention `{ error: { code, message } }`
// with 422 carrying `error.fields` via the `validateFields` helper.
//
// This router is NOT mounted here; wiring into app.js is Task 11.1.

const express = require('express');

const Band = require('../models/Band');
const User = require('../models/User');
const JoinRequest = require('../models/JoinRequest');
const membershipService = require('../services/membershipService');
const seedGenres = require('../config/seedGenres');
const authenticate = require('../middleware/authenticate');
const bandScope = require('../middleware/bandScope');
const { requireBandAdmin } = require('../middleware/authorize');
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

// PATCH /bands/:id — rename the current band (band admin only).
//
// Guarded by bandScope + requireBandAdmin so only the administrator of the
// current band (or a system_administrator) may rename it. The band is looked up
// scoped to req.currentBand so :id must be the current band. Because the band
// name is embedded in the JWT bands[] claim, the client should refresh its
// token after a successful rename so the switcher reflects the new name.
router.patch('/:id', authenticate, bandScope, requireBandAdmin, async (req, res, next) => {
  try {
    const { name } = req.body;

    if (!name || !name.trim()) {
      validateFields({ name: 'Name is required' });
    }

    const band = await Band.findOne({ _id: req.currentBand });
    if (!band) {
      const err = new Error('Band not found');
      err.status = 404;
      err.code = 'NOT_FOUND';
      return next(err);
    }

    band.name = name.trim();
    await band.save();

    return res.status(200).json({ id: band._id, name: band.name });
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

// GET /me/join-requests — the caller's own request statuses (Req 8.4).
//
// Only `authenticate`: the caller lists their own requests across any band,
// with no current-band context. The band name is populated for display, so the
// returned `band` is the populated object. Registered BEFORE the `/:id/...`
// join-request routes so the literal `/me` segment is not captured by `:id`.
router.get('/me/join-requests', authenticate, async (req, res, next) => {
  try {
    const requests = await JoinRequest.find({ user: req.user._id })
      .populate('band', 'name');

    const payload = requests.map((r) => ({ band: r.band, status: r.status }));
    return res.status(200).json(payload);
  } catch (err) {
    next(err);
  }
});

// POST /bands/:id/join-requests — request to join band :id (Req 8.1).
//
// Only `authenticate`: the requester is (by definition) not yet a member, so
// there is no current-band context to enforce. The band must exist (404). The
// JoinRequest is created with the default 'pending' status. The partial unique
// index on { band, user } filtered to status 'pending' rejects a second
// simultaneous pending request with a duplicate-key error (code 11000), which
// we surface as 409 CONFLICT — a user may still re-request after a denial.
router.post('/:id/join-requests', authenticate, async (req, res, next) => {
  try {
    const band = await Band.findById(req.params.id);
    if (!band) {
      const err = new Error('Band not found');
      err.status = 404;
      err.code = 'NOT_FOUND';
      return next(err);
    }

    const joinRequest = await JoinRequest.create({
      band: req.params.id,
      user: req.user._id,
    });

    return res.status(201).json({ id: joinRequest._id, status: joinRequest.status });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({
        error: { code: 'CONFLICT', message: 'A pending request already exists' },
      });
    }
    next(err);
  }
});

// GET /bands/:id/join-requests — the current band's pending queue (Req 8.2).
//
// bandScope + requireBandAdmin confine this to an administrator of the current
// band (or a system_administrator override). Only pending requests are listed;
// the requester's email is populated for display.
router.get('/:id/join-requests', authenticate, bandScope, requireBandAdmin, async (req, res, next) => {
  try {
    const requests = await JoinRequest.find({ band: req.currentBand, status: 'pending' })
      .populate('user', 'email');

    const payload = requests.map((r) => ({ id: r._id, user: r.user, status: r.status }));
    return res.status(200).json(payload);
  } catch (err) {
    next(err);
  }
});

// PATCH /bands/:id/join-requests/:reqId — approve or deny a request (Req 8.2, 8.3, 8.5).
//
// bandScope + requireBandAdmin gate this to the current band's administrator
// (or a sysadmin override). Body { status } must be 'approved' or 'denied'
// (422 otherwise). The request is looked up scoped to the current band so a
// request for another band yields 404. Approval adds the requester as a
// non-admin member via membershipService then marks the request approved;
// denial only marks the request denied and changes no membership.
router.patch('/:id/join-requests/:reqId', authenticate, bandScope, requireBandAdmin, async (req, res, next) => {
  try {
    const { status } = req.body;

    if (status !== 'approved' && status !== 'denied') {
      validateFields({ status: "Status must be 'approved' or 'denied'" });
    }

    const joinRequest = await JoinRequest.findOne({
      _id: req.params.reqId,
      band: req.currentBand,
    });
    if (!joinRequest) {
      const err = new Error('Join request not found');
      err.status = 404;
      err.code = 'NOT_FOUND';
      return next(err);
    }

    if (status === 'approved') {
      await membershipService.addMember(req.currentBand, joinRequest.user, { isAdmin: false });
      joinRequest.status = 'approved';
    } else {
      joinRequest.status = 'denied';
    }

    await joinRequest.save();
    return res.status(200).json({ id: joinRequest._id, status: joinRequest.status });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
