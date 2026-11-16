import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { GitHubArtifactProvider } from '../src/providers/github';
import { MAX_TREE_ENTRIES } from '../src/config/contract';
import { sha256 } from '../src/manifest/validate';
import {
  API_PATH,
  authEnv,
  contents,
  DIST,
  enc,
  fixture,
  gitTree,
  get,
  NEXT,
  TOKEN,
  upstream,
} from './fixtures';

afterEach(() => vi.restoreAllMocks());
const token = 'origin-test-placeholder';
const path = 'generated/loon/rules/example.list';

describe('GitHub on-demand artifacts', () => {
  it('downloads only the requested artifact and bounds the byte cache to one file', async () => {
    const data = await fixture();
    const origin = upstream(data);
    const provider = new GitHubArtifactProvider(origin.request);
    const binary = 'generated/sing-box/rules/example.srs';
    const artifact = await provider.artifact(binary, token);
    expect(artifact?.commit).toBe(DIST);
    expect(artifact?.bytes).toEqual(data.bytes.get(binary));
    expect(origin.calls[1]).toContain(`/git/trees/${DIST}?recursive=1`);
    expect(origin.calls).toHaveLength(4);
    expect(
      origin.calls
        .filter((call) => call.includes('/contents/'))
        .map((call) => new URL(call).pathname.split('/contents/')[1]),
    ).toEqual(['manifest.json', binary]);
    expect(
      origin.calls
        .filter((call) => call.includes('/contents/'))
        .every((call) => call.endsWith(`?ref=${DIST}`)),
    ).toBe(true);
    await provider.artifact(binary, token);
    expect(origin.calls).toHaveLength(4);
    await provider.artifact(path, token);
    expect(origin.calls).toHaveLength(5);
    expect(origin.calls.at(-1)).toContain(`/contents/${path}?`);
    await provider.artifact(binary, token);
    expect(origin.calls).toHaveLength(6);
  });
  it('cannot mix versions when dist advances during a read', async () => {
    const old = upstream(await fixture(), DIST);
    const next = upstream(await fixture(['test']), NEXT);
    let refs = 0;
    const request: typeof fetch = async (input, init) => {
      if (String(input).includes('/git/ref/')) {
        refs++;
        return (refs === 1 ? old : next).request(input, init);
      }
      return (String(input).includes(DIST) ? old : next).request(input, init);
    };
    const provider = new GitHubArtifactProvider(request);
    expect((await provider.artifact(path, token, '0'))?.commit).toBe(DIST);
    expect(await provider.artifact(path, token, '0')).toBeUndefined();
    expect(
      (await provider.artifact('generated/loon/rules/test.list', token, '0'))
        ?.commit,
    ).toBe(NEXT);
  });
  it.each(['digest', 'size'])(
    'rejects a requested file with a corrupted %s',
    async (damage) => {
      const data = await fixture();
      const target = data.manifest.files[0]!;
      if (damage === 'size') target.size++;
      else target.sha256 = '0'.repeat(64);
      const provider = new GitHubArtifactProvider(upstream(data).request);
      await expect(provider.artifact(path, token)).rejects.toMatchObject({
        status: 503,
      });
      const original = (await fixture()).manifest.files[0]!;
      target.sha256 = original.sha256;
      target.size = original.size;
      expect((await provider.artifact(path, token))?.bytes).toEqual(
        data.bytes.get(path),
      );
    },
  );
  it('does not read or depend on unrequested file bodies', async () => {
    const data = await fixture();
    const binary = 'generated/sing-box/rules/example.srs';
    data.bytes.delete(binary);
    const origin = upstream(data);
    const provider = new GitHubArtifactProvider(origin.request);
    expect((await provider.artifact(path, token))?.bytes).toEqual(
      data.bytes.get(path),
    );
    expect(origin.calls).toHaveLength(4);
    expect(
      origin.calls.some((call) => call.includes(`/contents/${binary}?`)),
    ).toBe(false);
    await expect(provider.artifact(binary, token)).rejects.toMatchObject({
      status: 503,
    });
  });
  it('does not reuse old files or a matching ETag after deletion or refresh failure', async () => {
    const first = upstream(await fixture());
    const next = upstream(await fixture(['test']), NEXT);
    let mode = 0;
    const provider = new GitHubArtifactProvider(async (input, init) => {
      if (mode === 2)
        return new Response('private upstream error', { status: 500 });
      return (mode === 0 ? first : next).request(input, init);
    });
    const app = createApp(provider);
    const env = await authEnv({ METADATA_CACHE_TTL_SECONDS: '0' });
    const res = await app(get(), env);
    const etag = res.headers.get('ETag')!;
    expect(res.status).toBe(200);
    mode = 1;
    expect(
      (
        await app(
          get(API_PATH, TOKEN, { headers: { 'If-None-Match': etag } }),
          env,
        )
      ).status,
    ).toBe(404);
    expect(next.calls).toHaveLength(3);
    mode = 2;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await app(get(), env)).status).toBe(503);
  });
  it('serves one one-MB file beyond eight sets and eight-MB aggregate in four calls', async () => {
    const data = await fixture(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
      1,
    );
    const bytes = new Uint8Array(1_000_000).fill(65);
    const digest = await sha256(bytes);
    for (const entry of data.manifest.files) {
      entry.size = bytes.length;
      entry.sha256 = digest;
      data.bytes.set(entry.path, bytes);
    }
    const origin = upstream(data);
    const artifact = await new GitHubArtifactProvider(origin.request).artifact(
      data.manifest.files[0]!.path,
      token,
    );
    expect(artifact?.bytes).toEqual(bytes);
    expect(data.manifest.files.reduce((sum, f) => sum + f.size, 0)).toBe(
      36_000_000,
    );
    expect(origin.calls).toHaveLength(4);
  });
  it('keeps request count constant at the publisher contract maximum of 1000 sets', async () => {
    const names = Array.from(
      { length: 1000 },
      (_, i) => `r${String(i).padStart(4, '0')}`,
    );
    const data = await fixture(names);
    const origin = upstream(data);
    const target = data.manifest.files.at(-1)!.path;
    expect(
      (await new GitHubArtifactProvider(origin.request).artifact(target, token))
        ?.bytes,
    ).toEqual(data.bytes.get(target));
    expect(origin.calls).toHaveLength(4);
  });
  it('rejects manifests beyond the publisher contract before fetching artifacts', async () => {
    const names = Array.from(
      { length: 1001 },
      (_, i) => `r${String(i).padStart(4, '0')}`,
    );
    const origin = upstream(await fixture(names));
    await expect(
      new GitHubArtifactProvider(origin.request).artifact(path, token),
    ).rejects.toMatchObject({ status: 503 });
    expect(origin.calls).toHaveLength(3);
  });
});

