import { describe, expect, it } from "vitest";
import { prepareCapture, redactPageText, type RawCapture } from "@/extension/src/lib/capture";
import { describeDiff } from "@/extension/src/lib/changes";
import { boxStyle, conditionView, findingCaption, leadsView, priceView, sourceRefs } from "@/extension/src/lib/evidence";
import { firstSentence, shortDate } from "@/extension/src/lib/format";
import { addEntry, caseForUrl, caseLabel, historyRows, HISTORY_LIMIT, keepFound, normaliseHistory, removeEntry, type HistoryEntry } from "@/extension/src/lib/history";
import type { CaseSummary } from "@/schemas/domain";
import { applyEvent, newInvestigation, parseEvent, revisionOf, segments, type IncomingEvent } from "@/extension/src/lib/progress";
import { VERDICTS, VERDICT_ORDER } from "@/extension/src/lib/verdicts";
import { CASE_FILE, DIFF, investigationInProgress } from "@/extension/src/preview/fixtures";
import { CaseDetailSchema } from "@/schemas/api";
import { CaseDiffSchema, CheckResultSchema, VerdictLabelSchema } from "@/schemas/domain";

const raw = (over: Partial<RawCapture> = {}): RawCapture => ({
  pageUrl: "https://www.vinted.co.uk/items/123-nike-pegasus-40",
  docTitle: "Nike Pegasus 40 | Vinted",
  ogTitle: null,
  h1: null,
  priceMeta: null,
  priceText: "£42.00",
  images: ["https://images.example.com/1.jpg", "http://insecure.example.com/2.jpg", "https://images.example.com/3.jpg"],
  pageText: "Nike Pegasus 40\nSize UK 9\nMember since 2019\n@trainerfan99\nGood condition",
  ...over,
});

describe("capture", () => {
  it("builds the API capture and the panel preview", () => {
    const { capture, preview } = prepareCapture(raw());
    expect(preview).toMatchObject({ title: "Nike Pegasus 40", priceGBP: 42, platform: "vinted", photoCount: 2 });
    expect(capture.imageUrls).toEqual(["https://images.example.com/1.jpg", "https://images.example.com/3.jpg"]);
    expect(capture.pageUrl).toBe("https://www.vinted.co.uk/items/123-nike-pegasus-40");
  });

  it("prefers structured price metadata in GBP and ignores other currencies", () => {
    expect(prepareCapture(raw({ priceMeta: { amount: "39.5", currency: "GBP" } })).preview.priceGBP).toBe(39.5);
    expect(prepareCapture(raw({ priceMeta: { amount: "50", currency: "EUR" }, priceText: null })).preview.priceGBP).toBeNull();
  });

  it("drops seller-identity lines before sending", () => {
    const t = redactPageText(raw().pageText);
    expect(t).not.toMatch(/Member since|@trainerfan99/);
    expect(t).toContain("Size UK 9");
  });

  it("omits empty fields so the backend's 'needs something' rule is meaningful", () => {
    const { capture } = prepareCapture(raw({ images: [], pageText: "  ", pageUrl: "chrome://newtab" }));
    expect(capture).toEqual({});
  });
});

const at = (s: number) => 1000 + s * 1000;
const ev = (name: IncomingEvent["name"], data: unknown, s = 0, revision = 1): IncomingEvent => ({ name, data, revision, at: at(s) });

