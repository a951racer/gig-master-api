function bandScope(req, res, next) {
  const bandId = req.headers['x-band-id'];
  const bands = (req.tokenClaims && req.tokenClaims.bands) || [];

  if (!bandId) {
    return res.status(403).json({
      error: { code: 'BAND_REQUIRED', message: 'X-Band-Id header is required' },
    });
  }

  const entry = bands.find((b) => b.id === bandId);
  if (!entry) {
    return res.status(403).json({
      error: { code: 'BAND_NOT_A_MEMBER', message: 'Not a member of the selected band' },
    });
  }

  req.currentBand = bandId;
  req.currentBandIsAdmin = entry.isAdmin === true;
  next();
}

module.exports = bandScope;
