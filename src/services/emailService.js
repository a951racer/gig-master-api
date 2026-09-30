const nodemailer = require('nodemailer');

// Reusable email transport built from EMAIL_* environment variables.
//
// NOTE: the env vars are EMAIL_HOST / EMAIL_PORT / EMAIL_USER / EMAIL_PASS /
// EMAIL_FROM (matching .env.example). The forgot-password code previously read
// SMTP_* keys, which did not exist in the environment, so email silently
// failed — this service is the single source of truth for mail config.

function isEmailConfigured() {
  return Boolean(process.env.EMAIL_HOST);
}

function buildTransport() {
  return nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: parseInt(process.env.EMAIL_PORT || '587', 10),
    // `secure` true for port 465 (implicit TLS), false otherwise (STARTTLS).
    secure: parseInt(process.env.EMAIL_PORT || '587', 10) === 465,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });
}

/**
 * Send an email. Resolves on success; rejects on transport/send failure so the
 * caller can decide how to handle it. Callers that must not fail the request
 * (e.g. forgot-password) should wrap this in try/catch.
 *
 * @param {{ to: string, subject: string, text?: string, html?: string }} msg
 */
async function sendMail({ to, subject, text, html }) {
  if (!isEmailConfigured()) {
    throw new Error('Email is not configured (EMAIL_HOST is not set)');
  }
  const transporter = buildTransport();
  return transporter.sendMail({
    from: process.env.EMAIL_FROM || 'noreply@gigmaster.app',
    to,
    subject,
    text,
    html,
  });
}

/**
 * Verify the transport can connect/authenticate. Useful for a startup check or
 * a one-off diagnostic. Rejects if not configured or verification fails.
 */
async function verifyTransport() {
  if (!isEmailConfigured()) {
    throw new Error('Email is not configured (EMAIL_HOST is not set)');
  }
  return buildTransport().verify();
}

module.exports = { sendMail, verifyTransport, isEmailConfigured };
