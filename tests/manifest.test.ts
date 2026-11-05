import { describe, expect, it } from 'vitest';
import { parseJson } from '../src/manifest/json';
import { validateManifest } from '../src/manifest/validate';
import { fixture } from './fixtures';

describe('strict publication contract', () => {
  it('accepts the reference consumer schema and sorted four-part sets', async () => {
    const { manifest } = await fixture(['example', 'test']);
    expect(
      validateManifest(parseJson(JSON.stringify(manifest))).files,
    ).toHaveLength(8);
  });
  it.each([
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '{"x":{"a":1,"a":2}}',
    '{"__proto__":0,"__proto__":1}',
    '[1,]',
    '{"a":1,}',
    '{}x',
    '01',
    '1.0',
    '1e0',
    '"unterminated',
    '{"a":"unescaped\n"}',
    '['.repeat(34) + ']'.repeat(34),
  ])('rejects duplicate keys and malformed JSON (%s)', (text) => {
    expect(() => parseJson(text)).toThrow();
  });
  it('handles escaped quotes, primitive types and prototype keys safely', () => {
    const text =
      '{"__proto__":{"ok":true},"quote":"a\\\"b","array":[false,null,-25]}';
    expect(parseJson(text)).toEqual(JSON.parse(text));
    expect({}).not.toHaveProperty('ok');
  });
  const mutations: [string, (m: Record<string, unknown>) => void][] = [
    [
      'schema',
      (m) => {
        m.schema_version = 2;
      },
    ],
    [
      'unknown field',
      (m) => {
        m.extra = true;
      },
    ],
    [
      'missing quartet',
      (m) => {
        (m.files as unknown[]).pop();
      },
    ],
    [
      'duplicate path',
      (m) => {
        const f = m.files as unknown[];
        f[1] = f[0];
      },
    ],
    [
      'traversal',
      (m) => {
        (m.files as { path: string }[])[0]!.path = '../private.yaml';
      },
    ],
    [
      'duplicate name',
      (m) => {
        m.rule_sets = ['example', 'example'];
      },
    ],
    [
      'unsorted names',
      (m) => {
        m.rule_sets = ['test', 'example'];
      },
    ],
    [
      'invalid name',
      (m) => {
        m.rule_sets = ['Example'];
      },
    ],
    [
      'long name',
      (m) => {
        m.rule_sets = ['a'.repeat(101)];
      },
    ],
    [
      'empty sets',
      (m) => {
        m.rule_sets = [];
      },
    ],
    [
      'future source format',
      (m) => {
        (m.versions as Record<string, unknown>).source_format = 3;
      },
    ],
    [
      'old reader',
      (m) => {
        (m.versions as Record<string, unknown>).minimum_reader = '1.9.9';
      },
    ],
    [
      'reader newer than compiler',
      (m) => {
        (m.versions as Record<string, unknown>).minimum_reader = '1.15.0';
      },
    ],
    [
      'prerelease',
      (m) => {
        (m.versions as Record<string, unknown>).bun = '1.4.4-beta';
      },
    ],
    [
      'wrong generator',
      (m) => {
        (m.generator as Record<string, unknown>).repository = 'other/repo';
      },
    ],
    [
      'mutable commit',
      (m) => {
        m.source_commit = 'main';
      },
    ],
    [
      'bad digest',
      (m) => {
        (m.files as { sha256: string }[])[0]!.sha256 = 'g'.repeat(64);
      },
    ],
    [
      'oversize',
      (m) => {
        (m.files as { size: number }[])[0]!.size = 1_000_001;
      },
    ],
    [
      'zero size',
      (m) => {
        (m.files as { size: number }[])[0]!.size = 0;
      },
    ],
    [
      'fraction size',
      (m) => {
        (m.files as { size: number }[])[0]!.size = 1.5;
      },
    ],
    [
      'boolean size',
      (m) => {
        (m.files as Record<string, unknown>[])[0]!.size = true;
      },
    ],
  ];
  it.each(mutations)('rejects %s', async (_, mutate) => {
    const { manifest } = await fixture();
    mutate(manifest);
    expect(() => validateManifest(manifest)).toThrow();
  });
  it('compares numeric versions rather than lexicographic versions', async () => {
    const { manifest } = await fixture();
    manifest.versions.sing_box = '1.100.0';
    manifest.versions.minimum_reader = '1.99.0';
    expect(validateManifest(manifest).files).toHaveLength(4);
  });
});
