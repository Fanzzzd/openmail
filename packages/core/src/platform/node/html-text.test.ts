import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, type Layer, Schema } from "effect";
import { expect, it } from "vitest";
// NodePlatform resolves the worker next to itself, which only the build has.
import { NodePlatform } from "../../../dist/platform/node/platform-node.js";
import { htmlToText } from "../../mime/mime.js";
import { GraphMessage } from "../../providers/outlook/graph.js";
import { graphBody, parseGraphMessage } from "../../providers/outlook/parse.js";
import { hostileHtml, nestedHtml } from "../../reader/parser-fuzz-corpus.js";
import { finishWith, HtmlText } from "../html-text.js";
import { syncHtml } from "./fixtures/sync-html.js";
import { NodeHtmlText, strippedHtmlText } from "./html-text.js";
import { scaledMs } from "../../../test-support/test-time.js";

// The source pool runs the compiled worker, the same file production ships.
const workerUrl = new URL("../../../dist/platform/node/html-worker.js", import.meta.url);
const readerFixtures = new URL("../../../test-support/fixtures/reader/", import.meta.url);
const samples = [
  ...readdirSync(readerFixtures).map((name) => readFileSync(new URL(name, readerFixtures), "utf8")),
  ...hostileHtml,
  nestedHtml(40),
  nestedHtml(400),
  "",
  ...[0, 1, 2, 97].map(syncHtml),
];

const extract = (
  htmls: readonly string[],
  layer: Layer.Layer<never> = NodeHtmlText({ workerUrl }),
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* HtmlText;
      return yield* Effect.forEach(htmls, service.htmlToText, { concurrency: 4 });
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

it(
  "worker extraction matches the inline parser byte for byte",
  async () => {
    expect(await extract(samples)).toStrictEqual(samples.map(htmlToText));
    const graph = Schema.decodeUnknownSync(GraphMessage)({
      id: "m1",
      conversationId: "t1",
      receivedDateTime: "2026-10-01T00:00:00Z",
      body: { contentType: "html", content: syncHtml(97) },
    });
    const message = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* finishWith(yield* HtmlText, graphBody(graph, "INBOX", []));
      }).pipe(Effect.provide(NodeHtmlText({ workerUrl })), Effect.scoped),
    );
    expect(message).toStrictEqual(parseGraphMessage(graph, "INBOX", []));
  },
  scaledMs(60_000),
);

it(
  "the Node platform extracts HTML off the main thread",
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openmail-html-text-"));
    const html = syncHtml(97);
    const mainThreadCpu = <A>(effect: Effect.Effect<A>) =>
      Effect.gen(function* () {
        const start = process.threadCpuUsage();
        const result = yield* effect;
        return { result, cpu: process.threadCpuUsage(start).user };
      });
    try {
      const { worker, inline } = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* HtmlText;
          yield* service.htmlToText("<p>warm up</p>");
          return {
            worker: yield* mainThreadCpu(service.htmlToText(html)),
            inline: yield* mainThreadCpu(Effect.sync(() => htmlToText(html))),
          };
        }).pipe(Effect.provide(NodePlatform({ dataDir })), Effect.scoped),
      );
      expect(worker.result).toBe(inline.result);
      expect(worker.cpu).toBeLessThan(inline.cpu / 4);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
  scaledMs(60_000),
);

const script = (body: string) =>
  new URL(
    `data:text/javascript,${encodeURIComponent(`import { parentPort } from "node:worker_threads";${body}`)}`,
  );

it(
  "a message over the time limit gets stripped text and a new worker",
  async () => {
    const stall = script(
      'parentPort.on("message", (html) => { if (html.includes("stall")) for (;;); parentPort.postMessage(html.toUpperCase()); });' +
        'parentPort.postMessage("ready");',
    );
    const html = "<head><title>t</title></head><p>stall &amp; <b>go</b></p><script>x()</script>";
    const [stalled, next] = await extract(
      [html, "<p>next</p>"],
      NodeHtmlText({ timeoutMs: 50, workerUrl: stall }),
    );
    expect(stalled).toBe("stall & go");
    expect(stalled).toBe(strippedHtmlText(html));
    expect(next).toBe("<P>NEXT</P>");
  },
  scaledMs(60_000),
);

it(
  "workers that never start leave extraction inline after three tries",
  async () => {
    const html = syncHtml(1);
    for (const workerUrl of [
      new URL("./missing-worker.js", import.meta.url),
      script("setInterval(() => {}, 1000);"),
    ])
      expect(await extract([html], NodeHtmlText({ startupMs: 50, workerUrl }))).toStrictEqual([
        htmlToText(html),
      ]);
  },
  scaledMs(60_000),
);

it("the portable default stays inline", async () => {
  const text = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* HtmlText).htmlToText("<p>a</p>");
    }),
  );
  expect(text).toBe("a");
});

it(
  "a failed visible-text worker leaves work queued instead of parsing CSS on main",
  async () => {
    const exits = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* HtmlText;
        return [
          yield* service.visibleText("plain", "<p>visible</p>").pipe(Effect.exit),
          yield* service.visibleText("plain", "<p>next</p>").pipe(Effect.exit),
        ];
      }).pipe(
        Effect.provide(
          NodeHtmlText({
            workerUrl: new URL("./missing-worker.js", import.meta.url),
            startupMs: 50,
          }),
        ),
        Effect.scoped,
      ),
    );
    expect(exits.map((exit) => exit._tag)).toEqual(["Failure", "Failure"]);
  },
  scaledMs(30_000),
);
