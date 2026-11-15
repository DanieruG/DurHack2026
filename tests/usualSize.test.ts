// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { checkFit } from "@/pipeline/checks/fit";
import { buildNeeds } from "@/pipeline/needs";
import { userSizeUK } from "@/lib/observed";
import { savedSizeFor } from "@/lib/userSize";
import { ProfileScreen } from "@/extension/src/panel/screens/Profile";
import { relevantSizes } from "@/extension/src/panel/screens/CaseReady";
import { ProfileSchema, type ListingFacts, type Profile, type UserNeeds } from "@/schemas/domain";
import { fixtureReference } from "./helpers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ref = fixtureReference();
const nikeChart = ref.sizeCharts.find((c) => c.id === "nike-mens")!;
const facts = (sizeText: string): ListingFacts => ({ platform: "vinted", photoCount: 1, conditionClaims: [], sizeText, sizeSystem: "UK", evidence: [] });
const needs = (over: Partial<UserNeeds>): UserNeeds => ({ sizes: [], priorities: [], wearTolerance: "light", extraPriorities: [], assumptions: [], ...over });
const fit = (n: UserNeeds, size = "UK 9") => checkFit({ facts: facts(size), needs: n, brand: "Nike", chart: nikeChart, charts: ref.sizeCharts });

describe("usual size (not tied to a brand)", () => {
  it("is used for a brand without its own saved size", () => {
    const r = fit(needs({ defaultSize: { size: 9, system: "UK" } }));
    expect(r.status).toBe("pass");
    expect(r.summary).toBe("Listed UK 9 matches your usual size.");
    expect(r.evidence.map((e) => e.label)).toContain("Your usual size: UK 9");
    expect(r.details).toMatchObject({ match: "exact", userSize: "UK 9 (usual size)", userSizeSource: "usual" });
    // A usual size may not carry across brands exactly: a little less confident than a size saved for Nike.
    expect(r.confidence).toBeLessThan(fit(needs({ sizes: [{ brand: "Nike", size: 9, system: "UK" }] })).confidence);
  });

  it("a size saved for the brand wins over the usual size", () => {
    const r = fit(needs({ sizes: [{ brand: "Nike", size: 10, system: "UK" }], defaultSize: { size: 9, system: "UK" } }));
    expect(r.status).toBe("fail");
    expect(r.details).toMatchObject({ userSizeSource: "brand" });
    expect(r.summary).toMatch(/than your Nike size\.$/);
  });

  it("is used before a cross-brand estimate from another brand's size", () => {
    const n = needs({ sizes: [{ brand: "Adidas", size: 11, system: "UK" }], defaultSize: { size: 9, system: "UK" } });
    expect(fit(n).details).toMatchObject({ userSizeSource: "usual", match: "exact" });
    expect(fit(needs({ sizes: [{ brand: "Adidas", size: 9.5, system: "UK" }] })).details).toMatchObject({ userSizeSource: "other_brand" });
  });

  it("converts across systems on the brand's chart", () => {
    expect(fit(needs({ defaultSize: { size: 10, system: "US" } })).status).toBe("pass");
    expect(userSizeUK(needs({ defaultSize: { size: 10, system: "US" } }), "Nike", nikeChart, ref.sizeCharts)).toBe(9);
    // No brand and no chart: only a UK usual size can be used as it is.
    expect(userSizeUK(needs({ defaultSize: { size: 9, system: "UK" } }), null, undefined, ref.sizeCharts)).toBe(9);
    expect(userSizeUK(needs({ defaultSize: { size: 10, system: "US" } }), null, undefined, ref.sizeCharts)).toBeNull();
  });

  it("savedSizeFor: brand first, then the usual size, else nothing", () => {
    const n = needs({ sizes: [{ brand: "Nike", size: 10, system: "UK" }], defaultSize: { size: 9, system: "EU" } });
    expect(savedSizeFor(n, "nike ")).toEqual({ brand: "Nike", size: 10, system: "UK" });
    expect(savedSizeFor(n, "Adidas")).toEqual({ brand: null, size: 9, system: "EU" });
    expect(savedSizeFor(needs({}), "Adidas")).toBeNull();
  });

  it("buildNeeds carries it through, recording an assumed UK system", async () => {
    const n = await buildNeeds(ProfileSchema.parse({ defaultSize: { size: 8 } }), undefined, null);
    expect(n.defaultSize).toEqual({ size: 8, system: "UK" });
    expect(n.assumptions).toContain("Size system not stated for your usual size 8; assumed UK");
    expect((await buildNeeds(ProfileSchema.parse({ sizes: [{ brand: "Nike", size: 9, system: "UK" }] }), undefined, null)).defaultSize).toBeUndefined();
  });

  it("the Investigate screen shows the brand's size if saved, else the usual size", () => {
    const p: Profile = { defaultSize: { size: 9, system: "UK" }, sizes: [{ brand: "Adidas", size: 9.5, system: "UK" }], priorities: [], wearTolerance: "light" };
    expect(relevantSizes(p, "Adidas Samba OG")).toBe("Adidas UK 9.5");
    expect(relevantSizes(p, "Nike Pegasus 40")).toBe("Usual UK 9");
    expect(relevantSizes({ ...p, defaultSize: undefined }, "Nike Pegasus 40")).toBe("Adidas UK 9.5");
  });
});

