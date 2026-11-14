import { errorJson, handle, json, options, requireCaseId } from "@/lib/http";
import { ShareRequestSchema } from "@/schemas/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const OPTIONS = options;

/** POST /api/cases/:id/share { optIn } -> 200 { shareOptIn }. Only allowed when the current verdict is hidden_gem. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(req, async (deps) => {
    const id = requireCaseId((await params).id);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorJson(400, "Expected a JSON body { optIn: boolean }");
    }
    const { optIn } = ShareRequestSchema.parse(body);
    const c = await deps.store.getCase(id);
    if (!c) return errorJson(404, "Case not found");
    if (optIn && c.verdict?.label !== "hidden_gem") {
      return errorJson(409, "Only hidden_gem verdicts can be shared to the feed");
    }
    const updated = await deps.store.updateCase(id, { shareOptIn: optIn });
    return json({ shareOptIn: updated.shareOptIn });
  });
}
