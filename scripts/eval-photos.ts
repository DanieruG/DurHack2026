/**
 * Eval photos live only on your machine (eval/listings/<case>/photo-NN.*, gitignored). Each case commits photos.json:
 * the stored case they came from and every photo's sha256. This script reads the main database and never writes to it.
 *   npm run eval:photos                                        restore missing photos from the main database
 *   npx tsx scripts/eval-photos.ts --manifest                  (re)write photos.json from the photos now in each folder
 *   npx tsx scripts/eval-photos.ts --remove <case> <file> "<reason>"   drop a photo that isn't the shoes, for good
 */
import "../lib/loadEnv";
import fs from "node:fs";
import path from "node:path";
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import { listingDirs } from "../eval/labels";
import { localPhotos, manifestFromFolder, missingPhotos, readManifest, removePhoto, sha256, writeManifest } from "../eval/photos";

neonConfig.webSocketConstructor = ws;
const ROOT = path.join(process.cwd(), "eval", "listings");
const args = process.argv.slice(2);

/** The main database's stored photos, by sha256 (optionally only some cases). */
async function storedPhotos(caseIds?: string[]): Promise<Map<string, { caseId: string; bytes: Buffer }>> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set: eval photos are restored from the main database");
  const pool = new Pool({ connectionString: url });
  try {
    const where = caseIds ? `and "caseId" = any($1)` : "";
    const { rows } = await pool.query(`select "caseId", data from "CaseInput" where data is not null and kind in ('image', 'screenshot') ${where}`, caseIds ? [caseIds] : []);
    const out = new Map<string, { caseId: string; bytes: Buffer }>();
    for (const r of rows as { caseId: string; data: Buffer }[]) out.set(sha256(r.data), { caseId: r.caseId, bytes: r.data });
    return out;
  } finally {
    await pool.end();
  }
}

async function manifests() {
  const stored = await storedPhotos();
  for (const id of listingDirs(ROOT)) {
    const dir = path.join(ROOT, id);
    const files = localPhotos(dir);
    const cases = new Set(files.map((f) => stored.get(sha256(fs.readFileSync(path.join(dir, f))))?.caseId));
    const caseId = readManifest(dir)?.source.caseId ?? (cases.size === 1 ? [...cases][0] : undefined);
    if (!caseId) {
      console.warn(`${id}: photos don't all come from one stored case (${[...cases].join(", ") || "none found"}); skipped`);
      continue;
    }
    const m = manifestFromFolder(dir, caseId);
    writeManifest(dir, m);
    console.log(`${id}: ${m.photos.length} photos from case ${caseId}${m.removed.length ? `, ${m.removed.length} removed` : ""}`);
  }
}

async function restore() {
  const todo = listingDirs(ROOT)
    .map((id) => ({ id, dir: path.join(ROOT, id), m: readManifest(path.join(ROOT, id)), missing: missingPhotos(path.join(ROOT, id)) }))
    .filter((c) => c.m && c.missing.length);
  if (!todo.length) return console.log("All eval photos are present.");
  const stored = await storedPhotos([...new Set(todo.map((c) => c.m!.source.caseId))]);
  let failed = 0;
  for (const c of todo) {
    for (const file of c.missing) {
      const want = c.m!.photos.find((p) => p.file === file)!;
      const hit = stored.get(want.sha256);
      if (!hit) {
        failed++;
        console.warn(`${c.id}/${file}: not in the main database any more (case ${c.m!.source.caseId})`);
        continue;
      }
      fs.writeFileSync(path.join(c.dir, file), hit.bytes);
    }
    console.log(`${c.id}: restored ${c.missing.length} photo${c.missing.length === 1 ? "" : "s"}`);
  }
  if (failed) process.exitCode = 1;
}

if (args[0] === "--manifest") await manifests();
else if (args[0] === "--remove") {
  const [, id, file, reason] = args;
  if (!id || !file || !reason) throw new Error('usage: --remove <case> <file> "<reason>"');
  const m = removePhoto(path.join(ROOT, id), file, reason);
  console.log(`${id}: removed ${file} (${reason}); ${m.photos.length} photos left`);
} else await restore();
