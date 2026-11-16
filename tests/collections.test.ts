import { afterEach, expect, it, vi } from 'vitest';
import { exports } from 'cloudflare:workers';
import { createApp } from '../src/app';
import { GitHubArtifactProvider } from '../src/providers/github';
import {
  API_PATH,
  authEnv,
  DIST,
  fixture,
  get,
  NEXT,
  TOKEN,
  URL_TOKEN,
  upstream,
} from './fixtures';

afterEach(() => vi.restoreAllMocks());
const collectionPath = '/v1/private/loon';
async function setup() {
  const data = await fixture(['example', 'other']);
  const origin = upstream(data);
  const provider = new GitHubArtifactProvider(origin.request);
  const env = await authEnv({ ALLOW_URL_TOKENS: 'true' });
  const config = JSON.parse(env.DEVICE_AUTH);
  for (const device of config.devices) device.paths = ['*'];
  env.DEVICE_AUTH = JSON.stringify(config);
  return { data, origin, provider, app: createApp(provider), env, config };
}

it.each(
  ['loon', 'quantumultx', 'sing-box'].flatMap((client) =>
    ['bearer', 'url'].map((transport) => ({ client, transport })),
  ),
)(
  'lists only $client resources with $transport credentials without downloading artifact bodies',
  async ({ client, transport }) => {
    const { app, env, origin } = await setup();
    const path = `/v1/private/${client}`;
    const request = (suffix: string) =>
      get(
        path + suffix + (transport === 'url' ? `?key=${URL_TOKEN}` : ''),
        transport === 'url' ? null : TOKEN,
      );
    const first = await app(request(''), env);
    expect(first.status).toBe(200);
    expect(first.headers.get('Content-Type')).toBe(
      'application/json; charset=utf-8',
    );
    expect(first.headers.get('Cache-Control')).toBe('private, no-store');
    expect(first.headers.get('X-Distribution-Commit')).toBe(DIST);
    const text = await first.text();
    const resources = ['example', 'other'].flatMap((name) =>
      (client === 'sing-box' ? ['json', 'srs'] : ['list']).map((extension) => ({
        name: `${name}.${extension}`,
        path: `${path}/${name}.${extension}`,
      })),
    );
    expect(JSON.parse(text)).toEqual({ resources });
    for (const secret of [
      TOKEN,
      URL_TOKEN,
      env.GITHUB_READ_TOKEN,
      'generated/',
      '?key=',
    ])
      expect(text).not.toContain(secret);
    expect(origin.calls).toHaveLength(3);
    expect(
      origin.calls.filter((call) => call.includes('/contents/')),
    ).toHaveLength(1);
    const trailing = await app(request('/'), env);
    expect(await trailing.text()).toBe(text);
    expect(trailing.headers.get('ETag')).toBe(first.headers.get('ETag'));
    expect(origin.calls).toHaveLength(4);
  },
);

it('filters exact scopes and disabled paths before computing a per-device ETag', async () => {
  const { app, env, origin, config } = await setup();
  const full = await app(get(collectionPath), env);
  const fullTag = full.headers.get('ETag')!;
  config.devices[0].paths = [API_PATH];
  env.DEVICE_AUTH = JSON.stringify(config);
  const restricted = await app(
    get(collectionPath, TOKEN, { headers: { 'If-None-Match': fullTag } }),
    env,
  );
  expect(restricted.status).toBe(200);
  expect(await restricted.json()).toEqual({
    resources: [{ name: 'example.list', path: API_PATH }],
  });
  expect(restricted.headers.get('ETag')).not.toBe(fullTag);
  config.disabled_paths = [API_PATH];
  env.DEVICE_AUTH = JSON.stringify(config);
  const empty = await app(
    get(collectionPath, TOKEN, {
      headers: { 'If-None-Match': restricted.headers.get('ETag')! },
    }),
    env,
  );
  expect(empty.status).toBe(200);
  expect(await empty.json()).toEqual({ resources: [] });
  expect((await app(get(), env)).status).toBe(410);
  const calls = origin.calls.length;
  expect((await app(get('/v1/private/sing-box'), env)).status).toBe(403);
  config.devices[0].paths = [];
  env.DEVICE_AUTH = JSON.stringify(config);
  expect((await app(get(collectionPath), env)).status).toBe(403);
  expect(origin.calls).toHaveLength(calls);
});

it('rechecks authentication and authorization for collection HEAD/304 and cached metadata', async () => {
  const { app, env, config, origin } = await setup();
  const first = await app(get(collectionPath), env);
  const body = await first.text();
  const etag = first.headers.get('ETag')!;
  const head = await app(get(collectionPath, TOKEN, { method: 'HEAD' }), env);
  expect(head.status).toBe(200);
  expect(await head.text()).toBe('');
  expect(Number(head.headers.get('Content-Length'))).toBe(
    new TextEncoder().encode(body).byteLength,
  );
  expect(head.headers.get('ETag')).toBe(etag);
  const conditional = { headers: { 'If-None-Match': `W/${etag}` } };
  expect((await app(get(collectionPath, TOKEN, conditional), env)).status).toBe(
    304,
  );
  const calls = origin.calls.length;
  const denied = await app(get(collectionPath, null, conditional), env);
  expect(denied.status).toBe(401);
  expect(denied.headers.has('ETag')).toBe(false);
  expect(denied.headers.has('X-Distribution-Commit')).toBe(false);
  config.devices[0].enabled = false;
  env.DEVICE_AUTH = JSON.stringify(config);
  expect((await app(get(collectionPath, TOKEN, conditional), env)).status).toBe(
    401,
  );
  expect(origin.calls).toHaveLength(calls);
});

