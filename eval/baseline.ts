import { z } from "zod";
import { BroadColourSchema, VerdictLabelSchema, type Box2d, type ListingData, type Profile } from "../schemas/domain";
import { generateStructured } from "../gemini/structured";
import { imagePart, type GeminiClient, type Part } from "../gemini/client";
import { LABEL_MEANING } from "../pipeline/verdict/wording";
import { tokenise } from "../lib/titleMatch";
import type { StoredImage } from "../lib/images";
import { structuredGroups, type CaseRun } from "./collect";
import type { Label } from "./labels";

/**
 * The baseline Sleuth is compared against (npm run eval:baseline): what a person gets by pasting the listing into a
 * chatbot. One Gemini call per case on GEMINI_MODEL_FAST, with a single plain prompt, the page text and the photos:
 * no system prompt, no tools, no search, no catalogue, no rules. Its answer comes back as structured output with the
 * same fields Sleuth reports, then goes through the same scoring code (eval/metrics.ts) against the same labels.
 */

export const BASELINE_PROMPT =
  "Here’s a second-hand listing. What exact shoe is this (brand, model, version, colour)? What size and size system? Describe any visible defects and where they are, with bounding boxes. Would you recommend buying it?";

/** The buyer, as Sleuth's eval profile gives it to Sleuth: a person asking a chatbot would say the same. */
export function buyerLine(p: Profile): string {
  const size = p.defaultSize ? `My usual size is ${p.defaultSize.system ?? "UK"} ${p.defaultSize.size}` : "";
  const wants = p.priorities.length ? `I care about ${p.priorities.join(", ")}` : "";
  const wear = { none: "I don't want any wear", light: "light wear is fine", moderate: "moderate wear is fine", any: "any wear is fine" }[p.wearTolerance];
  return `About me: ${[size, wants, wear].filter(Boolean).join("; ")}.`;
}

/** The answer's fields: the same ones Sleuth's output is scored on. Descriptions say what each field is, nothing more. */
export const BaselineAnswerSchema = z.object({
  brand: z.string().nullable().describe("The shoe's brand, or null if you can't tell."),
  model: z.string().nullable().describe("The model name without its version, or null if you can't tell."),
  version: z.string().nullable().describe('The model\'s version, "none" if the model has no versions, or null if you can\'t tell.'),
  styleCode: z.string().nullable().describe("The manufacturer's style code if you can read it in the text or photos, otherwise null."),
  colours: z.array(BroadColourSchema).describe("The shoe's broad colours, main colour first."),
  size: z.object({
    kind: z.enum(["single", "multiple", "not_stated"]).describe("One size, several sizes on offer, or no size given."),
    value: z.string().nullable().describe("The size, for one size."),
    system: z.enum(["UK", "US", "EU", "unknown"]).describe("The size system, or unknown if the listing doesn't say."),
  }),
  defects: z
    .array(
      z.object({
        photo: z.number().int().min(1).describe("Photo number (Photo 1 is the first)."),
        description: z.string().describe("What the defect is and where on the shoe."),
        box_2d: z.array(z.number()).min(4).max(4).describe("[ymin, xmin, ymax, xmax] normalised to 0-1000 on that photo."),
      }),
    )
    .describe("Visible defects, one entry per defect; empty if none."),
  recommendation: VerdictLabelSchema.describe(`Your recommendation, as one of: ${VerdictLabelSchema.options.map((l) => `${l} (${LABEL_MEANING[l]})`).join("; ")}.`),
  reason: z.string().describe("Why, in a sentence or two."),
});
export type BaselineAnswer = z.infer<typeof BaselineAnswerSchema>;

