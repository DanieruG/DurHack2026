import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { summarise } from "@/eval/metrics";
import { EMPTY_LABEL, type Label } from "@/eval/labels";
import { runCase, type CaseRun } from "@/eval/collect";
import { baselineRun } from "@/eval/baseline";
import { createCase } from "@/pipeline";
import { startConfirm } from "@/pipeline/confirm";
import { ResponseCache } from "@/lib/cache";
import { checksFrom, eventNames, json, makeDeps, PAGE_TEXT, PROFILE, type Handler } from "./helpers";
import type { Figure } from "@/schemas/eval";

const META = { runAt: "2026-11-15T10:00:00.000Z", pipelineVersion: "3", models: { fast: "flash-x", strong: "pro-x" }, cacheMode: "off" };
const label = (over: Partial<Label> = {}): Label => ({ ...EMPTY_LABEL, brand: "Nike", model: "Pegasus", version: "40", listingShowsModel: false, ...over });
const run = (id: string, over: Partial<CaseRun> = {}): CaseRun => ({
  id,
  label: label(),
  tier: "catalogue",
  brand: "Nike",
  modelName: "Pegasus 40",
  level: "likely",
  alternatives: [],
  wouldHavePaused: false,
  styleCode: null,
  colours: null,
  size: { text: null, system: null, options: null },
  findings: [],
  offers: [],
  verdict: null,
  durationMs: 1000,
  geminiCalls: 4,
  structured: [],
  ...over,
});
const fig = (runs: CaseRun[], id: string): Figure => {
  const s = summarise(runs, META);
  return s.sections.flatMap((x) => x.figures).find((f) => f.id === id)!.figure;
};
const frac = (runs: CaseRun[], id: string) => {
  const f = fig(runs, id);
  if (f.kind !== "fraction") throw new Error("not a fraction");
  return `${f.n}/${f.d}`;
};

describe("identification scoring with alternatives", () => {
  const wrongFirst = run("a", { modelName: "Vomero 17", alternatives: ["Pegasus 40", "Invincible 3"], level: "possible" });
  const right = run("b");
  const brandOnly = run("c", { tier: "brand", modelName: null, alternatives: [], level: "best_guess" });
  const nothing = run("d", { tier: "none", brand: null, modelName: null, level: "best_guess" });

  it("top 1 is the best guess; top 3 also counts the alternatives; brand only counts as wrong for both", () => {
    const runs = [wrongFirst, right, brandOnly, nothing];
    expect(frac(runs, "modelIdentification")).toBe("1/4");
    expect(frac(runs, "top3Identification")).toBe("2/4");
  });

  it("a baseline has one answer: top 3 equals top 1, and level, pause and Lens figures are not applicable (no cases)", () => {
    const b = baselineRun("x", label(), { answer: { brand: "Nike", model: "Pegasus", version: "40", styleCode: null, colours: [], size: { kind: "none" }, defects: [], recommendation: "buy", reason: "" } as never, durationMs: 1, calls: 1 }, 3);
    expect(frac([b], "modelIdentification")).toBe("1/1");
    expect(frac([b], "top3Identification")).toBe("1/1");
    expect(frac([b], "wouldHavePaused")).toBe("0/0");
    expect(frac([b], "levelLikely")).toBe("0/0");
    expect(frac([b], "lensRan")).toBe("0/0");
  });
});

describe("accuracy by confidence level", () => {
  it("counts correct answers per level, with n and d", () => {
    const runs = [
      run("1", { level: "confirmed" }),
      run("2", { level: "likely" }),
      run("3", { level: "likely", modelName: "Vomero 17" }),
      run("4", { level: "possible", modelName: "Vomero 17" }),
      run("5", { level: "best_guess", tier: "brand", modelName: null }),
    ];
    expect(frac(runs, "levelConfirmed")).toBe("1/1");
    expect(frac(runs, "levelLikely")).toBe("1/2");
    expect(frac(runs, "levelPossible")).toBe("0/1");
    expect(frac(runs, "levelBestGuess")).toBe("0/1");
    expect(frac(runs, "confidentWrong")).toBe("1/3"); // one wrong of the three confirmed/likely
    expect(frac(runs, "levelInversions")).toBe("0/6");
  });

  it("reports when a lower level is right more often than a higher one", () => {
    const runs = [
      run("1", { level: "likely", modelName: "Vomero 17" }), // likely: 0 of 1
      run("2", { level: "possible" }), // possible: 1 of 1
    ];
    expect(frac(runs, "levelInversions")).toBe("1/1");
  });
});

