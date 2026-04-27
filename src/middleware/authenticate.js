const jwt = require('jsonwebtoken');
const User = require('../models/User');

const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'dev-access-secret';

async function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: { code: 'TOKEN_MISSING', message: 'No token provided' },
    });
  }

  const token = authHeader.slice(7);

  try {
    const decoded = jwt.verify(token, ACCESS_TOKEN_SECRET);
    const user = await User.findById(decoded.sub);
    if (!user) {
      return res.status(401).json({
        error: { code: 'TOKEN_INVALID', message: 'Invalid token' },
      });
    }
    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: { code: 'TOKEN_EXPIRED', message: 'Token expired' },
      });
    }
    return res.status(401).json({
      error: { code: 'TOKEN_INVALID', message: 'Invalid token' },
    });
  }
}

module.exports = authenticate;
