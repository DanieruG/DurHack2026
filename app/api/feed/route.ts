import { handle, json, options } from "@/lib/http";
import { FeedQuerySchema } from "@/schemas/api";
import { buildFeed } from "@/pipeline/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const OPTIONS = options;

/** GET /api/feed?brand=&size=&system= -> FeedItem[] (seeded mock feature + opted-in hidden gems). */
export async function GET(req: Request) {
  return handle(req, async (deps) => {
    const sp = new URL(req.url).searchParams;
    const q = FeedQuerySchema.parse({
      brand: sp.get("brand") || undefined,
      size: sp.get("size") || undefined,
      system: sp.get("system")?.toUpperCase() || undefined,
    });
    return json(await buildFeed(deps, q));
  });
}
