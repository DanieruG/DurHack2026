import { z } from "zod";
import {
  DefectLabelSchema,
  SeveritySchema,
  type CheckResult,
  type CheckStatus,
  type ConditionFinding,
  type ConditionGrade,
  type DefectLabel,
  type Evidence,
  type ListingFacts,
  type Severity,
  type UserNeeds,
  type WearTolerance,
} from "@/schemas/domain";
import { generateStructured } from "@/gemini/structured";
import { imagePart, type GeminiClient, type Part } from "@/gemini/client";
import { containsBanned } from "../verdict/validate";
import type { CaseImage } from "../intake";
import { clamp01, round2, unknownCheck } from "../util";

export const POSSIBLE_BELOW = 0.6;

export const ConditionWireSchema = z.object({
  findings: z
    .array(
      z.object({
        label: DefectLabelSchema,
        photoIndex: z.number().int().nonnegative(),
        box2d: z.array(z.number()).length(4),
        severity: SeveritySchema,
        confidence: z.number().min(0).max(1),
        note: z.string(),
      }),
    )
    .default([]),
  notVisible: z.array(z.string()).default([]),
  contradictions: z.array(z.string()).default([]),
});
export type ConditionWire = z.infer<typeof ConditionWireSchema>;

export const CONDITION_SYSTEM = `You inspect photos of second-hand trainers for DEFECTS (not objects).
Use only these labels: ${DefectLabelSchema.options.join(", ")}.
For each defect: photoIndex, box2d as [ymin, xmin, ymax, xmax] normalised to 0-1000 on that photo, severity (minor | moderate | major), confidence 0-1, and a short neutral note.
Shadows, dirt, reflections, creases in packaging and lighting can resemble damage: lower your confidence when unsure, and do not report what you cannot see.
notVisible: areas of the shoe that no photo shows clearly and that matter for condition (e.g. "inside lining", "heel close-up", "outsole", "insole", "size label").
contradictions: where the seller's condition description disagrees with what the photos show, phrased neutrally (e.g. "described as like new; moderate outsole wear visible").`;

const LABEL_WORDS: Record<DefectLabel, string> = {
  outsole_wear: "outsole wear",
  heel_wear: "heel wear",
  upper_creasing: "creasing on the upper",
  stitching_damage: "stitching damage",
  discolouration: "discolouration",
  tear_or_hole: "a tear or hole",
  sole_separation: "sole separation",
  dirt_or_staining: "dirt or staining",
};

/** Seller condition words -> grade (also used to restrict price samples). */
export function gradeFromClaims(claims: string[]): ConditionGrade | undefined {
  const t = claims.join(" ").toLowerCase();
  if (!t) return undefined;
  if (/\b(new with tags|bnwt|bnib|brand new|new in box|deadstock|ds\b|unworn|never worn)/.test(t)) return "new_with_tags";
  if (/\b(new without tags|like new|as new|worn once|worn twice|barely worn|hardly worn|very good|excellent|mint|immaculate|pristine)/.test(t)) return "like_new";
  if (/\b(satisfactory|well worn|heavily worn|signs of wear|fair|worn|used|scuffs?|beaters?)/.test(t)) {
    if (/\bgood\b/.test(t) && !/\b(well|heavily) worn\b/.test(t)) return "good";
    return "worn";
  }
  if (/\bgood\b/.test(t)) return "good";
  return undefined;
}

function normaliseBox(b: number[]): [number, number, number, number] {
  const c = b.map((n) => Math.max(0, Math.min(1000, Math.round(n))));
  const [y1, x1, y2, x2] = c;
  return [Math.min(y1, y2), Math.min(x1, x2), Math.max(y1, y2), Math.max(x1, x2)];
}

const LOWER: Record<Severity, Severity | null> = { major: "moderate", moderate: "minor", minor: null };

/** Severity used for status: findings below 0.6 confidence ("possible") count one level lower. */
export function effectiveSeverity(f: Pick<ConditionFinding, "severity" | "confidence">): Severity | null {
  return f.confidence < POSSIBLE_BELOW ? LOWER[f.severity] : f.severity;
}

