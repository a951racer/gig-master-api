module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  globalSetup: './src/config/testSetup.js',
  globalTeardown: './src/config/testTeardown.js',
};
