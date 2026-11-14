import { errorJson, handle, options, requireCaseId } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const OPTIONS = options;

/** GET /api/cases/:id/images/:index -> stored listing image (the photoIndex used in evidence). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; index: string }> }) {
  return handle(req, async (deps) => {
    const p = await params;
    const id = requireCaseId(p.id);
    const index = Number(p.index);
    if (!Number.isInteger(index) || index < 0 || index > 100) return errorJson(404, "Image not found");
    const images = await deps.store.getInputs(id, { kinds: ["image"] });
    const img = images[index];
    if (!img?.data || !img.mimeType) return errorJson(404, "Image not found");
    return new Response(Buffer.from(img.data), {
      headers: {
        "content-type": img.mimeType,
        "cache-control": "private, max-age=3600",
        "x-content-type-options": "nosniff",
      },
    });
  });
}
