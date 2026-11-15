import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Eval photos are kept out of git (they're sellers' photos). Each case folder commits photos.json instead: which stored
 * case the photos came from and each photo's sha256, so `npm run eval:photos` can restore the exact bytes from the main
 * database, plus photos removed on purpose (not the shoes) so neither a restore nor a re-export brings them back.
 */

export const PhotoManifestSchema = z.object({
  source: z.object({ caseId: z.string().min(1), database: z.literal("main") }),
  photos: z.array(z.object({ file: z.string().regex(/^photo-\d{2}\.(jpg|png|webp)$/), sha256: z.string().regex(/^[0-9a-f]{64}$/) })),
  removed: z.array(z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), was: z.string(), reason: z.string().min(1) })).default([]),
});
export type PhotoManifest = z.infer<typeof PhotoManifestSchema>;

export const MANIFEST = "photos.json";
const PHOTO = /^photo-(\d+)\.(jpe?g|png|webp)$/i;

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function localPhotos(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => PHOTO.test(f)).sort() : [];
}

export function readManifest(dir: string): PhotoManifest | null {
  const p = path.join(dir, MANIFEST);
  return fs.existsSync(p) ? PhotoManifestSchema.parse(JSON.parse(fs.readFileSync(p, "utf8"))) : null;
}

export function writeManifest(dir: string, m: PhotoManifest): void {
  fs.writeFileSync(path.join(dir, MANIFEST), `${JSON.stringify(PhotoManifestSchema.parse(m), null, 2)}\n`);
}

/** The manifest for the photos now in the folder (keeping what was removed before). */
export function manifestFromFolder(dir: string, caseId: string): PhotoManifest {
  const removed = readManifest(dir)?.removed ?? [];
  return { source: { caseId, database: "main" }, photos: localPhotos(dir).map((file) => ({ file, sha256: sha256(fs.readFileSync(path.join(dir, file))) })), removed };
}

/** Photos the manifest lists that are missing locally or differ (need `npm run eval:photos`). */
export function missingPhotos(dir: string): string[] {
  const m = readManifest(dir);
  if (!m) return [];
  return m.photos.filter((p) => !fs.existsSync(path.join(dir, p.file)) || sha256(fs.readFileSync(path.join(dir, p.file))) !== p.sha256).map((p) => p.file);
}

/**
 * Remove one photo on purpose: delete it, record its hash and reason, and renumber the photos after it so they stay
 * consecutive; hand-marked defects on later photos move with them (label.json keys are photo numbers).
 */
export function removePhoto(dir: string, file: string, reason: string): PhotoManifest {
  const m = readManifest(dir);
  if (!m) throw new Error(`${dir} has no ${MANIFEST}: run scripts/eval-photos.ts --manifest first`);
  const entry = m.photos.find((p) => p.file === file);
  if (!entry) throw new Error(`${file} isn't in ${path.basename(dir)}/${MANIFEST}`);
  const n = Number(file.match(PHOTO)![1]);
  const labelPath = path.join(dir, "label.json");
  const label = fs.existsSync(labelPath) ? JSON.parse(fs.readFileSync(labelPath, "utf8")) : null;
  if (label?.defects?.[String(n)]?.length) throw new Error(`${file} has hand-marked defects in label.json; remove them first`);

  fs.rmSync(path.join(dir, file), { force: true });
  const photos: PhotoManifest["photos"] = [];
  for (const p of m.photos) {
    const k = Number(p.file.match(PHOTO)![1]);
    if (k === n) continue;
    if (k < n) {
      photos.push(p);
      continue;
    }
    const next = p.file.replace(PHOTO, (_, _d, ext) => `photo-${String(k - 1).padStart(2, "0")}.${ext}`);
    if (fs.existsSync(path.join(dir, p.file))) fs.renameSync(path.join(dir, p.file), path.join(dir, next));
    photos.push({ ...p, file: next });
  }
  if (label?.defects) {
    const shifted: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(label.defects)) {
      const i = Number(k);
      if (i === n) continue;
      shifted[String(i > n ? i - 1 : i)] = v;
    }
    label.defects = Object.keys(shifted).length ? shifted : null;
    fs.writeFileSync(labelPath, `${JSON.stringify(label, null, 2)}\n`);
  }
  const out = { ...m, photos, removed: [...m.removed, { sha256: entry.sha256, was: file, reason }] };
  writeManifest(dir, out);
  return out;
}
