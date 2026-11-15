import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { analyseColours, colourName, describeColours, rgbToLab } from "@/lib/colour";

const fixture = (f: string) => new Uint8Array(fs.readFileSync(path.join(__dirname, "fixtures", "colour", f)));

/** A w x h PNG painted by `paint(x, y)`. */
async function image(w: number, h: number, paint: (x: number, y: number) => [number, number, number]): Promise<Uint8Array> {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(paint(x, y), (y * w + x) * 3);
  return new Uint8Array(await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer());
}
const inEllipse = (x: number, y: number, w: number, h: number) => ((x - w / 2) / (w * 0.35)) ** 2 + ((y - h / 2) / (h * 0.25)) ** 2 <= 1;

describe("colour names in CIELAB", () => {
  it.each([
    [[15, 15, 15], "black"],
    [[250, 250, 250], "white"],
    [[128, 128, 130], "grey"],
    [[25, 35, 85], "navy"],
    [[40, 90, 200], "blue"],
    [[200, 30, 30], "red"],
    [[40, 140, 60], "green"],
    [[120, 75, 40], "brown"],
    [[220, 200, 160], "beige"],
    [[240, 150, 180], "pink"],
    [[120, 50, 150], "purple"],
    [[240, 130, 30], "orange"],
    [[240, 220, 40], "yellow"],
  ] as [[number, number, number], string][])("%j is %s", (rgb, name) => {
    expect(colourName(rgbToLab(...rgb))).toBe(name);
  });
});

describe("photo colour analysis", () => {
  it("removes a plain light backdrop and finds the grey shoe", async () => {
    const png = await image(200, 160, (x, y) => (inEllipse(x, y, 200, 160) ? [120, 122, 125] : [224, 221, 217])); // #E0DDD9 backdrop
    const a = await analyseColours(png);
    expect(a.colours[0]).toMatchObject({ name: "grey" });
    expect(a.colours.map((c) => c.name)).not.toContain("beige");
    expect(a.foregroundShare).toBeLessThan(0.4);
    expect(a.multi).toBe(false);
  });

  it("drops near-white pixels when the border is mostly white (product shots)", async () => {
    const png = await image(200, 160, (x, y) => (inEllipse(x, y, 200, 160) ? (y < 80 ? [200, 30, 30] : [30, 30, 30]) : [255, 255, 255]));
    const a = await analyseColours(png);
    expect(a.colours.map((c) => c.name).sort()).toEqual(["black", "red"]);
    expect(a.background).toEqual(["white"]);
  });

  it("reports multi when no colour covers more than about 40%", async () => {
    const bands: [number, number, number][] = [[200, 30, 30], [40, 90, 200], [40, 140, 60]];
    // Three equal bands inside a white margin.
    const png = await image(210, 160, (x, y) => (x >= 15 && x < 195 && y >= 20 && y < 140 ? bands[Math.min(2, Math.floor((x - 15) / 60))] : [255, 255, 255]));
    const a = await analyseColours(png);
    expect(a.multi).toBe(true);
    expect(a.colours.map((c) => c.name).sort()).toEqual(["blue", "green", "red"]);
    expect(describeColours(a)).toMatch(/\(multi-coloured\)$/);
  });

  it("analyses only the crop box when one is given", async () => {
    const png = await image(200, 100, (x) => (x < 100 ? [200, 30, 30] : [40, 90, 200]));
    const a = await analyseColours(png, { crop: [0, 550, 1000, 1000] });
    expect(a.colours[0].name).toBe("blue");
  });

  it("fixture: Vinted's grey P6000 on a wooden floor reads as grey", async () => {
    const a = await analyseColours(fixture("vinted-p6000-main.jpg"));
    expect(a.colours[0]).toMatchObject({ name: "grey" });
    expect(a.colours[0].share).toBeGreaterThan(0.6);
    expect(a.foregroundShare).toBeLessThan(0.4); // the floor is removed
    expect(a.background).toContain("beige");
  });

  it("fixture: eBay's black and white Revolution 6 product shot reads as black with white", async () => {
    const a = await analyseColours(fixture("ebay-revolution6-main.jpg"));
    expect(a.colours[0]).toMatchObject({ name: "black" });
    expect(a.colours.map((c) => c.name)).toContain("white");
    expect(a.background).toEqual(["white"]);
  });
});