/** Listing fields from the page's own data, as plain lines (only when the case captured them; Sleuth gets them too). */
function listingLines(l: ListingData | undefined): string {
  if (!l) return "";
  const lines: string[] = [];
  for (const [k, v] of Object.entries(l)) {
    if (v && typeof v === "object" && "value" in v) lines.push(`${k}: ${(v as { value: unknown }).value}`);
  }
  for (const s of l.itemSpecifics ?? []) lines.push(`${s.label}: ${s.value}`);
  if (l.sizeOptions) lines.push(`${l.sizeOptions.label}: ${l.sizeOptions.options.map((o) => o.value + (o.outOfStock ? " (out of stock)" : "")).join(", ")}`);
  return lines.length ? `\n\nListing details:\n${lines.join("\n")}` : "";
}

export function baselineParts(args: { pageText: string; images: StoredImage[]; profile: Profile; listing?: ListingData }): Part[] {
  const parts: Part[] = [{ text: `${BASELINE_PROMPT}\n${buyerLine(args.profile)}\n\nListing:\n${args.pageText || "(no text)"}${listingLines(args.listing)}` }];
  args.images.forEach((img, i) => parts.push({ text: `Photo ${i + 1}:` }, imagePart(img)));
  return parts;
}

/** One case: the call, timed and with its calls counted (a malformed answer gets the same single retry Sleuth's calls get). */
export async function askBaseline(gemini: GeminiClient, args: Parameters<typeof baselineParts>[0]) {
  let calls = 0;
  const counting: GeminiClient = { generate: (req) => (calls++, gemini.generate(req)) };
  const started = Date.now();
  try {
    const { data } = await generateStructured(counting, BaselineAnswerSchema, { stage: "baseline", tier: "fast", parts: baselineParts(args) });
    return { answer: data, durationMs: Date.now() - started, calls };
  } catch (err) {
    return { answer: null, durationMs: Date.now() - started, calls, error: err instanceof Error ? err.message : String(err) };
  }
}

const clamp = (x: number) => Math.max(0, Math.min(1000, Math.round(x)));

/** "Pegasus" + "40" → "Pegasus 40"; a version already in the model name isn't added twice; "none" adds nothing. */
export function baselineModelName(model: string | null, version: string | null): string | null {
  if (!model?.trim()) return null;
  if (!version?.trim() || version.trim().toLowerCase() === "none") return model.trim();
  const have = tokenise(model);
  const extra = tokenise(version).filter((w) => !have.includes(w));
  return extra.length ? `${model.trim()} ${version.trim()}` : model.trim();
}

/** The baseline's answer in the shape the scoring code reads (the same CaseRun Sleuth's runs produce). */
export function baselineRun(
  id: string,
  label: Label,
  r: { answer: BaselineAnswer | null; durationMs: number; calls: number; error?: string },
  photoCount: number,
  listing?: ListingData,
): CaseRun {
  const a = r.answer;
  const modelName = a ? baselineModelName(a.model, a.version) : null;
  const size: CaseRun["size"] = !a
    ? { text: null, system: null, options: null }
    : a.size.kind === "multiple"
      ? { text: null, system: a.size.system, options: { system: a.size.system } }
      : a.size.kind === "single" && a.size.value
        ? { text: a.size.system === "unknown" ? a.size.value : `${a.size.system} ${a.size.value}`, system: a.size.system, options: null }
        : { text: null, system: null, options: null };
  return {
    id,
    label,
    tier: modelName ? "model" : a?.brand ? "brand" : "none",
    brand: a?.brand ?? null,
    modelName,
    styleCode: a?.styleCode ?? null,
    colours: a?.colours.length ? a.colours : null,
    size,
    findings: (a?.defects ?? [])
      .filter((d) => d.photo >= 1 && d.photo <= photoCount)
      .map((d) => {
        const [y0, x0, y1, x1] = d.box_2d.map(clamp);
        return { photo: d.photo, label: d.description, box2d: [Math.min(y0, y1), Math.min(x0, x1), Math.max(y0, y1), Math.max(x0, x1)] as Box2d };
      }),
    offers: [],
    verdict: a?.recommendation ?? null,
    durationMs: r.durationMs,
    geminiCalls: r.calls,
    structured: structuredGroups(listing),
    ...(r.error ? { error: r.error } : {}),
  };
}
