import { route } from '../src/config/contract';

// Run only in a private terminal. Redirect output to a protected, ignored file.
const [id, transport, ...paths] = process.argv.slice(2);
if (
  !id ||
  !/^[a-z0-9-]{1,64}$/.test(id) ||
  !['bearer', 'url'].includes(transport ?? '') ||
  !paths.length
) {
  throw new Error(
    'Usage: bun run device:new <device-id> <bearer|url> <API path> [...]',
  );
}
if (
  paths.length > 32 ||
  new Set(paths).size !== paths.length ||
  paths.some((path) => !route(path))
) {
  throw new Error(
    'Use unique, exact /v1/private/... artifact paths (maximum 32).',
  );
}
const token = btoa(
  String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
)
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '');
const digest = new Uint8Array(
  await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)),
);
const sha256 = Array.from(digest, (byte) =>
  byte.toString(16).padStart(2, '0'),
).join('');
console.log(
  JSON.stringify(
    { token, device: { id, transport, enabled: true, sha256, paths } },
    null,
    2,
  ),
);