/** Status rules (spec 7.6), shifted by the user's wear tolerance. */
export function conditionStatus(findings: ConditionFinding[], contradictions: string[], tolerance: WearTolerance): CheckStatus {
  const sev = findings.map(effectiveSeverity).filter((s): s is Severity => !!s);
  const has = (s: Severity) => sev.includes(s);
  let status: CheckStatus;
  switch (tolerance) {
    case "none":
      status = has("major") ? "fail" : sev.length ? "warn" : "pass";
      break;
    case "moderate":
      status = has("major") ? "fail" : "pass";
      break;
    case "any":
      status = has("major") ? "warn" : "pass";
      break;
    case "light":
    default:
      status = has("major") ? "fail" : has("moderate") ? "warn" : "pass";
  }
  if (contradictions.length && status === "pass") status = "warn";
  return status;
}

export function describeFinding(f: ConditionFinding): string {
  const possible = f.confidence < POSSIBLE_BELOW;
  return `${possible ? "Possible" : capitalise(f.severity)} ${LABEL_WORDS[f.label]} (photo ${f.photoIndex + 1})`;
}

/** Build the CheckResult from findings; shared by the main check and the recheck lead. */
export function finaliseCondition(args: {
  findings: ConditionFinding[];
  notVisible: string[];
  modelContradictions: string[];
  facts: ListingFacts;
  needs: UserNeeds;
  photosChecked: number;
}): CheckResult {
  const { findings, facts, needs } = args;
  const claimEv: Evidence[] = facts.evidence.filter((e) => e.label.startsWith("Seller's condition"));
  const evidence: Evidence[] = [
    ...claimEv,
    ...findings.map(
      (f): Evidence => ({ id: f.evidenceId, kind: "photo_region", label: describeFinding(f), photoIndex: f.photoIndex, box2d: f.box2d, quote: f.note }),
    ),
  ];

  // Code-level contradiction: "new"/"like new" claims vs confident moderate+ wear.
  const contradictions = args.modelContradictions.filter((c) => !containsBanned(c)).slice(0, 4);
  const grade = gradeFromClaims(facts.conditionClaims);
  const serious = findings.filter((f) => f.confidence >= POSSIBLE_BELOW && f.severity !== "minor");
  if ((grade === "new_with_tags" || grade === "like_new") && serious.length && contradictions.length === 0) {
    const f = serious[0];
    contradictions.push(`Described as "${facts.conditionClaims[0]}"; ${f.severity} ${LABEL_WORDS[f.label]} visible in photo ${f.photoIndex + 1}`);
  }

  const status = conditionStatus(findings, contradictions, needs.wearTolerance);
  const worst = [...findings].sort((a, b) => rank(b) - rank(a))[0];
  let summary: string;
  if (findings.length === 0) {
    summary = `No visible defects in ${args.photosChecked} photo${args.photosChecked === 1 ? "" : "s"}.`;
  } else {
    summary = `${describeFinding(worst)}${findings.length > 1 ? ` and ${findings.length - 1} other finding${findings.length > 2 ? "s" : ""}` : ""}.`;
  }
  if (contradictions.length) summary += ` ${contradictions[0]}.`;
  if (args.notVisible.length && status !== "fail") summary += ` Not shown: ${args.notVisible.slice(0, 3).join(", ")}.`;

  const avgConf = findings.length ? findings.reduce((s, f) => s + f.confidence, 0) / findings.length : 0.75;
  const coverage = Math.min(1, 0.45 + 0.1 * args.photosChecked);
  return {
    check: "condition",
    status,
    summary: summary.replace(/\.\./g, "."),
    evidence,
    confidence: round2(clamp01(Math.min(avgConf, coverage, 0.9))),
    geminiFeatures: ["vision", "object_detection", "structured_output"],
    details: { findings, notVisible: args.notVisible, contradictions, photosChecked: args.photosChecked },
  };
}

function rank(f: ConditionFinding): number {
  const s = effectiveSeverity(f);
  return (s === "major" ? 3 : s === "moderate" ? 2 : s === "minor" ? 1 : 0) + f.confidence / 10;
}