describe("investigation reducer", () => {
  it("turns events into the short log the brief describes", () => {
    const s = investigationInProgress();
    const texts = s.log.map((l) => l.text);
    expect(texts[0]).toBe("Identified Nike Pegasus 40");
    expect(texts).toContain("Size checked");
    expect(texts).toContain("Reviews read, 4 sources");
    expect(texts).toContain("Inspecting photos");
    expect(s.log.find((l) => l.kind === "followup")?.text).toBe("Price looked low. Comparing more carefully.");
    expect(s.log.find((l) => l.text === "Inspecting photos")?.state).toBe("active");
    expect(segments(s).filter((x) => x.done)).toHaveLength(4);
  });

  it("replaces a repeated check_done and settles active lines when done", () => {
    let s = newInvestigation(1, at(0));
    s = applyEvent(s, ev("stage_started", { stage: "condition" }, 1));
    s = applyEvent(s, ev("check_done", { ...CASE_FILE.checks[2], status: "pass", summary: "x" }, 2));
    s = applyEvent(s, ev("check_done", { ...CASE_FILE.checks[2], status: "fail", summary: "y" }, 3));
    expect(s.checks.fit?.summary).toBe("y");
    expect(s.log.filter((l) => l.key === "fit")).toHaveLength(1);
    s = applyEvent(s, ev("investigation_done", { caseId: "c", revision: 1, durationMs: 1, geminiCalls: 1 }, 4));
    expect(s.done).toBe(true);
    expect(s.log.every((l) => l.state !== "active")).toBe(true);
  });

  it("ignores events from an older revision and resets on a newer one", () => {
    let s = newInvestigation(2, at(0));
    s = applyEvent(s, ev("verdict", CASE_FILE.verdict, 1, 1));
    expect(s.verdict).toBeNull();
    s = applyEvent(s, ev("diff", DIFF, 2, 2));
    expect(s.diff).toEqual(DIFF);
    s = applyEvent(s, ev("case_reopened", { caseId: "c", revision: 3 }, 3, 3));
    expect(s.revision).toBe(3);
    expect(s.diff).toBeNull();
  });

  it("only fatal errors (no stage) stop the investigation", () => {
    let s = newInvestigation(1, 0);
    s = applyEvent(s, ev("error", { stage: "price", message: "Price lookup timed out" }));
    expect(s.fatal).toBeNull();
    expect(s.log[0]).toMatchObject({ kind: "warning", state: "problem" });
    s = applyEvent(s, ev("error", { message: "Stopped" }));
    expect(s.fatal).toBe("Stopped");
  });

  it("validates SSE payloads against the backend contract", () => {
    expect(parseEvent("verdict", JSON.stringify(CASE_FILE.verdict))?.name).toBe("verdict");
    expect(parseEvent("verdict", JSON.stringify({ label: "great" }))).toBeNull();
    expect(parseEvent("not_an_event", "{}")).toBeNull();
    expect(parseEvent("check_done", "not json")).toBeNull();
    expect(revisionOf("3:17")).toBe(3);
    expect(revisionOf(undefined)).toBeNull();
  });
  it("keeps warning signals from the SSE stream for the case file", () => {
    let s = newInvestigation(1, 0);
    s = applyEvent(s, ev("warning_signals", CASE_FILE.warningSignals, 1));
    expect(s.warningSignals).toEqual(CASE_FILE.warningSignals);
  });
});

describe("case file evidence", () => {
  it("places condition boxes from normalised box2d and words them like the backend", () => {
    expect(boxStyle([560, 760, 820, 935])).toEqual({ top: 56, left: 76, height: 26, width: 17.5 });
    expect(findingCaption({ label: "heel_wear", severity: "moderate", confidence: 0.5 })).toBe("Possible heel wear");
    const v = conditionView(CASE_FILE.checks[1], CASE_FILE.imageUrls);
    expect(v.photos[0].boxes[0].caption).toBe("Possible heel wear");
    expect(v.notes).toEqual(["Inside lining not shown."]);
  });

  it("numbers comfort sources and states price sources with dates", () => {
    expect(sourceRefs(CASE_FILE.checks[3]).map((r) => r.n)).toEqual([1, 2, 3]);
    const p = priceView(CASE_FILE.checks[4]);
    expect(p.lines).toEqual(["Compared with 12 listings sampled 10 Nov.", "New price £75, median of 3 UK retailers."]);
    expect(p.strip!.listing).toBeLessThan(p.strip!.p25);
  });

  it("flags placeholder price samples", () => {
    const c = structuredClone(CASE_FILE.checks[4]);
    (c.details as { sample: { placeholder: boolean } }).sample.placeholder = true;
    expect(priceView(c).lines[0]).toMatch(/Placeholder data/);
  });
});

describe("what changed", () => {
  it("leads with the reason and the direction of change", () => {
    const d = describeDiff(DIFF);
    expect(d.line).toBe("Heel close-up shows light wear only. Condition upgraded.");
    expect(d.changes[0]).toMatchObject({ name: "Condition", direction: "upgraded" });
  });
});

describe("verdict treatments", () => {
  it("covers every backend verdict with a distinct treatment; red only for overpriced and wrong fit", () => {
    expect([...VERDICT_ORDER].sort()).toEqual([...VerdictLabelSchema.options].sort());
    const treatments = VERDICT_ORDER.map((v) => VERDICTS[v].treatment);
    expect(new Set(treatments).size).toBe(treatments.length);
    const red = VERDICT_ORDER.filter((v) => VERDICTS[v].treatment.endsWith("red"));
    expect(red.sort()).toEqual(["overpriced", "wrong_fit"]);
  });
});

describe("preview fixtures follow the API contract", () => {
  it("parses with the backend schemas", () => {
    expect(() => CaseDetailSchema.parse(CASE_FILE)).not.toThrow();
    expect(() => CaseDiffSchema.parse(DIFF)).not.toThrow();
    for (const c of CASE_FILE.checks) expect(() => CheckResultSchema.parse(c)).not.toThrow();
  });
});

