import { parentPort } from "node:worker_threads";
import { htmlToText } from "../../mime/mime.js";
import { searchVisibleText } from "../../visible-text/visible-text.js";

// Loads only the parser modules. "ready" tells the pool that module loading is done.
// A string is HTML for htmlToText; a [plain, html] pair asks for search's visible text.
const port = parentPort;
if (!port) throw new Error("HTML worker requires a parent");
function extract(input: unknown): string | null {
  if (typeof input === "string") return htmlToText(input);
  if (
    Array.isArray(input) &&
    input.length === 2 &&
    typeof input[0] === "string" &&
    typeof input[1] === "string"
  ) {
    return searchVisibleText(input[0], input[1]);
  }
  return null;
}

port.on("message", (input: unknown) => {
  port.postMessage(extract(input));
});
port.postMessage("ready");
