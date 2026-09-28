// src/middleware/authorize.js
//
// Authorization helpers for the Bands feature.
//
// - requireSystemAdmin: gates on the token `role` only. It is band-independent
//   and does NOT require bandScope to have run (Req 3.4, 3.5, 11.5).
// - requireBandAdmin: authorizes a system_administrator (band-independent
//   override, Req 8.5, 11.5) OR a caller whose current band membership is
//   admin (`req.currentBandIsAdmin === true`, set by bandScope, Req 4.1, 4.2,
//   4.4). It must run AFTER bandScope.

function requireSystemAdmin(req, res, next) {
  if (req.tokenClaims?.role === 'system_administrator') return next();
  return res.status(403).json({
    error: { code: 'FORBIDDEN', message: 'System administrator role required' },
  });
}

function requireBandAdmin(req, res, next) {
  const isSysAdmin = req.tokenClaims?.role === 'system_administrator';
  if (isSysAdmin) return next(); // sysadmin overrides, band-independent
  if (req.currentBandIsAdmin === true) return next(); // set by bandScope
  return res.status(403).json({
    error: { code: 'FORBIDDEN', message: 'Band administrator required for the current band' },
  });
}

module.exports = { requireSystemAdmin, requireBandAdmin };
