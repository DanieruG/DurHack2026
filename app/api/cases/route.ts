import { errorJson, handle, json, options, readForm } from "@/lib/http";
import { clientIp } from "@/lib/rateLimit";
import { createCase, startInBackground } from "@/pipeline";
import { parseCaseRequest } from "@/pipeline/intake";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const OPTIONS = options;

/** POST /api/cases: multipart { capture, profile, caseNote?, screenshots[]? } -> 201 { caseId } */
export async function POST(req: Request) {
  return handle(req, async (deps) => {
    const limit = deps.limiter.create.take(clientIp(req));
    if (!limit.allowed) {
      const res = errorJson(429, "Too many investigations from this address; try again later");
      res.headers.set("retry-after", String(limit.retryAfterSec));
      return res;
    }
    const body = await parseCaseRequest(await readForm(req), deps.config.maxImageBytes);
    const { caseId, done } = await createCase(deps, body);
    startInBackground(done);
    return json({ caseId }, 201);
  });
}
