import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { GitHubArtifactProvider } from '../src/providers/github';
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

describe('GitHub immutable snapshots', () => {
  it('pins every read to one dist SHA, verifies all files and preserves SRS bytes', async () => {
    const data = await fixture();
    const origin = upstream(data);
    const provider = new GitHubArtifactProvider(origin.request);
    const snapshot = await provider.snapshot(token);
    expect(snapshot.commit).toBe(DIST);
    expect(snapshot.files.size).toBe(4);
    expect(
      snapshot.files.get('generated/sing-box/rules/example.srs')!.bytes,
    ).toEqual(data.bytes.get('generated/sing-box/rules/example.srs'));
    expect(origin.calls[1]).toContain(`/git/trees/${DIST}?recursive=1`);
    expect(origin.calls).toHaveLength(7);
    expect(
      origin.calls
        .filter((call) => call.includes('/contents/'))
        .every((call) => call.endsWith(`?ref=${DIST}`)),
    ).toBe(true);
    await provider.snapshot(token);
    expect(origin.calls).toHaveLength(8);
    expect(origin.calls.at(-1)).toContain('/git/ref/heads/dist');
  });
  it('cannot mix snapshots when dist advances during a read', async () => {
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
    expect((await provider.snapshot(token)).commit).toBe(DIST);
    const updated = await provider.snapshot(token);
    expect(updated.commit).toBe(NEXT);
    expect(updated.files.has('generated/loon/rules/example.list')).toBe(false);
    expect(updated.files.has('generated/loon/rules/test.list')).toBe(true);
  });
  it.each(['digest', 'size', 'sibling'])(
    'rejects corrupted %s without publishing a partial snapshot',
    async (damage) => {
      const data = await fixture();
      const target = data.manifest.files[damage === 'sibling' ? 3 : 0]!;
      if (damage === 'size') target.size++;
      else target.sha256 = '0'.repeat(64);
      const provider = new GitHubArtifactProvider(upstream(data).request);
      await expect(provider.snapshot(token)).rejects.toMatchObject({
        status: 503,
      });
      target.sha256 = (await fixture()).manifest.files[
        damage === 'sibling' ? 3 : 0
      ]!.sha256;
      if (damage === 'size') target.size--;
      expect((await provider.snapshot(token)).files.size).toBe(4);
    },
  );
  it('does not reuse old files or a matching ETag after deletion or refresh failure', async () => {
    const data = await fixture();
    const first = upstream(data);
    const next = upstream(await fixture(['test']), NEXT);
    let mode = 0;
    const provider = new GitHubArtifactProvider(async (input, init) => {
      if (mode === 2)
        return new Response('private upstream error', { status: 500 });
      return (mode === 0 ? first : next).request(input, init);
    });
    const app = createApp(provider);
    const env = await authEnv();
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
    mode = 2;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await app(get(), env)).status).toBe(503);
  });
  it('accepts the maximum eight-set, eight-MB snapshot with one-MB files', async () => {
    const data = await fixture(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 1);
    const { sha256 } = await import('../src/manifest/validate');
    for (const [i, entry] of data.manifest.files.slice(0, 8).entries()) {
      entry.size = i < 7 ? 1_000_000 : 999_976;
      const bytes = new Uint8Array(entry.size).fill(65);
      data.bytes.set(entry.path, bytes);
      entry.sha256 = await sha256(bytes);
    }
    expect(data.manifest.files.reduce((sum, f) => sum + f.size, 0)).toBe(
      8_000_000,
    );
    const origin = upstream(data);
    expect(
      (await new GitHubArtifactProvider(origin.request).snapshot(token)).files
        .size,
    ).toBe(32);
    expect(origin.calls).toHaveLength(35);
  });
  it.each(['sets', 'aggregate'])(
    'rejects the %s scale limit before fetching artifacts',
    async (limit) => {
      const data = await fixture(
        limit === 'sets'
          ? ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']
          : ['a', 'b', 'c'],
      );
      if (limit === 'aggregate')
        data.manifest.files.forEach((f) => {
          f.size = 1_000_000;
        });
      const origin = upstream(data);
      await expect(
        new GitHubArtifactProvider(origin.request).snapshot(token),
      ).rejects.toMatchObject({ status: 503 });
      expect(origin.calls).toHaveLength(3);
    },
  );
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
    await expect(provider.snapshot(token)).rejects.toMatchObject({
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
      new GitHubArtifactProvider(request).snapshot(token),
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
      new GitHubArtifactProvider(request).snapshot(token),
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
      new GitHubArtifactProvider(request).snapshot(token),
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
      new GitHubArtifactProvider(request).snapshot(token),
    ).rejects.toMatchObject({ category: 'upstream_timeout' });
  });
  it('fails closed without origin secrets before I/O', async () => {
    const request = vi.fn<typeof fetch>();
    await expect(
      new GitHubArtifactProvider(request).snapshot(''),
    ).rejects.toMatchObject({ status: 503 });
    expect(request).not.toHaveBeenCalled();
  });
});

it('enforces the whole-snapshot deadline across individually successful requests', async () => {
  const origin = upstream(await fixture());
  let now = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const provider = new GitHubArtifactProvider(async (input, init) => {
    const res = await origin.request(input, init);
    now += 3100;
    return res;
  });
  await expect(provider.snapshot(token)).rejects.toMatchObject({
    category: 'upstream_timeout',
  });
  expect(origin.calls).toHaveLength(5);
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
    await expect(provider.snapshot(token)).rejects.toMatchObject({
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
      tree.tree = Array.from({ length: 65 }, (_, i) => ({
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
  await expect(provider.snapshot(token)).rejects.toMatchObject({ status: 503 });
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
  expect((await provider.snapshot(token)).files.size).toBe(4);
});
