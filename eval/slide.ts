/** npm run eval:slide: eval/slide.md, the headline figures from the latest eval/summary.json as a compact table. */
import fs from "node:fs";
import path from "node:path";
import { EvalSummarySchema } from "../schemas/eval";
import { slideMarkdown } from "./report";

const EVAL = path.join(process.cwd(), "eval");
const file = path.join(EVAL, "summary.json");
if (!fs.existsSync(file)) {
  console.error("No eval/summary.json yet: run npm run eval first.");
  process.exit(1);
}
fs.writeFileSync(path.join(EVAL, "slide.md"), slideMarkdown(EvalSummarySchema.parse(JSON.parse(fs.readFileSync(file, "utf8")))));
console.log("Wrote eval/slide.md");
