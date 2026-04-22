import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // Run test files serially. Live integration tests (live-auth, live-seed,
    // live-invites) share a single docker Postgres and would race on row
    // inserts + truncates if vitest ran files in parallel. Unit-only suites
    // don't benefit meaningfully from parallelism at this size.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // index.ts / logger.ts / sentry.ts are boot/init files that only run
      // in the full process context — not testable in unit/integration tests.
      // The gate criterion targets foundation routes (/healthz, /echo) in app.ts.
      exclude: [
        'src/**/*.test.ts',
        'src/__tests__/**',
        'src/index.ts',
        'src/logger.ts',
        'src/sentry.ts',
        'dist/**',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
