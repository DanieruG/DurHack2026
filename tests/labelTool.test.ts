// @vitest-environment happy-dom
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { caseView, FORM_OPTIONS, listCases, readPhoto, saveLabel } from "@/eval/label/api";
import { createLabelServer } from "@/eval/label/server";
import { EMPTY_LABEL, LabelSchema } from "@/eval/labels";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a10000000049454e44ae426082", "hex");

let root: string;
function makeCase(id: string, label: object = EMPTY_LABEL, capture: object = { pageUrl: "https://www.ebay.co.uk/itm/1", pageText: "Nike Pegasus 40\nUK 9" }) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "capture.json"), JSON.stringify({ capture, source: { status: "closed", capturedOn: "2026-11-14" } }));
  fs.writeFileSync(path.join(dir, "label.json"), JSON.stringify(label));
  fs.writeFileSync(path.join(dir, "photo-01.png"), PNG);
  fs.writeFileSync(path.join(dir, "photo-02.png"), PNG);
  return dir;
}

const FULL = {
  ...EMPTY_LABEL,
  listingShowsModel: true,
  brand: "Nike",
  model: "Pegasus",
  version: "40",
  styleCode: { value: null, visible: false },
  colourway: ["white", "grey"],
  size: { value: 9, system: "UK" },
  conditionGrade: "good",
  defects: { "1": [{ label: "heel_wear", severity: "minor", box2d: [100, 200, 300, 400] }], "2": [] },
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "label-tool-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("labelling tool: data", () => {
  it("lists every case with what's missing and the defect photo total", () => {
    makeCase("ebay-1");
    makeCase("ebay-2", FULL);
    makeCase("_example");
    const { cases, defectPhotos } = listCases(root);
    expect(cases.map((c) => [c.id, c.complete, c.photos])).toEqual([["ebay-1", false, 2], ["ebay-2", true, 2]]);
    expect(cases[0].missing).toContain("brand");
    expect(cases[1]).toMatchObject({ defectPhotos: 2, defectBoxes: 1 });
    expect(defectPhotos).toEqual({ marked: 2, needed: 10 });
  });

  it("shows only what's on the listing: never offer colours (Sleuth's offers), survey cards or run status", () => {
    makeCase("ebay-1", { ...FULL, offerColours: [{ url: "https://shop.example/a", colourMatch: "same" }] }, { pageUrl: "https://www.ebay.co.uk/itm/1", pageText: "t", observedListings: [{ id: "x" }], listing: { title: { value: "Nike Pegasus 40", source: "structured_data" } } });
    const v = caseView(root, "ebay-1")!;
    expect(Object.keys(v).sort()).toEqual(["id", "label", "listing", "pageText", "pageUrl", "photos"]);
    expect(JSON.stringify(v)).not.toMatch(/offerColours|shop\.example|observedListings|closed/);
    expect(v.listing?.title?.value).toBe("Nike Pegasus 40");
  });

  it("serves only a case's own photo files", () => {
    makeCase("ebay-1");
    expect(readPhoto(root, "ebay-1", "photo-01.png")?.mimeType).toBe("image/png");
    expect(readPhoto(root, "ebay-1", "label.json")).toBeNull();
    expect(readPhoto(root, "ebay-1", "../ebay-1/photo-01.png")).toBeNull();
    expect(readPhoto(root, "..", "photo-01.png")).toBeNull();
  });

  it("validates with the eval schema before writing, and keeps offer colours it never showed", () => {
    const dir = makeCase("ebay-1", { ...EMPTY_LABEL, offerColours: [{ url: "https://shop.example/a", colourMatch: "same" }] });
    const bad = (over: object) => saveLabel(root, "ebay-1", { ...FULL, ...over });
    expect(bad({ defects: { "1": [{ label: "heel_wear", severity: "minor", box2d: [300, 200, 100, 400] }] } })).toMatchObject({ ok: false });
    expect(bad({ defects: { "3": [] } })).toEqual({ ok: false, errors: ["defects.3: this case has photos 1 to 2"] });
    expect(bad({ defects: { "1": [{ label: "scuff", box2d: [1, 2, 3, 4] }] } })).toMatchObject({ ok: false });
    expect(bad({ size: { value: "not_stated", system: "UK" } })).toMatchObject({ ok: false });
    expect(JSON.parse(fs.readFileSync(path.join(dir, "label.json"), "utf8")).brand).toBeNull(); // nothing written

    expect(saveLabel(root, "ebay-1", { ...FULL, size: { value: "not_stated", system: "unknown" }, notes: "odd one" })).toEqual({ ok: true, missing: [], complete: true });
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "label.json"), "utf8"));
    expect(Object.keys(saved)).toEqual([...Object.keys(EMPTY_LABEL), "notes"]);
    expect(saved.offerColours).toEqual([{ url: "https://shop.example/a", colourMatch: "same" }]);
    expect(LabelSchema.parse(saved).defects!["1"][0]).toEqual({ label: "heel_wear", severity: "minor", box2d: [100, 200, 300, 400] });
  });

  it("refuses label writes from another origin", async () => {
    makeCase("ebay-1");
    const server = createLabelServer(root).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const { port } = server.address() as AddressInfo;
    try {
      // node:http, not fetch: happy-dom's fetch applies CORS itself.
      const put = (origin: string) =>
        new Promise<number>((resolve, reject) => {
          const req = http.request({ host: "127.0.0.1", port, path: "/api/cases/ebay-1/label", method: "PUT", headers: { origin, "content-type": "application/json" } }, (res) => {
            res.resume();
            resolve(res.statusCode!);
          });
          req.on("error", reject);
          req.end(JSON.stringify(FULL));
        });
      expect(await put("https://evil.example")).toBe(403);
      expect(await put(`http://127.0.0.1:${port}`)).toBe(200);
    } finally {
      server.close();
    }
  });
});