function capitalise(s: string) {
  return s[0].toUpperCase() + s.slice(1);
}

export function conditionParts(images: CaseImage[], facts: ListingFacts, labels?: DefectLabel[]): Part[] {
  const parts: Part[] = [
    {
      text:
        `Seller's condition description: ${facts.conditionClaims.length ? facts.conditionClaims.map((c) => `"${c}"`).join(", ") : "(none given)"}\n` +
        (labels ? `Look ONLY for these defects: ${labels.join(", ")}.\n` : "") +
        `Photos follow, each preceded by its photoIndex.`,
    },
  ];
  for (const img of images) parts.push({ text: `Photo ${img.index}:` }, imagePart(img));
  return parts;
}

export function wireToFindings(wire: ConditionWire, photoIndices: number[], idPrefix = "cond", startAt = 1): ConditionFinding[] {
  let n = startAt - 1;
  const seen = new Set<string>();
  return wire.findings
    .filter((f) => photoIndices.includes(f.photoIndex))
    .map((f) => ({ ...f, box2d: normaliseBox(f.box2d), confidence: round2(clamp01(f.confidence)) }))
    .filter((f) => f.box2d[2] > f.box2d[0] && f.box2d[3] > f.box2d[1])
    .filter((f) => {
      const key = `${f.label}:${f.photoIndex}:${f.box2d.map((x) => Math.round(x / 50)).join(",")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 12)
    .map((f) => ({
      ...f,
      note: containsBanned(f.note) || !f.note.trim() ? LABEL_WORDS[f.label] : f.note.slice(0, 200),
      evidenceId: `ev_${idPrefix}_${++n}`,
    }));
}

export async function checkCondition(args: {
  gemini: GeminiClient;
  images: CaseImage[];
  facts: ListingFacts;
  needs: UserNeeds;
}): Promise<CheckResult> {
  if (args.images.length === 0) {
    return unknownCheck("condition", "There are no usable photos, so I can't check the condition.", {
      details: { findings: [], notVisible: ["all areas"], contradictions: [], photosChecked: 0 },
    });
  }
  const { data } = await generateStructured(args.gemini, ConditionWireSchema, {
    stage: "condition",
    tier: "fast",
    thinking: "LOW",
    system: CONDITION_SYSTEM,
    parts: conditionParts(args.images, args.facts),
    temperature: 0,
  });
  const findings = wireToFindings(data, args.images.map((i) => i.index));
  return finaliseCondition({
    findings,
    notVisible: data.notVisible.map((s) => s.trim()).filter((s) => s && !containsBanned(s)).slice(0, 6),
    modelContradictions: data.contradictions,
    facts: args.facts,
    needs: args.needs,
    photosChecked: args.images.length,
  });
}

/** recheck_condition_photo lead: one photo, narrower defect list; merged into the existing findings. */
export async function recheckConditionPhoto(args: {
  gemini: GeminiClient;
  image: CaseImage;
  labels: DefectLabel[];
  previous: CheckResult;
  facts: ListingFacts;
  needs: UserNeeds;
}): Promise<CheckResult> {
  const prevDetails = (args.previous.details ?? {}) as { findings?: ConditionFinding[]; notVisible?: string[]; contradictions?: string[]; photosChecked?: number };
  const prevFindings = prevDetails.findings ?? [];
  const { data } = await generateStructured(args.gemini, ConditionWireSchema, {
    stage: "condition",
    tier: "strong",
    system: CONDITION_SYSTEM,
    parts: conditionParts([args.image], args.facts, args.labels),
    temperature: 0,
  });
  const fresh = wireToFindings(data, [args.image.index], "cond_re").filter((f) => args.labels.includes(f.label));
  const kept = prevFindings.filter((f) => !(f.photoIndex === args.image.index && args.labels.includes(f.label)));
  return finaliseCondition({
    findings: [...kept, ...fresh],
    notVisible: prevDetails.notVisible ?? [],
    modelContradictions: (prevDetails.contradictions ?? []).filter((c) => !/^Described as "/.test(c)),
    facts: args.facts,
    needs: args.needs,
    photosChecked: prevDetails.photosChecked ?? 1,
  });
}
