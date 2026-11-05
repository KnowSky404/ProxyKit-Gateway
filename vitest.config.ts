import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { authEnv, fixture, upstream } from './tests/fixtures';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const origin = upstream(await fixture());
      return {
        config: './cloudflare.config.ts',
        miniflare: {
          bindings: { ...(await authEnv()) },
          // Mock at the network boundary so workerd validates the real fetch call and options.
          outboundService: async (request) => {
            if (new URL(request.url).origin !== 'https://api.github.com')
              throw new Error('Unexpected external request');
            if (
              request.headers.get('Authorization') ===
              'Bearer redirect-test-placeholder'
            ) {
              return new Response(null, {
                status: 302,
                headers: { Location: 'https://other.example.com/' },
              });
            }
            return origin.request(request.url, {
              headers: request.headers,
              redirect: 'manual',
            });
          },
        },
      };
    }),
  ],
  test: { include: ['tests/**/*.test.ts'], testTimeout: 20000 },
});
