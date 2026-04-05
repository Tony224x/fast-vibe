module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  clearMocks: true,
  forceExit: true,
  coveragePathIgnorePatterns: ['/node_modules/'],
};
