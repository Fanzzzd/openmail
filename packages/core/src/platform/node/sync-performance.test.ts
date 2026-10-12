import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { Effect, Layer } from "effect";
import { expect, it, vi } from "vitest";
import { Mailbox } from "../../mailbox.js";
import { MailboxLive } from "../../mailbox-live.js";
import { makeOutlook } from "../../outlook.js";
import { Providers, Store } from "../../services.js";
import { StoreLive } from "../../store.js";
import { fakeHttp, graphFolderRoutes } from "./fake-http.js";
import { syncHtml } from "./fixtures/sync-html.js";
import { NodeHtmlText } from "./html-text.js";
import { MemoryPlatform } from "./platform-memory.js";
import { account } from "./testing.js";

const COUNT = 2000;
const BLOCK_MS = 50;
const owner = account("outlook");

/** Graph delta for a first sync: COUNT HTML messages in the inbox, 50 per page. */
const outlookHttp = () =>
  fakeHttp({
    "GET /me/mailFolders": { json: { value: [] } },
    ...graphFolderRoutes({
      inbox: (url) => {
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const size = Math.min(50, COUNT - offset);
        const base = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta";
        return {
          json: {
            value: Array.from({ length: size }, (_, i) => {
              const n = offset + i;
              return {
                id: `m${n}`,
                conversationId: `t${n % 700}`,
                receivedDateTime: new Date(Date.now() - n * 60_000).toISOString(),
                subject: `Newsletter ${n}`,
                from: { emailAddress: { name: "News", address: `news${n % 40}@example.test` } },
                body: { contentType: "html", content: syncHtml(n) },
                isRead: n % 3 > 0,
                hasAttachments: false,
              };
            }),
            ...(offset + size < COUNT
              ? { "@odata.nextLink": `${base}?offset=${offset + size}` }
              : { "@odata.deltaLink": `${base}?$deltatoken=end` }),
          },
        };
      },
    }),
  }).layer;

/** Times every statement on every connection opened after the call. */
function traceStatements() {
  const slow = new Map<string, { count: number; totalMs: number; maxMs: number }>();
  // oxlint-disable-next-line typescript/unbound-method
  const prepare = DatabaseSync.prototype.prepare;
  const spy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    const statement: StatementSync = prepare.call(this, sql);
    for (const method of ["run", "all"] as const) {
      const original = statement[method];
      Object.assign(statement, {
        [method]: (...params: unknown[]) => {
          const start = performance.now();
          const result: unknown = Reflect.apply(original, statement, params);
          const ms = performance.now() - start;
          const entry = slow.get(sql) ?? { count: 0, totalMs: 0, maxMs: 0 };
          slow.set(sql, {
            count: entry.count + 1,
            totalMs: entry.totalMs + ms,
            maxMs: Math.max(entry.maxMs, ms),
          });
          return result;
        },
      });
    }
    return statement;
  });
  return {
    restore: () => spy.mockRestore(),
    slowest: () =>
      [...slow]
        .map(([sql, entry]) => ({ sql: sql.replace(/\s+/g, " ").slice(0, 200), ...entry }))
        .toSorted((a, b) => b.maxMs - a.maxMs)
        .slice(0, 10),
  };
}

/** Garbage-collection pauses, so a late timer can be told apart from a slow statement. */
function traceGc() {
  const pauses: { at: number; ms: number }[] = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      pauses.push({ at: entry.startTime, ms: entry.duration });
    }
  });
  observer.observe({ entryTypes: ["gc"] });
  return () => {
    observer.disconnect();
    return {
      count: pauses.length,
      totalMs: pauses.reduce((sum, pause) => sum + pause.ms, 0),
      longest: pauses.toSorted((a, b) => b.ms - a.ms).slice(0, 5),
    };
  };
}

/** Counts event-loop turns that arrive more than BLOCK_MS late. */
function countBlocks() {
  let blocks = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    if (now - last - 10 > BLOCK_MS) blocks++;
    last = now;
  }, 10);
  return () => {
    clearInterval(timer);
    return blocks;
  };
}

it.skipIf(process.env.OPENMAIL_PERF !== "1")(
  "a 2k HTML Outlook sync keeps the event loop responsive",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "openmail-sync-performance-"));
    const trace = traceStatements();
    const delay = monitorEventLoopDelay({ resolution: 1 });
    const platform = Layer.mergeAll(
      outlookHttp(),
      // The source pool runs the compiled worker, the same file production ships.
      NodeHtmlText({
        workerUrl: new URL("../../../dist/platform/node/html-worker.js", import.meta.url),
      }),
      MemoryPlatform({
        database: join(directory, "mail.db"),
        secrets: { [owner.id]: "refresh-token" },
        config: { microsoft: { clientId: "client" } },
      }),
    );
    const providers = Layer.effect(
      Providers,
      Effect.map(makeOutlook, (adapter) => ({ get: () => adapter })),
    );
    const layer = MailboxLive({ backgroundFlush: false }).pipe(
      Layer.provideMerge(Layer.mergeAll(StoreLive, providers).pipe(Layer.provideMerge(platform))),
    );
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* (yield* Store).upsertAccount(owner.provider, owner.email);
          const mailbox = yield* Mailbox;
          const stopCounting = countBlocks();
          const stopGc = traceGc();
          delay.enable();
          const start = performance.now();
          const [result] = yield* mailbox.sync(owner.id);
          const elapsedMs = performance.now() - start;
          delay.disable();
          const report = {
            elapsedMs,
            longestBlockMs: delay.max / 1e6,
            p95BlockMs: delay.percentile(95) / 1e6,
            p99BlockMs: delay.percentile(99) / 1e6,
            blocksOver50Ms: stopCounting(),
            gc: stopGc(),
            loadAverage: loadavg(),
            statements: trace.slowest(),
          };
          writeFileSync(
            process.env.OPENMAIL_SYNC_REPORT ?? "/tmp/openmail-sync-performance.json",
            JSON.stringify(report, null, 2),
          );
          expect(result?.error).toBeUndefined();
          expect(result?.changed).toBe(COUNT);
          expect(report.p99BlockMs).toBeLessThan(BLOCK_MS);
          expect(report.longestBlockMs).toBeLessThan(300);
          // Preemption on an overloaded machine shows up as late timers too.
          if (report.loadAverage[0]! < availableParallelism())
            expect(report.blocksOver50Ms).toBe(0);
        }).pipe(Effect.provide(layer)),
      );
    } finally {
      delay.disable();
      trace.restore();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  600_000,
);
