import { z } from "zod";
import {
  CheckNameSchema,
  DefectLabelSchema,
  LeadTypeSchema,
  type CheckResult,
  type ConditionFinding,
  type Lead,
} from "@/schemas/domain";
import { generateStructured } from "@/gemini/structured";
import { functionTool } from "@/gemini/tools";
import { gradeFromClaims, recheckConditionPhoto } from "./checks/condition";
import { subjectOf } from "./identify";
import { runCheck, runDownstream, runIdentify, type RunCtx } from "./runChecks";
import { plainError, runStage } from "./util";

export const LeadWireSchema = z.object({
  leads: z
    .array(
      z.object({
        type: LeadTypeSchema,
        reason: z.string(),
        relatesTo: CheckNameSchema.nullish(),
        photoIndex: z.number().int().nonnegative().nullish(),
        defectLabels: z.array(DefectLabelSchema).nullish(),
      }),
    )
    .default([]),
});
export type LeadWire = z.infer<typeof LeadWireSchema>["leads"][number];

const LEADS_SYSTEM = `You are Sleuth's lead investigator. Given check results for a second-hand trainer listing, decide whether
anything looks off enough to follow up. You may call the functions to check exact facts first.
Allowed lead types:
- deeper_price_comparison: price looks odd; recompute sampled prices for the listing's condition grade and fetch the current new price
  (you may call getNewPrices first to see current UK retailer prices).
- recheck_identification: the identified model may be wrong (e.g. close variant); give photoIndex of the clearest photo.
- recheck_condition_photo: a condition finding is uncertain; give photoIndex and the defectLabels to look for.
- flag_for_seller: a gap only the seller can fill; set relatesTo to the check it concerns.
Return {"leads": []} when nothing needs following up. Each lead needs a one-sentence reason.`;

/** Something "looks off": any non-pass check, or a low-confidence one. */
export function needsLeads(checks: CheckResult[]): boolean {
  return checks.some((c) => c.status !== "pass" || c.confidence < 0.6);
}

export function compactSummary(checks: CheckResult[]) {
  return checks.map((c) => {
    const d = (c.details ?? {}) as Record<string, unknown>;
    const extra: Record<string, unknown> = {};
    if (c.check === "identify") Object.assign(extra, { tier: d.tier, modelName: d.modelName, catalogueModelId: d.catalogueModelId, inCatalogue: d.inCatalogue });
    if (c.check === "price") Object.assign(extra, { position: d.position, sampleN: (d.sample as { n?: number } | undefined)?.n, newPrice: d.newPrice, sourceBRun: d.sourceBRun });
    if (c.check === "condition") {
      Object.assign(extra, {
        findings: ((d.findings as ConditionFinding[] | undefined) ?? []).map((f) => ({ label: f.label, photoIndex: f.photoIndex, severity: f.severity, confidence: f.confidence })),
        notVisible: d.notVisible,
      });
    }
    if (c.check === "fit") Object.assign(extra, { match: d.match });
    return { check: c.check, status: c.status, confidence: c.confidence, summary: c.summary, ...extra };
  });
}

/** Validate and cap the model's proposals (code decides what is executable). */
export function sanitiseLeads(proposed: LeadWire[], ctx: { maxLeads: number; photoCount: number }): (Lead & { wire: LeadWire })[] {
  const out: (Lead & { wire: LeadWire })[] = [];
  const seen = new Set<string>();
  for (const w of proposed) {
    const key = w.type === "flag_for_seller" ? `${w.type}:${w.relatesTo ?? ""}` : w.type;
    if (seen.has(key)) continue;
    if (w.type === "recheck_condition_photo" && (w.photoIndex == null || w.photoIndex >= ctx.photoCount)) continue;
    if (w.type === "flag_for_seller" && !w.relatesTo) continue;
    seen.add(key);
    out.push({
      id: `lead_${out.length + 1}`,
      type: w.type,
      reason: w.reason.slice(0, 240),
      status: "pending",
      ...(w.relatesTo ? { relatesTo: w.relatesTo } : {}),
      wire: w,
    });
    if (out.length >= ctx.maxLeads) break;
  }
  return out;
}

async function proposeLeads(ctx: RunCtx, checks: CheckResult[]): Promise<LeadWire[]> {
  const { data } = await generateStructured(ctx.deps.gemini, LeadWireSchema, {
    stage: "leads",
    tier: "fast",
    system: LEADS_SYSTEM,
    parts: [
      {
        text:
          `Max leads: ${ctx.deps.config.maxLeads}. Photos available: ${ctx.images.length}.\n` +
          `Identified: ${subjectOf(ctx.identify, ctx.deps.config.identifyConfidenceMin, ctx.ref.catalogue).displayName ?? "nothing"} (catalogue id: ${ctx.identify?.catalogueModelId ?? "none"}). Seller condition claims: ${JSON.stringify(ctx.facts.conditionClaims)}.\n` +
          `Check results:\n${JSON.stringify(compactSummary(checks))}`,
      },
    ],
    tools: [functionTool()],
    executors: ctx.executors,
  });
  return data.leads;
}

export type LeadsOutcome = { checks: CheckResult[]; leads: Lead[]; usedFunctionCalling: boolean };

