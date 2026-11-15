import { errorJson, handle, json, options, requireCaseId } from "@/lib/http";
import { startInBackground } from "@/pipeline";
import { ConfirmConflictError, startConfirm } from "@/pipeline/confirm";
import { IdentityChoiceSchema } from "@/schemas/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const OPTIONS = options;

/**
 * POST /api/cases/:id/confirm-identity
 *   { choice: "best_guess" } | { choice: "alternative", index } | { choice: "custom", brand, model, version?, colourway? } | { choice: "skip" }
 * -> 202 { caseId, revision }. Resumes a case that is awaiting_confirmation; on a closed case it corrects the model (a new revision).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(req, async (deps) => {
    const id = requireCaseId((await params).id);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorJson(400, "Expected a JSON body, e.g. { \"choice\": \"best_guess\" }");
    }
    const choice = IdentityChoiceSchema.parse(body);
    try {
      const started = await startConfirm(deps, id, choice);
      if (!started) return errorJson(404, "Case not found");
      startInBackground(started.done);
      return json({ caseId: id, revision: started.revision }, 202);
    } catch (err) {
      if (err instanceof ConfirmConflictError) return errorJson(409, err.message);
      throw err;
    }
  });
}
