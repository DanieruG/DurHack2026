import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { BroadColourSchema, ConditionGradeSchema, DefectLabelSchema, SeveritySchema, VerdictLabelSchema, type ListingData } from "../../schemas/domain";
import { defectPhotoCount, EMPTY_LABEL, LabelSchema, listingDirs, MIN_DEFECT_PHOTOS, missingFields, type Label } from "../labels";

/**
 * The labelling tool's data layer (npm run label). It reads only what a person would see on the listing: the page
 * text, the extension's structured fields and the photos (capture.json, photo-NN.*), and the case's own label.json.
 * It never reads Sleuth's output (eval/report.md, eval/summary.json, the database), and it hides label fields that
 * would reveal it: offerColours names the offers Sleuth found, so it's kept on save but never shown.
 */

const PHOTO = /^photo-\d+\.(jpe?g|png|webp)$/i;
const MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

export function photoFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((f) => PHOTO.test(f)).sort();
}

/** Label fields the tool may show and edit. */
export type EditableLabel = Omit<Label, "offerColours">;

function readLabel(dir: string): { label: Label; error?: string } {
  try {
    return { label: LabelSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, "label.json"), "utf8"))) };
  } catch (err) {
    return { label: EMPTY_LABEL, error: err instanceof Error ? err.message.split("\n")[0] : String(err) };
  }
}

const editable = ({ offerColours: _hidden, ...rest }: Label): EditableLabel => rest;

export type CaseListItem = { id: string; photos: number; missing: string[]; defectPhotos: number; defectBoxes: number; complete: boolean; error?: string };

export function listCases(root: string): { cases: CaseListItem[]; defectPhotos: { marked: number; needed: number } } {
  const cases = listingDirs(root).map((id) => {
    const dir = path.join(root, id);
    const { label, error } = readLabel(dir);
    const missing = error ? ["label.json doesn't parse"] : missingFields(label);
    const defectBoxes = Object.values(label.defects ?? {}).reduce((n, b) => n + b.length, 0);
    return { id, photos: photoFiles(dir).length, missing, defectPhotos: defectPhotoCount(label), defectBoxes, complete: !error && missing.length === 0, ...(error ? { error } : {}) };
  });
  return { cases, defectPhotos: { marked: cases.reduce((n, c) => n + c.defectPhotos, 0), needed: MIN_DEFECT_PHOTOS } };
}

const CaptureFile = z.object({
  capture: z.object({ pageUrl: z.string().optional(), pageText: z.string().optional(), listing: z.unknown().optional() }).passthrough(),
});

/** Everything the page shows for one case. Deliberately no survey cards, source status, or anything from a run. */
export type CaseView = { id: string; pageUrl: string | null; pageText: string; listing: ListingData | null; photos: string[]; label: EditableLabel; labelError?: string };

export function caseView(root: string, id: string): CaseView | null {
  if (!listingDirs(root).includes(id)) return null;
  const dir = path.join(root, id);
  const file = CaptureFile.safeParse(JSON.parse(fs.readFileSync(path.join(dir, "capture.json"), "utf8")));
  const cap = file.success ? file.data.capture : {};
  const { label, error } = readLabel(dir);
  return {
    id,
    pageUrl: cap.pageUrl ?? null,
    pageText: cap.pageText ?? "",
    listing: (cap.listing as ListingData | undefined) ?? null,
    photos: photoFiles(dir),
    label: editable(label),
    ...(error ? { labelError: error } : {}),
  };
}

/** A photo's bytes, only for a known case and one of its photo-NN files. */
export function readPhoto(root: string, id: string, file: string): { bytes: Buffer; mimeType: string } | null {
  if (!listingDirs(root).includes(id) || !photoFiles(path.join(root, id)).includes(file)) return null;
  return { bytes: fs.readFileSync(path.join(root, id, file)), mimeType: MIME[file.split(".").pop()!.toLowerCase()] };
}

export type SaveResult = { ok: true; missing: string[]; complete: boolean } | { ok: false; errors: string[] };

/** Validate with the eval schema (plus: defects only on photos this case has) and write label.json. */
export function saveLabel(root: string, id: string, body: unknown): SaveResult {
  if (!listingDirs(root).includes(id)) return { ok: false, errors: [`No case ${id}`] };
  const dir = path.join(root, id);
  // offerColours is never shown, so keep whatever the file has.
  const kept = readLabel(dir).label.offerColours;
  const input = body && typeof body === "object" ? { ...(body as object), offerColours: kept } : body;
  const parsed = LabelSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "label"}: ${i.message}`) };
  const photos = photoFiles(dir).length;
  const bad = Object.keys(parsed.data.defects ?? {}).filter((k) => Number(k) < 1 || Number(k) > photos);
  if (bad.length) return { ok: false, errors: bad.map((k) => `defects.${k}: this case has photos 1 to ${photos}`) };
  // Same key order as an empty label, so diffs stay readable.
  const ordered = Object.fromEntries(Object.keys(EMPTY_LABEL).map((k) => [k, parsed.data[k as keyof Label]]));
  if (parsed.data.notes) ordered.notes = parsed.data.notes;
  fs.writeFileSync(path.join(dir, "label.json"), `${JSON.stringify(ordered, null, 2)}\n`);
  const missing = missingFields(parsed.data);
  return { ok: true, missing, complete: missing.length === 0 };
}

/** The choices the form offers, from the same schemas the eval validates with. */
export const FORM_OPTIONS = {
  defectLabels: DefectLabelSchema.options,
  severities: SeveritySchema.options,
  colours: BroadColourSchema.options,
  conditionGrades: ConditionGradeSchema.options,
  verdicts: VerdictLabelSchema.options,
  sizeSystems: ["UK", "US", "EU", "unknown"] as const,
};
