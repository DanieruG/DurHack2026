import { randomBytes } from "node:crypto";
import type {
  CaseStatus,
  CheckName,
  CheckResult,
  IdentifyResult,
  Lead,
  LeadsReport,
  ListingFacts,
  NextMove,
  Platform,
  UserNeeds,
  Verdict,
  VerdictLabel,
  WarningSignal,
} from "@/schemas/domain";
import type { ReferenceData } from "./seedData";

/** `run`: the investigation's totals (as in investigation_done), so a case file opened later can show them. */
export type HistoryEntry = { revision: number; verdictLabel: VerdictLabel; at: string; leads?: LeadsReport; run?: RunTotals; warningSignals?: WarningSignal[] };
export type RunTotals = { durationMs: number; geminiCalls: number; cachedCalls: number };

export type CaseRow = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  status: CaseStatus;
  platform: Platform;
  pageUrl: string | null;
  revision: number;
  inputHash: string;
  needs: UserNeeds;
  listingFacts: ListingFacts | null;
  identify: IdentifyResult | null;
  verdict: Verdict | null;
  nextMoves: NextMove[] | null;
  shareOptIn: boolean;
  history: HistoryEntry[];
  answered: CheckName[];
};

export type NewCase = Pick<CaseRow, "status" | "platform" | "pageUrl" | "inputHash" | "needs">;
export type CasePatch = Partial<Omit<CaseRow, "id" | "createdAt" | "updatedAt">>;

/**
 * observed_listings: the matched subset of the user's search survey (JSON in `text`; see lib/observed.ts StoredSurvey).
 * listing_data: the extension's structured fields for this listing, redacted (ListingData JSON in `text`, each field
 * with its source).
 */
export type InputKind = "image" | "screenshot" | "page_text" | "seller_reply" | "observed_listings" | "listing_data" | "pause_state";

export type CaseInputRow = {
  id: string;
  caseId: string;
  revision: number;
  kind: InputKind;
  mimeType: string | null;
  data: Uint8Array | null;
  text: string | null;
  sourceUrl: string | null;
  position: number;
  createdAt: Date;
};

export type NewInput = Omit<CaseInputRow, "id" | "caseId" | "createdAt" | "position" | "mimeType" | "data" | "text" | "sourceUrl"> &
  Partial<Pick<CaseInputRow, "mimeType" | "data" | "text" | "sourceUrl" | "position">>;

export interface Store {
  readonly kind: "memory" | "prisma";
  createCase(data: NewCase): Promise<CaseRow>;
  getCase(id: string): Promise<CaseRow | null>;
  updateCase(id: string, patch: CasePatch): Promise<CaseRow>;
  listCases(ids: string[]): Promise<CaseRow[]>;
  listSharedHiddenGems(limit: number): Promise<CaseRow[]>;

  addInputs(caseId: string, inputs: NewInput[]): Promise<CaseInputRow[]>;
  /** Inputs ordered by revision, then position. */
  getInputs(caseId: string, filter?: { kinds?: InputKind[]; revision?: number; withData?: boolean }): Promise<CaseInputRow[]>;
  setInputKind(ids: string[], kind: InputKind): Promise<void>;

  /** Appends check records; getChecks returns the latest record per check for the revision. */
  saveChecks(caseId: string, revision: number, results: CheckResult[]): Promise<void>;
  getChecks(caseId: string, revision: number): Promise<CheckResult[]>;
  saveLeads(caseId: string, revision: number, leads: Lead[]): Promise<void>;
  getLeads(caseId: string, revision: number): Promise<Lead[]>;

  getReference(): Promise<ReferenceData>;

  cacheGet(key: string): Promise<unknown | undefined>;
  cacheSet(key: string, value: unknown): Promise<void>;
}

/** Unguessable case id (cuid-like: lowercase alnum, starts with a letter). */
export function newId(): string {
  return "c" + randomBytes(16).toString("base64url").replace(/[^a-zA-Z0-9]/g, "").toLowerCase().slice(0, 24).padEnd(24, "0");
}

export const CHECK_ORDER: CheckName[] = ["identify", "fit", "price", "comfort", "condition", "colour"];

