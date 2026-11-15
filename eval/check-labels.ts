/** npm run eval:labels: print the cases with missing labels and update the list in eval/LABELLING.md. */
import path from "node:path";
import { missingLabelsMarkdown, readLabels, updateLabellingDoc } from "./labels";

const EVAL = path.join(process.cwd(), "eval");
const cases = readLabels(path.join(EVAL, "listings"));
updateLabellingDoc(path.join(EVAL, "LABELLING.md"), cases);
console.log(missingLabelsMarkdown(cases));
