/**
 * Jest config. Plain CommonJS so jest can load it without ts-node.
 * ts-jest still compiles the .ts test sources on-the-fly.
 */
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/srv/'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  testTimeout: 30_000,
  collectCoverageFrom: [
    'srv/**/*.ts',
    '!srv/**/*.d.ts',
    '!srv/plugin.ts',
  ],
  coverageReporters: ['text', 'lcov'],
};
