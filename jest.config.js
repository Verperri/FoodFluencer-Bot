module.exports = {
  testEnvironment: 'jsdom',
  testMatch: ['<rootDir>/test/**/*.test.js'],
  // chrome-mock only stubs globals (no Jest lifecycle hooks), so it can run
  // in setupFiles (before the test framework is installed). webcodecs-mock
  // calls `beforeEach`, which only exists once Jest's globals are in place,
  // so it must load via setupFilesAfterEnv instead — otherwise it throws
  // `ReferenceError: beforeEach is not defined` and every suite fails to run.
  setupFiles: ['<rootDir>/test/setup/chrome-mock.js'],
  setupFilesAfterEnv: ['<rootDir>/test/setup/webcodecs-mock.js'],
  testTimeout: 30000,
};
