import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // client.ts creates a pg.Pool on import (infrastructure/connection factory)
      // and is only useful in a live Postgres context — excluded from unit coverage.
      // Live integration tests exercise the schema via direct Pool creation.
      exclude: [
        'src/**/*.test.ts',
        'src/__tests__/**',
        'src/client.ts',
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
})
