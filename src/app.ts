import { authorize } from './auth/devices';
import { collection, route } from './config/contract';
import { GatewayError, response } from './http/errors';
import { sha256 } from './manifest/validate';
import type { Artifact, ArtifactProvider } from './providers/github';

export function createApp(provider: ArtifactProvider) {
  return async (request: Request, env: Env): Promise<Response> => {
    const requestId = crypto.randomUUID();
    const head = request.method === 'HEAD';
    try {
      const url = new URL(request.url);
      const resource = route(url.pathname);
      const client = collection(url.pathname);
      if (url.pathname !== '/v1/health' && !resource && !client)
        throw new GatewayError(404, 'not_found');
      if (request.method !== 'GET' && !head) {
        return response('Method not allowed\n', 405, {
          Allow: 'GET, HEAD',
          'X-Request-Id': requestId,
        });
      }
      if (url.pathname === '/v1/health') {
        return response(head ? null : '{"status":"ok"}\n', 200, {
          'Content-Type': 'application/json',
          'X-Request-Id': requestId,
        });
      }
      if ([...url.searchParams.keys()].some((key) => key !== 'key'))
        throw new GatewayError(404, 'not_found');
      if (url.protocol !== 'https:')
        throw new GatewayError(400, 'https_required');
      const allowed = await authorize(request, url, env);
      let artifact: Artifact | undefined;
      if (client) {
        const catalog = await provider.catalog(
          env.GITHUB_READ_TOKEN,
          env.METADATA_CACHE_TTL_SECONDS,
        );
        const resources = catalog.files
          .filter((file) => file.path.startsWith(`generated/${client}/`))
          .map((file) => {
            const name = file.path.split('/').at(-1)!;
            return { name, path: `/v1/private/${client}/${name}` };
          })
          .filter((file) => allowed(file.path));
        const bytes = new Uint8Array(
          new TextEncoder().encode(JSON.stringify({ resources }) + '\n'),
        );
        artifact = {
          path: url.pathname,
          commit: catalog.commit,
          bytes,
          sha256: await sha256(bytes),
        };
      } else {
        artifact = await provider.artifact(
          resource!.path,
          env.GITHUB_READ_TOKEN,
          env.METADATA_CACHE_TTL_SECONDS,
        );
      }
      if (!artifact) throw new GatewayError(404, 'not_found');
      const etag = `"sha256-${artifact.sha256}"`;
      const headers = {
        'Content-Type': client
          ? 'application/json; charset=utf-8'
          : resource!.contentType,
        ETag: etag,
        'X-Distribution-Commit': artifact.commit,
        'X-Request-Id': requestId,
      };
      const conditional = request.headers.get('If-None-Match');
      if (
        conditional?.trim() === '*' ||
        conditional
          ?.split(',')
          .some((tag) => tag.trim().replace(/^W\//, '') === etag)
      ) {
        return response(null, 304, headers);
      }
      return response(head ? null : artifact.bytes.slice(), 200, {
        ...headers,
        'Content-Length': String(artifact.bytes.byteLength),
      });
    } catch (error) {
      const failure =
        error instanceof GatewayError
          ? error
          : new GatewayError(503, 'internal_failure');
      // Never log URLs, queries, headers, exception messages, or origin response bodies.
      if (failure.status >= 500)
        console.error(
          JSON.stringify({
            category: failure.category,
            status: failure.status,
            requestId,
          }),
        );
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Request-Id': requestId,
      };
      if (failure.status === 401)
        headers['WWW-Authenticate'] = 'Bearer realm="private-rules"';
      if (failure.retryAfter !== undefined)
        headers['Retry-After'] = String(failure.retryAfter);
      return response(
        head
          ? null
          : JSON.stringify({
              error: failure.status >= 500 ? 'unavailable' : failure.category,
              request_id: requestId,
            }),
        failure.status,
        headers,
      );
    }
  };
}
