import { defineConfig } from 'vitest/config';

const coverageThreshold = 80;

export default defineConfig({
  test: {
    exclude: ['tests/unit/sensors.test.ts', 'node_modules/**'],
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    pool: 'threads',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      all: true,
      include: ['src/**/*.{ts,js}'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/tests/**',
        'src/database/migrations/**',
        'src/database/queries/**',
      ],
      thresholds: {
        lines: coverageThreshold,
        functions: coverageThreshold,
        branches: coverageThreshold,
        statements: coverageThreshold,
      },
    },
  },
});
