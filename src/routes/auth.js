const express = require('express');
const nodemailer = require('nodemailer');
const User = require('../models/User');
const RefreshToken = require('../models/RefreshToken');
const authService = require('../services/authService');
const authenticate = require('../middleware/authenticate');
const { validateFields } = require('../middleware/validate');

const router = express.Router();

const REFRESH_TOKEN_COOKIE = 'refreshToken';
const REFRESH_TOKEN_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days in ms

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    partitioned: process.env.NODE_ENV === 'production',
    maxAge: REFRESH_TOKEN_MAX_AGE,
  };
}

// POST /auth/register
router.post('/register', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const errors = {};

    if (!email || !isValidEmail(email)) errors.email = 'Must be a valid email address';
    if (!password || password.length < 8) errors.password = 'Must be at least 8 characters';

    if (Object.keys(errors).length) {
      validateFields(errors);
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ error: { code: 'EMAIL_TAKEN', message: 'Email already in use' } });
    }

    const passwordHash = await authService.hashPassword(password);
    await User.create({ email: email.toLowerCase(), passwordHash });

    return res.status(201).json({ message: 'User created' });
  } catch (err) {
    next(err);
  }
});

// POST /auth/login
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email: (email || '').toLowerCase() });
    if (!user) {
      return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } });
    }

    const valid = await authService.comparePassword(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } });
    }

    const accessToken = authService.generateAccessToken(user._id.toString());
    const refreshToken = authService.generateRefreshToken();
    const tokenHash = authService.hashToken(refreshToken);

    await RefreshToken.create({
      userId: user._id,
      tokenHash,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_MAX_AGE),
    });

    res.cookie(REFRESH_TOKEN_COOKIE, refreshToken, refreshCookieOptions());

    return res.status(200).json({
      accessToken,
      user: { id: user._id, email: user.email },
    });
  } catch (err) {
    next(err);
  }
});

// POST /auth/refresh
router.post('/refresh', async (req, res, next) => {
  try {
    const rawToken = req.cookies[REFRESH_TOKEN_COOKIE];
    if (!rawToken) {
      return res.status(401).json({ error: { code: 'TOKEN_MISSING', message: 'No refresh token provided' } });
    }

    const tokenHash = authService.hashToken(rawToken);
    const record = await RefreshToken.findOne({ tokenHash, expiresAt: { $gt: new Date() } });

    if (!record) {
      return res.status(401).json({ error: { code: 'TOKEN_INVALID', message: 'Invalid or expired refresh token' } });
    }

    const accessToken = authService.generateAccessToken(record.userId.toString());

    return res.status(200).json({ accessToken });
  } catch (err) {
    next(err);
  }
});

// POST /auth/logout
router.post('/logout', async (req, res, next) => {
  try {
    const rawToken = req.cookies[REFRESH_TOKEN_COOKIE];
    if (rawToken) {
      const tokenHash = authService.hashToken(rawToken);
      await RefreshToken.deleteOne({ tokenHash });
    }

    res.clearCookie(REFRESH_TOKEN_COOKIE, refreshCookieOptions());
    return res.status(200).json({ message: 'Logged out' });
  } catch (err) {
    next(err);
  }
});

// GET /auth/me
router.get('/me', authenticate, (req, res) => {
  return res.status(200).json({ id: req.user._id, email: req.user.email });
});

// PATCH /auth/me
router.patch('/me', authenticate, async (req, res, next) => {
  try {
    const user = req.user;
    const { email, currentPassword, newPassword } = req.body;

    if (email !== undefined) {
      if (!isValidEmail(email)) {
        validateFields({ email: 'Must be a valid email address' });
      }
      const existing = await User.findOne({ email: email.toLowerCase(), _id: { $ne: user._id } });
      if (existing) {
        return res.status(409).json({ error: { code: 'EMAIL_TAKEN', message: 'Email already in use' } });
      }
      user.email = email.toLowerCase();
    }

    if (currentPassword !== undefined || newPassword !== undefined) {
      const valid = await authService.comparePassword(currentPassword, user.passwordHash);
      if (!valid) {
        return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect' } });
      }
      if (!newPassword || newPassword.length < 8) {
        validateFields({ newPassword: 'Must be at least 8 characters' });
      }
      user.passwordHash = await authService.hashPassword(newPassword);
    }

    await user.save();
    return res.status(200).json({ id: user._id, email: user.email });
  } catch (err) {
    next(err);
  }
});

// DELETE /auth/me
router.delete('/me', authenticate, async (req, res, next) => {
  try {
    const user = req.user;

    await RefreshToken.deleteMany({ userId: user._id });
    await User.deleteOne({ _id: user._id });

    res.clearCookie(REFRESH_TOKEN_COOKIE, refreshCookieOptions());
    return res.status(200).json({ message: 'Account deleted' });
  } catch (err) {
    next(err);
  }
});

// POST /auth/forgot-password
router.post('/forgot-password', async (req, res, next) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email: (email || '').toLowerCase() });

    if (user) {
      const resetToken = authService.generateRefreshToken(); // opaque random token
      const resetTokenHash = authService.hashToken(resetToken);
      user.resetToken = resetTokenHash;
      user.resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 60 min
      await user.save();

      try {
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: parseInt(process.env.SMTP_PORT || '587', 10),
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
          },
        });

        const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/reset-password?token=${resetToken}`;

        await transporter.sendMail({
          from: process.env.SMTP_FROM || 'noreply@gigmaster.app',
          to: user.email,
          subject: 'GigMaster — Password Reset',
          text: `Reset your password: ${resetUrl}\n\nThis link expires in 60 minutes.`,
        });
      } catch (emailErr) {
        console.error('Failed to send password reset email:', emailErr);
      }
    }

    return res.status(200).json({ message: 'If that email is registered, a reset link has been sent' });
  } catch (err) {
    next(err);
  }
});

// POST /auth/reset-password
router.post('/reset-password', async (req, res, next) => {
  try {
    const { token, newPassword } = req.body;

    if (!token) {
      return res.status(422).json({ error: { code: 'INVALID_TOKEN', message: 'Token is invalid or expired' } });
    }

    const tokenHash = authService.hashToken(token);
    const user = await User.findOne({
      resetToken: tokenHash,
      resetTokenExpiry: { $gt: new Date() },
    });

    if (!user) {
      return res.status(422).json({ error: { code: 'INVALID_TOKEN', message: 'Token is invalid or expired' } });
    }

    if (!newPassword || newPassword.length < 8) {
      validateFields({ newPassword: 'Must be at least 8 characters' });
    }

    user.passwordHash = await authService.hashPassword(newPassword);
    user.resetToken = null;
    user.resetTokenExpiry = null;
    await user.save();

    return res.status(200).json({ message: 'Password reset successful' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
