import type { ImageMime } from "./safeFetch";

export const MAX_EDGE_PX = 2000;

export type StoredImage = { bytes: Uint8Array; mimeType: ImageMime };

/** Downscale images over ~2000 px on the long edge (spec 7.1 step 5). Falls back to the original on any error. */
export async function downscaleImage(img: StoredImage, maxEdge = MAX_EDGE_PX): Promise<StoredImage> {
  try {
    const sharp = (await import("sharp")).default;
    const pipeline = sharp(img.bytes, { failOn: "none" }).rotate();
    const meta = await pipeline.metadata();
    const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
    if (!longEdge || longEdge <= maxEdge) return img;
    const resized = pipeline.resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true });
    const out =
      img.mimeType === "image/png"
        ? await resized.png().toBuffer()
        : img.mimeType === "image/webp"
          ? await resized.webp({ quality: 85 }).toBuffer()
          : await resized.jpeg({ quality: 85 }).toBuffer();
    return { bytes: new Uint8Array(out), mimeType: img.mimeType };
  } catch {
    return img;
  }
}

export function sniffImageMime(bytes: Uint8Array): ImageMime | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return "image/webp";
  return null;
}
