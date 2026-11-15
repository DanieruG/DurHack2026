// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { checkComfort, comfortFromSnippets, comfortFromSummary, comfortPrompt, comfortResult, mergeResults, type ComfortSummary } from "@/pipeline/checks/comfort";
import { createGeminiClient } from "@/gemini/client";
import { testConfig } from "@/lib/config";
import { problemsQuery, type WebResult } from "@/lib/webSearch";
import { CaseFile } from "@/extension/src/panel/screens/CaseFile";
import { CASE_FILE } from "@/extension/src/preview/fixtures";
import type { UserNeeds } from "@/schemas/domain";
import { COMFORT_RESULTS, fakeWebSearch, fixtureReference, json, promptText } from "./helpers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const noPriorities: UserNeeds = { sizes: [], priorities: [], wearTolerance: "light", extraPriorities: [], assumptions: [] };
const withPriorities: UserNeeds = { ...noPriorities, priorities: ["wide fit"] };

const PROBLEMS = [
  { position: 1, title: "Nike Pegasus 40 problems: heel slip and a narrow toe box", link: "https://www.reddit.com/r/running/pegasus-40-problems", snippet: "My heel slips on every run and the toe box is far too narrow." },
  { position: 2, title: "Pegasus 40 cons | RunRepeat", link: "https://runrepeat.com/nike-pegasus-40", snippet: "Comfortable for long days on your feet. Our testers say it fits true to size." }, // a link the review search also returned
  { position: 3, title: "Nike Pegasus 40 durability complaints", link: "https://www.trustpilot.com/review/pegasus-40", snippet: "The outsole wore through in 200 miles." },
];

const r = (index: number, domain: string): WebResult => ({ index, title: `t${index}`, link: `https://${domain}/${index}`, domain, snippet: `snippet ${index}` });

/** A Gemini that answers the comfort summary with `points`, citing results by index. */
function gemini(points: ComfortSummary["points"], seen: string[] = []) {
  return createGeminiClient({
    config: testConfig(),
    retryBackoffMs: 1,
    transport: async (req) => {
      seen.push(promptText(req));
      return json({ points, sourceTypes: [] });
    },
  });
}
const cite = (...result: number[]) => result.map((n) => ({ result: n, quote: "" }));
const base = { model: { brand: "Nike", name: "Pegasus 40" }, today: "2026-11-14", combinedTools: false, executors: {}, snippets: fixtureReference().reviews };

describe("both searches, one balanced list", () => {
  it("merges the review and problems results: one per link, numbered from 1, interleaved so complaints aren't cut off", () => {
    const merged = mergeResults([[r(1, "a.com"), r(2, "b.com"), r(3, "c.com")], [r(1, "d.com"), r(2, "b.com"), r(3, "e.com")]], 5);
    expect(merged.map((x) => [x.index, x.domain])).toEqual([[1, "a.com"], [2, "d.com"], [3, "b.com"], [4, "c.com"], [5, "e.com"]]);
    expect(mergeResults([[r(1, "a.com")], []]).map((x) => x.index)).toEqual([1]);
  });

  it("runs a search for problems as well as reviews, and gives Gemini both sets of results", async () => {
    const seen: string[] = [];
    const web = fakeWebSearch({ fetch: async (url) => ({ ok: true, status: 200, json: async () => ({ organic_results: new URL(url).searchParams.get("q") === problemsQuery("Nike", "Pegasus 40") ? PROBLEMS : COMFORT_RESULTS }) }) });
    await checkComfort({ ...base, needs: noPriorities, webSearch: web.client, gemini: gemini([], seen) });
    expect(web.requests).toEqual(["Nike Pegasus 40 review comfort", "Nike Pegasus 40 problems complaints cons"]);
    expect(seen[0]).toContain("heel slips on every run");
    expect(seen[0]).toContain("Comfortable for long days");
    expect((seen[0].match(/runrepeat\.com/g) ?? []).length).toBeGreaterThan(0);
    expect(seen[0].match(/^\[\d+\]/gm)).toHaveLength(8); // 6 + 3 results, one shared link
  });

  it("asks for what reviewers dislike as well as like, and says so in the instructions", async () => {
    const { COMFORT_SYSTEM } = await import("@/pipeline/checks/comfort");
    expect(COMFORT_SYSTEM).toMatch(/BOTH what reviewers like and what\s+they dislike/);
    expect(COMFORT_SYSTEM).toMatch(/Never leave out a criticism/);
  });
});

