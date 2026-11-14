const ALLOWED_METHODS = "GET, POST, OPTIONS";
const ALLOWED_HEADERS = "content-type, last-event-id";

export type CorsDecision = { allowed: boolean; headers: Record<string, string> };

/**
 * Only origins in ALLOWED_EXTENSION_ORIGINS / ALLOWED_WEB_ORIGINS get CORS headers.
 * Requests without an Origin header (e.g. <img> loads, server-to-server, curl) are not cross-origin
 * browser requests and are allowed through without CORS headers.
 */
export function corsFor(origin: string | null, allowedOrigins: string[]): CorsDecision {
  if (!origin) return { allowed: true, headers: {} };
  const allowed = allowedOrigins.includes(origin);
  if (!allowed) return { allowed: false, headers: {} };
  return {
    allowed: true,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": ALLOWED_METHODS,
      "access-control-allow-headers": ALLOWED_HEADERS,
      "access-control-max-age": "600",
      vary: "Origin",
    },
  };
}

export function preflight(req: Request, allowedOrigins: string[]): Response {
  const { allowed, headers } = corsFor(req.headers.get("origin"), allowedOrigins);
  if (!allowed) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers });
}
