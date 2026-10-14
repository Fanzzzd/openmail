const log = (value) => process.stdout.write(`${value}\n`);
// Run after the core build: node --expose-gc packages/core/scripts/sync-memory.mjs [module]
// Measures fetchMessages against a fake ImapFlow client; no IMAP server is needed.
// The optional module argument permits measuring a compiled historical fetchMessages.
import { Effect } from "effect";
import { ImapFlow } from "imapflow";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const usage = "usage: node --expose-gc packages/core/scripts/sync-memory.mjs [path/to/pull.js]";
if (typeof global.gc !== "function") {
  process.stderr.write(`${usage}\nThe script needs --expose-gc.\n`);
  process.exit(2);
}
const target = process.argv[2]
  ? pathToFileURL(process.argv[2]).href
  : new URL("../dist/platform/node/imap/pull.js", import.meta.url).href;
const load = (url) =>
  import(url).catch((cause) => {
    process.stderr.write(`${usage}\nCould not load ${url}: ${cause.message}\nBuild core first.\n`);
    process.exit(2);
  });
const { fetchMessages } = await load(target);
const { HtmlText } = await load(new URL("../dist/platform/html-text.js", import.meta.url).href);
if (typeof fetchMessages !== "function") {
  process.stderr.write(`${usage}\n${target} does not export fetchMessages.\n`);
  process.exit(2);
}
const count = 25;
const payload = Buffer.alloc(4 * 1024 * 1024, 65).toString("base64");
const source = `From: alice@example.com\r\nSubject: Report\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nShort report\r\n--x\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename=report.bin\r\n\r\n${payload}\r\n--x--\r\n`;
const settings = {
  username: "test",
  imapHost: "fake.invalid",
  imapPort: 993,
  smtpHost: "fake.invalid",
  smtpPort: 465,
  smtpSecure: true,
};
const client = new ImapFlow({ host: settings.imapHost, port: 993, logger: false });
global.gc();
const baseline = process.memoryUsage();
let peakBuffers = baseline.arrayBuffers;
let peakRss = baseline.rss;
const sample = () => {
  const memory = process.memoryUsage();
  peakBuffers = Math.max(peakBuffers, memory.arrayBuffers);
  peakRss = Math.max(peakRss, memory.rss);
};
const item = (uid) => ({
  seq: uid,
  uid,
  flags: new Set(),
  size: Buffer.byteLength(source),
  source: Buffer.from(source),
});
client.fetchAll = async (_range, query) => {
  if (!query.source)
    return Array.from({ length: count }, (_, i) => ({
      seq: i + 1,
      uid: i + 1,
      size: Buffer.byteLength(source),
    }));
  const messages = Array.from({ length: count }, (_, i) => item(i + 1));
  sample();
  return messages;
};
client.fetch = async function* () {
  for (let i = 1; i <= count; i++) {
    // A collection point between network responses makes retained sources
    // measurable independently of GC scheduling and provider timing.
    global.gc();
    sample();
    yield item(i);
    sample();
  }
};
const timer = setInterval(sample, 5);
try {
  const start = performance.now();
  const messages = await Effect.runPromise(
    Effect.gen(function* () {
      const htmlText = yield* HtmlText;
      return yield* fetchMessages(
        { accountId: "imap:test", settings, client, htmlText },
        { path: "INBOX", label: "INBOX" },
        "1",
        Array.from({ length: count }, (_, i) => i + 1),
      );
    }),
  );
  sample();
  log(
    JSON.stringify({
      messages: messages.length,
      attachmentMiB: 4,
      batch: count,
      ms: performance.now() - start,
      peakArrayBufferMiB: (peakBuffers - baseline.arrayBuffers) / 1048576,
      peakRssMiB: (peakRss - baseline.rss) / 1048576,
    }),
  );
} finally {
  clearInterval(timer);
  client.close();
}
