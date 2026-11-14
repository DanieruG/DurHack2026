import "./lib/loadEnv";
import { defineConfig } from "prisma/config";

// Prisma 7: the connection URL lives here, not in schema.prisma.
// The CLI (migrate, studio) uses the direct (unpooled) Neon connection.
// The runtime client uses the pooled DATABASE_URL via the Neon adapter (lib/db.ts).
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations", seed: "tsx scripts/seed.ts" },
  datasource: {
    url: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "",
  },
});