describe('origin faults and trust boundaries', () => {
  it.each([401, 403, 404, 429, 500, 502, 503])(
    'handles GitHub %s without leaking response content',
    async (status) => {
      const origin = vi.fn<typeof fetch>(
        async () =>
          new Response('private-error.example.com', {
            status,
            headers: { 'Retry-After': '120' },
          }),
      );
      const app = createApp(new GitHubArtifactProvider(origin));
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await app(get(), await authEnv());
      expect(res.status).toBe(503);
      expect(await res.text()).not.toContain('private-error.example.com');
      expect(JSON.stringify(log.mock.calls)).not.toContain(
        'private-error.example.com',
      );
      if (status === 429 || status === 403) {
        expect(res.headers.get('Retry-After')).toBe('120');
        await app(get(), await authEnv());
        expect(origin).toHaveBeenCalledTimes(1);
      }
    },
  );
  it('honors HTTP-date Retry-After without retrying in the same invocation', async () => {
    const date = new Date(Date.now() + 120_000).toUTCString();
    const provider = new GitHubArtifactProvider(
      async () =>
        new Response(null, { status: 429, headers: { 'Retry-After': date } }),
    );
    await expect(provider.artifact(path, token)).rejects.toMatchObject({
      status: 503,
      category: 'upstream_rate_limit',
    });
  });
  it.each([
    'missing',
    'tag',
    'mutable',
    'redirect',
    'invalid-json',
    'large-body',
  ])('rejects %s ref responses', async (fault) => {
    const request: typeof fetch = async () => {
      if (fault === 'redirect')
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://example.com' },
        });
      if (fault === 'invalid-json') return new Response('{"object":');
      if (fault === 'large-body') return new Response('x'.repeat(2_100_001));
      return Response.json({
        object:
          fault === 'missing'
            ? {}
            : {
                type: fault === 'tag' ? 'tag' : 'commit',
                sha: fault === 'mutable' ? 'main' : DIST,
              },
      });
    };
    await expect(
      new GitHubArtifactProvider(request).artifact(path, token),
    ).rejects.toMatchObject({ status: 503 });
  });
  it.each([
    'encoding',
    'size',
    'path',
    'base64',
    'noncanonical',
    'symlink',
    'submodule',
    'oversize',
    'duplicate-key',
  ])('rejects untrusted Contents API %s', async (fault) => {
    const origin = upstream(await fixture());
    const request: typeof fetch = async (input, init) => {
      if (!String(input).includes('/contents/manifest.json'))
        return origin.request(input, init);
      const data: Record<string, unknown> = contents(
        'manifest.json',
        enc.encode('{}'),
      );
      if (fault === 'encoding') data.encoding = 'none';
      if (fault === 'size') data.size = 1;
      if (fault === 'path') data.path = 'other';
      if (fault === 'base64') data.content = '!!!!';
      if (fault === 'noncanonical') data.content = 'e31=';
      if (fault === 'symlink') data.type = 'symlink';
      if (fault === 'submodule') data.submodule_git_url = 'https://example.com';
      if (fault === 'oversize') data.size = 1_000_001;
      if (fault === 'duplicate-key')
        return new Response('{"type":"file","type":"symlink"}');
      return Response.json(data);
    };
    await expect(
      new GitHubArtifactProvider(request).artifact(path, token),
    ).rejects.toMatchObject({ status: 503 });
  });
  it('times out network requests and never exposes the fetch exception', async () => {
    const request: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new Error('private network error')),
          { once: true },
        );
      });
    await expect(
      new GitHubArtifactProvider(request).artifact(path, token),
    ).rejects.toMatchObject({ category: 'upstream_timeout' });
  });
  it('applies the timeout while reading a stalled body too', async () => {
    const request: typeof fetch = async (_input, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener(
              'abort',
              () => controller.error(new Error('private-body')),
              { once: true },
            );
          },
        }),
      );
    await expect(
      new GitHubArtifactProvider(request).artifact(path, token),
    ).rejects.toMatchObject({ category: 'upstream_timeout' });
  });
  it('fails closed without origin secrets before I/O', async () => {
    const request = vi.fn<typeof fetch>();
    await expect(
      new GitHubArtifactProvider(request).artifact(path, ''),
    ).rejects.toMatchObject({ status: 503 });
    expect(request).not.toHaveBeenCalled();
  });
});