it.each([null, 'wrong', 'C'.repeat(43)])(
  'denies invalid collection credentials before upstream I/O: %s',
  async (token) => {
    const { app, env, origin } = await setup();
    expect((await app(get(collectionPath, token), env)).status).toBe(401);
    expect(origin.calls).toHaveLength(0);
  },
);

it('keeps collection URL credentials explicit, separate, and unambiguous', async () => {
  const { app, env, origin } = await setup();
  env.ALLOW_URL_TOKENS = 'false';
  expect(
    (await app(get(`${collectionPath}?key=${URL_TOKEN}`, null), env)).status,
  ).toBe(401);
  env.ALLOW_URL_TOKENS = 'true';
  expect(
    (await app(get(`${collectionPath}?key=${TOKEN}`, null), env)).status,
  ).toBe(401);
  expect((await app(get(collectionPath, URL_TOKEN), env)).status).toBe(401);
  expect(
    (await app(get(`${collectionPath}?key=${URL_TOKEN}`), env)).status,
  ).toBe(401);
  expect(
    (
      await app(
        get(`${collectionPath}?key=${URL_TOKEN}&key=${URL_TOKEN}`, null),
        env,
      )
    ).status,
  ).toBe(401);
  expect(origin.calls).toHaveLength(0);
});

it('enforces collection HTTPS, query, and method boundaries without upstream I/O', async () => {
  const { app, env, origin } = await setup();
  expect(
    (
      await app(
        new Request(`http://gateway.example.com${collectionPath}`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        }),
        env,
      )
    ).status,
  ).toBe(400);
  for (const path of [
    '/v1/private',
    '/v1/private/other',
    '/v1/private/loon//',
    '/v1/private/%6coon',
    `${collectionPath}?url=https://example.com`,
  ])
    expect((await app(get(path), env)).status).toBe(404);
  const res = await app(get(collectionPath, null, { method: 'POST' }), env);
  expect(res.status).toBe(405);
  expect(res.headers.get('Allow')).toBe('GET, HEAD');
  expect(origin.calls).toHaveLength(0);
});

it('rejects invalid publication metadata before exposing a collection', async () => {
  const { app, env, data, origin } = await setup();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  data.manifest.schema_version = 2;
  const res = await app(get(collectionPath), env);
  expect(res.status).toBe(503);
  expect(await res.text()).not.toContain('example.list');
  expect(origin.calls).toHaveLength(3);
});

it('tracks collection additions and deletions at the latest pinned dist version', async () => {
  let current = upstream(await fixture());
  const app = createApp(
    new GitHubArtifactProvider((input, init) => current.request(input, init)),
  );
  const env = await authEnv();
  const config = JSON.parse(env.DEVICE_AUTH);
  config.devices[0].paths = ['*'];
  env.DEVICE_AUTH = JSON.stringify(config);
  expect(
    (
      (await (await app(get(collectionPath), env)).json()) as {
        resources: unknown[];
      }
    ).resources,
  ).toHaveLength(1);
  current = upstream(await fixture(['example', 'other']), NEXT);
  const updated = await app(get(collectionPath), env);
  expect(updated.headers.get('X-Distribution-Commit')).toBe(NEXT);
  expect(
    ((await updated.json()) as { resources: unknown[] }).resources,
  ).toHaveLength(2);
  current = upstream(await fixture(['other']), 'e'.repeat(40));
  expect(await (await app(get(collectionPath), env)).json()).toEqual({
    resources: [{ name: 'other.list', path: '/v1/private/loon/other.list' }],
  });
  expect((await app(get(API_PATH), env)).status).toBe(404);
});

it('reuses catalog metadata and preserves the existing last-file cache', async () => {
  const { provider, origin } = await setup();
  const token = 'origin-test-placeholder';
  expect((await provider.catalog(token)).files).toHaveLength(8);
  expect(origin.calls).toHaveLength(3);
  await provider.artifact('generated/loon/rules/example.list', token);
  expect(origin.calls).toHaveLength(5);
  await provider.catalog(token);
  expect(origin.calls).toHaveLength(6);
  await provider.artifact('generated/loon/rules/example.list', token);
  expect(origin.calls).toHaveLength(7);
});

it('serves collection JSON through the production entrypoint and native workerd fetch', async () => {
  const res = await exports.default.fetch(get(collectionPath));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    resources: [{ name: 'example.list', path: API_PATH }],
  });
});
