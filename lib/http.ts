import { ZodError, z } from "zod";
import { getDeps, type Deps } from "@/pipeline/deps";
import { RequestError } from "@/pipeline/intake";
import { corsFor, preflight } from "./cors";

export const CASE_ID_RE = /^[a-z0-9]{8,40}$/i;

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function errorJson(status: number, error: string, details?: unknown): Response {
  return json(details === undefined ? { error } : { error, details }, status);
}

function withHeaders(res: Response, headers: Record<string, string>): Response {
  if (!Object.keys(headers).length) return res;
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

/** Common wrapper: CORS (extension + web origins only), error mapping, deps. */
export async function handle(req: Request, fn: (deps: Deps) => Promise<Response>): Promise<Response> {
  const deps = await getDeps();
  const cors = corsFor(req.headers.get("origin"), deps.config.allowedOrigins);
  if (!cors.allowed) return errorJson(403, "Origin not allowed");
  let res: Response;
  try {
    res = await fn(deps);
  } catch (err) {
    if (err instanceof RequestError) res = errorJson(err.status, err.message, err.details);
    else if (err instanceof ZodError) res = errorJson(400, "Invalid request", z.treeifyError(err));
    else {
      console.error("[api] unhandled error", err);
      res = errorJson(500, "Internal error");
    }
  }
  return withHeaders(res, cors.headers);
}

export async function options(req: Request): Promise<Response> {
  const deps = await getDeps();
  return preflight(req, deps.config.allowedOrigins);
}

export function requireCaseId(id: string): string {
  if (!CASE_ID_RE.test(id)) throw new RequestError("Case not found", 404);
  return id;
}

export async function readForm(req: Request): Promise<FormData> {
  const type = req.headers.get("content-type") ?? "";
  if (!/multipart\/form-data|application\/x-www-form-urlencoded/i.test(type)) {
    throw new RequestError("Expected multipart/form-data", 415);
  }
  try {
    return await req.formData();
  } catch {
    throw new RequestError("Could not read the form data");
  }
}

export function originOf(req: Request): string {
  const fwdHost = req.headers.get("x-forwarded-host");
  const fwdProto = req.headers.get("x-forwarded-proto");
  if (fwdHost) return `${fwdProto ?? "https"}://${fwdHost}`;
  return new URL(req.url).origin;
}
