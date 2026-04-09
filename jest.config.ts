import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  clearMocks: true,
  forceExit: true,
  coveragePathIgnorePatterns: ['/node_modules/', '/dist/'],
  moduleNameMapper: { '^node-pty$': '<rootDir>/__mocks__/node-pty.ts' },
};

export default config;
