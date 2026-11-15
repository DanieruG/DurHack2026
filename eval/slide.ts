/** npm run eval:slide: eval/slide.md (and report.md) from the latest summaries, with the baseline comparison once it has run. */
import { writeReports } from "./write";

if (!writeReports().length) {
  console.error("No eval/summary.json yet: run npm run eval first.");
  process.exit(1);
}
console.log("Wrote eval/report.md and eval/slide.md");
