import fs from "node:fs/promises";
import path from "node:path";
import { hashObject, sha256 } from "./hash";
import type { Store } from "./store";

export type CacheMode = "off" | "record" | "replay";

/**
 * Record/replay cache for Gemini calls and image downloads (spec section 10).
 * Layered: local files under data/cache (so a stage demo works with no network, including no Neon),
 * then the CacheEntry table when a database is configured.
 */
export class ResponseCache {
  constructor(
    private readonly mode: CacheMode,
    private readonly store: Pick<Store, "cacheGet" | "cacheSet"> | null,
    private readonly dir: string | null = path.join(process.cwd(), "data", "cache"),
  ) {}

  get enabled() {
    return this.mode !== "off";
  }
  get replaying() {
    return this.mode === "replay";
  }

  /** Key: hash(stage, model, normalised inputs, PIPELINE_VERSION); images are hashed by content (see hash.ts). */
  static key(parts: { stage: string; model: string; input: unknown; pipelineVersion: string }): string {
    return hashObject({ s: parts.stage, m: parts.model, i: normalise(parts.input), v: parts.pipelineVersion });
  }

  async get<T>(namespace: string, key: string): Promise<T | undefined> {
    if (!this.enabled) return undefined;
    if (this.dir) {
      try {
        const raw = await fs.readFile(path.join(this.dir, namespace, `${key}.json`), "utf8");
        return JSON.parse(raw) as T;
      } catch {
        /* miss */
      }
    }
    if (this.store) {
      try {
        const v = await this.store.cacheGet(`${namespace}:${key}`);
        if (v !== undefined) return v as T;
      } catch {
        /* db unreachable in offline demo: ignore */
      }
    }
    return undefined;
  }

  async set(namespace: string, key: string, value: unknown): Promise<void> {
    if (!this.enabled) return;
    if (this.dir) {
      try {
        await fs.mkdir(path.join(this.dir, namespace), { recursive: true });
        await fs.writeFile(path.join(this.dir, namespace, `${key}.json`), JSON.stringify(value));
      } catch {
        /* read-only fs: ignore */
      }
    }
    if (this.store) {
      try {
        await this.store.cacheSet(`${namespace}:${key}`, value);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Replace inline base64 image data with its content hash so keys stay small and content-addressed. */
function normalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj.inlineData && typeof (obj.inlineData as { data?: unknown }).data === "string") {
      const d = obj.inlineData as { data: string; mimeType?: string };
      return { inlineData: { mimeType: d.mimeType, sha256: sha256(d.data) } };
    }
    if (obj.abortSignal) {
      const { abortSignal: _drop, ...rest } = obj;
      return normalise(rest);
    }
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, normalise(v)]));
  }
  return value;
}

/** Deterministic "realistic" replay delay between 300 and 900 ms, derived from the key. */
export function replayDelayMs(key: string): number {
  return 300 + (parseInt(key.slice(0, 6), 16) % 601);
}
