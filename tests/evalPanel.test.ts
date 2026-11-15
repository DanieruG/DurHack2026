// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Accuracy } from "@/extension/src/panel/screens/Accuracy";
import { ProfileScreen } from "@/extension/src/panel/screens/Profile";
import { CaseFile } from "@/extension/src/panel/screens/CaseFile";
import { CASE_FILE } from "@/extension/src/preview/fixtures";
import { summarise } from "@/eval/metrics";
import { EMPTY_LABEL } from "@/eval/labels";
import type { CaseRun } from "@/eval/collect";
import type { PublicEvalSummary } from "@/schemas/eval";

vi.mock("@/lib/evalSummary", () => ({ loadPublicEvalSummary: vi.fn(async () => null) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});
async function render(el: ReturnType<typeof h>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(el));
  return host;
}

const runs: CaseRun[] = Array.from({ length: 12 }, (_, i) => ({
  id: `c${i}`,
  label: { ...EMPTY_LABEL, identifiable: true, brand: "Nike", model: "Pegasus", version: "40", size: { value: 9, system: "UK" } },
  tier: "catalogue",
  brand: "Nike",
  modelName: i < 10 ? "Pegasus 40" : "Vomero 17",
  styleCode: null,
  colours: null,
  size: { text: "UK 9", system: "UK", options: null },
  findings: [],
  offers: [],
  verdict: null,
  durationMs: 40_000 + i * 1000,
  geminiCalls: 8,
  structured: [],
}));
const { failures: _f, ...SUMMARY } = summarise(runs, { runAt: "2026-11-15T10:00:00.000Z", pipelineVersion: "3", models: { fast: "f", strong: "s" }, cacheMode: "off" });
const PUBLIC: PublicEvalSummary = SUMMARY;

describe("How accurate is Sleuth? (panel)", () => {
  it("shows the five headline figures with sample sizes, the test date and the honest line", async () => {
    const el = await render(h(Accuracy, { load: async () => PUBLIC }));
    const rows = [...el.querySelectorAll(".accuracy-row")].map((r) => `${r.querySelector("dt")!.textContent}: ${r.querySelector("dd")!.textContent}`);
    expect(rows).toEqual([
      "Model identified correctly: 10 of 12 (83%)",
      "Marked defects found: not measured yet (0 labelled)",
      "Reported defects that weren't marked (false alarms): not measured yet (0 labelled)",
      "Listed size read as labelled: 12 of 12 (100%)",
      "Time per case: median 45.5 s, slowest 51.0 s (12 cases)",
    ]);
    expect(el.textContent).toContain("Tested on 12 real listings we labelled by hand. Small sample; results will vary.");
    expect(el.textContent).toContain("Tested 15 Nov 2026.");
  });

  it("says so when there are no results yet, or the server can't be reached", async () => {
    expect((await render(h(Accuracy, { load: async () => null }))).textContent).toContain("No test results yet.");
    act(() => root?.unmount());
    expect((await render(h(Accuracy, { load: async () => Promise.reject(new Error("Can't reach the Sleuth server. Is it running?")) }))).textContent).toContain("Can't reach the Sleuth server");
  });

  it("is linked from the Profile tab and the bottom of the case file", async () => {
    const onAccuracy = vi.fn();
    let el = await render(h(ProfileScreen, { profile: null, apiBase: "http://localhost:3000", firstRun: true, onSave: vi.fn(), onAccuracy }));
    const link = (e: HTMLElement) => [...e.querySelectorAll("button")].find((b) => b.textContent === "How accurate is Sleuth?")!;
    act(() => link(el).click());
    expect(onAccuracy).toHaveBeenCalledTimes(1);
    act(() => root?.unmount());
    el = await render(
      h(CaseFile, {
        caseId: CASE_FILE.id,
        detail: CASE_FILE,
        listing: { title: "Nike Pegasus 40", priceGBP: 42 },
        addEvidence: { busy: false, error: null, onCaptureTab: async () => null, onSubmit: () => undefined },
        onAccuracy,
      }),
    );
    const screen = el.querySelector(".screen")!;
    expect(screen.lastElementChild).toBe(link(el)); // at the bottom
    act(() => link(el).click());
    expect(onAccuracy).toHaveBeenCalledTimes(2);
  });
});

describe("GET /api/eval/summary", () => {
  it("404 before any eval run; the public summary after", async () => {
    const { setDeps } = await import("@/pipeline/deps");
    const { makeDeps } = await import("./helpers");
    const { loadPublicEvalSummary } = await import("@/lib/evalSummary");
    const route = await import("@/app/api/eval/summary/route");
    setDeps(makeDeps());
    const get = () => route.GET(new Request("http://localhost:3000/api/eval/summary", { headers: { origin: "chrome-extension://testextensionid" } }));
    expect((await get()).status).toBe(404);
    vi.mocked(loadPublicEvalSummary).mockResolvedValueOnce(PUBLIC);
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(JSON.parse(JSON.stringify(PUBLIC)));
    setDeps(null);
  });
});
