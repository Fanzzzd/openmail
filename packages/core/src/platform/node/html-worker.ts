import { parentPort } from "node:worker_threads";
import { htmlToText } from "../../mime.js";

// Loads only the parser modules. "ready" tells the pool that module loading is done.
const port = parentPort;
if (!port) throw new Error("HTML worker requires a parent");
port.on("message", (html: unknown) => {
  port.postMessage(typeof html === "string" ? htmlToText(html) : null);
});
port.postMessage("ready");
