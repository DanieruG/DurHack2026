import { describe, expect, it } from "vitest";
import { createCase } from "@/pipeline";
import { createLensClient, LensError, lensCacheKey, topMatches } from "@/lib/lens";
import { lensPhotoUrls, shouldRunLens } from "@/pipeline/lens";
import { resetSerpCounts, serpCallCounts } from "@/lib/serpQuota";
import { MemoryStore } from "@/lib/store";
import type { IdentifyResult } from "@/schemas/domain";
import { checksFrom, fixtureReference, json, makeDeps, promptText, PROFILE, type Handler } from "./helpers";

const cat = fixtureReference().catalogue;
const facts = { platform: "vinted" as const, conditionClaims: [], photoCount: 2, evidence: [] };
const id = (over: Partial<IdentifyResult> = {}): IdentifyResult => ({ brand: "Nike", brandConfidence: 0.9, modelName: "Pegasus 40", catalogueModelId: "nike-pegasus-40", inCatalogue: true, confidence: 0.9, reasons: "", evidence: [], confidenceLevel: "likely", ...over });

describe("shouldRunLens", () => {
  it("not when the title names the model and identification is likely or better", () => {
    expect(shouldRunLens(id(), { ...facts, title: "Nike Pegasus 40 trainers" }, cat)).toBe(false);
    expect(shouldRunLens(id({ confidenceLevel: "confirmed" }), { ...facts, title: "Nike Pegasus 40" }, cat)).toBe(false);
  });
  it("when the title doesn't name a model", () => {
    expect(shouldRunLens(id(), { ...facts, title: "Nike running trainers" }, cat)).toBe(true);
    expect(shouldRunLens(id({ modelName: null, catalogueModelId: null }), { ...facts, title: "Nike trainers" }, cat)).toBe(true);
    expect(shouldRunLens(null, facts, cat)).toBe(true);
  });
  it("when confidence is below likely, even if the title names the model", () => {
    expect(shouldRunLens(id({ confidenceLevel: "possible" }), { ...facts, title: "Nike Pegasus 40" }, cat)).toBe(true);
    expect(shouldRunLens(id({ confidenceLevel: "best_guess" }), { ...facts, title: "Nike Pegasus 40" }, cat)).toBe(true);
  });
  it("never after the buyer has confirmed", () => {
    expect(shouldRunLens(id({ confidenceLevel: "user_confirmed" }), { ...facts, title: "Nike trainers" }, cat)).toBe(false);
  });
});

describe("lensPhotoUrls", () => {
  const images = [
    { index: 0, sourceUrl: "https://img.example.com/1.jpg" },
    { index: 1, sourceUrl: "https://img.example.com/2.jpg" },
    { index: 2 },
  ];
  it("main photo plus the clearest side profile, when it is another photo", () => {
    expect(lensPhotoUrls(images, id({ sideProfilePhotoIndex: 1 }))).toEqual(["https://img.example.com/1.jpg", "https://img.example.com/2.jpg"]);
    expect(lensPhotoUrls(images, id({ sideProfilePhotoIndex: 0 }))).toEqual(["https://img.example.com/1.jpg"]);
    expect(lensPhotoUrls(images, id())).toEqual(["https://img.example.com/1.jpg"]);
  });
  it("skips photos with no public URL", () => {
    expect(lensPhotoUrls(images, id({ sideProfilePhotoIndex: 2 }))).toEqual(["https://img.example.com/1.jpg"]);
    expect(lensPhotoUrls([{ index: 0 }], id())).toEqual([]);
  });
});

describe("Lens client", () => {
  const raw = [
    { title: "Nike Pegasus 41 Men's", source: "Shop A", link: "https://a.example.com/1" },
    { title: "Nike Pegasus 41 Men's", source: "Shop A", link: "https://a.example.com/1" }, // duplicate link
    { title: "", link: "https://a.example.com/2" }, // no title
    { title: "Javascript link", link: "javascript:alert(1)" },
    { title: "Nike Zoom Pegasus 41", link: "https://b.example.com/3" },
  ];
  const make = (over: { mode?: "off" | "replay"; apiKey?: string; store?: MemoryStore } = {}) => {
    const urls: string[] = [];
    const client = createLensClient({
      apiKey: "apiKey" in over ? over.apiKey : "k",
      mode: over.mode ?? "off",
      store: over.store ?? new MemoryStore(fixtureReference()),
      logger: () => undefined,
      retryBackoffMs: 1,
      fetch: async (url) => {
        urls.push(url);
        return { ok: true, status: 200, json: async () => ({ visual_matches: raw }) };
      },
    });
    return { client, urls };
  };

  it("asks SerpApi's google_lens engine for visual matches by image URL, and keeps clean matches", async () => {
    resetSerpCounts();
    const { client, urls } = make();
    const r = await client.visualMatches("https://img.example.com/1.jpg");
    const u = new URL(urls[0]);
    expect(u.searchParams.get("engine")).toBe("google_lens");
    expect(u.searchParams.get("type")).toBe("visual_matches");
    expect(u.searchParams.get("url")).toBe("https://img.example.com/1.jpg");
    expect(r.matches).toEqual([
      { title: "Nike Pegasus 41 Men's", source: "Shop A", link: "https://a.example.com/1" },
      { title: "Nike Zoom Pegasus 41", source: null, link: "https://b.example.com/3" },
    ]);
    expect(topMatches(raw)).toHaveLength(2);
    expect(serpCallCounts().lens).toBe(1); // counted against the quota
  });

  it("caches per image URL: the second ask makes no request and spends no quota", async () => {
    resetSerpCounts();
    const { client, urls } = make();
    const a = await client.visualMatches("https://img.example.com/1.jpg");
    const b = await client.visualMatches("https://img.example.com/1.jpg");
    await client.visualMatches("https://img.example.com/2.jpg");
    expect(a.fromCache).toBe(false);
    expect(b.fromCache).toBe(true);
    expect(urls).toHaveLength(2);
    expect(serpCallCounts().lens).toBe(2);
    expect(lensCacheKey("https://img.example.com/1.jpg")).not.toBe(lensCacheKey("https://img.example.com/2.jpg"));
  });

  it("replay mode serves the cache and throws on a miss without any request", async () => {
    const store = new MemoryStore(fixtureReference());
    await make({ store }).client.visualMatches("https://img.example.com/1.jpg");
    const replay = make({ mode: "replay", store });
    expect((await replay.client.visualMatches("https://img.example.com/1.jpg")).fromCache).toBe(true);
    await expect(replay.client.visualMatches("https://img.example.com/9.jpg")).rejects.toBeInstanceOf(LensError);
    expect(replay.urls).toHaveLength(0);
  });

  it("needs a key and a public URL", async () => {
    await expect(make({ apiKey: undefined }).client.visualMatches("https://img.example.com/1.jpg")).rejects.toThrow(/key/);
    await expect(make().client.visualMatches("data:image/png;base64,AAAA")).rejects.toThrow(/public image URL/);
  });
});