export function latestPerCheck(records: { check: string; result: CheckResult }[]): CheckResult[] {
  const map = new Map<string, CheckResult>();
  for (const r of records) map.set(r.check, r.result);
  return CHECK_ORDER.filter((c) => map.has(c)).map((c) => map.get(c)!);
}

// ---------- in-memory implementation (tests, and local dev without DATABASE_URL) ----------

export class MemoryStore implements Store {
  readonly kind = "memory" as const;
  private cases = new Map<string, CaseRow>();
  private inputs: CaseInputRow[] = [];
  private checks: { caseId: string; revision: number; check: string; result: CheckResult }[] = [];
  private leads: { caseId: string; revision: number; lead: Lead }[] = [];
  private cache = new Map<string, unknown>();

  constructor(private readonly reference: ReferenceData | (() => ReferenceData)) {}

  async createCase(data: NewCase): Promise<CaseRow> {
    const now = new Date();
    const row: CaseRow = {
      id: newId(),
      createdAt: now,
      updatedAt: now,
      revision: 1,
      listingFacts: null,
      identify: null,
      verdict: null,
      nextMoves: null,
      shareOptIn: false,
      history: [],
      answered: [],
      ...structuredClone(data),
    };
    this.cases.set(row.id, row);
    return structuredClone(row);
  }

  async getCase(id: string) {
    const c = this.cases.get(id);
    return c ? structuredClone(c) : null;
  }

  async updateCase(id: string, patch: CasePatch) {
    const c = this.cases.get(id);
    if (!c) throw new Error(`Case ${id} not found`);
    const next = { ...c, ...structuredClone(patch), updatedAt: new Date() };
    this.cases.set(id, next);
    return structuredClone(next);
  }

  async listCases(ids: string[]) {
    return ids.map((id) => this.cases.get(id)).filter((c): c is CaseRow => !!c).map((c) => structuredClone(c));
  }

  async listSharedHiddenGems(limit: number) {
    return [...this.cases.values()]
      .filter((c) => c.shareOptIn && c.verdict?.label === "hidden_gem")
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, limit)
      .map((c) => structuredClone(c));
  }

  async addInputs(caseId: string, inputs: NewInput[]) {
    const existing = this.inputs.filter((i) => i.caseId === caseId).length;
    const rows = inputs.map((i, n) => ({
      id: newId(),
      caseId,
      createdAt: new Date(),
      mimeType: null,
      data: null,
      text: null,
      sourceUrl: null,
      ...i,
      position: i.position ?? existing + n,
    }));
    this.inputs.push(...rows);
    return rows.map((r) => ({ ...r }));
  }

  async getInputs(caseId: string, filter: { kinds?: InputKind[]; revision?: number } = {}) {
    return this.inputs
      .filter(
        (i) =>
          i.caseId === caseId &&
          (!filter.kinds || filter.kinds.includes(i.kind)) &&
          (filter.revision === undefined || i.revision === filter.revision),
      )
      .sort((a, b) => a.revision - b.revision || a.position - b.position)
      .map((r) => ({ ...r }));
  }

  async setInputKind(ids: string[], kind: InputKind) {
    for (const i of this.inputs) if (ids.includes(i.id)) i.kind = kind;
  }

  async saveChecks(caseId: string, revision: number, results: CheckResult[]) {
    for (const r of results) this.checks.push({ caseId, revision, check: r.check, result: structuredClone(r) });
  }

  async getChecks(caseId: string, revision: number) {
    return structuredClone(latestPerCheck(this.checks.filter((c) => c.caseId === caseId && c.revision === revision)));
  }

  async saveLeads(caseId: string, revision: number, leads: Lead[]) {
    for (const lead of leads) this.leads.push({ caseId, revision, lead: structuredClone(lead) });
  }

  async getLeads(caseId: string, revision: number) {
    return this.leads.filter((l) => l.caseId === caseId && l.revision === revision).map((l) => structuredClone(l.lead));
  }

  async getReference() {
    return typeof this.reference === "function" ? this.reference() : this.reference;
  }

  async cacheGet(key: string) {
    return this.cache.has(key) ? structuredClone(this.cache.get(key)) : undefined;
  }

  async cacheSet(key: string, value: unknown) {
    this.cache.set(key, structuredClone(value));
  }
}
