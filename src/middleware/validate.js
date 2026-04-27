/**
 * Throws a structured 422 error with field-level messages.
 * @param {Object} fields - { fieldName: errorMessage }
 */
function validateFields(fields) {
  if (Object.keys(fields).length === 0) return;

  const err = new Error('Validation failed');
  err.status = 422;
  err.code = 'VALIDATION_ERROR';
  err.fields = fields;
  throw err;
}

module.exports = { validateFields };
