/**
 * Catch-all Express error handler.
 * Returns consistent JSON: { error: { code, message, fields } }
 */
function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  const code = err.code || 'INTERNAL_ERROR';
  const message = err.message || 'An unexpected error occurred';

  const body = { error: { code, message } };

  if (status === 422 && err.fields) {
    body.error.fields = err.fields;
  }

  res.status(status).json(body);
}

module.exports = errorHandler;
