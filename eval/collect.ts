import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CaptureSchema, ProfileSchema, type CheckResult, type Profile } from "../schemas";
import type { Box2d, IdentifyResult, ListingFacts, NewOffers } from "../schemas/domain";
import type { Deps } from "../pipeline/deps";
import { createCase } from "../pipeline";
import { MemoryStore } from "../lib/store";
import { EventHub } from "../pipeline/events";
import { sniffImageMime } from "../lib/images";
import { subjectOf } from "../pipeline/identify";
import type { Label } from "./labels";

/** Every eval case runs with this profile, so fit results don't depend on whoever captured the listing. */
export const EVAL_PROFILE: Profile = ProfileSchema.parse({ defaultSize: { size: 9, system: "UK" }, priorities: ["all-day comfort"], wearTolerance: "light" });

const CaptureFileSchema = z.object({ capture: CaptureSchema, profile: ProfileSchema.optional(), caseNote: z.string().optional() });

/** What Sleuth said about one eval case: only what the metrics compare with the labels. */
export type CaseRun = {
  id: string;
  label: Label;
  /** What identify established after the gate: none, brand, family (version unclear), model, catalogue. */
  tier: "none" | "brand" | "family" | "model" | "catalogue";
  brand: string | null;
  modelName: string | null;
  /** Gemini Pro version check (model read only from photos), when it ran. */
  proRecheck?: { outcome: string; flash: string; pro: string | null };
  styleCode: string | null;
  colours: string[] | null;
  size: { text: string | null; system: string | null; options: { system: string } | null };
  /** Condition findings with boxes: photo number (1-based, matching photo-NN) and box. */
  findings: { photo: number; label: string; box2d: Box2d }[];
  offers: { url: string; colourMatch: string }[];
  verdict: string | null;
  durationMs: number;
  geminiCalls: number;
  error?: string;
};

export function readCase(dir: string) {
  const file = CaptureFileSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, "capture.json"), "utf8")));
  const screenshots = fs
    .readdirSync(dir)
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    .sort()
    .map((f) => new Uint8Array(fs.readFileSync(path.join(dir, f))))
    .map((bytes) => ({ bytes, mimeType: sniffImageMime(bytes)! }))
    .filter((s) => s.mimeType);
  return { ...file, screenshots };
}

/** Run one labelled case through the pipeline with a fresh in-memory store, and record what it said. */
export async function runCase(base: Deps, dir: string, id: string, label: Label): Promise<CaseRun> {
  const ref = await base.store.getReference();
  const deps: Deps = { ...base, store: new MemoryStore(ref), hub: new EventHub() };
  const run: CaseRun = {
    id,
    label,
    tier: "none",
    brand: null,
    modelName: null,
    styleCode: null,
    colours: null,
    size: { text: null, system: null, options: null },
    findings: [],
    offers: [],
    verdict: null,
    durationMs: 0,
    geminiCalls: 0,
  };
  try {
    const file = readCase(dir);
    const { caseId, done } = await createCase(deps, { capture: file.capture, profile: EVAL_PROFILE, caseNote: file.caseNote, screenshots: file.screenshots });
    await done;
    const doneEv = deps.hub.events(caseId).find((e) => e.event === "investigation_done")?.data as { durationMs: number; geminiCalls: number } | undefined;
    const c = (await deps.store.getCase(caseId))!;
    const checks = (await deps.store.getChecks(caseId, c.revision)) as CheckResult[];
    const get = (n: string) => checks.find((x) => x.check === n);
    const subject = subjectOf(c.identify as IdentifyResult | null, base.config.identifyConfidenceMin, ref.catalogue);
    const facts = c.listingFacts as ListingFacts | null;
    Object.assign(run, {
      tier: subject.tier,
      brand: subject.brand,
      modelName: subject.tier === "family" ? null : subject.modelName,
      proRecheck: (get("identify")?.details as { proRecheck?: CaseRun["proRecheck"] } | undefined)?.proRecheck,
      styleCode: facts?.styleCode ?? null,
      colours: facts?.listingColour?.names ?? null,
      size: {
        text: facts?.sizeText ?? null,
        system: facts?.sizeSystem ?? null,
        options: facts?.sizeOptions ? { system: facts.sizeOptions.system } : null,
      },
      findings: (get("condition")?.evidence ?? [])
        .filter((e) => e.kind === "photo_region" && e.photoIndex !== undefined && e.box2d)
        .map((e) => ({ photo: e.photoIndex! + 1, label: e.label, box2d: e.box2d! })),
      offers: ((get("price")?.details as { newOffers?: NewOffers } | undefined)?.newOffers?.offers ?? []).map((o) => ({ url: o.url, colourMatch: o.colourMatch })),
      verdict: c.verdict?.label ?? null,
      durationMs: doneEv?.durationMs ?? 0,
      geminiCalls: doneEv?.geminiCalls ?? 0,
      ...(c.status === "error" ? { error: "the investigation stopped with an error" } : {}),
    });
  } catch (err) {
    run.error = err instanceof Error ? err.message : String(err);
  }
  return run;
}
