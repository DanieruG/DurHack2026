import sharp from "sharp";
import type { Box2d } from "@/schemas/domain";
import { analysePixels, type ColourAnalysis } from "./colourCore";

export * from "./colourCore";

/** Images from other sites are read here, on the backend, after download (browsers block reading their pixels). */
const SIZE = 100;

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
 * The shoe's broad colours: downscale to about 100x100 (optionally cropped to the shoe's box first), then analysePixels
 * (background removal, clustering, naming in CIELAB).
 */
export async function analyseColours(bytes: Uint8Array, opts: { crop?: Box2d } = {}): Promise<ColourAnalysis> {
  let img = sharp(bytes, { failOn: "none" }).rotate();
  if (opts.crop) {
    const meta = await sharp(bytes, { failOn: "none" }).rotate().toBuffer({ resolveWithObject: true });
    const region = cropRegion(opts.crop, meta.info.width, meta.info.height);
    if (region) img = sharp(meta.data).extract(region);
  }
  const { data, info } = await img.resize(SIZE, SIZE, { fit: "inside" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return analysePixels(data, info.width, info.height, info.channels);
}
