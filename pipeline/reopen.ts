import { z } from "zod";
import {
  CheckNameSchema,
  type CaseDiff,
  type CheckName,
  type CheckResult,
  type Evidence,
  type ListingFacts,
  type Verdict,
} from "@/schemas/domain";
import { redact } from "@/lib/redact";
import { generateStructured } from "@/gemini/structured";
import { imagePart, type GeminiClient, type Part } from "@/gemini/client";
import type { Deps } from "./deps";
import { subjectOf } from "./identify";
import { normaliseIdentify } from "./identifyLevel";
import { scopeListingImages } from "@/lib/listingScope";
import { intakeImages, type CaseImage, type ReopenRequest } from "./intake";
import { buildCtx, DOWNSTREAM, runDownstream, runIdentify, type DownstreamCheck } from "./runChecks";
import { finalise, instrumented, loadImages, loadSurvey } from "./core";
import { runStage, textContains } from "./util";

// ---------- seller reply extraction ----------

export const ReplyWireSchema = z.object({
  sizeText: z.string().nullish(),
  sizeSystem: z.enum(["UK", "US", "EU", "unknown"]).nullish(),
  price: z.number().nonnegative().nullish(),
  currency: z.string().nullish(),
  conditionStatements: z.array(z.string()).default([]),
  brandText: z.string().nullish(),
  modelText: z.string().nullish(),
  answers: z.array(CheckNameSchema).default([]),
});
export type ReplyFacts = z.infer<typeof ReplyWireSchema>;

const REPLY_SYSTEM = `You read a seller's reply to a buyer's questions about second-hand trainers.
Extract only facts the SELLER states in the reply: size (and system), price in the reply, statements about condition (copied exactly),
brand/model name. "answers": which topics the reply addresses: identify (model name / label), fit (size), price, condition, comfort.
Ignore the buyer's own messages and any seller identity (names, usernames, ratings). Leave fields null if not stated.`;

export const ImageLabelWireSchema = z.object({
  images: z.array(z.object({ photoIndex: z.number().int(), showsLabel: z.boolean(), labelText: z.string().nullish(), sizeText: z.string().nullish() })).default([]),
});

// ---------- affected-check mapping (pure) ----------

/**
 * Spec 7.11: new image -> condition (+ identify if Gemini sees a label/tag; + fit if that label shows a size);
 * seller reply: size -> fit, price -> price, condition statements -> condition, model name -> identify.
 */
export function affectedChecks(input: {
  newImages: boolean;
  imageShowsLabel: boolean;
  labelHasSize?: boolean;
  reply?: Pick<ReplyFacts, "sizeText" | "price" | "conditionStatements" | "modelText" | "brandText"> | null;
}): Set<CheckName> {
  const out = new Set<CheckName>();
  if (input.newImages) out.add("condition");
  if (input.imageShowsLabel) out.add("identify");
  if (input.labelHasSize) out.add("fit");
  const r = input.reply;
  if (r) {
    if (r.sizeText) out.add("fit");
    if (r.price != null) out.add("price");
    if (r.conditionStatements.length) out.add("condition");
    if (r.modelText || r.brandText) out.add("identify");
  }
  return out;
}

/** Merge reply facts into ListingFacts; replaced facts get the seller's quoted words as evidence. */
export function mergeReplyFacts(facts: ListingFacts, reply: ReplyFacts, replyText: string, revision: number): ListingFacts {
  let n = 0;
  const id = () => `ev_reply${revision}_${++n}`;
  const quoteFor = (needle: string | null | undefined) => (needle && textContains(replyText, needle) ? needle : undefined);
  const next: ListingFacts = { ...facts, evidence: [...facts.evidence], conditionClaims: [...facts.conditionClaims] };
  const add = (label: string, value: string | number, quoteSource?: string | null) => {
    const quote = quoteFor(quoteSource);
    next.evidence.push(quote ? { id: id(), kind: "quote", label, quote, value } : { id: id(), kind: "data_point", label: `${label} (from the seller's reply)`, value });
  };
  if (reply.sizeText) {
    next.sizeText = reply.sizeText;
    next.sizeSystem = reply.sizeSystem ?? "unknown";
    next.evidence = next.evidence.filter((e) => !e.label.startsWith("Listed size"));
    add("Listed size (seller reply)", reply.sizeText, reply.sizeText);
  }
  const gbp = !reply.currency || /^(gbp|£)/i.test(reply.currency);
  if (reply.price != null && gbp) {
    next.priceGBP = reply.price;
    next.evidence = next.evidence.filter((e) => !e.label.startsWith("Asking price"));
    add("Asking price (seller reply)", reply.price, `£${reply.price}`);
  }
  for (const s of reply.conditionStatements.slice(0, 4)) {
    next.conditionClaims.push(s);
    add("Seller's condition description (reply)", s, s);
  }
  if (reply.brandText) next.brandText = reply.brandText;
  if (reply.modelText) {
    next.modelText = reply.modelText;
    add("Model (seller reply)", reply.modelText, reply.modelText);
  }
  return next;
}