it('enforces the per-artifact deadline across individually successful requests', async () => {
  const origin = upstream(await fixture());
  let now = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const provider = new GitHubArtifactProvider(async (input, init) => {
    const res = await origin.request(input, init);
    now += 5100;
    return res;
  });
  await expect(provider.artifact(path, token)).rejects.toMatchObject({
    category: 'upstream_timeout',
  });
  expect(origin.calls).toHaveLength(3);
});

it.each([
  'manifest.json',
  'generated/loon/rules/example.list',
  'generated/sing-box/rules/example.srs',
])(
  'rejects a dereferenced symlink at %s even when Contents returns matching regular-file bytes',
  async (path) => {
    const data = await fixture();
    const origin = upstream(data);
    const calls: string[] = [];
    const provider = new GitHubArtifactProvider(async (input, init) => {
      calls.push(String(input));
      if (String(input).includes('/git/trees/')) {
        const tree = gitTree(data);
        tree.tree.find((entry) => entry.path === path)!.mode = '120000';
        return Response.json(tree);
      }
      return origin.request(input, init);
    });
    await expect(
      provider.artifact(
        path === 'manifest.json' ? 'generated/loon/rules/example.list' : path,
        token,
      ),
    ).rejects.toMatchObject({
      status: 503,
    });
    expect(calls.some((url) => url.includes(`/contents/${path}?`))).toBe(false);
  },
);

it.each([
  'truncated',
  'oversize',
  'duplicate',
  'missing',
  'submodule',
  'directory',
])('fails closed on %s pinned tree metadata', async (fault) => {
  const data = await fixture();
  const origin = upstream(data);
  const provider = new GitHubArtifactProvider(async (input, init) => {
    if (!String(input).includes('/git/trees/'))
      return origin.request(input, init);
    const tree = gitTree(data);
    if (fault === 'truncated') tree.truncated = true;
    if (fault === 'oversize')
      tree.tree = Array.from({ length: MAX_TREE_ENTRIES + 1 }, (_, i) => ({
        path: `ignored-${i}`,
        mode: '100644',
        type: 'blob',
      }));
    if (fault === 'duplicate') tree.tree.push(tree.tree[0]!);
    if (fault === 'missing') tree.tree.shift();
    if (fault === 'submodule') {
      tree.tree[0]!.mode = '160000';
      tree.tree[0]!.type = 'commit';
    }
    if (fault === 'directory') {
      tree.tree[0]!.mode = '040000';
      tree.tree[0]!.type = 'tree';
    }
    return Response.json(tree);
  });
  await expect(provider.artifact(path, token)).rejects.toMatchObject({
    status: 503,
  });
});

it('accepts both ordinary Git blob modes without following symlinks', async () => {
  const data = await fixture();
  const origin = upstream(data);
  const provider = new GitHubArtifactProvider(async (input, init) => {
    if (!String(input).includes('/git/trees/'))
      return origin.request(input, init);
    const tree = gitTree(data);
    tree.tree[0]!.mode = '100755';
    return Response.json(tree);
  });
  expect((await provider.artifact(path, token))?.bytes).toEqual(
    data.bytes.get(path),
  );
});
