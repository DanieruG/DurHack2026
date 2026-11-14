import { errorJson, handle, json, options, readForm, requireCaseId } from "@/lib/http";
import { clientIp } from "@/lib/rateLimit";
import { ReopenConflictError, startInBackground, startReopen } from "@/pipeline";
import { parseReopenRequest } from "@/pipeline/intake";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const OPTIONS = options;

/** POST /api/cases/:id/reopen: multipart { capture?, sellerReply?, screenshots[]? } -> 202 { caseId, revision } */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(req, async (deps) => {
    const id = requireCaseId((await params).id);
    if (!deps.limiter.reopen.take(clientIp(req)).allowed) return errorJson(429, "Too many requests; try again later");
    const body = await parseReopenRequest(await readForm(req), deps.config.maxImageBytes);
    try {
      const started = await startReopen(deps, id, body);
      if (!started) return errorJson(404, "Case not found");
      startInBackground(started.done);
      return json({ caseId: id, revision: started.revision }, 202);
    } catch (err) {
      if (err instanceof ReopenConflictError) return errorJson(409, err.message);
      throw err;
    }
  });
}
