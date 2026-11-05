import { DIGEST, route } from '../config/contract';
import { GatewayError, requireValue } from '../http/errors';
import { fields, parseJson } from '../manifest/json';

interface Device {
  sha256: string;
  transport: 'bearer' | 'url';
  enabled: boolean;
  paths: string[];
}

function paths(value: unknown): string[] {
  requireValue(Array.isArray(value) && value.length <= 32);
  requireValue(
    value.every(
      (path): path is string => typeof path === 'string' && !!route(path),
    ),
  );
  requireValue(new Set(value).size === value.length);
  return value;
}

function configuration(secret: string): {
  devices: Device[];
  disabledPaths: string[];
} {
  requireValue(
    typeof secret === 'string' &&
      secret.length <= 5000 &&
      new TextEncoder().encode(secret).byteLength <= 5000,
  );
  const config = fields(parseJson(secret), ['devices', 'disabled_paths']);
  requireValue(
    Array.isArray(config.devices) &&
      config.devices.length > 0 &&
      config.devices.length <= 64,
  );
  const ids = new Set<string>();
  const hashes = new Set<string>();
  const devices = config.devices.map((value): Device => {
    const d = fields(value, ['id', 'sha256', 'transport', 'enabled', 'paths']);
    requireValue(
      typeof d.id === 'string' &&
        /^[a-z0-9-]{1,64}$/.test(d.id) &&
        !ids.has(d.id),
    );
    requireValue(
      typeof d.sha256 === 'string' &&
        DIGEST.test(d.sha256) &&
        !hashes.has(d.sha256),
    );
    requireValue(d.transport === 'bearer' || d.transport === 'url');
    requireValue(typeof d.enabled === 'boolean');
    ids.add(d.id);
    hashes.add(d.sha256);
    return {
      sha256: d.sha256,
      transport: d.transport,
      enabled: d.enabled,
      paths: paths(d.paths),
    };
  });
  return { devices, disabledPaths: paths(config.disabled_paths) };
}

export async function authorize(
  request: Request,
  url: URL,
  env: Env,
): Promise<void> {
  const header = request.headers.get('Authorization');
  const keys = url.searchParams.getAll('key');
  const transport = header !== null ? 'bearer' : 'url';
  const token =
    header !== null
      ? /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(header)?.[1]
      : keys[0];
  if (
    (header !== null && keys.length > 0) ||
    !token ||
    !/^[A-Za-z0-9_-]{43}$/.test(token) ||
    (transport === 'url' &&
      (keys.length !== 1 || env.ALLOW_URL_TOKENS !== 'true'))
  ) {
    throw new GatewayError(401, 'unauthorized');
  }
  let config;
  try {
    config = configuration(env.DEVICE_AUTH);
  } catch {
    throw new GatewayError(503, 'auth_configuration');
  }
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  );
  let device: Device | undefined;
  for (const candidate of config.devices) {
    const expected = Uint8Array.from(candidate.sha256.match(/../g)!, (hex) =>
      parseInt(hex, 16),
    );
    const matches = crypto.subtle.timingSafeEqual(digest, expected);
    if (matches && candidate.enabled && candidate.transport === transport)
      device = candidate;
  }
  if (!device) throw new GatewayError(401, 'unauthorized');
  if (!device.paths.includes(url.pathname))
    throw new GatewayError(403, 'forbidden');
  if (config.disabledPaths.includes(url.pathname))
    throw new GatewayError(410, 'subscription_disabled');
}
