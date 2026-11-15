import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manifestFromFolder, missingPhotos, readManifest, removePhoto, sha256, writeManifest } from "@/eval/photos";
import { EMPTY_LABEL } from "@/eval/labels";

let dir: string;
const bytes = (n: number) => new Uint8Array([n, n, n]);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "evalphotos-"));
  for (const n of [1, 2, 3]) fs.writeFileSync(path.join(dir, `photo-0${n}.webp`), bytes(n));
  fs.writeFileSync(path.join(dir, "label.json"), JSON.stringify({ ...EMPTY_LABEL, defects: { "1": [], "3": [{ label: "heel_wear", box2d: [1, 1, 9, 9] }] } }));
  writeManifest(dir, manifestFromFolder(dir, "case-1"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("eval photo manifest", () => {
  it("records the source case and each photo's hash", () => {
    expect(readManifest(dir)).toEqual({
      source: { caseId: "case-1", database: "main" },
      photos: [1, 2, 3].map((n) => ({ file: `photo-0${n}.webp`, sha256: sha256(bytes(n)) })),
      removed: [],
    });
  });

  it("notices photos that are missing or changed (so the eval won't run without them)", () => {
    expect(missingPhotos(dir)).toEqual([]);
    fs.rmSync(path.join(dir, "photo-02.webp"));
    fs.writeFileSync(path.join(dir, "photo-03.webp"), bytes(9));
    expect(missingPhotos(dir)).toEqual(["photo-02.webp", "photo-03.webp"]);
  });

  it("removing a photo renumbers the later ones, moves their defect labels, and remembers the removal", () => {
    const m = removePhoto(dir, "photo-02.webp", "a dog");
    expect(fs.readdirSync(dir).filter((f) => f.startsWith("photo-")).sort()).toEqual(["photo-01.webp", "photo-02.webp"]);
    expect(fs.readFileSync(path.join(dir, "photo-02.webp"))).toEqual(Buffer.from(bytes(3)));
    expect(m.photos.map((p) => p.file)).toEqual(["photo-01.webp", "photo-02.webp"]);
    expect(m.removed).toEqual([{ sha256: sha256(bytes(2)), was: "photo-02.webp", reason: "a dog" }]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "label.json"), "utf8")).defects).toEqual({ "1": [], "2": [{ label: "heel_wear", box2d: [1, 1, 9, 9] }] });
    // A later re-manifest keeps the removal.
    expect(manifestFromFolder(dir, "case-1").removed).toHaveLength(1);
  });

  it("won't remove a photo that has hand-marked defects", () => {
    expect(() => removePhoto(dir, "photo-03.webp", "x")).toThrow(/hand-marked defects/);
  });
});
