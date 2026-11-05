export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly category: string,
    readonly retryAfter?: number,
  ) {
    super(category);
  }
}

export function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new GatewayError(503, 'contract_rejected');
}

export function response(
  body: BodyInit | null,
  status = 200,
  extra: HeadersInit = {},
): Response {
  const headers = new Headers(extra);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set(
    'Content-Security-Policy',
    "default-src 'none'; frame-ancestors 'none'",
  );
  headers.set('Strict-Transport-Security', 'max-age=31536000');
  return new Response(body, { status, headers });
}
