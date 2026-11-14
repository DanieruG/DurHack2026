import { describe, expect, it } from "vitest";
import { downloadImages, isBlockedAddress, safeFetchImage, SafeFetchError, validateImageUrl } from "@/lib/safeFetch";

describe("address blocking", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "not-an-ip"])("blocks %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });
  it.each(["8.8.8.8", "151.101.1.140", "2606:4700::1111", "172.32.0.1"])("allows %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe("safeFetchImage", () => {
  const reason = async (p: Promise<unknown>) => {
    try {
      await p;
      return "ok";
    } catch (e) {
      return e instanceof SafeFetchError ? e.reason : String(e);
    }
  };
  it("rejects non-HTTPS, literal private IPs and local hostnames before any request", async () => {
    expect(() => validateImageUrl("http://example.com/a.jpg")).toThrow(/HTTPS/);
    expect(await reason(safeFetchImage("https://127.0.0.1/a.jpg", { maxBytes: 1000 }))).toBe("blocked_address");
    expect(await reason(safeFetchImage("https://[::1]/a.jpg", { maxBytes: 1000 }))).toBe("blocked_address");
    expect(await reason(safeFetchImage("https://localhost/a.jpg", { maxBytes: 1000 }))).toBe("blocked_address");
    expect(await reason(safeFetchImage("https://user:pw@example.com/a.jpg", { maxBytes: 1000 }))).toBe("invalid_url");
  });
  it("rejects hostnames that resolve to private addresses (checked at connect time)", async () => {
    const resolver = async () => [{ address: "10.0.0.5", family: 4 }];
    expect(await reason(safeFetchImage("https://images.example.com/a.jpg", { maxBytes: 1000, resolver, timeoutMs: 2000 }))).toBe("blocked_address");
    const mixed = async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }];
    expect(await reason(safeFetchImage("https://images.example.com/a.jpg", { maxBytes: 1000, resolver: mixed, timeoutMs: 2000 }))).toBe("blocked_address");
  });
  it("downloadImages skips failures, de-duplicates and caps", async () => {
    const fetcher = async (url: string) => {
      if (url.includes("bad")) throw new SafeFetchError("http_error", "404");
      return { bytes: new Uint8Array(Buffer.from(url.includes("dup") ? "same" : url)), mimeType: "image/png" as const, sourceUrl: url };
    };
    const r = await downloadImages(["https://a/1", "https://a/1", "https://a/bad", "https://a/dup1", "https://a/dup2", "https://a/2"], fetcher, 4);
    expect(r.failed).toEqual([{ url: "https://a/bad", reason: "http_error" }]);
    expect(r.images.map((i) => i.sourceUrl)).toEqual(["https://a/1", "https://a/dup1"]);
  });
});