describe("format", () => {
  it("formats case numbers, dates and sentences", () => {
    expect(caseLabel("cmabcdef12x7f3kq2")).toBe("Case 7F3KQ2");
    expect(shortDate("2026-11-10")).toBe("10 Nov");
    expect(firstSentence("Listed UK 9. Your Nike size.")).toBe("Listed UK 9.");
  });
});

describe("capture: full eBay gallery", () => {
  it("turns every gallery thumbnail into its full-size photo, one per image id, without other listings", () => {
    const ids = ["AS4AAeSw505qR4He", "yvcAAeSwts9qR4Hg", "obUAAeSwn0ZqR4Hf", "xoUAAeSwepNqR4Hg", "K1sAAeSwQ2xqR4Hh", "Zz9AAeSw7mVqR4Hi"];
    const images = [
      `https://i.ebayimg.com/images/g/${ids[0]}/s-l1600.webp`, // the slide on screen
      ...ids.map((id) => `https://i.ebayimg.com/images/g/${id}/s-l140.webp`), // filmstrip thumbnails
      ...ids.map((id) => `https://i.ebayimg.com/images/g/${id}/s-l64.jpg`), // smaller copies
      "https://i.ebayimg.com/thumbs/images/g/Rp0AAeSwY-tq4Nzq/s-l500.jpg", // "Similar items" card
    ];
    const { capture, preview } = prepareCapture(raw({ pageUrl: "https://www.ebay.co.uk/itm/100000000001", images }));
    expect(capture.imageUrls).toEqual(ids.map((id) => `https://i.ebayimg.com/images/g/${id}/s-l1600.webp`));
    expect(preview.photoCount).toBe(6);
  });
});

describe("history (stored on this device: caseId and createdAt only)", () => {
  const at = (d: number) => new Date(Date.UTC(2026, 10, d)).toISOString();
  const e = (id: string, d: number): HistoryEntry => ({ caseId: id, createdAt: at(d) });
  const summary = (id: string, over: Partial<CaseSummary> = {}): CaseSummary => ({ id, revision: 1, platform: "vinted", pageUrl: null, status: "closed", updatedAt: at(1), ...over });

  it("keeps the newest 50, newest first, one entry per case", () => {
    let list: HistoryEntry[] = [];
    for (let i = 1; i <= 55; i++) list = addEntry(list, e(`case${String(i).padStart(8, "0")}`, (i % 28) + 1));
    expect(list).toHaveLength(HISTORY_LIMIT);
    expect([...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))).toEqual(list);
    expect(addEntry([e("caseaaaaaaaa", 1)], e("caseaaaaaaaa", 2))).toEqual([e("caseaaaaaaaa", 2)]);
    expect(Object.keys(list[0]).sort()).toEqual(["caseId", "createdAt"]);
  });

  it("removes locally, drops cases the server can't find, and migrates the old rich store to ids and dates only", () => {
    const list = [e("caseaaaaaaaa", 3), e("casebbbbbbbb", 2), e("casecccccccc", 1)];
    expect(removeEntry(list, "casebbbbbbbb").map((x) => x.caseId)).toEqual(["caseaaaaaaaa", "casecccccccc"]);
    expect(keepFound(list, [{ id: "casecccccccc" }, { id: "caseaaaaaaaa" }]).map((x) => x.caseId)).toEqual(["caseaaaaaaaa", "casecccccccc"]);
    const legacy = { casedddddddd: { id: "casedddddddd", number: 4, title: "Old", pageUrl: "https://x.test", createdAt: at(5), diffs: {} } };
    expect(normaliseHistory(undefined, legacy)).toEqual([e("casedddddddd", 5)]);
    expect(normaliseHistory([{ caseId: "bad id!", createdAt: at(1) }, { caseId: "caseaaaaaaaa" }])).toEqual([]);
  });

  it("rows come from server summaries; the case for the open listing is found by its URL", () => {
    const list = [e("caseaaaaaaaa", 3), e("casebbbbbbbb", 2)];
    const sums = { casebbbbbbbb: summary("casebbbbbbbb", { pageUrl: "https://www.vinted.co.uk/items/1-x?ref=y" }) };
    expect(historyRows(list, sums).map((r) => r.entry.caseId)).toEqual(["casebbbbbbbb"]);
    expect(caseForUrl(list, sums, "https://www.vinted.co.uk/items/1-x#photos")?.id).toBe("casebbbbbbbb");
    expect(caseForUrl(list, sums, "https://www.vinted.co.uk/items/2-y")).toBeNull();
  });
});

