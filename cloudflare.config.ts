import { bindings, defineConfig } from 'cf/config';
import * as entrypoint from './src/index.ts' with { type: 'cf-worker' };
import { DEFAULT_METADATA_CACHE_TTL_SECONDS } from './src/config/contract.ts';

export default defineConfig({
  worker: {
    name: 'proxykit-gateway',
    compatibilityDate: '2026-11-05',
    entrypoint,
    workersDev: true,
    previewUrls: false,
    observability: {
      enabled: true,
      redactQueryString: true,
      logs: { enabled: true, invocationLogs: false },
      traces: { enabled: false },
    },
    env: {
      ALLOW_URL_TOKENS: bindings.text<string>('true'),
      METADATA_CACHE_TTL_SECONDS: bindings.text<string>(
        DEFAULT_METADATA_CACHE_TTL_SECONDS,
      ),
      GITHUB_READ_TOKEN: bindings.secret(),
      DEVICE_AUTH: bindings.secret(),
    },
  },
});
