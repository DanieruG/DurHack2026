import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { createGeminiClient, GeminiError, withCallLog, type GenResponse } from "@/gemini/client";
import { extractJson, generateStructured, StructuredOutputError, toGeminiSchema } from "@/gemini/structured";
import { makeToolExecutors, runToolLoop } from "@/gemini/tools";
import { ResponseCache } from "@/lib/cache";
import { testConfig } from "@/lib/config";
import { fixtureReference } from "./helpers";

const Schema = z.object({ answer: z.number() });
const res = (text: string, extra: Partial<GenResponse> = {}): GenResponse => ({ text, functionCalls: [], ...extra });
const client = (responses: (GenResponse | Error)[], cache?: ResponseCache) => {
  const seen: unknown[] = [];
  const c = createGeminiClient({
    config: testConfig(),
    cache,
    retryBackoffMs: 1,
    transport: async (req) => {
      seen.push(req);
      const r = responses.shift();
      if (!r) throw new Error("no more responses");
      if (r instanceof Error) throw r;
      return r;
    },
  });
  return { c, seen };
};

describe("generateStructured", () => {
  it("sends the JSON schema through structured output config and validates", async () => {
    const { c, seen } = client([res('{"answer": 42}')]);
    const out = await generateStructured(c, Schema, { stage: "t", tier: "fast", parts: [{ text: "q" }] });
    expect(out.data).toEqual({ answer: 42 });
    const cfg = (seen[0] as { config: Record<string, unknown> }).config;
    expect(cfg.responseMimeType).toBe("application/json");
    expect(cfg.responseJsonSchema).toMatchObject({ type: "object", properties: { answer: { type: "number" } } });
  });
  it("retries once with the validation error appended, then succeeds", async () => {
    const { c, seen } = client([res('{"answer": "nope"}'), res('{"answer": 1}')]);
    const out = await generateStructured(c, Schema, { stage: "t", tier: "fast", parts: [{ text: "q" }] });
    expect(out.data.answer).toBe(1);
    const second = seen[1] as { contents: { parts: { text?: string }[] }[] };
    expect(JSON.stringify(second.contents.at(-1))).toMatch(/previous output was invalid/);
  });
  it("throws after the retry also fails", async () => {
    const { c } = client([res("not json"), res('{"answer": "x"}')]);
    await expect(generateStructured(c, Schema, { stage: "t", tier: "fast", parts: [] })).rejects.toBeInstanceOf(StructuredOutputError);
  });
  it("extracts JSON from fenced / chatty text", () => {
    expect(extractJson('Sure! ```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here: {"a": {"b": "}"}} trailing')).toEqual({ a: { b: "}" } });
  });
  it("produces a Gemini-friendly schema without $schema/additionalProperties", () => {
    expect(JSON.stringify(toGeminiSchema(z.object({ a: z.string().nullish() })))).not.toMatch(/\$schema|additionalProperties/);
  });
});

describe("client", () => {
  it("retries once on 429/5xx", async () => {
    const { c, seen } = client([new GeminiError("rate limited", 429), res("ok")]);
    expect((await c.generate({ stage: "t", tier: "fast", contents: [] })).text).toBe("ok");
    expect(seen).toHaveLength(2);
  });
  it("does not retry 4xx", async () => {
    const { c, seen } = client([new GeminiError("bad", 400), res("ok")]);
    await expect(c.generate({ stage: "t", tier: "fast", contents: [] })).rejects.toThrow("bad");
    expect(seen).toHaveLength(1);
  });
  it("reads model names from config per tier and logs calls per case", async () => {
    const { c, seen } = client([res("a"), res("b")]);
    const { log, run } = withCallLog("case1", async () => {
      await c.generate({ stage: "x", tier: "fast", contents: [] });
      await c.generate({ stage: "y", tier: "strong", contents: [] });
    });
    await run;
    expect((seen as { model: string }[]).map((s) => s.model)).toEqual(["test-fast", "test-strong"]);
    expect(log.map((l) => [l.caseId, l.stage, l.model])).toEqual([["case1", "x", "test-fast"], ["case1", "y", "test-strong"]]);
  });
  it("fails clearly when a model tier is not configured", async () => {
    const c = createGeminiClient({ config: testConfig({ models: {} }), transport: async () => res("x") });
    await expect(c.generate({ stage: "t", tier: "fast", contents: [] })).rejects.toThrow(/GEMINI_MODEL_FAST/);
  });
});

describe("record / replay cache", () => {
  it("records then replays without calling the transport (image content hashed)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sleuth-cache-"));
    const req = { stage: "t", tier: "fast" as const, contents: [{ role: "user" as const, parts: [{ inlineData: { mimeType: "image/png", data: "AAAA" } }] }] };
    const rec = client([res("recorded")], new ResponseCache("record", null, dir));
    expect((await rec.c.generate(req)).cached).toBe(false);
    const rep = client([], new ResponseCache("replay", null, dir));
    const out = await rep.c.generate(req);
    expect(out).toMatchObject({ text: "recorded", cached: true });
    expect(rep.seen).toHaveLength(0);
    // different image content -> different key -> miss (falls through to live)
    const miss = client([res("live")], new ResponseCache("replay", null, dir));
    expect((await miss.c.generate({ ...req, contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/png", data: "BBBB" } }] }] })).text).toBe("live");
  }, 10000);
});

describe("function calling", () => {
  it("executes requested functions locally and feeds results back", async () => {
    const { c, seen } = client([
      res("", { functionCalls: [{ id: "1", name: "convertSize", args: { brand: "Nike", size: 9, system: "UK" } }] }),
      res('{"answer": 10}'),
    ]);
    const out = await runToolLoop(c, { stage: "t", tier: "fast", contents: [{ role: "user", parts: [{ text: "q" }] }], config: {}, executors: makeToolExecutors(fixtureReference()) });
    expect(out.calledFunctions).toEqual(["convertSize"]);
    const fr = (seen[1] as { contents: { parts: { functionResponse?: { response: unknown } }[] }[] }).contents.at(-1)!.parts[0].functionResponse;
    expect(fr?.response).toMatchObject({ uk: 9, us: 10, eu: 44, cm: 28 });
  });
  it("executors return exact facts", () => {
    const ex = makeToolExecutors(fixtureReference());
    expect(ex.sampleStats({ modelId: "nike-pegasus-40" })).toMatchObject({ available: true, n: 12 });
    expect(ex.sampleStats({ modelId: "nike-pegasus-40", condition: "worn" })).toMatchObject({ available: false });
    expect(ex.getCatalogueCandidates({ brandText: "Nike", modelText: "Pegasus 40" })).toMatchObject({ candidates: [{ id: "nike-pegasus-40" }, { id: "nike-pegasus-41" }] });
    expect(ex.convertSize({ brand: "Puma", size: 9, system: "UK" })).toHaveProperty("error");
  });
});