describe("leads followed", () => {
  const lead = { id: "lead_1", type: "deeper_price_comparison" as const, reason: "Price looked low.", status: "done" as const, outcome: "Compared with like new listings: no change." };
  it("hidden when no leads were considered; one line when skipped or none were needed", () => {
    expect(leadsView({ leads: [], leadsReport: { considered: false } })).toBeNull();
    expect(leadsView({ leads: [], leadsReport: { considered: true, skipped: "Skipped: the review search was unavailable." } })).toEqual({ items: [], note: "Skipped: the review search was unavailable." });
    expect(leadsView({ leads: [], leadsReport: { considered: true } })!.note).toBe("Nothing needed following up.");
  });
  it("lists each lead's reason, what was done and the outcome", () => {
    const v = leadsView({ leads: [lead, { ...lead, id: "lead_2", type: "recheck_identification", status: "failed", outcome: undefined }], leadsReport: { considered: true } })!;
    expect(v.items[0]).toEqual({ id: "lead_1", action: "Compared the price more carefully", reason: "Price looked low.", outcome: "Compared with like new listings: no change.", state: "done" });
    expect(v.items[1]).toMatchObject({ action: "Took a second look at the model", outcome: "Couldn't complete this.", state: "problem" });
    expect(v.note).toBeNull();
  });
  it("the log shows leads as they happen, and a skip as one line", () => {
    let s = newInvestigation(1, 0);
    s = applyEvent(s, { name: "check_done", data: { check: "price", status: "warn", summary: "", evidence: [], confidence: 0.5, geminiFeatures: [], details: { position: "suspiciously_low" } }, revision: 1, at: 1 });
    s = applyEvent(s, { name: "lead_started", data: { ...lead, status: "pending", outcome: undefined }, revision: 1, at: 2 });
    expect(s.log.at(-1)).toMatchObject({ text: "Price looked low. Comparing more carefully.", state: "active", kind: "followup" });
    s = applyEvent(s, { name: "lead_done", data: lead, revision: 1, at: 3 });
    expect(s.log.at(-1)).toMatchObject({ state: "done", note: lead.outcome });
    s = applyEvent(s, { name: "leads_skipped", data: { reason: "Skipped: the review search was unavailable." }, revision: 1, at: 4 });
    expect(s.log.at(-1)).toMatchObject({ text: "No follow-ups", note: "the review search was unavailable." });
  });
});

describe("evidence interaction", () => {
  const f = (photoIndex: number, confidence: number, label = "heel_wear" as const) => ({ label, photoIndex, box2d: [100, 100, 300, 300] as [number, number, number, number], severity: "moderate" as const, confidence, note: "n", evidenceId: "e" });
  const check = { check: "condition" as const, status: "warn" as const, summary: "", evidence: [], confidence: 0.7, geminiFeatures: [], details: { findings: [f(2, 0.9), f(0, 0.4), f(2, 0.55)] } };
  const urls = ["https://x.test/0.jpg", "https://x.test/1.jpg", "https://x.test/2.jpg"];

  it("the switcher has every photo; boxes link to their findings; below 0.6 is 'possible'", () => {
    const v = conditionView(check, urls);
    expect(v.photos.map((p) => [p.index, p.boxes.map((b) => b.finding)])).toEqual([[0, [1]], [1, []], [2, [0, 2]]]);
    expect(v.initialPhoto).toBe(2);
    expect(v.findings.map((x) => [x.photoIndex, x.possible, x.caption])).toEqual([[2, false, "Moderate heel wear"], [0, true, "Possible heel wear"], [2, true, "Possible heel wear"]]);
    expect(v.photos[2].boxes.map((b) => b.possible)).toEqual([false, true]);
  });

  it("retailer offers are numbered source chips with links", () => {
    const price = {
      check: "price" as const, status: "pass" as const, summary: "", confidence: 0.7, geminiFeatures: [],
      evidence: [
        { id: "p1", kind: "data_point" as const, label: "New price £89.99", value: 89.99 },
        { id: "p2", kind: "source" as const, label: "Retailer: JD", url: "https://jd.test/p", title: "Pegasus 40", sourceType: "retailer" as const },
        { id: "p3", kind: "source" as const, label: "Retailer: SportsShoes", url: "https://ss.test/p", title: "Pegasus 40", sourceType: "retailer" as const },
      ],
    };
    expect(sourceRefs(price).map((r) => [r.n, r.url])).toEqual([[1, "https://jd.test/p"], [2, "https://ss.test/p"]]);
  });
});
