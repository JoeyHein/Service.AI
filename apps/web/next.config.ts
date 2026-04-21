import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';

const nextConfig: NextConfig = {
  // Transpile workspace packages that publish TypeScript sources directly.
  // This alone is not sufficient when the package's source files use NodeNext
  // .js extensions in their imports — see the webpack config below.
  transpilePackages: ['@service-ai/contracts'],

  webpack(config: Parameters<NonNullable<NextConfig['webpack']>>[0]) {
    // @service-ai/contracts is compiled with NodeNext module resolution which
    // requires explicit .js extensions in TypeScript import statements (per the
    // TypeScript NodeNext spec). Next.js webpack runs in "bundler" mode and
    // cannot resolve these .js extensions to the actual .ts source files without
    // help. We add a custom resolver plugin rather than a global extensionAlias
    // (which would break Next.js's own internal .js → compiled-JS mapping) to
    // rewrite .js → .ts only for workspace packages under the monorepo root.
    const path = require('path') as typeof import('path');
    const monorepoRoot = path.resolve(__dirname, '..', '..');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- webpack type
    config.resolve.plugins ??= [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- webpack type
    (config.resolve.plugins as any[]).push({
      apply(resolver: any) {
        const target = resolver.ensureHook('resolve');
        resolver
          .getHook('resolve')
          .tapAsync('WorkspaceTsExtensionPlugin', (request: any, resolveContext: any, callback: any) => {
            const reqPath: string = request.request ?? '';
            // Only rewrite .js imports that come from within the monorepo's
            // packages directory — leave all node_modules .js references alone.
            const issuer: string = request.context?.issuer ?? '';
            const isFromMonorepoPackage =
              issuer.startsWith(monorepoRoot) &&
              !issuer.includes('node_modules') &&
              reqPath.endsWith('.js') &&
              reqPath.startsWith('.');

            if (!isFromMonorepoPackage) {
              return callback();
            }

            const tsRequest = {
              ...request,
              request: reqPath.slice(0, -3) + '.ts',
            };
            resolver.doResolve(target, tsRequest, null, resolveContext, (err: unknown, result: unknown) => {
              if (err || !result) {
                // Fall back to the original .js request.
                return callback();
              }
              return callback(null, result);
            });
          });
      },
    });

    return config;
  },
};

export default withSentryConfig(nextConfig, {
  // Disable Sentry CLI source-map upload; the upload requires SENTRY_AUTH_TOKEN
  // which is a CI-only secret. Skipping it keeps local and preview builds clean.
  silent: true,
  // Suppress the Sentry telemetry prompt during build.
  telemetry: false,
  // Disable source-map upload entirely so the build does not require the auth token.
  sourcemaps: {
    disable: true,
  },
  disableLogger: true,
  // We initialise Sentry manually in src/instrumentation.ts via the Next.js
  // instrumentation hook. Disable all automatic wrapping to avoid Sentry
  // injecting Pages Router imports (Html, Head, etc.) into App Router builds,
  // which Next.js rejects with "Html should not be imported outside of _document".
  autoInstrumentServerFunctions: false,
  autoInstrumentAppDirectory: false,
  autoInstrumentMiddleware: false,
});