// ---------- diff (pure) ----------

export function diffCases(args: {
  fromRevision: number;
  toRevision: number;
  before: CheckResult[];
  after: CheckResult[];
  rerun: Set<CheckName>;
  reasons: Partial<Record<CheckName, string>>;
  verdictBefore: Verdict["label"];
  verdictAfter: Verdict["label"];
}): CaseDiff {
  const checks: CaseDiff["checks"] = [];
  for (const a of args.after) {
    if (!args.rerun.has(a.check)) continue;
    const b = args.before.find((x) => x.check === a.check);
    if (b && b.status === a.status && b.summary === a.summary) continue;
    checks.push({ check: a.check, before: b?.status ?? "unknown", after: a.status, reason: args.reasons[a.check] ?? a.summary });
  }
  return { fromRevision: args.fromRevision, toRevision: args.toRevision, checks, verdict: { before: args.verdictBefore, after: args.verdictAfter } };
}

// ---------- reopen ----------

export class ReopenConflictError extends Error {
  constructor() {
    super("This case is still being investigated; try again when it finishes");
    this.name = "ReopenConflictError";
  }
}

/** POST /api/cases/:id/reopen: store new inputs at revision+1, start the reopen in the background. */
export async function startReopen(deps: Deps, caseId: string, req: ReopenRequest): Promise<{ revision: number; done: Promise<void> } | null> {
  const c = await deps.store.getCase(caseId);
  if (!c) return null;
  if (c.status === "investigating") throw new ReopenConflictError();
  const revision = c.revision + 1;
  const replyText = redact(req.sellerReply ?? req.capture?.pageText ?? "").text;
  await deps.store.updateCase(caseId, { revision, status: "investigating" });
  const existing = (await deps.store.getInputs(caseId, { kinds: ["image", "screenshot"], withData: false })).length;
  await deps.store.addInputs(caseId, [
    ...(replyText ? [{ revision, kind: "seller_reply" as const, text: replyText }] : []),
    ...req.screenshots.map((s, i) => ({ revision, kind: "screenshot" as const, mimeType: s.mimeType, data: s.bytes, position: existing + i })),
  ]);
  deps.hub.startRevision(caseId, revision);
  const done = reopenCase(deps, caseId, { imageUrls: scopeListingImages(req.capture?.imageUrls ?? [], c.platform), replyText });
  return { revision, done };
}

async function extractReply(gemini: GeminiClient, replyText: string): Promise<ReplyFacts> {
  const { data } = await generateStructured(gemini, ReplyWireSchema, {
    stage: "reopen",
    tier: "fast",
    system: REPLY_SYSTEM,
    parts: [{ text: `Seller reply (identity removed):\n"""\n${replyText}\n"""` }],
  });
  return { ...data, conditionStatements: data.conditionStatements.map((s) => redact(s).text).filter(Boolean) };
}

async function classifyNewImages(gemini: GeminiClient, images: CaseImage[]) {
  const parts: Part[] = [{ text: "For each photo, say whether it shows a size label, tongue label, box label or tag, and transcribe the label text and any size on it." }];
  for (const img of images) parts.push({ text: `Photo ${img.index}:` }, imagePart(img));
  const { data } = await generateStructured(gemini, ImageLabelWireSchema, { stage: "reopen", tier: "fast", parts });
  return data.images.filter((i) => images.some((x) => x.index === i.photoIndex));
}

