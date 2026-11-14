/**
 * Apply pending Prisma migrations over Neon's WebSocket driver (port 443), for networks that block Postgres
 * port 5432 (e.g. venue Wi-Fi), where `prisma migrate deploy` fails with P1001.
 *
 * Applies prisma/migrations/<name>/migration.sql in order, each in a transaction, and records it in
 * _prisma_migrations with the same checksum Prisma uses, so `prisma migrate deploy/status` agree afterwards.
 * It does not create migrations: generate them with `prisma migrate diff` or `prisma migrate dev` first.
 *
 *   npm run db:migrate:https
 */
import "../lib/loadEnv";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

const MIGRATIONS = path.join(process.cwd(), "prisma", "migrations");

async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL_UNPOOLED / DATABASE_URL is not set");
  const pool = new Pool({ connectionString: url });
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      "id" VARCHAR(36) PRIMARY KEY NOT NULL,
      "checksum" VARCHAR(64) NOT NULL,
      "finished_at" TIMESTAMPTZ,
      "migration_name" VARCHAR(255) NOT NULL,
      "logs" TEXT,
      "rolled_back_at" TIMESTAMPTZ,
      "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "applied_steps_count" INTEGER NOT NULL DEFAULT 0
    )`);
    const applied = await pool.query(`SELECT migration_name, checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`);
    const done = new Map(applied.rows.map((r: { migration_name: string; checksum: string }) => [r.migration_name, r.checksum]));

    const names = fs.readdirSync(MIGRATIONS).filter((n) => fs.existsSync(path.join(MIGRATIONS, n, "migration.sql"))).sort();
    let count = 0;
    for (const name of names) {
      const sql = fs.readFileSync(path.join(MIGRATIONS, name, "migration.sql"), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      if (done.has(name)) {
        if (done.get(name) !== checksum) console.warn(`⚠  ${name} was modified after it was applied (checksum differs)`);
        continue;
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          `INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, applied_steps_count) VALUES ($1, $2, now(), $3, 1)`,
          [randomUUID(), checksum, name],
        );
        await client.query("COMMIT");
        console.log(`Applied ${name}`);
        count++;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new Error(`Migration ${name} failed: ${err instanceof Error ? err.message : err}`);
      } finally {
        client.release();
      }
    }
    console.log(count ? `${count} migration(s) applied.` : "Database is up to date.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
