/**
 * Re-run today's redaction over every stored case, in the main database and the test-runs branch:
 *   npx tsx scripts/redact-stored.ts            dry run: what would change, per table
 *   npx tsx scripts/redact-stored.ts --apply    write the changes (originals of changed rows go to a backup file in the OS temp dir)
 *   npx tsx scripts/redact-stored.ts --verify   search both databases and eval/listings for every known identity
 *
 * Covers page text and seller replies (full redact()), survey cards and structured listing data (JSON), case JSON
 * columns (listing facts, identify, verdict, next moves, history, needs), check results and their evidence, leads,
 * cached responses (CacheEntry: the only stored model/search output; prompts and logs aren't stored), and every URL.
 *
 * Known identities: identifiers collected from the stored data (seller cards, feedback replies, store links) are added
 * to data/private/known-identities.txt (gitignored, one per line), which --verify searches for. Never commit them.
 */
import "../lib/loadEnv";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import { collectIdentifiers, countMatches, redactJson, redactString, redactTextColumn } from "../lib/redactStored";

neonConfig.webSocketConstructor = ws;

const KNOWN = path.join(process.cwd(), "data", "private", "known-identities.txt");
const apply = process.argv.includes("--apply");
const verifyOnly = process.argv.includes("--verify");

const dbs = [
  { name: "main", url: process.env.DATABASE_URL },
  { name: "test-runs", url: process.env.TEST_DATABASE_URL },
].filter((d): d is { name: string; url: string } => !!d.url);
if (dbs.length < 2) console.warn("Only one database configured: set DATABASE_URL and TEST_DATABASE_URL to cover both.");

