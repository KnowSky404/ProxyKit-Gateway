import { authorize } from './auth/devices';
import { route } from './config/contract';
import { GatewayError, response } from './http/errors';
import type { ArtifactProvider } from './providers/github';

export function createApp(provider: ArtifactProvider) {
  return async (request: Request, env: Env): Promise<Response> => {
    const requestId = crypto.randomUUID();
    const head = request.method === 'HEAD';
    try {
      const url = new URL(request.url);
      const resource = route(url.pathname);
      if (url.pathname !== '/v1/health' && !resource)
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
      await authorize(request, url, env);
      const snapshot = await provider.snapshot(env.GITHUB_READ_TOKEN);
      const artifact = snapshot.files.get(resource!.path);
      if (!artifact) throw new GatewayError(404, 'not_found');
      const etag = `"sha256-${artifact.sha256}"`;
      const headers = {
        'Content-Type': resource!.contentType,
        ETag: etag,
        'X-Distribution-Commit': snapshot.commit,
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
