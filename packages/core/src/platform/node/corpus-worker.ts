import { parentPort } from "node:worker_threads";
import { Schema } from "effect";
import { CorpusPipeline } from "./corpus-pipeline.js";

// Only parser modules are loaded. No Mailbox Layer, keychain adapter or HTTP client.
const port = parentPort;
if (!port) throw new Error("Corpus worker requires a parent");
const pipeline = new CorpusPipeline();
const Request = Schema.Struct({ row: Schema.Unknown, explain: Schema.Boolean });
const done = () => port.postMessage({ kind: "done" });
port.on("message", (input: unknown) => {
  const request = Schema.decodeUnknownSync(Request)(input);
  void pipeline.run(request.row, (event) => port.postMessage(event), request.explain).finally(done);
});
port.postMessage({ kind: "ready" });
