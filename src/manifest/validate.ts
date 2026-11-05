import {
  artifactPaths,
  COMMIT,
  DIGEST,
  MAX_FILE_BYTES,
  MAX_RULE_SETS,
  MAX_SNAPSHOT_BYTES,
  NAME,
} from '../config/contract';
import { requireValue } from '../http/errors';
import { fields } from './json';

export interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
}
export interface Manifest {
  sourceCommit: string;
  files: ManifestFile[];
}

function version(value: unknown): string[] {
  requireValue(
    typeof value === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(value),
  );
  return value.split('.').map((part) => part.replace(/^0+/, '') || '0');
}
function compare(a: string[], b: string[]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i]!.length !== b[i]!.length)
      return a[i]!.length < b[i]!.length ? -1 : 1;
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return 0;
}

export function validateManifest(value: unknown): Manifest {
  const m = fields(value, [
    'schema_version',
    'source_commit',
    'generator',
    'versions',
    'rule_sets',
    'files',
  ]);
  requireValue(m.schema_version === 1);
  requireValue(
    typeof m.source_commit === 'string' && COMMIT.test(m.source_commit),
  );
  const g = fields(m.generator, ['repository', 'commit']);
  requireValue(
    g.repository === 'KnowSky404/ProxyKit' &&
      typeof g.commit === 'string' &&
      COMMIT.test(g.commit),
  );
  const v = fields(m.versions, [
    'bun',
    'sing_box',
    'source_format',
    'minimum_reader',
  ]);
  requireValue(v.source_format === 2);
  version(v.bun);
  const reader = version(v.minimum_reader);
  requireValue(
    compare(reader, ['1', '10', '0']) >= 0 &&
      compare(reader, version(v.sing_box)) <= 0,
  );
  requireValue(
    Array.isArray(m.rule_sets) &&
      m.rule_sets.length > 0 &&
      m.rule_sets.length <= MAX_RULE_SETS,
  );
  let previous = '';
  const expected: string[] = [];
  for (const name of m.rule_sets) {
    requireValue(
      typeof name === 'string' &&
        name.length <= 100 &&
        NAME.test(name) &&
        name > previous,
    );
    previous = name;
    expected.push(...artifactPaths(name));
  }
  expected.sort();
  requireValue(Array.isArray(m.files) && m.files.length === expected.length);
  let total = 0;
  const files = m.files.map((value, i) => {
    const f = fields(value, ['path', 'size', 'sha256']);
    requireValue(typeof f.path === 'string' && f.path === expected[i]);
    requireValue(
      typeof f.size === 'number' &&
        Number.isSafeInteger(f.size) &&
        f.size > 0 &&
        f.size <= MAX_FILE_BYTES,
    );
    requireValue(typeof f.sha256 === 'string' && DIGEST.test(f.sha256));
    total += f.size;
    return { path: f.path, size: f.size, sha256: f.sha256 };
  });
  requireValue(total <= MAX_SNAPSHOT_BYTES);
  return { sourceCommit: m.source_commit, files };
}

export async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}
