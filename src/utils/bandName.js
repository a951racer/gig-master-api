// Shared handling for the global unique band-name constraint (the { name }
// unique index with case-insensitive collation on the Band model). A duplicate
// create/rename surfaces as a MongoDB E11000 duplicate-key error; translate it
// into a 409 with a user-friendly message rather than a 500.

function isDuplicateBandNameError(err) {
  return err && (err.code === 11000 || err.code === 11001);
}

function duplicateBandNameError() {
  const err = new Error('A band with that name already exists');
  err.status = 409;
  err.code = 'DUPLICATE_BAND_NAME';
  return err;
}

module.exports = { isDuplicateBandNameError, duplicateBandNameError };