const readKnown = () =>
  fs.existsSync(KNOWN)
    ? fs.readFileSync(KNOWN, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    : [];

type Rows = {
  cases: { id: string; pageUrl: string | null; [col: string]: unknown }[];
  inputs: { id: string; kind: string; text: string | null; sourceUrl: string | null }[];
  checks: { id: string; result: unknown }[];
  leads: { id: string; lead: unknown }[];
  cache: { key: string; value: unknown }[];
};
const CASE_JSON = ["needs", "listingFacts", "identify", "verdict", "nextMoves", "history", "answered"] as const;

async function load(pool: Pool): Promise<Rows> {
  const q = async <T>(sql: string) => (await pool.query(sql)).rows as T[];
  return {
    cases: await q(`select id, "pageUrl", ${CASE_JSON.map((c) => `"${c}"`).join(", ")} from "Case"`),
    inputs: await q(`select id, kind, text, "sourceUrl" from "CaseInput" where text is not null or "sourceUrl" is not null`),
    checks: await q(`select id, result from "CheckRecord"`),
    leads: await q(`select id, lead from "LeadRecord"`),
    cache: await q(`select key, value from "CacheEntry"`),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function redactDb(name: string, pool: Pool, rows: Rows, ids: string[]) {
  const changed = { Case: 0, CaseInput: 0, CheckRecord: 0, LeadRecord: 0, CacheEntry: 0 };
  const backup: Record<string, unknown[]> = { Case: [], CaseInput: [], CheckRecord: [], LeadRecord: [], CacheEntry: [] };
  const writes: { sql: string; params: unknown[] }[] = [];

  for (const c of rows.cases) {
    const pageUrl = c.pageUrl ? redactString(c.pageUrl, ids) : null;
    const cols = Object.fromEntries(CASE_JSON.map((k) => [k, c[k] == null ? c[k] : redactJson(c[k], ids)]));
    const diff = CASE_JSON.filter((k) => !same(cols[k], c[k]));
    if (pageUrl === c.pageUrl && !diff.length) continue;
    changed.Case++;
    backup.Case.push(c);
    const sets = [`"pageUrl" = $2`, ...diff.map((k, i) => `"${k}" = $${i + 3}::jsonb`)];
    writes.push({ sql: `update "Case" set ${sets.join(", ")} where id = $1`, params: [c.id, pageUrl, ...diff.map((k) => JSON.stringify(cols[k]))] });
  }
  for (const i of rows.inputs) {
    const text = i.text == null ? null : redactTextColumn(i.text, i.kind, ids);
    const sourceUrl = i.sourceUrl == null ? null : redactString(i.sourceUrl, ids);
    if (text === i.text && sourceUrl === i.sourceUrl) continue;
    changed.CaseInput++;
    backup.CaseInput.push(i);
    writes.push({ sql: `update "CaseInput" set text = $2, "sourceUrl" = $3 where id = $1`, params: [i.id, text, sourceUrl] });
  }
  const jsonTable = <K extends "checks" | "leads" | "cache">(key: K, table: keyof typeof changed, idCol: string, col: string) => {
    for (const r of rows[key] as Record<string, unknown>[]) {
      const next = redactJson(r[col], ids);
      if (same(next, r[col])) continue;
      changed[table]++;
      backup[table].push(r);
      writes.push({ sql: `update "${table}" set "${col}" = $2::jsonb where "${idCol}" = $1`, params: [r[idCol], JSON.stringify(next)] });
    }
  };
  jsonTable("checks", "CheckRecord", "id", "result");
  jsonTable("leads", "LeadRecord", "id", "lead");
  jsonTable("cache", "CacheEntry", "key", "value");

  const total = Object.values(changed).reduce((a, b) => a + b, 0);
  console.log(`${name}: ${total} record${total === 1 ? "" : "s"} ${apply ? "changed" : "would change"} ${JSON.stringify(changed)}`);
  if (!apply || !writes.length) return changed;
  const file = path.join(os.tmpdir(), `sleuth-redact-backup-${name}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(backup), { mode: 0o600 });
  console.log(`  originals of the changed rows: ${file} (delete it once you're happy)`);
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const w of writes) await client.query(w.sql, w.params);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
  return changed;
}

function haystacks(rows: Rows): Record<string, string> {
  return {
    Case: JSON.stringify(rows.cases),
    CaseInput: JSON.stringify(rows.inputs),
    CheckRecord: JSON.stringify(rows.checks),
    LeadRecord: JSON.stringify(rows.leads),
    CacheEntry: JSON.stringify(rows.cache),
  };
}

function evalFiles(): string {
  const dir = path.join(process.cwd(), "eval", "listings");
  if (!fs.existsSync(dir)) return "";
  return fs
    .readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".json"))
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
    .join("\n");
}

async function main() {
  const pools = dbs.map((d) => ({ ...d, pool: new Pool({ connectionString: d.url }) }));
  try {
    const loaded = await Promise.all(pools.map(async (p) => ({ ...p, rows: await load(p.pool) })));
    if (!verifyOnly) {
      // Identifiers from every database, so a name seen in one is masked in the other.
      const texts = loaded.flatMap((l) => l.rows.inputs.filter((i) => i.kind === "page_text" || i.kind === "seller_reply").map((i) => i.text ?? ""));
      const urls = loaded.flatMap((l) => JSON.stringify(l.rows).match(/https?:\/\/[^"\s\\]+/g) ?? []);
      const known = readKnown();
      const found = collectIdentifiers(texts, urls);
      const ids = [...new Set([...known, ...found])].sort((a, b) => b.length - a.length);
      const added = found.filter((f) => !known.includes(f));
      console.log(`${ids.length} identifiers (${known.length} known, ${added.length} newly found)`);
      if (apply && added.length) {
        fs.mkdirSync(path.dirname(KNOWN), { recursive: true });
        fs.appendFileSync(KNOWN, `${fs.existsSync(KNOWN) ? "" : "# Seller identities found in stored data. Gitignored: never commit.\n"}${added.join("\n")}\n`);
      }
      for (const l of loaded) await redactDb(l.name, l.pool, l.rows, ids);
      if (!apply) console.log("Dry run: nothing written. Run with --apply to write.");
      if (!apply) return;
    }
    // Verify: every known identity, in every table of both databases and in the eval set.
    const names = readKnown();
    if (!names.length) throw new Error(`No known identities in ${KNOWN}`);
    let any = 0;
    for (const p of pools) {
      const rows = await load(p.pool);
      for (const [table, text] of Object.entries(haystacks(rows))) {
        const hits = countMatches(text, names);
        const n = Object.values(hits).reduce((a, b) => a + b, 0);
        any += n;
        console.log(`verify ${p.name}.${table}: ${n} match${n === 1 ? "" : "es"}${n ? ` ${JSON.stringify(hits)}` : ""}`);
      }
    }
    const e = countMatches(evalFiles(), names);
    const en = Object.values(e).reduce((a, b) => a + b, 0);
    any += en;
    console.log(`verify eval/listings: ${en} match${en === 1 ? "" : "es"}${en ? ` ${JSON.stringify(e)}` : ""}`);
    console.log(any ? `FAIL: ${any} matches for ${names.length} known identities` : `OK: 0 matches for ${names.length} known identities`);
    if (any) process.exitCode = 1;
  } finally {
    await Promise.all(pools.map((p) => p.pool.end()));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