// ---------- the Profile screen ----------

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(profile: Profile | null, onSave = vi.fn()) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(h(ProfileScreen, { profile, apiBase: "http://localhost:3000", firstRun: !profile, onSave })));
  return { el: host, onSave };
}

/** Set a controlled input's value the way React notices. */
function type(input: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}
const byLabel = <T extends HTMLElement>(el: HTMLElement, label: string) => el.querySelector<T>(`[aria-label="${label}"]`)!;
const button = (el: HTMLElement, text: string) => [...el.querySelectorAll("button")].find((b) => b.textContent === text)!;

describe("Profile screen sizes", () => {
  it("saves a usual size on its own, with no brand", async () => {
    const { el, onSave } = render(null);
    expect(el.querySelectorAll('[aria-label="Brand"]')).toHaveLength(0); // no brand row until one is added
    act(() => type(byLabel<HTMLSelectElement>(el, "Usual size system"), "EU"));
    act(() => type(byLabel<HTMLInputElement>(el, "Usual size"), "43"));
    await act(async () => button(el, "Save").click());
    expect(onSave.mock.calls[0][0]).toMatchObject({ defaultSize: { size: 43, system: "EU" }, sizes: [] });
  });

  it("adds sizes for different brands alongside the usual size", async () => {
    const { el, onSave } = render(null);
    act(() => type(byLabel<HTMLInputElement>(el, "Usual size"), "9"));
    act(() => button(el, "Add a brand size").click());
    act(() => button(el, "Add a brand size").click());
    const brands = el.querySelectorAll<HTMLInputElement>('[aria-label="Brand"]');
    const sizes = el.querySelectorAll<HTMLInputElement>('[aria-label="Size"]');
    act(() => type(brands[0], "Adidas"));
    act(() => type(sizes[0], "9.5"));
    act(() => type(brands[1], "New Balance"));
    act(() => type(sizes[1], "8.5"));
    await act(async () => button(el, "Save").click());
    expect(onSave.mock.calls[0][0]).toMatchObject({
      defaultSize: { size: 9, system: "UK" },
      sizes: [
        { brand: "Adidas", size: 9.5, system: "UK" },
        { brand: "New Balance", size: 8.5, system: "UK" },
      ],
    });
  });

  it("needs a usual size or a brand size before saving", async () => {
    const { el, onSave } = render(null);
    await act(async () => button(el, "Save").click());
    expect(onSave).not.toHaveBeenCalled();
    expect(el.textContent).toContain("Add your usual size, or a size for a brand.");
  });

  it("loads a saved usual size and brand sizes", () => {
    const { el } = render({ defaultSize: { size: 10, system: "US" }, sizes: [{ brand: "Nike", size: 9, system: "UK" }], priorities: [], wearTolerance: "light" });
    expect(byLabel<HTMLInputElement>(el, "Usual size").value).toBe("10");
    expect(byLabel<HTMLSelectElement>(el, "Usual size system").value).toBe("US");
    expect(byLabel<HTMLInputElement>(el, "Brand").value).toBe("Nike");
  });
});