/** Gemini decides (up to MAX_LEADS), code executes. Leads change results only through executors. */
export async function followLeads(ctx: RunCtx, checks: CheckResult[]): Promise<LeadsOutcome> {
  const max = ctx.deps.config.maxLeads;
  if (max <= 0 || !needsLeads(checks)) return { checks, leads: [], usedFunctionCalling: false };

  let proposed: LeadWire[] = [];
  try {
    proposed = await runStage("leads", { emit: ctx.emit, timeoutMs: ctx.deps.config.stageTimeoutMs, geminiFeatures: ["function_calling", "structured_output"] }, () =>
      proposeLeads(ctx, checks),
    );
  } catch {
    return { checks, leads: [], usedFunctionCalling: false };
  }
  const leads = sanitiseLeads(proposed, { maxLeads: max, photoCount: ctx.images.length });

  let current = checks;
  const done: Lead[] = [];
  for (const lead of leads) {
    const { wire, ...publicLead } = lead;
    ctx.emit("lead_started", publicLead);
    let finished: Lead;
    try {
      const r = await executeLead(ctx, publicLead, wire, current);
      current = r.checks;
      finished = { ...publicLead, status: r.status, outcome: r.outcome };
      for (const c of r.updated) ctx.emit("check_done", c);
    } catch (err) {
      finished = { ...publicLead, status: "failed", outcome: plainError(lead.relatesTo ?? "price", err) };
    }
    ctx.emit("lead_done", finished);
    done.push(finished);
  }
  return { checks: current, leads: done, usedFunctionCalling: true };
}

const replace = (checks: CheckResult[], next: CheckResult) => checks.map((c) => (c.check === next.check ? next : c));

async function executeLead(
  ctx: RunCtx,
  lead: Lead,
  wire: LeadWire,
  checks: CheckResult[],
): Promise<{ checks: CheckResult[]; updated: CheckResult[]; status: Lead["status"]; outcome: string }> {
  switch (lead.type) {
    case "flag_for_seller":
      return { checks, updated: [], status: "done", outcome: `Added a question for the seller about ${lead.relatesTo}.` };

    case "deeper_price_comparison": {
      const grade = gradeFromClaims(ctx.facts.conditionClaims);
      const before = checks.find((c) => c.check === "price");
      const next = await runCheck(ctx, "price", { priceCondition: grade, forceSourceB: true });
      const changed = before?.status !== next.status;
      return {
        checks: replace(checks, next),
        updated: [next],
        status: "done",
        outcome: `${grade ? `Compared with ${grade.replace(/_/g, " ")} listings` : "Rechecked prices"}${changed ? `: price is now ${next.status}` : ": no change"}.`,
      };
    }

    case "recheck_identification": {
      const photo = wire.photoIndex != null && wire.photoIndex < ctx.images.length ? wire.photoIndex : ctx.images.length ? 0 : undefined;
      if (photo === undefined) return { checks, updated: [], status: "skipped", outcome: "No photo to recheck." };
      const min = ctx.deps.config.identifyConfidenceMin;
      const before = subjectOf(ctx.identify, min, ctx.ref.catalogue);
      const { result, check } = await runIdentify(ctx, { onlyPhotoIndex: photo });
      const after = subjectOf(result, min, ctx.ref.catalogue);
      const changed = after.displayName !== before.displayName || after.catalogue?.id !== before.catalogue?.id;
      // Adopt the recheck only when it names a model confidently and differs from what we had.
      if (after.modelName && changed) {
        ctx.identify = result;
        const downstream = await runDownstream(ctx, ["fit", "price", "comfort"], checks.filter((c) => c.check !== "identify"));
        const next = [check, ...downstream];
        return { checks: next, updated: [check], status: "done", outcome: `Model changed to ${after.displayName}; reran fit, price and comfort.` };
      }
      return {
        checks,
        updated: [],
        status: "done",
        outcome: !changed ? "Identification confirmed on the clearest photo." : "Recheck was inconclusive; kept the original identification.",
      };
    }

    case "recheck_condition_photo": {
      const image = ctx.images.find((i) => i.index === wire.photoIndex);
      const prev = checks.find((c) => c.check === "condition");
      if (!image || !prev) return { checks, updated: [], status: "skipped", outcome: "No photo to recheck." };
      const prevFindings = ((prev.details as { findings?: ConditionFinding[] } | undefined)?.findings ?? []).filter((f) => f.photoIndex === image.index);
      const labels = wire.defectLabels?.length ? wire.defectLabels : [...new Set(prevFindings.map((f) => f.label))];
      if (!labels.length) return { checks, updated: [], status: "skipped", outcome: "No specific defect to recheck." };
      const next = await runStage("condition", { emit: ctx.emit, timeoutMs: ctx.deps.config.stageTimeoutMs, geminiFeatures: ["vision", "object_detection", "structured_output"] }, () =>
        recheckConditionPhoto({ gemini: ctx.deps.gemini, image, labels, previous: prev, facts: ctx.facts, needs: ctx.needs }),
      );
      return {
        checks: replace(checks, next),
        updated: [next],
        status: "done",
        outcome: `Rechecked photo ${image.index + 1} for ${labels.map((l) => l.replace(/_/g, " ")).join(", ")}: condition is ${next.status}.`,
      };
    }
  }
}
