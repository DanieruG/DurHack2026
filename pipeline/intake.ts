import { z } from "zod";
import {
  CaptureSchema,
  ProfileSchema,
  type Capture,
  type Platform,
  type Profile,
} from "@/schemas/domain";
import { detectPlatform } from "@/lib/platform";
import { redact } from "@/lib/redact";
import { scopeListingText } from "@/lib/listingScope";
import { downscaleImage, sniffImageMime, type StoredImage } from "@/lib/images";
import { downloadImages } from "@/lib/safeFetch";
import { computeInputHash } from "@/lib/hash";
import type { CaseInputRow } from "@/lib/store";
import type { Deps } from "./deps";
import type { Emit } from "./events";

export const MAX_SCREENSHOTS = 6;
export const MAX_CASE_NOTE = 1000;
export const MAX_SELLER_REPLY = 5000;

export type CaseImage = StoredImage & { index: number; sourceUrl?: string };

export class RequestError extends Error {
  constructor(message: string, public readonly status = 400, public readonly details?: unknown) {
    super(message);
    this.name = "RequestError";
  }
}

function parseJsonField<T>(form: FormData, name: string, schema: z.ZodType<T>, required: boolean): T | undefined {
  const raw = form.get(name);
  if (raw === null || raw === "") {
    if (required) throw new RequestError(`Missing field "${name}"`);
    return undefined;
  }
  if (typeof raw !== "string") throw new RequestError(`Field "${name}" must be a JSON string`);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new RequestError(`Field "${name}" is not valid JSON`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new RequestError(`Field "${name}" is invalid`, 400, z.treeifyError(parsed.error));
  return parsed.data;
}

async function readScreenshots(form: FormData, maxBytes: number): Promise<StoredImage[]> {
  const files = [...form.getAll("screenshots[]"), ...form.getAll("screenshots")].filter(
    (f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f,
  );
  if (files.length > MAX_SCREENSHOTS) throw new RequestError(`At most ${MAX_SCREENSHOTS} screenshots are allowed`);
  const out: StoredImage[] = [];
  for (const f of files) {
    if (f.size > maxBytes) throw new RequestError(`Screenshot "${f.name}" is larger than ${maxBytes} bytes`, 413);
    const bytes = new Uint8Array(await f.arrayBuffer());
    const mimeType = sniffImageMime(bytes);
    if (!mimeType) throw new RequestError(`Screenshot "${f.name}" must be a PNG, JPEG or WebP image`, 415);
    out.push(await downscaleImage({ bytes, mimeType }));
  }
  return out;
}

export const MAX_COLOUR_WISH = 100;

export type CaseRequest = { capture: Capture; profile: Profile; caseNote?: string; /** "all white, nothing neon" */ colourWish?: string; screenshots: StoredImage[] };

/** Validate POST /api/cases multipart input. At least one of screenshots, imageUrls or pageText. */
export async function parseCaseRequest(form: FormData, maxImageBytes: number): Promise<CaseRequest> {
  const capture = parseJsonField(form, "capture", CaptureSchema, true)!;
  const profile = parseJsonField(form, "profile", ProfileSchema, true)!;
  const noteRaw = form.get("caseNote");
  const caseNote = typeof noteRaw === "string" && noteRaw.trim() ? noteRaw.trim().slice(0, MAX_CASE_NOTE) : undefined;
  const colourRaw = form.get("colourWish");
  const colourWish = typeof colourRaw === "string" && colourRaw.trim() ? colourRaw.replace(/\s+/g, " ").trim().slice(0, MAX_COLOUR_WISH) : undefined;
  const screenshots = await readScreenshots(form, maxImageBytes);
  const hasText = !!capture.pageText?.trim();
  const hasUrls = (capture.imageUrls?.length ?? 0) > 0;
  if (!hasText && !hasUrls && screenshots.length === 0) {
    throw new RequestError("Capture is empty: send at least one screenshot, image URL or page text");
  }
  return { capture, profile, caseNote, ...(colourWish ? { colourWish } : {}), screenshots };
}

export type ReopenRequest = { capture?: Capture; sellerReply?: string; screenshots: StoredImage[] };

export async function parseReopenRequest(form: FormData, maxImageBytes: number): Promise<ReopenRequest> {
  const capture = parseJsonField(form, "capture", CaptureSchema, false);
  const replyRaw = form.get("sellerReply");
  const sellerReply = typeof replyRaw === "string" && replyRaw.trim() ? replyRaw.trim().slice(0, MAX_SELLER_REPLY) : undefined;
  const screenshots = await readScreenshots(form, maxImageBytes);
  if (!sellerReply && !capture?.pageText?.trim() && !(capture?.imageUrls?.length) && screenshots.length === 0) {
    throw new RequestError("Nothing new to investigate: send a seller reply, page text, image URLs or screenshots");
  }
  return { capture, sellerReply, screenshots };
}

/** Platform detection + redaction of the page text (before it is stored or sent to Gemini). */
export function prepareText(capture: Capture): { platform: Platform; pageText: string; removedLines: number } {
  const platform = detectPlatform(capture.pageUrl);
  const { text, removedLines } = redact(capture.pageText);
  // Only this listing's own text: drop site navigation and other listings ("Similar items", "Sponsored", ...).
  const scoped = scopeListingText(text, platform, capture.listing?.title?.value);
  return { platform, pageText: scoped.text, removedLines: removedLines + scoped.removedLines };
}

/**
 * Background intake: download listing images through safeFetch; if none could be downloaded, fall back to the
 * screenshots; if neither, continue text-only. Emits capture_warning for partial failures.
 */
export async function intakeImages(
  deps: Deps,
  args: { caseId: string; revision: number; imageUrls: string[]; emit: Emit; existingImageCount: number },
): Promise<{ downloaded: number; usedScreenshots: boolean }> {
  const { images, failed } = await downloadImages(args.imageUrls, deps.fetchImage, deps.config.maxImages);
  const requested = Math.min(new Set(args.imageUrls).size, deps.config.maxImages);

  if (images.length > 0) {
    const scaled = await Promise.all(images.map((i) => downscaleImage(i)));
    await deps.store.addInputs(
      args.caseId,
      scaled.map((img, n) => ({
        revision: args.revision,
        kind: "image" as const,
        mimeType: img.mimeType,
        data: img.bytes,
        sourceUrl: images[n].sourceUrl,
        position: args.existingImageCount + n,
      })),
    );
    if (failed.length > 0) {
      args.emit("capture_warning", {
        message: `Only ${images.length} of ${requested} photo${requested === 1 ? "" : "s"} could be loaded`,
      });
    }
    return { downloaded: images.length, usedScreenshots: false };
  }

  const screenshots = await deps.store.getInputs(args.caseId, { kinds: ["screenshot"], revision: args.revision });
  if (screenshots.length > 0) {
    await deps.store.setInputKind(screenshots.map((s) => s.id), "image");
    if (requested > 0) {
      args.emit("capture_warning", { message: "The listing photos couldn't be loaded, so I'm using your screenshots instead" });
    }
    return { downloaded: 0, usedScreenshots: true };
  }
  if (requested > 0) {
    args.emit("capture_warning", { message: "None of the listing photos could be loaded" });
  }
  return { downloaded: 0, usedScreenshots: false };
}

export function toCaseImages(rows: CaseInputRow[]): CaseImage[] {
  return rows
    .filter((r) => r.data && r.mimeType)
    .map((r, index) => ({ bytes: r.data!, mimeType: r.mimeType as StoredImage["mimeType"], index, sourceUrl: r.sourceUrl ?? undefined }));
}

export function inputHashFor(images: CaseImage[], text: string, needs: unknown, version: string): string {
  return computeInputHash({ images: images.map((i) => i.bytes), text, needs, pipelineVersion: version });
}
