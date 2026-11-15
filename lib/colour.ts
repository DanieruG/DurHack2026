import sharp from "sharp";
import type { Box2d } from "@/schemas/domain";

/**
 * Photo colour analysis in plain TypeScript (no Gemini): the broad colours of the shoe in a photo, after removing the
 * background. Weak evidence only: it never overrides a style code, a specific colour field or colour words in a title.
 * Images from other sites are read here, on the backend, after download (browsers block reading their pixels).
 */

export const BROAD_COLOURS = ["black", "white", "grey", "navy", "blue", "red", "green", "brown", "beige", "pink", "purple", "orange", "yellow"] as const;
export type BroadColour = (typeof BROAD_COLOURS)[number];

export type Lab = [number, number, number];

/** sRGB (0-255) -> CIELAB (D65). */
export function rgbToLab(r: number, g: number, b: number): Lab {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export const deltaE = (p: Lab, q: Lab) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
const chroma = (p: Lab) => Math.hypot(p[1], p[2]);

// Reference colours for the chromatic names (several shades each); achromatic ones are decided by lightness.
const REFERENCES: [BroadColour, [number, number, number]][] = [
  ["navy", [20, 30, 80]], ["navy", [35, 45, 95]],
  ["blue", [40, 90, 200]], ["blue", [100, 150, 220]], ["blue", [60, 120, 170]],
  ["red", [200, 30, 30]], ["red", [140, 20, 30]], ["red", [220, 60, 50]],
  ["green", [40, 140, 60]], ["green", [100, 140, 60]], ["green", [40, 80, 50]], ["green", [150, 190, 90]],
  ["brown", [110, 70, 40]], ["brown", [150, 100, 60]], ["brown", [80, 55, 40]],
  ["beige", [220, 200, 160]], ["beige", [200, 180, 140]], ["beige", [235, 225, 200]],
  ["pink", [240, 150, 180]], ["pink", [220, 100, 150]], ["pink", [245, 190, 200]],
  ["purple", [120, 50, 150]], ["purple", [160, 120, 200]], ["purple", [80, 40, 100]],
  ["orange", [240, 130, 30]], ["orange", [230, 100, 50]],
  ["yellow", [240, 220, 40]], ["yellow", [230, 200, 80]],
];
const REF_LAB = REFERENCES.map(([name, rgb]) => [name, rgbToLab(...rgb)] as const);

/** The nearest broad colour name for a CIELAB colour. Low-chroma colours are black, grey or white by lightness. */
export function colourName(lab: Lab): BroadColour {
  const c = chroma(lab);
  const L = lab[0];
  if (c < 12 || (L < 20 && c < 18)) return L < 22 ? "black" : L > 78 ? "white" : "grey";
  let best: BroadColour = "grey";
  let bestD = Infinity;
  for (const [name, ref] of REF_LAB) {
    const d = deltaE(lab, ref);
    if (d < bestD) {
      bestD = d;
      best = name;
    }
  }
  return best;
}

/** Deterministic k-means on CIELAB points (farthest-point initialisation, fixed iterations). */
export function kMeans(points: Lab[], k: number, iterations = 12): { centre: Lab; size: number }[] {
  if (!points.length) return [];
  k = Math.min(k, points.length);
  const byL = [...points].sort((a, b) => a[0] - b[0]);
  const centres: Lab[] = [byL[Math.floor(byL.length / 2)]];
  while (centres.length < k) {
    let far: Lab = points[0];
    let farD = -1;
    for (const p of points) {
      const d = Math.min(...centres.map((c) => deltaE(p, c)));
      if (d > farD) {
        farD = d;
        far = p;
      }
    }
    if (farD <= 0) break;
    centres.push(far);
  }
  let assign = new Array<number>(points.length).fill(0);
  for (let it = 0; it < iterations; it++) {
    assign = points.map((p) => {
      let bi = 0;
      let bd = Infinity;
      centres.forEach((c, i) => {
        const d = deltaE(p, c);
        if (d < bd) {
          bd = d;
          bi = i;
        }
      });
      return bi;
    });
    for (let i = 0; i < centres.length; i++) {
      const mine = points.filter((_, j) => assign[j] === i);
      if (!mine.length) continue;
      centres[i] = [0, 1, 2].map((d) => mine.reduce((s, p) => s + p[d], 0) / mine.length) as Lab;
    }
  }
  return centres.map((centre, i) => ({ centre, size: assign.filter((a) => a === i).length })).filter((c) => c.size > 0);
}

export type ColourShare = { name: BroadColour; share: number };

export type ColourAnalysis = {
  /** Broad colours of the foreground (the shoe), largest share first; shares sum to about 1. */
  colours: ColourShare[];
  /** No colour covers more than about 40% of the shoe. */
  multi: boolean;
  /** Share of the (cropped, downscaled) image kept as foreground after background removal. */
  foregroundShare: number;
  /** The background's own colour names (from the border), for evidence. */
  background: BroadColour[];
};

const SIZE = 100;
const BACKGROUND_DE = 14;
const MIN_SHARE = 0.08;
export const MULTI_THRESHOLD = 0.4;

/** Box2d [ymin, xmin, ymax, xmax] (0-1000) -> a pixel region of a w x h image, or null when it's too small. */
function cropRegion(box: Box2d, w: number, h: number) {
  const [ymin, xmin, ymax, xmax] = box.map((n) => Math.max(0, Math.min(1000, n)));
  const left = Math.floor((xmin / 1000) * w);
  const top = Math.floor((ymin / 1000) * h);
  const width = Math.ceil(((xmax - xmin) / 1000) * w);
  const height = Math.ceil(((ymax - ymin) / 1000) * h);
  if (width < 8 || height < 8) return null;
  return { left, top, width: Math.min(width, w - left), height: Math.min(height, h - top) };
}

/**
 * The shoe's broad colours: downscale to about 100x100 (optionally cropped to the shoe's box first), estimate the
 * background from the border pixels, drop pixels close to it (and near-white / near-black when the border is mostly
 * that), cluster the rest into up to 4 groups and name each in CIELAB.
 */
export async function analyseColours(bytes: Uint8Array, opts: { crop?: Box2d } = {}): Promise<ColourAnalysis> {
  let img = sharp(bytes, { failOn: "none" }).rotate();
  if (opts.crop) {
    const meta = await sharp(bytes, { failOn: "none" }).rotate().toBuffer({ resolveWithObject: true });
    const region = cropRegion(opts.crop, meta.info.width, meta.info.height);
    if (region) img = sharp(meta.data).extract(region);
  }
  const { data, info } = await img.resize(SIZE, SIZE, { fit: "inside" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels } = info;
  const all: Lab[] = [];
  const border: Lab[] = [];
  const ring = Math.max(2, Math.round(Math.min(w, h) * 0.04));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * channels;
      const lab = rgbToLab(data[i], data[i + 1], data[i + 2]);
      all.push(lab);
      if (x < ring || y < ring || x >= w - ring || y >= h - ring) border.push(lab);
    }
  }
  // Background: the border's main colours (a plain backdrop is one; a floor or a shadow can be two or three).
  const bg = kMeans(border, 3).filter((c) => c.size / border.length >= 0.12);
  const nearWhite = (p: Lab) => p[0] > 88 && chroma(p) < 10;
  const nearBlack = (p: Lab) => p[0] < 15 && chroma(p) < 10;
  const dropWhite = border.filter(nearWhite).length / border.length > 0.5;
  const dropBlack = border.filter(nearBlack).length / border.length > 0.5;
  const isBackground = (p: Lab) => bg.some((c) => deltaE(p, c.centre) < BACKGROUND_DE) || (dropWhite && nearWhite(p)) || (dropBlack && nearBlack(p));
  let fg = all.filter((p) => !isBackground(p));
  // Nothing left (the shoe matches its background, or the crop is all shoe): fall back to every pixel.
  if (fg.length < all.length * 0.03) fg = all;

  const totals = new Map<BroadColour, number>();
  for (const c of kMeans(fg, 4)) {
    const name = colourName(c.centre);
    totals.set(name, (totals.get(name) ?? 0) + c.size);
  }
  const colours = [...totals.entries()]
    .map(([name, n]) => ({ name, share: Math.round((n / fg.length) * 100) / 100 }))
    .filter((c) => c.share >= MIN_SHARE)
    .sort((a, b) => b.share - a.share);
  return {
    colours,
    multi: !colours.length || colours[0].share <= MULTI_THRESHOLD,
    foregroundShare: Math.round((fg.length / all.length) * 100) / 100,
    background: [...new Set(bg.map((c) => colourName(c.centre)))],
  };
}

/** "grey 62%, white 25%" */
export function describeColours(a: Pick<ColourAnalysis, "colours" | "multi">): string {
  const parts = a.colours.slice(0, 3).map((c) => `${c.name} ${Math.round(c.share * 100)}%`);
  return `${parts.join(", ")}${a.multi ? " (multi-coloured)" : ""}`;
}
