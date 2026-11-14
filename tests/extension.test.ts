import { describe, expect, it } from "vitest";
import { prepareCapture, redactPageText, type RawCapture } from "@/extension/src/lib/capture";
import { describeDiff } from "@/extension/src/lib/changes";
import { boxStyle, conditionView, findingCaption, priceView, sourceRefs } from "@/extension/src/lib/evidence";
import { caseNumber, firstSentence, shortDate } from "@/extension/src/lib/format";
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
    expect(caseNumber(42)).toBe("Case 0042");
    expect(shortDate("2026-11-10")).toBe("10 Nov");
    expect(firstSentence("Listed UK 9. Your Nike size.")).toBe("Listed UK 9.");
  });
});
