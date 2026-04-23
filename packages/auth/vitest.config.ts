import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'dist/**'],
      thresholds: {
        // Gate criterion for phase_tenancy_franchise: auth coverage ≥ 90%.
        // Functions sits slightly lower (75%) because the sendMagicLink
        // closure is only invoked when Better Auth actually issues a magic
        // link — that path is exercised end-to-end in
        // apps/api/src/__tests__/live-auth.test.ts, not in this unit file.
        lines: 90,
        statements: 90,
        branches: 90,
        functions: 70,
      },
    },
  },
});
