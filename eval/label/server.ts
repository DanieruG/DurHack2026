/**
 * npm run label: a local page for labelling the eval cases in eval/listings/ (http://127.0.0.1:4870, or LABEL_PORT).
 * Lists every case with what's still missing; per case, the photos (drag defect boxes), the label form and the page
 * text side by side. Saves each case's label.json, validated with the eval schema. Never shows Sleuth's answers.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { caseView, FORM_OPTIONS, listCases, readPhoto, saveLabel } from "./api";

const MAX_BODY = 1_000_000;

export function createLabelServer(root: string) {
  const page = fs.readFileSync(path.join(import.meta.dirname, "page.html"), "utf8");
  return http.createServer((req, res) => {
    const send = (status: number, body: unknown, type = "application/json") => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(type === "application/json" ? JSON.stringify(body) : (body as string | Buffer));
    };
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    try {
      if (req.method === "GET" && url.pathname === "/") return send(200, page, "text/html; charset=utf-8");
      if (req.method === "GET" && url.pathname === "/api/options") return send(200, FORM_OPTIONS);
      if (req.method === "GET" && url.pathname === "/api/cases") return send(200, listCases(root));
      if (parts[0] === "api" && parts[1] === "cases" && parts.length === 3 && req.method === "GET") {
        const v = caseView(root, parts[2]);
        return v ? send(200, v) : send(404, { error: "no such case" });
      }
      if (parts[0] === "photos" && parts.length === 3 && req.method === "GET") {
        const p = readPhoto(root, parts[1], parts[2]);
        return p ? send(200, p.bytes, p.mimeType) : send(404, { error: "no such photo" });
      }
      if (parts[0] === "api" && parts[1] === "cases" && parts[3] === "label" && parts.length === 4 && req.method === "PUT") {
        // Same-origin only: the page is served from here, so refuse writes from any other site.
        const origin = req.headers.origin;
        if (origin && origin !== `http://${req.headers.host}`) return send(403, { ok: false, errors: ["cross-origin write refused"] });
        let size = 0;
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_BODY) req.destroy();
          else chunks.push(c);
        });
        req.on("end", () => {
          let body: unknown;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            return send(400, { ok: false, errors: ["body is not JSON"] });
          }
          const r = saveLabel(root, parts[2], body);
          send(r.ok ? 200 : 400, r);
        });
        return;
      }
      send(404, { error: "not found" });
    } catch (err) {
      send(500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.LABEL_PORT ?? 4870);
  const root = path.join(process.cwd(), "eval", "listings");
  createLabelServer(root).listen(port, "127.0.0.1", () => console.log(`Labelling ${root}\n  http://127.0.0.1:${port}  (Ctrl+C to stop)`));
}