describe("labelling tool: the page", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const until = async (ok: () => unknown) => {
    for (let i = 0; i < 100 && !ok(); i++) await tick();
    expect(ok()).toBeTruthy();
  };

  it("draws a box, fills the form, and saves a label that passes the schema", async () => {
    const dir = makeCase("ebay-1");
    // The page's fetches, answered by the same functions the server uses.
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (url === "/api/options") return json(200, FORM_OPTIONS);
      if (url === "/api/cases") return json(200, listCases(root));
      const m = url.match(/^\/api\/cases\/([^/]+)(\/label)?$/);
      if (m && !m[2]) return json(200, caseView(root, decodeURIComponent(m[1])));
      if (m && init?.method === "PUT") {
        const r = saveLabel(root, decodeURIComponent(m[1]), JSON.parse(String(init.body)));
        return json(r.ok ? 200 : 400, r);
      }
      return json(404, {});
    }) as typeof fetch;

    const html = fs.readFileSync(path.join(process.cwd(), "eval/label/page.html"), "utf8");
    document.body.innerHTML = html.match(/<body>([\s\S]*)<script>/)![1];
    new Function(html.match(/<script>([\s\S]*)<\/script>/)![1])();
    await until(() => document.querySelector("#list button[data-id]"));
    expect(document.querySelector("header")?.textContent ?? document.querySelector("#progress")!.textContent).toMatch(/0 of 1 cases complete/);
    expect(document.querySelector("#list")!.textContent).toMatch(/missing: listingShowsModel, brand/);

    (document.querySelector("#list button[data-id]") as HTMLElement).click();
    await until(() => document.querySelector("#overlay"));
    expect(document.querySelector("#pageText")!.textContent).toContain("Nike Pegasus 40");

    // Drag a box on a 500x500 photo from (100,50) to (300,250): x 200-600, y 100-500 on the 0-1000 scale.
    const ov = document.querySelector("#overlay") as HTMLElement;
    ov.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 500, right: 500, bottom: 500, x: 0, y: 0, toJSON: () => ({}) });
    (ov as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
    const ev = (type: string, x: number, y: number, target: EventTarget) => target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));
    ev("pointerdown", 100, 50, ov);
    ev("pointermove", 300, 250, document);
    ev("pointerup", 300, 250, document);
    expect(document.querySelector("#boxes")!.textContent).toContain("[100, 200, 500, 600]");
    // Change its type in the list.
    const typeSel = document.querySelector('#boxes select[data-f="label"]') as HTMLSelectElement;
    typeSel.value = "outsole_wear";
    typeSel.dispatchEvent(new Event("change", { bubbles: true }));
    // Photo 2: checked, no defects.
    (document.querySelector("#next") as HTMLElement).click();
    (document.querySelector("#noDefects") as HTMLElement).click();

    const form = document.querySelector("#form") as HTMLFormElement;
    const set = (name: string, value: string) => {
      const el = form.elements.namedItem(name) as HTMLInputElement;
      el.value = value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    set("listingShowsModel", "true");
    set("brand", "Nike");
    set("model", "Pegasus");
    set("version", "40");
    set("styleMode", "not_visible");
    set("sizeMode", "single");
    set("sizeValue", "9");
    set("sizeSystem", "UK");
    set("conditionGrade", "like_new");
    set("expectedVerdict", "worth_a_look");
    (document.querySelector('#colours button[data-c="white"]') as HTMLElement).click();
    (document.querySelector('#colours button[data-c="grey"]') as HTMLElement).click();

    (document.querySelector("#save") as HTMLElement).click();
    await until(() => /Saved/.test(document.querySelector("#status")!.textContent ?? ""));
    expect(document.querySelector("#status")!.textContent).toBe("Saved ✓ case complete");
    expect(LabelSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, "label.json"), "utf8")))).toMatchObject({
      listingShowsModel: true,
      brand: "Nike",
      model: "Pegasus",
      version: "40",
      styleCode: { value: null, visible: false },
      colourway: ["white", "grey"],
      size: { value: 9, system: "UK" },
      conditionGrade: "like_new",
      expectedVerdict: "worth_a_look",
      defects: { "1": [{ label: "outsole_wear", severity: "minor", box2d: [100, 200, 500, 600] }], "2": [] },
    });

    // A vague listing: never "refuse"; the labeller gives the real model, or "unknown" after looking it up.
    expect(form.textContent).not.toMatch(/refuse/i);
    set("listingShowsModel", "false");
    const unknown = form.elements.namedItem("modelUnknown") as HTMLInputElement;
    unknown.checked = true;
    unknown.dispatchEvent(new Event("change", { bubbles: true }));
    expect((form.elements.namedItem("version") as HTMLInputElement).disabled).toBe(true);
    expect(document.querySelector("#missing")!.textContent).toBe("All required fields filled.");
    (document.querySelector("#save") as HTMLElement).click();
    await until(() => JSON.parse(fs.readFileSync(path.join(dir, "label.json"), "utf8")).model === "unknown");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "label.json"), "utf8"))).toMatchObject({ listingShowsModel: false, model: "unknown", version: "unknown" });
  });
});
