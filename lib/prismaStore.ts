import type { CheckResult, Lead } from "@/schemas/domain";
import type { Db } from "./db";
import type { ReferenceData } from "./seedData";
import {
  latestPerCheck,
  type CaseInputRow,
  type CasePatch,
  type CaseRow,
  type InputKind,
  type NewCase,
  type NewInput,
  type Store,
} from "./store";

type AnyJson = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const REFERENCE_TTL_MS = 5 * 60_000;

function toCaseRow(r: AnyJson): CaseRow {
  return {
    id: r.id,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    status: r.status,
    platform: r.platform,
    pageUrl: r.pageUrl,
    revision: r.revision,
    inputHash: r.inputHash,
    needs: r.needs,
    listingFacts: r.listingFacts ?? null,
    identify: r.identify ?? null,
    verdict: r.verdict ?? null,
    nextMoves: r.nextMoves ?? null,
    shareOptIn: r.shareOptIn,
    history: r.history ?? [],
    answered: r.answered ?? [],
  };
}

/** JSON columns: Prisma wants DbNull for "no value" on nullable Json fields; undefined skips the field. */
function jsonPatch(patch: CasePatch): AnyJson {
  const out: AnyJson = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = v === null ? null : v;
  }
  return out;
}

function toInputRow(r: AnyJson): CaseInputRow {
  return {
    id: r.id,
    caseId: r.caseId,
    revision: r.revision,
    kind: r.kind,
    mimeType: r.mimeType,
    data: r.data ? new Uint8Array(r.data) : null,
    text: r.text,
    sourceUrl: r.sourceUrl,
    position: r.position,
    createdAt: r.createdAt,
  };
}

export class PrismaStore implements Store {
  readonly kind = "prisma" as const;
  private ref?: { at: number; data: ReferenceData };

  constructor(private readonly db: Db) {}

  async createCase(data: NewCase) {
    const r = await this.db.case.create({ data: { ...data, needs: data.needs as AnyJson, history: [], answered: [] } });
    return toCaseRow(r);
  }

  async getCase(id: string) {
    const r = await this.db.case.findUnique({ where: { id } });
    return r ? toCaseRow(r) : null;
  }

  async updateCase(id: string, patch: CasePatch) {
    const r = await this.db.case.update({ where: { id }, data: jsonPatch(patch) });
    return toCaseRow(r);
  }

  async listCases(ids: string[]) {
    const rows = await this.db.case.findMany({ where: { id: { in: ids } } });
    const byId = new Map(rows.map((r: AnyJson) => [r.id, toCaseRow(r)]));
    return ids.map((id) => byId.get(id)).filter((c): c is CaseRow => !!c);
  }

  async listSharedHiddenGems(limit: number) {
    const rows = await this.db.case.findMany({
      where: { shareOptIn: true, verdict: { path: ["label"], equals: "hidden_gem" } },
      orderBy: { updatedAt: "desc" },
      take: limit,
    });
    return rows.map(toCaseRow);
  }

  async addInputs(caseId: string, inputs: NewInput[]) {
    const existing = await this.db.caseInput.count({ where: { caseId } });
    const created = await this.db.$transaction(
      inputs.map((i, n) =>
        this.db.caseInput.create({
          data: {
            caseId,
            revision: i.revision,
            kind: i.kind,
            mimeType: i.mimeType ?? null,
            data: i.data ? Buffer.from(i.data) : null,
            text: i.text ?? null,
            sourceUrl: i.sourceUrl ?? null,
            position: i.position ?? existing + n,
          },
        }),
      ),
    );
    return created.map(toInputRow);
  }

  async getInputs(caseId: string, filter: { kinds?: InputKind[]; revision?: number; withData?: boolean } = {}) {
    const rows = await this.db.caseInput.findMany({
      where: { caseId, ...(filter.kinds ? { kind: { in: filter.kinds } } : {}), ...(filter.revision !== undefined ? { revision: filter.revision } : {}) },
      orderBy: [{ revision: "asc" }, { position: "asc" }],
      ...(filter.withData === false ? { omit: { data: true } } : {}),
    });
    return rows.map(toInputRow);
  }

  async setInputKind(ids: string[], kind: InputKind) {
    await this.db.caseInput.updateMany({ where: { id: { in: ids } }, data: { kind } });
  }

  async saveChecks(caseId: string, revision: number, results: CheckResult[]) {
    if (!results.length) return;
    await this.db.checkRecord.createMany({
      data: results.map((r) => ({ caseId, revision, check: r.check, result: r as AnyJson })),
    });
  }

  async getChecks(caseId: string, revision: number) {
    const rows = await this.db.checkRecord.findMany({ where: { caseId, revision }, orderBy: { createdAt: "asc" } });
    return latestPerCheck(rows.map((r: AnyJson) => ({ check: r.check, result: r.result as CheckResult })));
  }

  async saveLeads(caseId: string, revision: number, leads: Lead[]) {
    if (!leads.length) return;
    await this.db.leadRecord.createMany({ data: leads.map((lead) => ({ caseId, revision, lead: lead as AnyJson })) });
  }

  async getLeads(caseId: string, revision: number) {
    const rows = await this.db.leadRecord.findMany({ where: { caseId, revision } });
    return rows.map((r: AnyJson) => r.lead as Lead);
  }

  async getReference(): Promise<ReferenceData> {
    if (this.ref && Date.now() - this.ref.at < REFERENCE_TTL_MS) return this.ref.data;
    const [catalogue, sizeCharts, priceSamples, reviews] = await Promise.all([
      this.db.catalogueModel.findMany(),
      this.db.sizeChart.findMany(),
      this.db.priceSample.findMany(),
      this.db.reviewSnippet.findMany(),
    ]);
    const data: ReferenceData = {
      catalogue: catalogue.map((m: AnyJson) => ({ ...m, aliases: m.aliases as string[], matchTokens: m.matchTokens ?? null })),
      sizeCharts: sizeCharts.map((c: AnyJson) => ({ id: c.id, brand: c.brand, rows: c.rows })),
      priceSamples: priceSamples.map((s: AnyJson) => ({
        modelId: s.modelId,
        priceGBP: s.priceGBP,
        condition: s.condition,
        platform: s.platform,
        collectedOn: s.collectedOn.toISOString().slice(0, 10),
        ruleId: s.ruleId,
      })),
      reviews: reviews.map((r: AnyJson) => ({
        modelId: r.modelId, text: r.text, url: r.url, title: r.title, sourceType: r.sourceType, topics: r.topics,
      })),
    };
    this.ref = { at: Date.now(), data };
    return data;
  }

  async cacheGet(key: string) {
    const r = await this.db.cacheEntry.findUnique({ where: { key } });
    return r ? r.value : undefined;
  }

  async cacheSet(key: string, value: unknown) {
    await this.db.cacheEntry.upsert({ where: { key }, create: { key, value: value as AnyJson }, update: { value: value as AnyJson } });
  }
}