export async function reopenCase(deps: Deps, caseId: string, args: { imageUrls: string[]; replyText: string }): Promise<void> {
  const c = await deps.store.getCase(caseId);
  if (!c) throw new Error(`Case ${caseId} not found`);
  const revision = c.revision;
  const fromRevision = revision - 1;
  const { config } = deps;

  await instrumented(deps, caseId, revision, async (emit) => {
    emit("case_reopened", { caseId, revision });
    const before = await deps.store.getChecks(caseId, fromRevision);
    const prevLeads = await deps.store.getLeads(caseId, fromRevision);
    const prevImages = await loadImages(deps, caseId);

    await runStage("intake", { emit, timeoutMs: config.stageTimeoutMs + 6000 }, () =>
      intakeImages(deps, { caseId, revision, imageUrls: args.imageUrls, emit, existingImageCount: prevImages.length }),
    ).catch(() => emit("capture_warning", { message: "The new photos couldn't be loaded" }));

    const [images, ref, pageRows] = await Promise.all([
      loadImages(deps, caseId),
      deps.store.getReference(),
      deps.store.getInputs(caseId, { kinds: ["page_text"], withData: false }),
    ]);
    const newImages = images.slice(prevImages.length);
    const pageText = pageRows.map((r) => r.text ?? "").join("\n\n");
    let facts: ListingFacts = c.listingFacts ?? { platform: c.platform, photoCount: 0, conditionClaims: [], evidence: [] };

    // Classify new evidence.
    const [reply, labels] = await runStage("reopen", { emit, timeoutMs: config.stageTimeoutMs, geminiFeatures: ["vision", "structured_output"] }, () =>
      Promise.all([
        args.replyText ? extractReply(deps.gemini, args.replyText).catch(() => null) : Promise.resolve(null),
        newImages.length ? classifyNewImages(deps.gemini, newImages).catch(() => []) : Promise.resolve([]),
      ]),
    ).catch(() => [null, []] as const);

    const reasons: Partial<Record<CheckName, string>> = {};
    if (reply) {
      facts = mergeReplyFacts(facts, reply, args.replyText, revision);
      if (reply.sizeText) reasons.fit = `Seller's reply gave the size: ${reply.sizeText}`;
      if (reply.price != null) reasons.price = `Seller's reply gave the price: £${reply.price}`;
      if (reply.conditionStatements.length) reasons.condition = `Seller's reply on condition: "${reply.conditionStatements[0]}"`;
      if (reply.modelText) reasons.identify = `Seller's reply named the model: ${reply.modelText}`;
    }
    const labelled = labels.filter((l) => l.showsLabel);
    const labelSize = labelled.find((l) => l.sizeText)?.sizeText;
    if (labelSize && !reply?.sizeText) {
      const ev: Evidence = { id: `ev_reply${revision}_label`, kind: "photo_region", label: `Listed size (size label, photo ${labelled[0].photoIndex + 1})`, photoIndex: labelled[0].photoIndex, value: labelSize };
      facts = { ...facts, sizeText: labelSize, sizeSystem: "unknown", evidence: [...facts.evidence.filter((e) => !e.label.startsWith("Listed size")), ev] };
      reasons.fit = `New photo shows the size label: ${labelSize}`;
    }
    if (newImages.length) reasons.condition ??= `${newImages.length} new photo${newImages.length === 1 ? "" : "s"} checked`;
    if (labelled.length) reasons.identify ??= "New photo shows a label";
    facts = { ...facts, photoCount: images.length };

    const affected = affectedChecks({ newImages: newImages.length > 0, imageShowsLabel: labelled.length > 0, labelHasSize: !!labelSize, reply });
    const answered = new Set<CheckName>([...c.answered, ...(reply?.answers ?? []), ...affected]);

    const ctx = buildCtx({ deps, caseId, revision, emit, ref, images, pageText, facts, needs: c.needs, identify: normaliseIdentify(c.identify), survey: await loadSurvey(deps, caseId) });
    const rerun = new Set<CheckName>();
    let checks = before;

    let identifyChanged = false;
    if (affected.has("identify")) {
      const prev = subjectOf(c.identify, ref.catalogue);
      const { result, check } = await runIdentify(ctx);
      rerun.add("identify");
      const next = subjectOf(result, ref.catalogue);
      identifyChanged = next.tier !== prev.tier || next.displayName !== prev.displayName || next.catalogue?.id !== prev.catalogue?.id;
      ctx.identify = result;
      emit("check_done", check);
      checks = [check, ...checks.filter((x) => x.check !== "identify")];
    }

    // Checks gate themselves on what identify established; a changed identification reruns them all.
    const toRun: DownstreamCheck[] = identifyChanged ? DOWNSTREAM : DOWNSTREAM.filter((n) => affected.has(n));
    for (const n of toRun) rerun.add(n);
    if (toRun.length) {
      const downstream = await runDownstream(ctx, toRun, checks.filter((x) => x.check !== "identify"));
      checks = [checks.find((x) => x.check === "identify")!, ...downstream];
    }

    // Leads are not re-run on reopen; flagged gaps the seller has now answered are dropped.
    const leads = prevLeads.filter((l) => l.type === "flag_for_seller" && l.relatesTo && !answered.has(l.relatesTo));
    const verdictBefore = c.verdict?.label ?? "not_enough_evidence";
    await finalise(ctx, {
      checks,
      leads,
      row: c,
      inputHashImages: images,
      answered: [...answered],
      beforeDone: (verdict) =>
        emit(
          "diff",
          diffCases({ fromRevision, toRevision: revision, before, after: checks, rerun, reasons, verdictBefore, verdictAfter: verdict.label }),
        ),
    });
  });
}
