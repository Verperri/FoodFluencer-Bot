module.exports = {
  testEnvironment: 'jsdom',
  testMatch: ['<rootDir>/test/**/*.test.js'],
  setupFiles: ['<rootDir>/test/setup/chrome-mock.js', '<rootDir>/test/setup/webcodecs-mock.js'],
  testTimeout: 30000,
};
