// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableJavaScriptEvaluation":true,"disableJavaScriptFileLoading":true,"disableCSSFileLoading":true,"disableIframePageLoading":true,"disableComputedStyleRendering":true,"handleDisabledFileLoadingAsSuccess":true}}
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prepareCapture } from "@/extension/src/lib/capture";
import { createCase } from "@/pipeline";
import { ListingDataSchema } from "@/schemas/domain";
import { runCase, structuredGroups } from "@/eval/collect";
import { EMPTY_LABEL } from "@/eval/labels";
import { summarise } from "@/eval/metrics";
import { structuredMarkdown } from "@/eval/report";
import { collectFixture, EBAY_FIXTURE, VINTED_FIXTURE } from "./listingFixtures";
import { makeDeps, PAGE_TEXT, PROFILE } from "./helpers";

async function storedListing(fixture: typeof EBAY_FIXTURE | typeof VINTED_FIXTURE) {
  const deps = makeDeps({ images: {} });
  const { capture } = prepareCapture(collectFixture(fixture));
  const { caseId, done } = await createCase(deps, { capture, profile: PROFILE, screenshots: [] });
  await done;
  const rows = await deps.store.getInputs(caseId, { kinds: ["listing_data"] });
  expect(rows).toHaveLength(1);
  return ListingDataSchema.parse(JSON.parse(rows[0].text!));
}

describe("structured capture is stored with each case", () => {
  it("eBay: item specifics, size options and pricing, each with its source, and no seller identity", async () => {
    const l = await storedListing(EBAY_FIXTURE);
    expect(l.itemSpecifics?.length).toBeGreaterThan(5);
    expect(l.itemSpecifics!.every((s) => s.source === "page_field")).toBe(true);
    expect(l.sizeOptions).toMatchObject({ label: "UK Shoe Size", system: "UK", source: "structured_data" });
    expect(l.priceGBP).toEqual({ value: 54, source: "structured_data" });
    expect(l.postageGBP?.source).toBe("structured_data");
    expect(structuredGroups(l)).toEqual(["item specifics", "size options", "attributes", "pricing"]);
    expect(JSON.stringify(l)).not.toMatch(new RegExp([...EBAY_FIXTURE.seller, ...EBAY_FIXTURE.account].join("|"), "i"));
  });

  it("Vinted: attributes and the pricing breakdown (price, buyer protection, postage, seller's currency)", async () => {
    const l = await storedListing(VINTED_FIXTURE);
    expect(l.size?.source).toBeDefined();
    expect(l.brand?.value).toBe("Nike");
    expect(l.buyerProtectionGBP?.source).toBe("structured_data");
    expect(l.sellerPrice).toMatchObject({ currency: "AUD", source: "structured_data" });
    expect(structuredGroups(l)).toContain("pricing");
    expect(JSON.stringify(l)).not.toMatch(new RegExp(VINTED_FIXTURE.seller.join("|"), "i"));
  });

  it("a capture without structured fields stores none", async () => {
    const deps = makeDeps();
    const { caseId, done } = await createCase(deps, { capture: { pageUrl: "https://www.vinted.co.uk/items/1-nike", pageText: PAGE_TEXT }, profile: PROFILE, screenshots: [] });
    await done;
    expect(await deps.store.getInputs(caseId, { kinds: ["listing_data"] })).toEqual([]);
  });
});

describe("eval cases run with their structured fields when present", () => {
  it("passes capture.listing to the pipeline and records which groups it had", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evalcase-"));
    const listing = { title: { value: "Nike Air Zoom Pegasus 40", source: "structured_data" }, size: { value: "9", source: "structured_data" }, priceGBP: { value: 45, source: "structured_data" } };
    fs.writeFileSync(path.join(dir, "capture.json"), JSON.stringify({ capture: { pageUrl: "https://www.vinted.co.uk/items/123-nike", pageText: PAGE_TEXT, listing, imageUrls: [] } }));
    const deps = makeDeps();
    const r = await runCase(deps, dir, "vinted-123", EMPTY_LABEL);
    expect(r.error).toBeUndefined();
    expect(r.structured).toEqual(["attributes", "pricing"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the report says which cases had structured data and which didn't", () => {
    const base = { label: EMPTY_LABEL, tier: "none" as const, brand: null, modelName: null, styleCode: null, colours: null, size: { text: null, system: null, options: null }, findings: [], offers: [], verdict: null, durationMs: 1, geminiCalls: 1 };
    const s = summarise([{ ...base, id: "ebay-1", structured: ["item specifics", "pricing"] }, { ...base, id: "vinted-2", structured: [] }], { runAt: "x", pipelineVersion: "1", models: { fast: null, strong: null }, cacheMode: "off" });
    expect(s.structuredCapture).toEqual({ with: [{ caseId: "ebay-1", groups: ["item specifics", "pricing"] }], without: ["vinted-2"] });
    const md = structuredMarkdown(s).join("\n");
    expect(md).toContain("1 of 2 cases ran with the extension's structured fields");
    expect(md).toContain("| ebay-1 | item specifics, pricing |");
    expect(md).toContain("Page text only: vinted-2.");
  });
});
