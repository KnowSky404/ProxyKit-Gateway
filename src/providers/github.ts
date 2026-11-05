import {
  COMMIT,
  MAX_FILE_BYTES,
  MAX_TREE_ENTRIES,
  MAX_UPSTREAM_JSON_BYTES,
  SNAPSHOT_TIMEOUT_MS,
  UPSTREAM_TIMEOUT_MS,
} from '../config/contract';
import { GatewayError, requireValue } from '../http/errors';
import { object, parseJson } from '../manifest/json';
import { sha256, validateManifest } from '../manifest/validate';

export interface Artifact {
  bytes: Uint8Array<ArrayBuffer>;
  sha256: string;
}
export interface Snapshot {
  commit: string;
  sourceCommit: string;
  files: ReadonlyMap<string, Artifact>;
}
export interface ArtifactProvider {
  snapshot(token: string): Promise<Snapshot>;
}

const API = 'https://api.github.com/repos/KnowSky404/ProxyKit-Private';

function retryAfter(value: string | null): number | undefined {
  if (!value) return;
  const seconds = /^[0-9]+$/.test(value)
    ? Number(value)
    : Math.ceil((Date.parse(value) - Date.now()) / 1000);
  if (Number.isSafeInteger(seconds) && seconds >= 0)
    return Math.max(1, seconds);
}

async function boundedBody(response: Response): Promise<string> {
  const declared = response.headers.get('Content-Length');
  requireValue(
    !declared ||
      (/^[0-9]+$/.test(declared) &&
        Number(declared) <= MAX_UPSTREAM_JSON_BYTES),
  );
  requireValue(response.body);
  const reader = response.body.getReader();
  const bytes = new Uint8Array(MAX_UPSTREAM_JSON_BYTES);
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      requireValue(size <= MAX_UPSTREAM_JSON_BYTES);
      bytes.set(value, size - value.byteLength);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    bytes.subarray(0, size),
  );
}

export class GitHubArtifactProvider implements ArtifactProvider {
  // Only verified bytes are shared; never share in-flight I/O between request contexts.
  private cached?: Snapshot;
  private retryAt = 0;

  constructor(
    private readonly request: typeof fetch = fetch.bind(globalThis),
  ) {}

  async snapshot(token: string): Promise<Snapshot> {
    if (
      typeof token !== 'string' ||
      !token.trim() ||
      token.startsWith('REPLACE_')
    ) {
      throw new GatewayError(503, 'origin_configuration');
    }
    if (Date.now() < this.retryAt) {
      throw new GatewayError(
        503,
        'upstream_rate_limit',
        Math.ceil((this.retryAt - Date.now()) / 1000),
      );
    }
    const deadline = Date.now() + SNAPSHOT_TIMEOUT_MS;
    const api = async (endpoint: string): Promise<Record<string, unknown>> => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new GatewayError(503, 'upstream_timeout');
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        Math.min(remaining, UPSTREAM_TIMEOUT_MS),
      );
      try {
        const response = await this.request(`${API}/${endpoint}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2026-03-10',
            'User-Agent': 'ProxyKit-Gateway/1',
          },
          redirect: 'manual',
          cache: 'no-store',
          signal: controller.signal,
        });
        if (response.status !== 200) {
          await response.body?.cancel();
          const retry =
            response.status === 403 || response.status === 429
              ? (retryAfter(response.headers.get('Retry-After')) ?? 60)
              : undefined;
          if (retry !== undefined) this.retryAt = Date.now() + retry * 1000;
          throw new GatewayError(
            503,
            retry ? 'upstream_rate_limit' : 'upstream_unavailable',
            retry,
          );
        }
        return object(parseJson(await boundedBody(response)));
      } catch (error) {
        if (controller.signal.aborted)
          throw new GatewayError(503, 'upstream_timeout');
        if (error instanceof GatewayError) throw error;
        throw new GatewayError(503, 'upstream_invalid');
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      const ref = object((await api('git/ref/heads/dist')).object);
      requireValue(
        ref.type === 'commit' &&
          typeof ref.sha === 'string' &&
          COMMIT.test(ref.sha),
      );
      const commit = ref.sha;
      if (this.cached?.commit === commit) return this.cached;
      // Discard the previous version before loading a new one; never backfill deleted paths.
      this.cached = undefined;
      const treeResponse = await api(`git/trees/${commit}?recursive=1`);
      requireValue(
        treeResponse.truncated === false &&
          Array.isArray(treeResponse.tree) &&
          treeResponse.tree.length <= MAX_TREE_ENTRIES,
      );
      const tree = new Map<string, Record<string, unknown>>();
      for (const value of treeResponse.tree) {
        const entry = object(value);
        requireValue(typeof entry.path === 'string' && !tree.has(entry.path));
        tree.set(entry.path, entry);
      }
      const read = async (path: string): Promise<Uint8Array<ArrayBuffer>> => {
        // Contents API can silently dereference symlinks, so verify the pinned Git mode first.
        const entry = tree.get(path);
        requireValue(
          entry?.type === 'blob' &&
            (entry.mode === '100644' || entry.mode === '100755'),
        );
        const obj = await api(`contents/${path}?ref=${commit}`);
        requireValue(
          obj.type === 'file' && obj.path === path && obj.encoding === 'base64',
        );
        requireValue(
          !Object.hasOwn(obj, 'submodule_git_url') &&
            !Object.hasOwn(obj, 'target'),
        );
        requireValue(
          typeof obj.size === 'number' &&
            Number.isInteger(obj.size) &&
            obj.size > 0 &&
            obj.size <= MAX_FILE_BYTES,
        );
        requireValue(
          typeof obj.content === 'string' &&
            obj.content.length <= MAX_FILE_BYTES * 2,
        );
        const encoded = obj.content.replace(/\n/g, '');
        requireValue(encoded.length === Math.ceil(obj.size / 3) * 4);
        requireValue(/^[A-Za-z0-9+/]*={0,2}$/.test(encoded));
        const binary = atob(encoded);
        requireValue(binary.length === obj.size && btoa(binary) === encoded);
        return Uint8Array.from(binary, (char) => char.charCodeAt(0));
      };
      const manifest = validateManifest(
        parseJson(
          new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
            await read('manifest.json'),
          ),
        ),
      );
      const files = new Map<string, Artifact>();
      for (const entry of manifest.files) {
        const bytes = await read(entry.path);
        requireValue(
          bytes.byteLength === entry.size &&
            (await sha256(bytes)) === entry.sha256,
        );
        files.set(entry.path, { bytes, sha256: entry.sha256 });
      }
      const verified = { commit, sourceCommit: manifest.sourceCommit, files };
      this.cached = verified;
      return verified;
    } catch (error) {
      this.cached = undefined;
      if (error instanceof GatewayError) throw error;
      throw new GatewayError(503, 'snapshot_rejected');
    }
  }
}
