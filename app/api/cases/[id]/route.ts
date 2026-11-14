import { errorJson, handle, json, options, originOf, requireCaseId } from "@/lib/http";
import { caseDetail } from "@/pipeline/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const OPTIONS = options;

/** GET /api/cases/:id -> full case */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(req, async (deps) => {
    const id = requireCaseId((await params).id);
    const c = await deps.store.getCase(id);
    if (!c) return errorJson(404, "Case not found");
    return json(await caseDetail(deps, c, originOf(req)));
  });
}