describe("no priorities", () => {
  it("is a balanced overview, not a made-up list of priorities", () => {
    const p = comfortPrompt({ brand: "Nike", name: "Pegasus 40" }, [], [r(1, "runrepeat.com")]);
    expect(p).toContain("none stated: give a balanced overview of what reviewers like and dislike");
    expect(p).not.toMatch(/durability|all-day comfort/);
  });

  it("keeps criticism: a negative point with no priority to hang it on is reported, and the check warns", async () => {
    const web = fakeWebSearch({ fetch: async (url) => ({ ok: true, status: 200, json: async () => ({ organic_results: new URL(url).searchParams.get("q")!.includes("problems") ? PROBLEMS : COMFORT_RESULTS }) }) });
    const res = await checkComfort({
      ...base,
      needs: noPriorities,
      webSearch: web.client,
      gemini: gemini([
        { topic: "cushioning", assessment: "positive", summary: "Testers like the cushioning.", citations: cite(1, 2) },
        { topic: "heel slip", assessment: "negative", summary: "Wearers say the heel slips.", citations: cite(7) },
      ]),
    });
    expect(res.status).toBe("warn");
    expect(res.summary).toContain('Reviews raise concerns for "heel slip".');
    expect(res.summary).toContain('Reviewers also like "cushioning".');
    expect(res.details).toMatchObject({ general: [{ topic: "cushioning", assessment: "positive" }, { topic: "heel slip", assessment: "negative" }], priorities: [] });
    expect(res.evidence.some((e) => e.url?.includes("reddit.com"))).toBe(true);
  });

  it("passes only on praise from independent reviews, and says the search for complaints found none", async () => {
    const web = fakeWebSearch(); // every query returns the same (positive) results
    const res = await checkComfort({
      ...base,
      needs: noPriorities,
      webSearch: web.client,
      gemini: gemini([{ topic: "cushioning", assessment: "positive", summary: "Comfortable.", citations: cite(1, 2) }]),
    });
    expect(res.status).toBe("pass");
    expect(res.summary).toMatch(/independent reviews are positive on "cushioning"\. A search for complaints found none\./);
  });

  it("does not claim that when the problems search failed", async () => {
    const web = fakeWebSearch({ fetch: async (url) => (new URL(url).searchParams.get("q")!.includes("problems") ? { ok: false, status: 403, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ organic_results: COMFORT_RESULTS }) }) });
    const res = await checkComfort({ ...base, needs: noPriorities, webSearch: web.client, gemini: gemini([{ topic: "cushioning", assessment: "positive", summary: "Comfortable.", citations: cite(1, 2) }]) });
    expect(res.status).toBe("pass");
    expect(res.summary).not.toContain("complaints found none");
    expect((res.details as { fallback: boolean }).fallback).toBe(false); // the review search alone was enough
  });

  it("with nothing said about comfort at all it is unknown, worded for no priorities", () => {
    const parsed = comfortFromSummary({ points: [], sourceTypes: [] }, COMFORT_RESULTS.map((x, i) => r(i + 1, `s${i}.com`)), []);
    expect(comfortResult(parsed, { today: "2026-11-14", features: [] }).summary).toBe("I couldn't find reviews that say much about comfort for this model.");
  });

  it("the saved-review fallback reports every concern when there are no priorities", () => {
    const reviews = [
      ...fixtureReference().reviews,
      { modelId: "nike-pegasus-40", text: "Heel slips.", url: "https://www.example-reviews.com/p40", title: "Example", sourceType: "independent_review" as const, topics: ["negative:heel slip"] },
    ];
    expect(comfortFromSnippets(reviews, noPriorities, "2026-11-14")).toMatchObject({ status: "warn", summary: expect.stringContaining("heel slip") });
    expect(comfortFromSnippets(reviews, withPriorities, "2026-11-14").status).toBe("pass"); // a concern outside a stated priority stays out, as before
  });
});

describe("with priorities", () => {
  it("a criticism outside the buyer's priorities is no longer dropped", () => {
    const results = COMFORT_RESULTS.map((x, i) => r(i + 1, i < 2 ? ["runrepeat.com", "runnersworld.com"][i] : `s${i}.com`));
    const summary: ComfortSummary = {
      points: [
        { topic: "wide fit", assessment: "positive", summary: "Roomy.", citations: cite(1, 2) },
        { topic: "heel slip", assessment: "negative", summary: "Heel slips.", citations: cite(4) },
      ],
      sourceTypes: [],
    };
    const parsed = comfortFromSummary(summary, results, ["wide fit"]);
    expect(parsed.priorities.map((p) => p.priority)).toEqual(["wide fit"]);
    expect(parsed.general.map((g) => [g.topic, g.assessment])).toEqual([["heel slip", "negative"]]);
    const res = comfortResult(parsed, { today: "2026-11-14", features: [], hadPriorities: true });
    expect(res.status).toBe("warn");
    expect(res.summary).toContain('"heel slip"');
  });

  it("caps general points so a long rant can't flood the row", () => {
    const results = Array.from({ length: 9 }, (_, i) => r(i + 1, `s${i}.com`));
    const points = Array.from({ length: 9 }, (_, i) => ({ topic: `issue ${i}`, assessment: "negative" as const, summary: "x", citations: cite(i + 1) }));
    expect(comfortFromSummary({ points, sourceTypes: [] }, results, []).general).toHaveLength(6);
  });
});

describe("the comfort row shows both sides", () => {
  it("lists what reviewers criticise and what they like", async () => {
    const comfort = {
      check: "comfort" as const,
      status: "warn" as const,
      summary: 'Reviews raise concerns for "heel slip".',
      evidence: [],
      confidence: 0.65,
      geminiFeatures: [],
      details: {
        reviewSizing: "unclear",
        independentSources: 2,
        fallback: false,
        priorities: [{ priority: "wide fit", assessment: "positive", summary: "Roomy toe box.", evidenceIds: [] }],
        general: [{ topic: "heel slip", assessment: "negative", summary: "Wearers say the heel slips.", evidenceIds: [] }],
      },
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () =>
      root!.render(h(CaseFile, { caseId: CASE_FILE.id, detail: { ...CASE_FILE, checks: CASE_FILE.checks.map((c) => (c.check === "comfort" ? comfort : c)) }, listing: { title: "Nike", priceGBP: 40 }, initialOpen: ["comfort"], addEvidence: { busy: false, error: null, onCaptureTab: async () => null, onSubmit: () => undefined } })),
    );
    const text = host.textContent ?? "";
    expect(text).toContain("Reviewers criticise:");
    expect(text).toContain("heel slip: Wearers say the heel slips.");
    expect(text).toContain("Reviewers like:");
    expect(text).toContain("wide fit: Roomy toe box.");
    expect(text.indexOf("Reviewers criticise:")).toBeLessThan(text.indexOf("Reviewers like:")); // the concerns come first
  });
});
