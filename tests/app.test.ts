import { afterEach, describe, expect, it, vi } from 'vitest';
import { exports } from 'cloudflare:workers';
import { createApp } from '../src/app';
import { GitHubArtifactProvider } from '../src/providers/github';
import {
  API_PATH,
  authEnv,
  fixture,
  get,
  NEXT,
  TOKEN,
  URL_TOKEN,
  upstream,
} from './fixtures';

afterEach(() => vi.restoreAllMocks());
async function setup() {
  const data = await fixture();
  const origin = upstream(data);
  const app = createApp(new GitHubArtifactProvider(origin.request));
  const env = await authEnv();
  return { data, origin, app, env };
}

it('runs the actual Worker entrypoint in workerd', async () => {
  const res = await exports.default.fetch(
    'https://gateway.example.com/v1/health',
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: 'ok' });
});

describe('HTTP and access control', () => {
  it.each([null, 'wrong', 'C'.repeat(43)])(
    'denies missing/invalid credentials before origin I/O',
    async (token) => {
      const { app, env, origin } = await setup();
      expect((await app(get(API_PATH, token), env)).status).toBe(401);
      expect(origin.calls).toHaveLength(0);
    },
  );
  it('returns health without origin secrets or private metadata', async () => {
    const { app, env, origin } = await setup();
    env.GITHUB_READ_TOKEN = '';
    const res = await app(get('/v1/health', null), env);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(origin.calls).toHaveLength(0);
  });
  it('does not fetch damaged unrequested bytes with repository access', async () => {
    const { app, env, data } = await setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const config = JSON.parse(env.DEVICE_AUTH);
    config.devices[0].paths = ['*'];
    env.DEVICE_AUTH = JSON.stringify(config);
    data.bytes.set('generated/sing-box/rules/example.srs', new Uint8Array([0]));
    expect((await app(get(), env)).status).toBe(200);
    expect(
      (await app(get('/v1/private/sing-box/example.srs'), env)).status,
    ).toBe(503);
  });
  it.each([
    ['/v1/private/loon/example.list', 'text/plain; charset=utf-8'],
    ['/v1/private/quantumultx/example.list', 'text/plain; charset=utf-8'],
    ['/v1/private/sing-box/example.json', 'application/json'],
    ['/v1/private/sing-box/example.srs', 'application/octet-stream'],
  ])(
    'serves verified bytes and private HTTP headers for %s',
    async (path, mime) => {
      const { app, env, data } = await setup();
      const res = await app(get(path), env);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe(mime);
      expect(res.headers.get('Cache-Control')).toBe('private, no-store');
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.has('Access-Control-Allow-Origin')).toBe(false);
      const original = data.bytes.get(
        path.includes('quantumultx')
          ? 'generated/quantumultx/filters/example.list'
          : `generated/${path.split('/').slice(3, 4)[0]}/rules/${path.split('/').at(-1)}`,
      );
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(original);
    },
  );
  it('denies paths outside a device scope without origin I/O', async () => {
    const { app, env, origin } = await setup();
    expect((await app(get('/v1/private/loon/other.list'), env)).status).toBe(
      403,
    );
    expect(origin.calls).toHaveLength(0);
  });
  it.each(['bearer', 'url'])(
    'tracks additions and deletions for %s repository access while enforcing authentication and disabling',
    async (transport) => {
      let current = upstream(await fixture());
      const request = vi.fn<typeof fetch>((input, init) =>
        current.request(input, init),
      );
      const app = createApp(new GitHubArtifactProvider(request));
      const env = await authEnv({ ALLOW_URL_TOKENS: 'true' });
      const config = JSON.parse(env.DEVICE_AUTH);
      for (const device of config.devices) device.paths = ['*'];
      env.DEVICE_AUTH = JSON.stringify(config);
      const download = (path: string, init: RequestInit = {}) =>
        get(
          transport === 'url' ? `${path}?key=${URL_TOKEN}` : path,
          transport === 'url' ? null : TOKEN,
          init,
        );
      const added = '/v1/private/loon/new.list';
      expect((await app(download(API_PATH), env)).status).toBe(200);
      expect((await app(download(added), env)).status).toBe(404);
      current = upstream(await fixture(['example', 'new']), NEXT);
      const published = await app(download(added), env);
      expect(published.status).toBe(200);
      expect(published.headers.get('X-Distribution-Commit')).toBe(NEXT);
      current = upstream(await fixture(['new']), 'e'.repeat(40));
      expect((await app(download(API_PATH), env)).status).toBe(404);
      const head = await app(download(added, { method: 'HEAD' }), env);
      expect(head.status).toBe(200);
      expect(await head.text()).toBe('');
      const conditional = {
        headers: { 'If-None-Match': head.headers.get('ETag')! },
      };
      expect((await app(download(added, conditional), env)).status).toBe(304);
      const calls = request.mock.calls.length;
      expect((await app(get(added, null, conditional), env)).status).toBe(401);
      expect((await app(download('/manifest.json'), env)).status).toBe(404);
      config.disabled_paths = [added];
      env.DEVICE_AUTH = JSON.stringify(config);
      expect((await app(download(added, conditional), env)).status).toBe(410);
      for (const device of config.devices) device.enabled = false;
      env.DEVICE_AUTH = JSON.stringify(config);
      expect((await app(download(added, conditional), env)).status).toBe(401);
      expect(request.mock.calls).toHaveLength(calls);
    },
  );
  it.each([
    { paths: ['*', API_PATH], disabled: [] },
    { paths: ['*', '*'], disabled: [] },
    { paths: ['/v1/private/loon/*'], disabled: [] },
    { paths: ['*'], disabled: ['*'] },
  ])(
    'rejects ambiguous scopes and wildcard disabling: %j',
    async ({ paths, disabled }) => {
      const { app, env, origin } = await setup();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const config = JSON.parse(env.DEVICE_AUTH);
      config.devices[0].paths = paths;
      config.disabled_paths = disabled;
      env.DEVICE_AUTH = JSON.stringify(config);
      expect((await app(get(), env)).status).toBe(503);
      expect(origin.calls).toHaveLength(0);
    },
  );
  it('revokes immediately even after a snapshot was cached', async () => {
    const { app, env, origin } = await setup();
    expect((await app(get(), env)).status).toBe(200);
    const calls = origin.calls.length;
    const config = JSON.parse(env.DEVICE_AUTH);
    config.devices[0].enabled = false;
    env.DEVICE_AUTH = JSON.stringify(config);
    expect((await app(get(), env)).status).toBe(401);
    config.devices.shift();
    env.DEVICE_AUTH = JSON.stringify(config);
    expect((await app(get(), env)).status).toBe(401);
    expect(origin.calls).toHaveLength(calls);
  });
  it('returns 410 only to an authenticated, authorized disabled subscription', async () => {
    const { app, env, origin } = await setup();
    const config = JSON.parse(env.DEVICE_AUTH);
    config.disabled_paths = [API_PATH];
    env.DEVICE_AUTH = JSON.stringify(config);
    expect((await app(get(), env)).status).toBe(410);
    expect((await app(get(API_PATH, null), env)).status).toBe(401);
    expect(origin.calls).toHaveLength(0);
  });
  it('requires explicit URL mode and separate URL-only credentials', async () => {
    const { app, env, origin } = await setup();
    const url = `${API_PATH}?key=${URL_TOKEN}`;
    expect((await app(get(url, null), env)).status).toBe(401);
    env.ALLOW_URL_TOKENS = 'true';
    expect((await app(get(url, null), env)).status).toBe(200);
    expect((await app(get(`${API_PATH}?key=${TOKEN}`, null), env)).status).toBe(
      401,
    );
    expect((await app(get(API_PATH, URL_TOKEN), env)).status).toBe(401);
    const calls = origin.calls.length;
    expect((await app(get(url), env)).status).toBe(401);
    expect((await app(get(`${url}&key=${URL_TOKEN}`, null), env)).status).toBe(
      401,
    );
    expect(origin.calls).toHaveLength(calls);
  });
  it('returns HEAD and authenticated conditional responses', async () => {
    const { app, env } = await setup();
    const first = await app(get(), env);
    const etag = first.headers.get('ETag')!;
    expect(
      (
        await app(
          get(API_PATH, TOKEN, {
            headers: { 'If-None-Match': `"other", W/${etag}` },
          }),
          env,
        )
      ).status,
    ).toBe(304);
    expect(
      (
        await app(
          get(API_PATH, null, { headers: { 'If-None-Match': etag } }),
          env,
        )
      ).status,
    ).toBe(401);
    const head = await app(get(API_PATH, TOKEN, { method: 'HEAD' }), env);
    expect(head.status).toBe(200);
    expect(head.headers.get('ETag')).toBe(etag);
    expect(Number(head.headers.get('Content-Length'))).toBeGreaterThan(0);
    expect(await head.text()).toBe('');
    const denied = await app(get(API_PATH, null, { method: 'HEAD' }), env);
    expect(denied.status).toBe(401);
    expect(await denied.text()).toBe('');
  });
  it.each([
    '/manifest.json',
    '/v1/private/loon/../secret.yaml',
    '/v1/private/loon/%2e%2e%2fsecret.list',
    '/v1/private/loon/%252e%252e.list',
    '/v1/private/loon/UPPER.list',
    '/v1/private/loon/a--b.list',
    '/v1/private/loon/a.json',
    '/v1/private/sing-box/a.list',
    '/v1/private/loon/a.list/extra',
    '/v1/private/loon/a%00.list',
    '/v1/private/loon/a.list?url=https://example.com',
  ])('rejects illegal routes (%s) without upstream access', async (path) => {
    const { app, env, origin } = await setup();
    expect((await app(get(path), env)).status).toBe(404);
    expect(origin.calls).toHaveLength(0);
  });
  it('returns 405 and Allow without origin access', async () => {
    const { app, env, origin } = await setup();
    const res = await app(get(API_PATH, null, { method: 'POST' }), env);
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, HEAD');
    expect(origin.calls).toHaveLength(0);
  });
  it.each([
    '',
    '{}',
    '{"devices":[],"disabled_paths":[]}',
    '{"devices":[],"devices":[]}',
  ])('fails closed on invalid configuration', async (config) => {
    const { app, env, origin } = await setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    env.DEVICE_AUTH = config;
    expect((await app(get(), env)).status).toBe(503);
    expect(origin.calls).toHaveLength(0);
  });
  it('does not expose URL tokens or arbitrary exception text in logs/errors', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const privateError = 'private-origin-response.example.com';
    const fail = async () => {
      throw new Error(privateError);
    };
    const app = createApp({ artifact: fail, catalog: fail });
    const env = await authEnv({ ALLOW_URL_TOKENS: 'true' });
    const res = await app(get(`${API_PATH}?key=${URL_TOKEN}`, null), env);
    const output = JSON.stringify(log.mock.calls) + (await res.text());
    expect(res.status).toBe(503);
    for (const secret of [
      TOKEN,
      URL_TOKEN,
      env.GITHUB_READ_TOKEN,
      privateError,
      '?key=',
      'Authorization',
    ]) {
      expect(output).not.toContain(secret);
    }
  });
});

