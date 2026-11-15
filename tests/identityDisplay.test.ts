// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CaseFile } from "@/extension/src/panel/screens/CaseFile";
import { CASE_FILE } from "@/extension/src/preview/fixtures";
import { identifyLabel } from "@/lib/identifyLabel";
import type { CaseDetail } from "@/schemas/api";
import type { CheckResult } from "@/schemas/domain";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});
async function render(detail: CaseDetail) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(h(CaseFile, { caseId: "cm0preview0042", detail, listing: { title: "Nike trainers", priceGBP: 38 }, initialOpen: ["identify", "price"], addEvidence: { busy: false, error: null, onCaptureTab: async () => null, onSubmit: () => undefined } })));
  return host;
}

const withChecks = (patch: (c: CheckResult) => CheckResult): CaseDetail => ({ ...CASE_FILE, checks: CASE_FILE.checks.map(patch) });

describe("identify and price display when the model is a guess", () => {
  it("shows the identify row with 'Could also be' for a possible identification", async () => {
    const el = await render(
      withChecks((c) =>
        c.check === "identify"
          ? { ...c, status: "warn", summary: "Possibly Nike Pegasus 40 or Nike Pegasus 41.", details: { tier: "catalogue", level: "possible", label: "Possibly Nike Pegasus 40 or Nike Pegasus 41", alternatives: [{ brand: "Nike", model: "Pegasus 41", version: null, colourway: null, confidence: 0.4, evidence: [] }] } }
          : c,
      ),
    );
    expect(el.textContent).toContain("Possibly Nike Pegasus 40 or Nike Pegasus 41");
    expect(el.textContent).toContain("Could also be: Nike Pegasus 41");
  });

  it("marks a conditional price as conditional", async () => {
    const el = await render(withChecks((c) => (c.check === "price" ? { ...c, details: { ...(c.details ?? {}), conditional: true } } : c)));
    expect(el.querySelector(".conditional")?.textContent).toMatch(/Conditional\./);
  });

  it("a confirmed identification stays out of the evidence rows", async () => {
    const el = await render(CASE_FILE);
    expect(el.textContent).not.toContain("Could also be");
  });
});

describe("identifyLabel falls back for results stored before levels", () => {
  it("treats a missing level as likely", () => {
    expect(identifyLabel({ brand: "Nike", brandConfidence: 0.9, modelName: "Pegasus 40", catalogueModelId: null, inCatalogue: false, confidence: 0.9, reasons: "", evidence: [] })).toBe("Likely Nike Pegasus 40");
  });
});
