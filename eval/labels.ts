import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { BroadColourSchema, ConditionGradeSchema, DefectLabelSchema, SeveritySchema, VerdictLabelSchema } from "../schemas/domain";

/**
 * label.json: what a person found by looking at the listing (photos and text), written before running the pipeline.
 * null means "not labelled yet" and the case is left out of that metric. Never fill a label from Sleuth's output.
 * How to label: eval/LABELLING.md.
 */

const Box = z
  .tuple([z.number().min(0).max(1000), z.number().min(0).max(1000), z.number().min(0).max(1000), z.number().min(0).max(1000)])
  .refine(([ymin, xmin, ymax, xmax]) => ymin < ymax && xmin < xmax, "box must be [ymin, xmin, ymax, xmax] with ymin < ymax and xmin < xmax");

/** One hand-marked defect. Severity is optional so older labels still parse; the labelling tool always sets it. */
export const LabelDefectSchema = z.object({ label: DefectLabelSchema, box2d: Box, severity: SeveritySchema.optional() });

export const LabelSchema = z.object({
  /**
   * Does the listing itself (title, item details, a readable style code, the photos) settle the exact model and
   * version? true: Sleuth should reach "confirmed" or "likely" and carry on. false: Sleuth still names its best guess
   * ("possible" or "best guess") and, outside the eval, asks the user to confirm it. Sleuth never refuses to guess.
   */
  listingShowsModel: z.boolean().nullable().default(null),
  brand: z.string().min(1).nullable().default(null),
  /**
   * What the pair really is, model name without the version: "Pegasus", "Air Max", "Samba OG", "P-6000". Work it out
   * by any means when the listing doesn't say (style code lookup, the brand's site, a reverse image search): Sleuth's
   * best guess is scored against it. UNKNOWN only when you still can't tell; that leaves the case out of model accuracy.
   */
  model: z.string().min(1).nullable().default(null),
  /** "40", "95", "7"; "none" when the model has no versions; UNKNOWN when you can't tell which version it is. */
  version: z.string().min(1).nullable().default(null),
  /** The style code when known ("FV6603-101", "JP9997"), and whether it can be read in the listing's photos or text. */
  styleCode: z.object({ value: z.string().min(1).nullable(), visible: z.boolean() }).nullable().default(null),
  /** Broad colours of the shoe, main colour first. */
  colourway: z.array(BroadColourSchema).min(1).nullable().default(null),
  /**
   * The size as the listing states it. "multiple": a multi-size listing; "not_stated": the listing gives no size (system
   * "unknown"). System "unknown" when the listing doesn't say which system.
   */
  size: z
    .object({ value: z.union([z.number().positive(), z.literal("multiple"), z.literal("not_stated")]), system: z.enum(["UK", "US", "EU", "unknown"]) })
    .refine((s) => s.value !== "not_stated" || s.system === "unknown", "a size that isn't stated has system \"unknown\"")
    .nullable()
    .default(null),
  conditionGrade: ConditionGradeSchema.nullable().default(null),
  /**
   * Hand-marked defects, by photo number (photo-01 is "1"). Only photos you checked appear; [] means checked, no
   * defects. Boxes are [ymin, xmin, ymax, xmax] on a 0-1000 scale.
   */
  defects: z.record(z.string().regex(/^\d+$/), z.array(LabelDefectSchema)).nullable().default(null),
  /** Optional: new-price offers whose colour you checked by eye against the listing, matched by URL. */
  offerColours: z.array(z.object({ url: z.string().url(), colourMatch: z.enum(["same", "different"]) })).nullable().default(null),
  /** Optional: the verdict you'd expect. */
  expectedVerdict: VerdictLabelSchema.nullable().default(null),
  notes: z.string().optional(),
});
export type Label = z.infer<typeof LabelSchema>;

export const EMPTY_LABEL: Label = LabelSchema.parse({});

/** Fields every case needs (offer colours and the expected verdict are optional; defects are counted across the set). */
/** model/version value for "I can't tell what it is, even after looking it up" (not the same as null: not labelled yet). */
export const UNKNOWN = "unknown";
/** A model or version that a prediction can be scored against. */
export const isKnown = (s: string | null): s is string => !!s && s.trim().toLowerCase() !== UNKNOWN;

export const REQUIRED_FIELDS = ["listingShowsModel", "brand", "model", "version", "styleCode", "colourway", "size", "conditionGrade"] as const;
/** Hand-marked defect boxes are needed on at least this many photos across the whole set. */
export const MIN_DEFECT_PHOTOS = 10;

/** Required fields still empty. Every case needs a model and version, even if it's UNKNOWN (no version needed then). */
export function missingFields(l: Label): string[] {
  return REQUIRED_FIELDS.filter((f) => l[f] === null && !(f === "version" && l.model !== null && !isKnown(l.model)));
}

export const defectPhotoCount = (l: Label) => (l.defects ? Object.keys(l.defects).length : 0);

export type CaseLabels = { id: string; label: Label; photos: number; error?: string };

export function listingDirs(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((d) => !d.startsWith("_") && fs.statSync(path.join(dir, d)).isDirectory()).sort() : [];
}

export function readLabels(dir: string): CaseLabels[] {
  return listingDirs(dir).map((id) => {
    const photos = fs.readdirSync(path.join(dir, id)).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).length;
    try {
      return { id, photos, label: LabelSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, id, "label.json"), "utf8"))) };
    } catch (err) {
      return { id, photos, label: EMPTY_LABEL, error: err instanceof Error ? err.message.split("\n")[0] : String(err) };
    }
  });
}

/** The "Cases with missing labels" section of LABELLING.md. */
export function missingLabelsMarkdown(cases: CaseLabels[]): string {
  const marked = cases.reduce((n, c) => n + defectPhotoCount(c.label), 0);
  const lines = [
    `Defect boxes: marked on ${marked} of the ${MIN_DEFECT_PHOTOS} photos needed${marked >= MIN_DEFECT_PHOTOS ? " (done)" : ""}.`,
    "",
    "| Case | Photos | Missing | Defect photos marked |",
    "| --- | --- | --- | --- |",
  ];
  for (const c of cases) {
    const missing = c.error ? `label.json doesn't parse: ${c.error}` : missingFields(c.label).join(", ") || "none";
    lines.push(`| ${c.id} | ${c.photos} | ${missing} | ${defectPhotoCount(c.label)} |`);
  }
  return lines.join("\n");
}

const START = "<!-- missing-labels:start -->";
const END = "<!-- missing-labels:end -->";

/** Rewrite the list between the markers in LABELLING.md (npm run eval:labels). */
export function updateLabellingDoc(docPath: string, cases: CaseLabels[]): void {
  const doc = fs.readFileSync(docPath, "utf8");
  const a = doc.indexOf(START);
  const b = doc.indexOf(END);
  if (a < 0 || b < a) throw new Error(`${docPath} has no ${START} ... ${END} section`);
  fs.writeFileSync(docPath, `${doc.slice(0, a + START.length)}\n${missingLabelsMarkdown(cases)}\n${doc.slice(b)}`);
}
