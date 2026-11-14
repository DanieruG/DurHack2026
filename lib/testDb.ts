/**
 * Test runs (eval, reruns, DB integration tests) use the Neon branch "test-runs" (TEST_DATABASE_URL), never the main
 * database. Call this before getDeps()/getDb() in those scripts.
 */
export function useTestDatabase(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.TEST_DATABASE_URL?.trim();
  if (!url) throw new Error("TEST_DATABASE_URL is not set: test runs must not touch the main database (see README)");
  env.DATABASE_URL = url;
  env.DATABASE_URL_UNPOOLED = url;
  return url;
}
