import { expect, test } from 'bun:test';

const path = '/v1/private/loon/example.list';
function generate(...args: string[]) {
  return Bun.spawnSync(['bun', 'scripts/device-token.ts', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

test('generates independent high-entropy device credentials with matching stored digest', async () => {
  const first = generate('phone', 'bearer', path);
  const second = generate('phone-url', 'url', path);
  expect(first.exitCode).toBe(0);
  expect(second.exitCode).toBe(0);
  const a = JSON.parse(first.stdout.toString());
  const b = JSON.parse(second.stdout.toString());
  expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(a.token).not.toBe(b.token);
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(a.token),
  );
  expect(a.device.sha256).toBe(Buffer.from(hash).toString('hex'));
  expect(a.device).toMatchObject({
    id: 'phone',
    transport: 'bearer',
    enabled: true,
    paths: [path],
  });
  expect(b.device.transport).toBe('url');
});

test('rejects missing, invalid and ambiguous device scopes before generating output', () => {
  for (const args of [
    [],
    ['phone', 'bad', path],
    ['phone', 'url', '/manifest.json'],
    ['phone', 'bearer', path, path],
    ['phone', 'bearer', '*', path],
    ['phone', 'url', '/v1/private/loon/*'],
  ]) {
    const result = generate(...args);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.length).toBe(0);
  }
});

test.each(['bearer', 'url'])(
  'defaults %s credentials to fixed repository access',
  (transport) => {
    const result = generate('phone', transport);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString()).device.paths).toEqual(['*']);
  },
);