describe("pauses and Lens", () => {
  it("records how many cases would have paused, and how often Lens ran and changed the answer", () => {
    const runs = [
      run("1", { level: "possible", wouldHavePaused: true, lens: { ran: true, changedAnswer: true } }),
      run("2", { level: "best_guess", wouldHavePaused: true, lens: { ran: true, changedAnswer: false }, modelName: "Vomero 17" }),
      run("3", { lens: { ran: false, changedAnswer: false } }),
      run("4", { lens: { ran: false, changedAnswer: false } }),
    ];
    expect(frac(runs, "wouldHavePaused")).toBe("2/4");
    expect(frac(runs, "lensRan")).toBe("2/4");
    expect(frac(runs, "lensChanged")).toBe("1/2");
    expect(frac(runs, "lensCorrect")).toBe("1/2");
  });
});

describe("the eval never pauses", () => {
  const vague: Handler = () => json({ catalogueModelId: "nike-pegasus-40", confidence: 0.55, reasons: "maybe", evidence: [], alternatives: [{ modelName: "Pegasus 41", confidence: 0.4 }] });

  it("carries on with the best guess, finishes, and records that the app would have paused", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evalcase-"));
    fs.writeFileSync(path.join(dir, "capture.json"), JSON.stringify({ capture: { pageUrl: "https://www.vinted.co.uk/items/123-nike", pageText: PAGE_TEXT, imageUrls: [] } }));
    const deps = makeDeps({ handlers: { identify: vague }, shopping: {} });
    const r = await runCase(deps, dir, "vinted-123", label());
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ level: "possible", wouldHavePaused: true, alternatives: ["Pegasus 41"], tier: "catalogue", modelName: "Pegasus 40" });
    expect(r.verdict).toBeTruthy(); // it reached a verdict: nothing waited for a buyer
  });

  it("a likely identification would not have paused", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evalcase-"));
    fs.writeFileSync(path.join(dir, "capture.json"), JSON.stringify({ capture: { pageUrl: "https://www.vinted.co.uk/items/123-nike", pageText: PAGE_TEXT, imageUrls: [] } }));
    const r = await runCase(makeDeps(), dir, "vinted-123", label());
    expect(r).toMatchObject({ wouldHavePaused: false, lens: { ran: false } });
  });
});

describe("cache replay reproduces the pause and the recorded answer", () => {
  const vague: Handler = () => json({ catalogueModelId: "nike-pegasus-40", confidence: 0.55, reasons: "maybe", evidence: [], alternatives: [{ modelName: "Pegasus 41", confidence: 0.4 }] });
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "identity-cache-"));
  const capture = { pageText: PAGE_TEXT, imageUrls: ["https://img.example.com/1.jpg"] };
  const start = async (cache: ResponseCache) => {
    const deps = makeDeps({ handlers: { identify: vague }, cache });
    const { caseId, done } = await createCase(deps, { capture, profile: PROFILE, screenshots: [] });
    await done;
    return { deps, caseId };
  };

  it("record: the buyer's answer is saved; replay: the same listing shows the pause, then applies it, with no human", async () => {
    const d = dir();
    const live = await start(new ResponseCache("record", null, d));
    expect((await live.deps.store.getCase(live.caseId))!.status).toBe("awaiting_confirmation");
    await (await startConfirm(live.deps, live.caseId, { choice: "alternative", index: 0 }))!.done;
    expect((await live.deps.store.getCase(live.caseId))!.identify).toMatchObject({ catalogueModelId: "nike-pegasus-41" });

    const replayed = await start(new ResponseCache("replay", null, d)); // a new process: nothing in memory
    const names = eventNames(replayed.deps.hub.events(replayed.caseId));
    expect(names).toContain("identity_check_needed"); // the pause is shown...
    expect(names.indexOf("identity_check_needed")).toBeLessThan(names.lastIndexOf("check_done"));
    const c = (await replayed.deps.store.getCase(replayed.caseId))!;
    expect(c.status).toBe("closed"); // ...then resolved by the recorded answer
    expect(c.identify).toMatchObject({ confidenceLevel: "user_confirmed", catalogueModelId: "nike-pegasus-41", userChoice: { choice: "alternative" } });
    expect(checksFrom(replayed.deps.hub.events(replayed.caseId)).identify.details).toMatchObject({ userChoice: "alternative" });
  });

  it("replay with nothing recorded waits for the buyer, like a live case", async () => {
    const waiting = await start(new ResponseCache("replay", null, dir()));
    expect((await waiting.deps.store.getCase(waiting.caseId))!.status).toBe("awaiting_confirmation");
  });

  it("off or record mode never applies an answer by itself", async () => {
    const d = dir();
    const first = await start(new ResponseCache("record", null, d));
    await (await startConfirm(first.deps, first.caseId, { choice: "best_guess" }))!.done;
    const again = await start(new ResponseCache("record", null, d));
    expect((await again.deps.store.getCase(again.caseId))!.status).toBe("awaiting_confirmation");
    const off = await start(new ResponseCache("off", null, d));
    expect((await off.deps.store.getCase(off.caseId))!.status).toBe("awaiting_confirmation");
  });
});
