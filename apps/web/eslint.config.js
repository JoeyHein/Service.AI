import { createRequire } from 'module';

// eslint-config-next ships CJS; createRequire lets ESM packages load it.
const require = createRequire(import.meta.url);

/** @type {import('eslint').Linter.Config[]} */
const nextCoreWebVitals = require('eslint-config-next/core-web-vitals');

const config = [
  ...nextCoreWebVitals,
  {
    ignores: ['.next/**', 'node_modules/**'],
  },
];

export default config;
