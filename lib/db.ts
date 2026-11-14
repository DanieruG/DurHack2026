import { neonConfig } from "@neondatabase/serverless";
import { PrismaNeon } from "@prisma/adapter-neon";
import ws from "ws";
// Prisma 7: PrismaClient comes from the generated output path, not @prisma/client.
import { PrismaClient } from "@/generated/prisma/client";

neonConfig.webSocketConstructor = ws;

export type Db = InstanceType<typeof PrismaClient>;

const g = globalThis as unknown as { __sleuthPrisma?: Db };

/** Runtime Prisma client using the Neon driver adapter and the pooled DATABASE_URL. */
export function getDb(connectionString = process.env.DATABASE_URL): Db {
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  if (!g.__sleuthPrisma) {
    const adapter = new PrismaNeon({ connectionString });
    g.__sleuthPrisma = new PrismaClient({ adapter });
  }
  return g.__sleuthPrisma;
}