it('requires HTTPS for private distribution before authentication or origin I/O', async () => {
  const { app, env, origin } = await setup();
  const request = new Request(`http://gateway.example.com${API_PATH}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  expect((await app(request, env)).status).toBe(400);
  expect(origin.calls).toHaveLength(0);
});

it('rotates one device and revokes its path scope without affecting another device', async () => {
  const { app, env } = await setup();
  const { sha256 } = await import('../src/manifest/validate');
  const rotated = 'D'.repeat(43);
  const config = JSON.parse(env.DEVICE_AUTH);
  expect((await app(get(), env)).status).toBe(200);
  config.devices[0].sha256 = await sha256(
    new Uint8Array(new TextEncoder().encode(rotated)),
  );
  env.DEVICE_AUTH = JSON.stringify(config);
  expect((await app(get(), env)).status).toBe(401);
  expect((await app(get(API_PATH, rotated), env)).status).toBe(200);
  config.devices[0].paths = [];
  env.DEVICE_AUTH = JSON.stringify(config);
  expect((await app(get(API_PATH, rotated), env)).status).toBe(403);
  env.ALLOW_URL_TOKENS = 'true';
  expect(
    (await app(get(`${API_PATH}?key=${URL_TOKEN}`, null), env)).status,
  ).toBe(200);
});

it.each([
  ['/v1/private/loon/example.list', 'generated/loon/rules/example.list'],
  [
    '/v1/private/quantumultx/example.list',
    'generated/quantumultx/filters/example.list',
  ],
  [
    '/v1/private/sing-box/example.json',
    'generated/sing-box/rules/example.json',
  ],
  ['/v1/private/sing-box/example.srs', 'generated/sing-box/rules/example.srs'],
])(
  'serves %s through the actual entrypoint and native workerd fetch',
  async (path, artifact) => {
    const res = await exports.default.fetch(get(path));
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      (await fixture()).bytes.get(artifact),
    );
  },
);

it('rejects a redirect at the native fetch boundary without following its Location', async () => {
  await expect(
    new GitHubArtifactProvider().artifact(
      'generated/loon/rules/example.list',
      'redirect-test-placeholder',
    ),
  ).rejects.toMatchObject({
    status: 503,
    category: 'upstream_unavailable',
  });
});

it('enforces the production Secret byte limit for device configuration', async () => {
  const { app, env, origin } = await setup();
  const config = env.DEVICE_AUTH;
  env.DEVICE_AUTH = config.padEnd(5000, ' ');
  expect((await app(get(), env)).status).toBe(200);
  const calls = origin.calls.length;
  env.DEVICE_AUTH = config.padEnd(5001, ' ');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect((await app(get(), env)).status).toBe(503);
  expect(origin.calls).toHaveLength(calls);
});
