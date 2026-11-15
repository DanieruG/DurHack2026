// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { IdentityChoice } from "@/schemas/api";
import type { CaseSummary } from "@/schemas/domain";
import { IdentityCard } from "@/extension/src/panel/screens/IdentityCard";
import { Investigating } from "@/extension/src/panel/screens/Investigating";
import { History } from "@/extension/src/panel/screens/History";
import { CaseFile } from "@/extension/src/panel/screens/CaseFile";
import { CASE_FILE } from "@/extension/src/preview/fixtures";
import { applyEvent, newInvestigation, type IdentityCheck } from "@/extension/src/lib/progress";
import type { IdentityQuestion } from "@/extension/src/lib/identity";

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

const question: IdentityQuestion = {
  headline: "Possibly Nike Air Max 95 Essential or OG",
  bestGuess: { brand: "Nike", model: "Air Max 95", version: "Essential", colourway: null, label: "Nike Air Max 95 Essential", confidence: 0.6, evidence: ['Title: "Air Max 95"'] },
  alternatives: [
    { brand: "Nike", model: "Air Max 95", version: "OG", colourway: null, label: "Nike Air Max 95 OG", confidence: 0.3, evidence: [] },
    { brand: "Nike", model: "Air Max 97", version: null, colourway: null, label: "Nike Air Max 97", confidence: 0.2, evidence: ["Similar sole"] },
  ],
};
const needed: IdentityCheck = { level: "possible", ...question, lensMatches: [], waiting: ["price", "comfort"] };
const click = (el: Element) => act(() => (el as HTMLElement).click());
const radios = (el: HTMLElement) => [...el.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
const button = (el: HTMLElement, text: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;

describe("the identity card", () => {
  it("shows the confidence wording, the best guess, each alternative as a real radio with its own label, and the one-liner", async () => {
    const el = await render(h(IdentityCard, { question, onConfirm: vi.fn() }));
    expect(el.querySelector("h2")?.textContent).toBe("Is this the right item?");
    expect(el.textContent).toContain("Possibly Nike Air Max 95 Essential or OG");
    expect(el.textContent).toContain("I'm not sure which version this is. Confirming helps me search for the right prices.");
    const rs = radios(el);
    expect(rs).toHaveLength(4); // best guess, two alternatives, something else
    for (const r of rs) expect(el.querySelector(`label[for="${r.id}"]`), r.value).not.toBeNull();
    expect(el.querySelector('label[for="' + rs[1].id + '"]')?.textContent).toContain("Nike Air Max 95 OG");
    expect(rs[0].checked).toBe(true);
    expect(el.querySelector("fieldset legend")).not.toBeNull();
    expect(el.textContent).toContain("60% sure");
  });

  it("moves focus to the card and announces that Sleuth needs input", async () => {
    const el = await render(h(IdentityCard, { question, onConfirm: vi.fn() }));
    expect(document.activeElement).toBe(el.querySelector("h2"));
    expect(el.querySelector('[role="status"]')?.textContent).toMatch(/Sleuth needs your input/);
  });

  it("Continue sends the selected option; Skip is quieter and sends skip", async () => {
    const onConfirm = vi.fn<(c: IdentityChoice) => void>();
    const el = await render(h(IdentityCard, { question, onConfirm }));
    click(button(el, "Continue")!);
    expect(onConfirm).toHaveBeenLastCalledWith({ choice: "best_guess" });
    click(radios(el)[2]);
    click(button(el, "Continue")!);
    expect(onConfirm).toHaveBeenLastCalledWith({ choice: "alternative", index: 1 });
    expect(button(el, "Skip")!.className).toContain("btn-text");
    click(button(el, "Skip")!);
    expect(onConfirm).toHaveBeenLastCalledWith({ choice: "skip" });
  });

  it("Something else asks for brand, model and version, and needs brand and model", async () => {
    const onConfirm = vi.fn<(c: IdentityChoice) => void>();
    const el = await render(h(IdentityCard, { question, onConfirm }));
    expect(el.querySelector('input[type="text"], input.input')).toBeNull();
    click(radios(el)[3]);
    const fields = [...el.querySelectorAll<HTMLInputElement>("input.input")];
    expect(fields.map((f) => el.querySelector(`label[for="${f.id}"]`)?.textContent?.trim())).toEqual(["Brand", "Model", "Version (optional)"]);
    expect(fields[0].value).toBe("Nike"); // prefilled from the best guess
    expect(button(el, "Continue")!.disabled).toBe(true); // no model yet
    const setValue = (f: HTMLInputElement, v: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(f, v);
        f.dispatchEvent(new Event("input", { bubbles: true }));
      });
    setValue(fields[1], "Air Max 90");
    setValue(fields[2], "OG");
    expect(button(el, "Continue")!.disabled).toBe(false);
    click(button(el, "Continue")!);
    expect(onConfirm).toHaveBeenCalledWith({ choice: "custom", brand: "Nike", model: "Air Max 90", version: "OG" });
  });

  it("once answered it locks in place and says what Sleuth is continuing with", async () => {
    const el = await render(h(IdentityCard, { question, onConfirm: vi.fn(), answered: { choice: "alternative", index: 0 } }));
    expect(radios(el).every((r) => r.disabled)).toBe(true);
    expect(button(el, "Continue")).toBeUndefined();
    expect(el.textContent).toContain("Continuing with Nike Air Max 95 OG…");
    expect(el.querySelector('[role="status"]')?.textContent).toMatch(/continuing/);
  });

  it("correcting a finished case has no Skip, but a Cancel", async () => {
    const onCancel = vi.fn();
    const el = await render(h(IdentityCard, { question, onConfirm: vi.fn(), correcting: true, onCancel }));
    expect(button(el, "Skip")).toBeUndefined();
    click(button(el, "Cancel")!);
    expect(onCancel).toHaveBeenCalled();
  });
});

describe("in the investigation view", () => {
  const inv = applyEvent(newInvestigation(1, 0), { name: "identity_check_needed", data: needed, revision: 1, at: 1 });

  it("shows the card, and Condition and Fit keep appearing below it while waiting", async () => {
    const withChecks = applyEvent(
      applyEvent(inv, { name: "check_done", data: { check: "fit", status: "pass", summary: "UK 9 fits", evidence: [], confidence: 0.9, geminiFeatures: [], details: { match: "exact" } }, revision: 1, at: 2 }),
      { name: "check_done", data: { check: "condition", status: "pass", summary: "ok", evidence: [], confidence: 0.8, geminiFeatures: ["vision"], details: { findings: [] } }, revision: 1, at: 3 },
    );
    const el = await render(h(Investigating, { caseId: "cm0preview0042", title: "Nike trainers", inv: withChecks, onConfirm: vi.fn() }));
    const card = el.querySelector(".identity-card")!;
    const log = el.querySelector("ol.log")!;
    expect(card).not.toBeNull();
    expect(card.compareDocumentPosition(log) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // the results are below the card
    expect(log.textContent).toContain("Size checked");
    expect(log.textContent).toContain("Photos inspected");
  });

  it("after the answer the card stays, locked, even once the server has recorded the choice", async () => {
    const answeredInv = applyEvent(inv, {
      name: "check_done",
      data: { check: "identify", status: "pass", summary: "You confirmed this as the Nike Air Max 95 Essential.", evidence: [], confidence: 1, geminiFeatures: [], details: { tier: "model", level: "user_confirmed", label: "Nike Air Max 95 Essential (confirmed by you)", userChoice: "best_guess" } },
      revision: 1,
      at: 5,
    });
    expect(answeredInv.identityCheck).toBeNull(); // the reducer closes the question...
    // ...but the view that showed the card remembers it, so the locked card stays and nothing below moves.
    const wrapper = document.createElement("div");
    document.body.appendChild(wrapper);
    root = createRoot(wrapper);
    host = wrapper;
    await act(async () => root!.render(h(Investigating, { caseId: "c", title: "t", inv, onConfirm: vi.fn() })));
    await act(async () => root!.render(h(Investigating, { caseId: "c", title: "t", inv: answeredInv, onConfirm: vi.fn(), answered: { choice: "best_guess" } })));
    expect(wrapper.querySelector(".identity-card")?.textContent).toContain("Continuing with Nike Air Max 95 Essential…");
  });

  it("History says 'Waiting for you' for a paused case, and it can be opened", async () => {
    const summary: CaseSummary = { id: "cm0paused0001", revision: 1, title: "Nike trainers", platform: "vinted", pageUrl: null, status: "awaiting_confirmation", updatedAt: "2026-11-14T12:00:00.000Z" };
    const onOpen = vi.fn();
    const el = await render(h(History, { rows: [{ entry: { caseId: "cm0paused0001", createdAt: "2026-11-14T12:00:00.000Z" }, summary }], loading: false, error: null, onOpen, onRemove: vi.fn() }));
    expect(el.querySelector(".stamp")?.textContent).toBe("Waiting for you");
    click(el.querySelector("button.h-open")!);
    expect(onOpen).toHaveBeenCalledWith("cm0paused0001");
  });
});

describe("'Not right?' on a finished case", () => {
  const detail = { ...CASE_FILE, identify: { brand: "Nike", brandConfidence: 0.9, modelName: "Pegasus 40", catalogueModelId: "nike-pegasus-40", inCatalogue: true, confidence: 0.9, reasons: "", evidence: [], confidenceLevel: "likely" as const, alternatives: [{ brand: "Nike", model: "Pegasus 41", version: null, colourway: null, confidence: 0.3, evidence: [] }] } };
  const props = { caseId: CASE_FILE.id, listing: { title: "Nike Pegasus 40", priceGBP: 42 }, addEvidence: { busy: false, error: null, onCaptureTab: async () => null, onSubmit: () => undefined } };

  it("opens the card with the stored candidates and sends the correction", async () => {
    const onCorrect = vi.fn<(c: IdentityChoice) => void>();
    const el = await render(h(CaseFile, { ...props, detail, onCorrect }));
    expect(el.querySelector(".identity-line")?.textContent).toContain("Likely Nike Pegasus 40");
    click(button(el, "Not right?")!);
    expect(el.querySelector(".identity-card")).not.toBeNull();
    click(radios(el)[1]);
    click(button(el, "Continue")!);
    expect(onCorrect).toHaveBeenCalledWith({ choice: "alternative", index: 0 });
  });

  it("isn't offered when there is no handler or nothing was identified", async () => {
    const none = await render(h(CaseFile, { ...props, detail }));
    expect(button(none, "Not right?")).toBeUndefined();
  });
});
