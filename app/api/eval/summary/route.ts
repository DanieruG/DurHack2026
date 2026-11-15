import { errorJson, handle, json, options } from "@/lib/http";
import { loadPublicEvalSummary } from "@/lib/evalSummary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const OPTIONS = options;

/** GET /api/eval/summary -> the latest eval figures (eval/summary.json without its failure list); 404 before any eval run. */
export async function GET(req: Request) {
  return handle(req, async () => {
    const summary = await loadPublicEvalSummary();
    return summary ? json(summary) : errorJson(404, "No evaluation has been run yet");
  });
}
