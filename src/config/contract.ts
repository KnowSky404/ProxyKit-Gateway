export const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const COMMIT = /^[0-9a-f]{40}$/;
export const DIGEST = /^[0-9a-f]{64}$/;
export const MAX_FILE_BYTES = 1_000_000;
export const MAX_RULE_SETS = 8;
export const MAX_TREE_ENTRIES = 64;
export const MAX_SNAPSHOT_BYTES = 8_000_000;
export const MAX_UPSTREAM_JSON_BYTES = 2_100_000;
export const UPSTREAM_TIMEOUT_MS = 3000;
export const SNAPSHOT_TIMEOUT_MS = 15000;

export function artifactPaths(name: string): string[] {
  return [
    `generated/loon/rules/${name}.list`,
    `generated/quantumultx/filters/${name}.list`,
    `generated/sing-box/rules/${name}.json`,
    `generated/sing-box/rules/${name}.srs`,
  ];
}

export function route(
  path: string,
): { path: string; contentType: string } | undefined {
  const match =
    /^\/v1\/private\/(loon|quantumultx|sing-box)\/([a-z0-9-]+)\.(list|json|srs)$/.exec(
      path,
    );
  if (!match) return;
  const [, client, name, extension] = match;
  if (!name || name.length > 100 || !NAME.test(name)) return;
  if (client === 'sing-box' ? extension === 'list' : extension !== 'list')
    return;
  const directory =
    client === 'loon'
      ? 'rules'
      : client === 'quantumultx'
        ? 'filters'
        : 'rules';
  return {
    path: `generated/${client}/${directory}/${name}.${extension}`,
    contentType:
      extension === 'list'
        ? 'text/plain; charset=utf-8'
        : extension === 'json'
          ? 'application/json'
          : 'application/octet-stream',
  };
}
