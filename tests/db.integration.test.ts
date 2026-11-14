/**
 * Opt-in integration test against the real Neon database (PrismaStore + Neon adapter), with mocked Gemini.
 *   RUN_DB_TESTS=1 npx vitest run tests/db.integration.test.ts
 * Requires DATABASE_URL in .env.local / .env, a migrated schema and `npm run seed`. Cleans up its own case.
 */
import fs from "node:fs";
import { parse } from "dotenv";
import { afterAll, describe, expect, it } from "vitest";
import { createCase } from "@/pipeline";
import { startReopen } from "@/pipeline/reopen";
import { buildFeed, caseDetail } from "@/pipeline/views";
import { CaseDetailSchema } from "@/schemas";
import type { Db } from "@/lib/db";
import { json, makeDeps, PAGE_TEXT, PROFILE } from "./helpers";

const env = Object.assign({}, ...[".env", ".env.local"].filter((f) => fs.existsSync(f)).map((f) => parse(fs.readFileSync(f))));
const enabled = process.env.RUN_DB_TESTS === "1" && !!env.DATABASE_URL;

describe.skipIf(!enabled)("Neon integration (PrismaStore)", () => {
  let db: Db;
  const created: string[] = [];

  afterAll(async () => {
    if (db) {
      await db.case.deleteMany({ where: { id: { in: created } } });
      await db.$disconnect();
    }
  });

  it("runs an investigation, reopen and share end to end against Neon", async () => {
    const [{ getDb }, { PrismaStore }] = await Promise.all([import("@/lib/db"), import("@/lib/prismaStore")]);
    db = getDb(env.DATABASE_URL);
    const store = new PrismaStore(db);
    const ref = await store.getReference();
    expect(ref.catalogue.find((m) => m.id === "nike-pegasus-40")).toBeTruthy();

    const deps = { ...makeDeps({ handlers: { reopen: () => json({ conditionStatements: ["No marks on the soles"], answers: ["condition"] }) } }), store };
    const { caseId, done } = await createCase(deps, {
      capture: { pageUrl: "https://www.vinted.co.uk/items/1", pageText: PAGE_TEXT, imageUrls: ["https://img.example.com/1.jpg"] },
      profile: PROFILE,
      screenshots: [],
    });
    created.push(caseId);
    await done;

    const c = (await store.getCase(caseId))!;
    expect(c.status).toBe("closed");
    expect(c.verdict?.label).toBeTruthy();
    expect((await store.getChecks(caseId, 1)).map((x) => x.check)).toEqual(["identify", "fit", "price", "comfort", "condition"]);
    const [img] = await store.getInputs(caseId, { kinds: ["image"] });
    expect(img.data?.length).toBeGreaterThan(60);
    const detail = CaseDetailSchema.parse(await caseDetail(deps, c, "http://localhost:3000"));
    expect(detail.history).toHaveLength(1);

    const r = await startReopen(deps, caseId, { sellerReply: "No marks on the soles.", screenshots: [] });
    await r!.done;
    const after = (await store.getCase(caseId))!;
    expect(after.revision).toBe(2);
    expect(after.answered).toContain("condition");
    expect(await store.getChecks(caseId, 2)).toHaveLength(5);

    // Exercise the JSON-path filter used by the feed (verdict.label = hidden_gem AND shareOptIn).
    expect((await store.listSharedHiddenGems(50)).some((x) => x.id === caseId)).toBe(false);
    await store.updateCase(caseId, { shareOptIn: true, verdict: { ...after.verdict!, label: "hidden_gem" } });
    expect((await store.listSharedHiddenGems(50)).some((x) => x.id === caseId)).toBe(true);
    const feed = await buildFeed(deps, {});
    expect(feed.some((f) => f.caseId === caseId)).toBe(true);
  }, 60_000);
});