describe("Lens in the pipeline", () => {
  const VAGUE = "Nike running trainers\nSize: UK 9\n£38.00\nCondition: Very good\nWorn twice, no box.";
  const MAIN = "https://img.example.com/1.jpg";
  const SIDE = "https://img.example.com/2.jpg";
  const first = { brand: "Nike", brandConfidence: 0.9, modelName: "Pegasus 40", catalogueModelId: "nike-pegasus-40", confidence: 0.6, reasons: "Maybe", evidence: [], sideProfilePhotoIndex: 1 };
  const withLens: Handler = (req) =>
    promptText(req).includes("VISUAL MATCHES")
      ? json({ ...first, modelName: "Pegasus 41", catalogueModelId: "nike-pegasus-41", confidence: 0.85, reasons: "Matches show the 41", sideProfilePhotoIndex: null })
      : json(first);
  const matches = { [MAIN]: [{ title: "Nike Pegasus 41 Men's Road Running Shoes", source: "Shop A", link: "https://a.example.com/p41" }], [SIDE]: [{ title: "Nike Air Zoom Pegasus 41", source: "Shop B", link: "https://b.example.com/p41" }] };

  it("runs for a vague title, searches the main photo and the side profile, and identifies again with the matches as evidence", async () => {
    const deps = makeDeps({ handlers: { identify: withLens, extract: titleOnly("Nike running trainers") }, lens: matches });
    const { caseId, done } = await createCase(deps, { capture: { pageText: VAGUE, imageUrls: [MAIN, SIDE] }, profile: PROFILE, screenshots: [] });
    await done;
    const events = deps.hub.events(caseId);
    expect(deps.lensRequests).toEqual([MAIN, SIDE]);
    // The second identify call carries the matches, marked as visual matches and not facts.
    const second = deps.calls.filter((c) => c.stage === "identify").map(promptText).find((t) => t.includes("VISUAL MATCHES"))!;
    expect(second).toContain("NOT facts about this listing");
    expect(second).toContain("Nike Pegasus 41 Men's Road Running Shoes (Shop A)");
    const c = (await deps.store.getCase(caseId))!;
    expect(c.identify).toMatchObject({ bestGuess: { model: "Pegasus 41" }, lens: { photos: 2, live: 2, changedAnswer: true } });
    expect(c.identify!.lensMatches).toHaveLength(2);
    // Stored as evidence with links, and on the identify check.
    const links = checksFrom(events).identify.evidence.filter((e) => e.kind === "source").map((e) => e.url);
    expect(links).toEqual(["https://a.example.com/p41", "https://b.example.com/p41"]);
    expect(events.some((e) => e.event === "stage_started" && (e.data as { stage: string }).stage === "lens")).toBe(true);
  });

  it("does not run when the title names the model and identification is likely", async () => {
    const deps = makeDeps({ handlers: { identify: () => json({ ...first, confidence: 0.9 }), extract: titleOnly("Nike Air Zoom Pegasus 40 trainers") }, lens: matches });
    const { done } = await createCase(deps, { capture: { pageText: "Nike Air Zoom Pegasus 40 trainers\nSize: UK 9\n£38.00", imageUrls: [MAIN, SIDE] }, profile: PROFILE, screenshots: [] });
    await done;
    expect(deps.lensRequests).toEqual([]);
  });

  it("a Lens failure leaves the first identification standing", async () => {
    const deps = makeDeps({ handlers: { identify: withLens, extract: titleOnly("Nike running trainers") }, lens: {} });
    const { caseId, done } = await createCase(deps, { capture: { pageText: VAGUE, imageUrls: [MAIN, SIDE] }, profile: PROFILE, screenshots: [] });
    await done;
    const c = (await deps.store.getCase(caseId))!;
    expect(c.identify).toMatchObject({ bestGuess: { model: "Pegasus 40" }, lens: { changedAnswer: false } });
    expect(deps.calls.filter((x) => x.stage === "identify").map(promptText).some((t) => t.includes("VISUAL MATCHES"))).toBe(false);
  });
});

/** An extract mock whose listing title is `title` and never names a model field. */
function titleOnly(title: string): Handler {
  return async () =>
    json({ title, brandText: "Nike", modelText: null, sizeText: "UK 9", sizeSystem: "UK", price: 38, currency: "GBP", conditionClaims: ["Very good"], evidence: [{ field: "price", kind: "quote", quote: "£38.00" }] });
}
