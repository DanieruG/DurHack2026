import { createHash } from "node:crypto";

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Deterministic JSON: object keys sorted recursively, so equal inputs hash equally. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value instanceof Uint8Array) return { $bytes: sha256(value) };
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function hashObject(value: unknown): string {
  return sha256(stableStringify(value));
}

/** inputHash for a case: image content + text + needs + PIPELINE_VERSION (spec 7.1). */
export function computeInputHash(args: {
  images: Uint8Array[];
  text?: string;
  needs: unknown;
  pipelineVersion: string;
}): string {
  return hashObject({
    images: args.images.map((b) => sha256(b)),
    text: args.text ?? "",
    needs: args.needs,
    v: args.pipelineVersion,
  });
}
