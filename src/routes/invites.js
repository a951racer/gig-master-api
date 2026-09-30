// src/routes/invites.js
//
// Public + authenticated invite-acceptance endpoints, mounted at /invites.
//
//   - GET  /invites/:token          (public)        look up an invite by its
//                                                    raw token for the accept
//                                                    screen; never leaks the
//                                                    token or sensitive data.
//   - POST /invites/:token/accept   (authenticate)  the logged-in invitee (whose
//                                                    email must match) accepts,
//                                                    becoming a non-admin member.
//
// The raw token is never stored; we hash the :token param (authService.hashToken)
// and look up the invite by tokenHash. A pending invite past its expiresAt is
// treated as expired.
//
// Error responses follow the project convention `{ error: { code, message } }`.

const express = require('express');

const Invite = require('../models/Invite');
const Band = require('../models/Band');
const User = require('../models/User');
const authService = require('../services/authService');
const membershipService = require('../services/membershipService');
const authenticate = require('../middleware/authenticate');

const router = express.Router();

// Compute the effective status of an invite: a pending invite past its
// expiresAt is treated as expired. Returns the effective status string.
function effectiveStatus(invite) {
  if (invite.status === 'pending' && invite.expiresAt && invite.expiresAt.getTime() < Date.now()) {
    return 'expired';
  }
  return invite.status;
}

// GET /invites/:token — PUBLIC. Look up an invite by its raw token so the
// accept screen can show the band name and decide whether the invitee needs to
// register first. Persists the expired transition so the queue stays accurate.
router.get('/:token', async (req, res, next) => {
  try {
    const tokenHash = authService.hashToken(req.params.token);
    const invite = await Invite.findOne({ tokenHash });
    if (!invite) {
      const err = new Error('Invite not found');
      err.status = 404;
      err.code = 'NOT_FOUND';
      return next(err);
    }

    const status = effectiveStatus(invite);
    if (status === 'expired' && invite.status === 'pending') {
      invite.status = 'expired';
      await invite.save();
    }

    const band = await Band.findById(invite.band);
    const existingUser = await User.findOne({ email: invite.email });

    return res.status(200).json({
      bandName: band ? band.name : null,
      email: invite.email,
      status,
      hasAccount: Boolean(existingUser),
    });
  } catch (err) {
    next(err);
  }
});

// POST /invites/:token/accept — the logged-in invitee accepts the invite.
//
// Requires authenticate. The invite must exist (404), be pending and not
// expired (409 INVITE_INVALID otherwise), and be addressed to the caller's own
// email (403 FORBIDDEN on mismatch). On success the caller is added as a
// non-admin member and the invite is marked accepted.
router.post('/:token/accept', authenticate, async (req, res, next) => {
  try {
    const tokenHash = authService.hashToken(req.params.token);
    const invite = await Invite.findOne({ tokenHash });
    if (!invite) {
      const err = new Error('Invite not found');
      err.status = 404;
      err.code = 'NOT_FOUND';
      return next(err);
    }

    const status = effectiveStatus(invite);
    if (status !== 'pending') {
      if (invite.status === 'pending') {
        // Persist the lazily-computed expired transition.
        invite.status = 'expired';
        await invite.save();
      }
      return res.status(409).json({
        error: {
          code: 'INVITE_INVALID',
          message: 'This invite is no longer valid',
        },
      });
    }

    if (String(req.user.email).toLowerCase() !== invite.email.toLowerCase()) {
      return res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'This invite was sent to a different email',
        },
      });
    }

    await membershipService.addMember(invite.band, req.user._id, { isAdmin: false });
    invite.status = 'accepted';
    await invite.save();

    return res.status(200).json({ bandId: invite.band, status: 'accepted' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
