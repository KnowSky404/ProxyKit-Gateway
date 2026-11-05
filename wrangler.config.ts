import { defineWranglerConfig } from 'wrangler/experimental-config';

// cf reads these development settings; deployment stays in cloudflare.config.ts.
export default defineWranglerConfig({ dev: { localProtocol: 'https' } });
