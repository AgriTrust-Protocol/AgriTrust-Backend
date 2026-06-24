export default {
  test: {
    exclude: ['tests/unit/sensors.test.ts', 'node_modules/**'],
    include: ['tests/**/*.test.ts'],
    pool: 'threads',
  },
};
