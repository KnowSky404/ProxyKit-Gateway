import { artifactPaths } from '../src/config/contract';
import { sha256 } from '../src/manifest/validate';
import type { ManifestFile } from '../src/manifest/validate';

export const DIST = 'a'.repeat(40);
export const NEXT = 'b'.repeat(40);
export const TOKEN = 'A'.repeat(43);
export const URL_TOKEN = 'B'.repeat(43);
export const API_PATH = '/v1/private/loon/example.list';
export const enc = {
  encode: (text: string) => new Uint8Array(new TextEncoder().encode(text)),
};

export async function authEnv(overrides: Partial<Env> = {}): Promise<Env> {
  return {
    ALLOW_URL_TOKENS: 'false',
    GITHUB_READ_TOKEN: 'origin-test-placeholder',
    DEVICE_AUTH: JSON.stringify({
      devices: [
        {
          id: 'test-header',
          sha256: await sha256(enc.encode(TOKEN)),
          transport: 'bearer',
          enabled: true,
          paths: [
            API_PATH,
            '/v1/private/quantumultx/example.list',
            '/v1/private/sing-box/example.json',
            '/v1/private/sing-box/example.srs',
          ],
        },
        {
          id: 'test-url',
          sha256: await sha256(enc.encode(URL_TOKEN)),
          transport: 'url',
          enabled: true,
          paths: [API_PATH],
        },
      ],
      disabled_paths: [],
    }),
    ...overrides,
  };
}

export async function fixture(names = ['example'], fileSize?: number) {
  const bytes = new Map<string, Uint8Array<ArrayBuffer>>();
  const files: ManifestFile[] = [];
  for (const name of names) {
    for (const path of artifactPaths(name)) {
      const data = fileSize
        ? new Uint8Array(fileSize).fill(65)
        : path.endsWith('.srs')
          ? new Uint8Array([0x53, 0x52, 0x53, 0, 255, 128, 13, 10, 0])
          : enc.encode(
              path.endsWith('.json')
                ? '{"version":2,"rules":[{"domain":["example.com"]}]}'
                : path.includes('quantumultx')
                  ? 'HOST,example.com,PROXY\n'
                  : 'DOMAIN,example.com\n',
            );
      bytes.set(path, data);
      files.push({ path, size: data.length, sha256: await sha256(data) });
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  const manifest = {
    schema_version: 1,
    source_commit: 'c'.repeat(40),
    generator: { repository: 'KnowSky404/ProxyKit', commit: 'd'.repeat(40) },
    versions: {
      bun: '1.4.4',
      sing_box: '1.14.4',
      source_format: 2,
      minimum_reader: '1.10.0',
    },
    rule_sets: names,
    files,
  };
  return { bytes, manifest };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;

export function contents(path: string, bytes: Uint8Array<ArrayBuffer>) {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 8192) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
  }
  return {
    type: 'file',
    path,
    encoding: 'base64',
    size: bytes.length,
    content: btoa(binary).replace(/(.{60})/g, '$1\n'),
  };
}

export function gitTree(data: Fixture) {
  const files = ['manifest.json', ...data.bytes.keys()];
  const directories = new Set(
    files.flatMap((path) => {
      const parts = path.split('/');
      return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
    }),
  );
  return {
    truncated: false,
    tree: [
      ...files.map((path) => ({ path, mode: '100644', type: 'blob' })),
      ...[...directories].map((path) => ({
        path,
        mode: '040000',
        type: 'tree',
      })),
    ],
  };
}

export function upstream(data: Fixture, commit = DIST) {
  const calls: string[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.href);
    if (
      url.origin !== 'https://api.github.com' ||
      !url.pathname.startsWith('/repos/KnowSky404/ProxyKit-Private/')
    ) {
      throw new Error('Unexpected upstream');
    }
    if (
      new Headers(init?.headers).get('Authorization') !==
        'Bearer origin-test-placeholder' ||
      init?.redirect !== 'manual'
    ) {
      throw new Error('Missing origin protection');
    }
    if (url.pathname.endsWith('/git/ref/heads/dist')) {
      return Response.json({ object: { type: 'commit', sha: commit } });
    }
    if (
      url.pathname.endsWith(`/git/trees/${commit}`) &&
      url.searchParams.get('recursive') === '1'
    ) {
      return Response.json(gitTree(data));
    }
    if (url.searchParams.get('ref') !== commit) throw new Error('Mutable ref');
    const path = url.pathname.split('/contents/')[1]!;
    const bytes =
      path === 'manifest.json'
        ? enc.encode(JSON.stringify(data.manifest))
        : data.bytes.get(path);
    return bytes
      ? Response.json(contents(path, bytes))
      : new Response(null, { status: 404 });
  };
  return { request, calls };
}

export function get(
  path = API_PATH,
  token: string | null = TOKEN,
  init: RequestInit = {},
): Request {
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return new Request(`https://gateway.example.com${path}`, {
    ...init,
    headers,
  });
}
