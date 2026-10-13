import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

// PRAGMA quick_check reads every page; on a multi-GB cache it takes seconds.
// It runs here so the main thread can paint while it reads.
let reply;
let db;
try {
  db = new DatabaseSync(workerData.file, { readOnly: true });
  reply = { rows: db.prepare("PRAGMA quick_check").all() };
} catch (error) {
  reply = { errcode: typeof error?.errcode === "number" ? error.errcode : null };
} finally {
  db?.close();
}
// oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker_threads port has no target origin.
parentPort.postMessage(reply);
