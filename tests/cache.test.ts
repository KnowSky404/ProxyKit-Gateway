import { afterEach, expect, it, vi } from 'vitest';
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
  upstream,
} from './fixtures';

afterEach(() => vi.restoreAllMocks());
const token = 'origin-test-placeholder';
const path = 'generated/loon/rules/example.list';

it('serves 100 catalog hits without origin calls and expires at a fixed sixty-second boundary', async () => {
  let now = 100_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const origin = upstream(await fixture());
  const provider = new GitHubArtifactProvider(origin.request);
  expect((await provider.catalog(token)).commit).toBe(DIST);
  expect(origin.calls).toHaveLength(3);
  for (let i = 0; i < 100; i++) {
    now = 100_001 + i * 500;
    await provider.catalog(token);
  }
  expect(origin.calls).toHaveLength(3);
  now = 159_999;
  await provider.catalog(token);
  expect(origin.calls).toHaveLength(3);
  now = 160_000;
  await provider.catalog(token);
  expect(origin.calls).toHaveLength(4);
  expect(origin.calls.at(-1)).toContain('/git/ref/heads/dist');
  now = 160_001;
  await provider.catalog(token);
  expect(origin.calls).toHaveLength(4);
});

it('reuses checked bytes across an unchanged-version refresh but bounds the byte cache to one file', async () => {
  let now = 100_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const origin = upstream(await fixture());
  const provider = new GitHubArtifactProvider(origin.request);
  const first = await provider.artifact(path, token);
  expect(origin.calls).toHaveLength(4);
  expect(await provider.artifact(path, token)).toBe(first);
  expect(origin.calls).toHaveLength(4);
  now = 160_000;
  expect(await provider.artifact(path, token)).toBe(first);
  expect(origin.calls).toHaveLength(5);
  const binary = 'generated/sing-box/rules/example.srs';
  await provider.artifact(binary, token);
  expect(origin.calls).toHaveLength(6);
  expect(origin.calls.at(-1)).toContain(`/contents/${binary}?`);
  await provider.artifact(path, token);
  expect(origin.calls).toHaveLength(7);
});

it('supports a custom TTL and zero for checking every request', async () => {
  let now = 100_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const origin = upstream(await fixture());
  const provider = new GitHubArtifactProvider(origin.request);
  await provider.catalog(token, '2');
  now = 101_999;
  await provider.catalog(token, '2');
  expect(origin.calls).toHaveLength(3);
  now = 102_000;
  await provider.catalog(token, '2');
  expect(origin.calls).toHaveLength(4);
  await provider.catalog(token, '0');
  await provider.catalog(token, '0');
  expect(origin.calls).toHaveLength(6);
  now = 103_000;
  await provider.catalog(token, '1');
  expect(origin.calls).toHaveLength(7);
});

it('bounds publication and deletion delay, then drops deleted paths before responding with 304', async () => {
  let now = 100_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  let current = upstream(await fixture());
  const app = createApp(
    new GitHubArtifactProvider((input, init) => current.request(input, init)),
  );
  const env = await authEnv();
  const config = JSON.parse(env.DEVICE_AUTH);
  config.devices[0].paths = ['*'];
  env.DEVICE_AUTH = JSON.stringify(config);
  const first = await app(get(), env);
  const conditional = {
    headers: { 'If-None-Match': first.headers.get('ETag')! },
  };
  expect(first.status).toBe(200);
  current = upstream(await fixture(['other']), NEXT);
  now = 159_999;
  expect((await app(get(API_PATH, TOKEN, conditional), env)).status).toBe(304);
  expect((await app(get('/v1/private/loon/other.list'), env)).status).toBe(404);
  expect(current.calls).toHaveLength(0);
  now = 160_000;
  expect((await app(get(API_PATH, TOKEN, conditional), env)).status).toBe(404);
  expect(current.calls).toHaveLength(3);
  const added = await app(get('/v1/private/loon/other.list'), env);
  expect(added.status).toBe(200);
  expect(added.headers.get('X-Distribution-Commit')).toBe(NEXT);
  expect(current.calls).toHaveLength(4);
});

it.each(['network', 'manifest'])(
  'does not serve expired metadata or bytes after a %s refresh failure',
  async (fault) => {
    let now = 100_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const original = upstream(await fixture());
    const badData = await fixture();
    badData.manifest.schema_version = 2;
    const bad = upstream(badData, NEXT);
    let mode = 'original';
    const provider = new GitHubArtifactProvider((input, init) =>
      mode === 'broken'
        ? fault === 'network'
          ? Promise.resolve(new Response(null, { status: 500 }))
          : bad.request(input, init)
        : original.request(input, init),
    );
    await provider.artifact(path, token);
    now = 160_000;
    mode = 'broken';
    await expect(provider.artifact(path, token)).rejects.toMatchObject({
      status: 503,
    });
    await expect(provider.catalog(token)).rejects.toMatchObject({
      status: 503,
    });
    mode = 'original';
    const calls = original.calls.length;
    expect((await provider.catalog(token)).commit).toBe(DIST);
    expect(original.calls).toHaveLength(calls + 3);
    await provider.artifact(path, token);
    expect(original.calls).toHaveLength(calls + 4);
  },
);

it.each([
  '',
  '-1',
  '1.5',
  'Infinity',
  'NaN',
  '1e2',
  '0x10',
  '9007199254740991',
])(
  'rejects an invalid TTL before origin I/O even with cached metadata: %s',
  async (ttl) => {
    const origin = upstream(await fixture());
    const provider = new GitHubArtifactProvider(origin.request);
    await provider.catalog(token);
    await expect(provider.catalog(token, ttl)).rejects.toMatchObject({
      status: 503,
      category: 'cache_configuration',
    });
    expect(origin.calls).toHaveLength(3);
  },
);

it('does not reuse a cache timestamp in the future after the clock moves backward', async () => {
  let now = 100_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const origin = upstream(await fixture());
  const provider = new GitHubArtifactProvider(origin.request);
  await provider.catalog(token);
  now = 99_000;
  await provider.catalog(token);
  expect(origin.calls).toHaveLength(4);
});

it('keeps warmed metadata behind live per-device authentication, disabling, and scope filters', async () => {
  const origin = upstream(await fixture());
  const app = createApp(new GitHubArtifactProvider(origin.request));
  const env = await authEnv();
  const first = await app(get('/v1/private/loon'), env);
  expect(first.status).toBe(200);
  const headers = { 'If-None-Match': first.headers.get('ETag')! };
  const calls = origin.calls.length;
  expect(
    (await app(get('/v1/private/loon', null, { headers }), env)).status,
  ).toBe(401);
  const config = JSON.parse(env.DEVICE_AUTH);
  config.disabled_paths = [API_PATH];
  env.DEVICE_AUTH = JSON.stringify(config);
  const filtered = await app(get('/v1/private/loon', TOKEN, { headers }), env);
  expect(filtered.status).toBe(200);
  expect(await filtered.json()).toEqual({ resources: [] });
  expect((await app(get(), env)).status).toBe(410);
  config.devices[0].enabled = false;
  env.DEVICE_AUTH = JSON.stringify(config);
  expect(
    (await app(get('/v1/private/loon', TOKEN, { headers }), env)).status,
  ).toBe(401);
  expect(origin.calls).toHaveLength(calls);
});
