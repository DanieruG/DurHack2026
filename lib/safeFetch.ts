import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import type { LookupFunction } from "node:net";

export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type ImageMime = (typeof ALLOWED_IMAGE_TYPES)[number];

export type FetchedImage = { bytes: Uint8Array; mimeType: ImageMime; sourceUrl: string };

export class SafeFetchError extends Error {
  constructor(
    public readonly reason:
      | "invalid_url"
      | "not_https"
      | "blocked_address"
      | "dns_failed"
      | "redirect_blocked"
      | "too_many_redirects"
      | "http_error"
      | "timeout"
      | "too_large"
      | "bad_content_type",
    message: string,
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

// ---------- address blocking ----------

const blockList = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (incl. cloud metadata 169.254.169.254)
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) {
  blockList.addSubnet(addr, prefix, "ipv4");
}
for (const [addr, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
  ["2001:db8::", 32], // documentation
] as const) {
  blockList.addSubnet(addr, prefix, "ipv6");
}

/** True for private, loopback, link-local, multicast and other non-public addresses. */
export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return true;
  if (family === 4) return blockList.check(address, "ipv4");
  const lower = address.toLowerCase();
  // IPv4-mapped / NAT64 forms: check the embedded IPv4 address.
  const mapped = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isBlockedAddress(mapped[1]);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isBlockedAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return blockList.check(address, "ipv6");
}

type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

const defaultResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) =>
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => (err ? reject(err) : resolve(addrs))),
  );

/** A `lookup` for https.request that validates every resolved address at connect time (no DNS rebinding gap). */
function guardedLookup(resolver: Resolver): LookupFunction {
  return (hostname, options, callback) => {
    resolver(hostname)
      .then((addrs) => {
        if (addrs.length === 0) throw new SafeFetchError("dns_failed", `No addresses for ${hostname}`);
        const bad = addrs.find((a) => isBlockedAddress(a.address));
        if (bad) throw new SafeFetchError("blocked_address", `${hostname} resolves to a blocked address`);
        if ((options as { all?: boolean }).all) {
          (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, addrs);
        } else {
          callback(null, addrs[0].address, addrs[0].family);
        }
      })
      .catch((err) => callback(err instanceof SafeFetchError ? err : new SafeFetchError("dns_failed", String(err)), "", 0));
  };
}

// ---------- fetch ----------

export type SafeFetchOptions = {
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
  resolver?: Resolver;
};

function sniffMime(bytes: Uint8Array): ImageMime | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  )
    return "image/webp";
  return null;
}

export function validateImageUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeFetchError("invalid_url", "Invalid URL");
  }
  if (url.protocol !== "https:") throw new SafeFetchError("not_https", "Only HTTPS image URLs are allowed");
  if (url.username || url.password) throw new SafeFetchError("invalid_url", "Credentials in URL are not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && isBlockedAddress(host)) throw new SafeFetchError("blocked_address", "Blocked address");
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) {
    throw new SafeFetchError("blocked_address", "Blocked hostname");
  }
  return url;
}

/**
 * Download one image the user's capture pointed at. HTTPS only; DNS-resolved addresses must be public;
 * redirects only to the same host; 5 s timeout; byte limit; jpeg/png/webp only (header and magic bytes).
 */
export async function safeFetchImage(rawUrl: string, opts: SafeFetchOptions): Promise<FetchedImage> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const maxRedirects = opts.maxRedirects ?? 3;
  const lookup = guardedLookup(opts.resolver ?? defaultResolver);
  const original = validateImageUrl(rawUrl);
  const deadline = Date.now() + timeoutMs;

  let current = original;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await requestOnce(current, lookup, opts.maxBytes, Math.max(1, deadline - Date.now()));
    if (res.redirect) {
      const next = new URL(res.redirect, current);
      if (next.protocol !== "https:" || next.hostname !== original.hostname) {
        throw new SafeFetchError("redirect_blocked", "Redirect to another host blocked");
      }
      current = next;
      continue;
    }
    const sniffed = sniffMime(res.body!);
    const declared = (res.contentType ?? "").split(";")[0].trim().toLowerCase();
    if (!ALLOWED_IMAGE_TYPES.includes(declared as ImageMime) || !sniffed) {
      throw new SafeFetchError("bad_content_type", `Unsupported content type ${declared || "unknown"}`);
    }
    return { bytes: res.body!, mimeType: sniffed, sourceUrl: rawUrl };
  }
  throw new SafeFetchError("too_many_redirects", "Too many redirects");
}

function requestOnce(
  url: URL,
  lookup: LookupFunction,
  maxBytes: number,
  timeoutMs: number,
): Promise<{ redirect?: string; body?: Uint8Array; contentType?: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method: "GET", lookup, headers: { accept: ALLOWED_IMAGE_TYPES.join(","), "user-agent": "SleuthBot/2 (image fetch)" } },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve({ redirect: res.headers.location });
        }
        if (status < 200 || status >= 300) {
          res.resume();
          return reject(new SafeFetchError("http_error", `HTTP ${status}`));
        }
        const declared = Number(res.headers["content-length"] ?? 0);
        if (declared > maxBytes) {
          res.destroy();
          return reject(new SafeFetchError("too_large", "Image too large"));
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (c: Buffer) => {
          total += c.length;
          if (total > maxBytes) {
            res.destroy();
            reject(new SafeFetchError("too_large", "Image too large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve({ body: new Uint8Array(Buffer.concat(chunks)), contentType: res.headers["content-type"] }));
        res.on("error", reject);
      },
    );
    const timer = setTimeout(() => req.destroy(new SafeFetchError("timeout", "Image download timed out")), timeoutMs);
    req.on("error", (err) => reject(err instanceof SafeFetchError ? err : (err as { cause?: unknown }).cause instanceof SafeFetchError ? (err as { cause: SafeFetchError }).cause : err));
    req.on("close", () => clearTimeout(timer));
    req.end();
  });
}

export type ImageFetcher = (url: string) => Promise<FetchedImage>;

/** De-duplicate, cap at maxImages, download in parallel; failures are skipped, not fatal. */
export async function downloadImages(
  urls: string[],
  fetcher: ImageFetcher,
  maxImages: number,
): Promise<{ images: FetchedImage[]; failed: { url: string; reason: string }[] }> {
  const unique = [...new Set(urls.map((u) => u.trim()).filter(Boolean))].slice(0, maxImages);
  const settled = await Promise.allSettled(unique.map((u) => fetcher(u)));
  const images: FetchedImage[] = [];
  const failed: { url: string; reason: string }[] = [];
  const seen = new Set<string>();
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      // Content de-dup: the same photo at two URLs (thumbnail vs full) counts once.
      const key = Buffer.from(r.value.bytes.subarray(0, 4096)).toString("base64") + r.value.bytes.length;
      if (!seen.has(key)) {
        seen.add(key);
        images.push(r.value);
      }
    } else {
      failed.push({ url: unique[i], reason: r.reason instanceof SafeFetchError ? r.reason.reason : "error" });
    }
  });
  return { images, failed };
}
