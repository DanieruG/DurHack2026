import { handle, json, options, originOf } from "@/lib/http";
import { SummariesQuerySchema } from "@/schemas/api";
import { caseSummaries } from "@/pipeline/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const OPTIONS = options;

/** GET /api/cases/summaries?ids=a,b,c (max 50) -> CaseSummary[] */
export async function GET(req: Request) {
  return handle(req, async (deps) => {
    const { ids } = SummariesQuerySchema.parse({ ids: new URL(req.url).searchParams.get("ids") ?? "" });
    return json(await caseSummaries(deps, ids, originOf(req)));
  });
}
