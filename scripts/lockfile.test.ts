import { expect, test } from 'bun:test';

test('locked dependencies use the public HTTPS npm registry, independent of local mirrors', async () => {
  const lock = Bun.JSONC.parse(await Bun.file('bun.lock').text()) as {
    packages: Record<string, [string, string]>;
  };
  for (const [name, [, url]] of Object.entries(lock.packages)) {
    expect(url, name).toStartWith('https://registry.npmjs.org/');
  }
});
