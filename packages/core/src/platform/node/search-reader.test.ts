import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber, Layer } from "effect";
import { afterAll, expect, it } from "vitest";
import { SqlClient } from "effect/sql";
import { Store } from "../../store/service.js";
import { StoreLive } from "../../store/store.js";
import { SearchReader } from "../search-reader.js";
import { MemoryPlatform } from "./platform-memory.js";
import { NodeSearchReader } from "./search-reader.js";
import { nodeSearchProcess } from "./search-process.js";
import type { SearchProcessLauncher } from "../search-reader.js";
import { scaledMs } from "../../../test-support/test-time.js";

const workerUrl = new URL("../../../dist/platform/node/search-worker.js", import.meta.url);
const fixtures: string[] = [];
const fixture = (source: string) => {
  const dir = mkdtempSync(join(tmpdir(), "openmail-search-child-"));
  fixtures.push(dir);
  const file = join(dir, "child.mjs");
  writeFileSync(
    file,
    source.replace(
      /import \{ parentPort(?:, workerData)? \} from "node:worker_threads";/,
      `
    const parentPort = {
      on: (_, listener) => process.on("message", (frame) => listener(frame)),
      postMessage: (message) => process.send(message),
    };
    const workerData = process.argv[2];
  `,
    ),
  );
  return new URL(`file://${file}`);
};
afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});
const busyWorker = fixture(`
  import { parentPort } from "node:worker_threads";
  import { DatabaseSync } from "node:sqlite";
  const db = new DatabaseSync(":memory:");
  const busy = db.prepare(
    "WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<?) SELECT sum(n) FROM numbers"
  );
  parentPort.on("message", ({query}) => {
    if (query.search === "slow") busy.get(10_000_000);
    if (query.search === "blocked") busy.get(50_000_000);
    parentPort.postMessage({kind:"threads",value:[]});
  });
  parentPort.postMessage({kind:"ready"});
`);

it(
  "the main event loop stays responsive while a worker is busy",
  async () => {
    let previous = performance.now();
    let longest = 0;
    let ticks = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      longest = Math.max(longest, now - previous);
      previous = now;
      ticks++;
    }, 10);
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const reader = yield* SearchReader;
          if (!reader) throw new Error("missing reader");
          yield* reader.threads({ search: "slow" });
        }).pipe(Effect.provide(NodeSearchReader("unused", busyWorker)), Effect.scoped),
      );
      expect(ticks).toBeGreaterThan(50);
      expect(longest).toBeLessThan(scaledMs(200));
    } finally {
      clearInterval(timer);
    }
  },
  scaledMs(30_000),
);

it(
  "the next search does not wait for an interrupted synchronous SQLite statement",
  async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const reader = yield* SearchReader;
        if (!reader) throw new Error("missing reader");
        // The queued search starts only after the blocked process exits. Killing the process
        // stops native SQLite, unlike Worker.terminate(), which waited over five seconds here.
        // Warm the child first, then send a long synchronous SQLite query.
        yield* reader.threads({ search: "fast" });
        const old = yield* reader.threads({ search: "blocked" }).pipe(Effect.forkChild);
        yield* Effect.sleep(100);
        const next = yield* reader.threads({ search: "fast" }).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(old);
        const start = performance.now();
        expect(yield* Fiber.join(next)).toEqual([]);
        expect(performance.now() - start).toBeLessThan(scaledMs(2000));
      }).pipe(Effect.provide(NodeSearchReader("unused", busyWorker)), Effect.scoped),
    );
  },
  scaledMs(30_000),
);

it("closing the layer terminates its worker instead of only unrefing it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "openmail-search-close-"));
  const file = join(dir, "ticks");
  const tickingWorker = fixture(`
    import { appendFileSync } from "node:fs";
    import { parentPort, workerData } from "node:worker_threads";
    parentPort.on("message", () => {
      appendFileSync(workerData, ".");
      parentPort.postMessage({ kind: "threads", value: [] });
    });
    setInterval(() => appendFileSync(workerData, "."), 10);
    parentPort.postMessage({ kind: "ready" });
  `);
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const reader = yield* SearchReader;
        if (!reader) throw new Error("missing reader");
        yield* reader.threads({ search: "fast" });
      }).pipe(Effect.provide(NodeSearchReader(file, tickingWorker)), Effect.scoped),
    );
    const stopped = readFileSync(file, "utf8");
    await Effect.runPromise(Effect.sleep(100));
    expect(readFileSync(file, "utf8")).toBe(stopped);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it(
  "a failed startup fails its waiting request without endlessly replacing the worker",
  async () => {
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const reader = yield* SearchReader;
        if (!reader) throw new Error("missing reader");
        return yield* reader.threads({ search: "weekly" }).pipe(Effect.exit);
      }).pipe(
        Effect.provide(
          NodeSearchReader("unused", new URL("./missing-search-worker.js", import.meta.url)),
        ),
        Effect.scoped,
      ),
    );
    expect(exit._tag).toBe("Failure");
  },
  scaledMs(10_000),
);

it(
  "the read-only worker returns the same pages and counts, and sees committed writes",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "openmail-search-worker-"));
    const file = join(dir, "mail.db");
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Store;
          const reader = yield* SearchReader;
          if (!reader) throw new Error("missing reader");
          const account = yield* store.upsertAccount("gmail", "search@example.com");
          const write = (id: string) =>
            store.upsertMessage(account.id, {
              providerId: id,
              threadId: id,
              subject: "weekly report",
              from: { name: "Alice", address: "alice@example.com" },
              to: [{ name: "Bob", address: "bob@example.com" }],
              cc: [],
              date: 1000 + Number(id),
              snippet: "preview",
              bodyText: "weekly report budget",
              bodyHtml: "<p>weekly report budget</p><span hidden>secret</span>",
              labels: ["INBOX"],
              isUnread: true,
              isStarred: false,
              attachments: [],
            });
          yield* write("1");
          while (!(yield* store.backfillWordIndex()).ready) {
            /* drain */
          }
          yield* store.fillVisibleText();
          for (const search of [
            "weekly",
            "we*",
            '"weekly report"',
            "from:alice weekly",
            "to:bob",
            "is:unread",
            "label:INBOX",
            "has:attachment weekly",
          ]) {
            const query = { search, limit: 50 };
            expect(yield* reader.threads(query)).toEqual(
              yield* store.transaction(store.listThreads(query)),
            );
            expect(yield* reader.count(query)).toEqual(
              yield* store.transaction(store.countThreads(query)),
            );
          }
          yield* write("2");
          expect((yield* reader.threads({ search: "weekly" })).length).toBe(2);
          // Worker has no writer connection: its queries have not touched the version or body cache.
          const sql = yield* SqlClient.SqlClient;
          expect((yield* sql`SELECT COUNT(*) AS n FROM message_visible_text_pending`)[0]?.n).toBe(
            1,
          );
          yield* store.fillVisibleText();
          expect(yield* reader.threads({ search: "weekly" })).toEqual(
            yield* store.transaction(store.listThreads({ search: "weekly" })),
          );
          yield* sql`DELETE FROM messages WHERE provider_id='1'`;
          expect(yield* reader.threads({ search: "weekly" })).toEqual(
            yield* store.transaction(store.listThreads({ search: "weekly" })),
          );
          expect(yield* reader.count({ search: "weekly" })).toBe(1);
        }).pipe(
          Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform({ database: file })))),
          Effect.provide(NodeSearchReader(file, workerUrl)),
          Effect.scoped,
        ),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  scaledMs(60_000),
);

it(
  "rapid supersession keeps one child alive and closes it with the Store scope",
  async () => {
    let alive = 0;
    let maximum = 0;
    let starts = 0;
    const launch: SearchProcessLauncher = (entry, file) => {
      const child = nodeSearchProcess(entry, file);
      alive++;
      starts++;
      maximum = Math.max(maximum, alive);
      return {
        ...child,
        kill: async () => {
          await child.kill();
          alive--;
        },
      };
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        const reader = yield* SearchReader;
        if (!reader) throw new Error("missing reader");
        yield* reader.threads({ search: "fast" });
        for (let i = 0; i < 8; i++) {
          const stale = yield* reader.threads({ search: "blocked" }).pipe(Effect.forkChild);
          yield* Effect.sleep(30);
          yield* Fiber.interrupt(stale);
        }
        expect(yield* reader.threads({ search: "fast" })).toEqual([]);
      }).pipe(Effect.provide(NodeSearchReader("unused", busyWorker, launch)), Effect.scoped),
    );
    expect(starts).toBeGreaterThan(1);
    expect(maximum).toBe(1);
    expect(alive).toBe(0);
  },
  scaledMs(30_000),
);

it(
  "a child crash or bad frame fails its job and the next caller gets a new child",
  async () => {
    const crashing = fixture(`
    process.on("message", (frame) => {
      const {query}=frame;
      if (query.search === "crash") process.exit(1);
      else if (query.search === "bad") process.send("bad JSON");
      else process.send({kind:"threads",value:[]});
    });
    process.send({kind:"ready"});
  `);
    await Effect.runPromise(
      Effect.gen(function* () {
        const reader = yield* SearchReader;
        if (!reader) throw new Error("missing reader");
        for (const search of ["crash", "bad"]) {
          expect((yield* reader.threads({ search }).pipe(Effect.exit))._tag).toBe("Failure");
          expect(yield* reader.threads({ search: "fast" })).toEqual([]);
        }
      }).pipe(Effect.provide(NodeSearchReader("unused", crashing)), Effect.scoped),
    );
  },
  scaledMs(30_000),
);

it("Store routes search counts off thread, but mailbox and transaction reads stay local", async () => {
  const calls: string[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Store;
      expect(yield* store.countThreads({ search: "weekly" })).toBe(12345);
      expect(yield* store.countThreads({ mailbox: "inbox" })).toBe(0);
      expect(yield* store.transaction(store.countThreads({ mailbox: "inbox" }))).toBe(0);
      expect(yield* store.listThreads({ mailbox: "inbox" })).toEqual([]);
      expect(yield* store.listThreads({ search: "weekly" })).toEqual([]);
      expect(calls).toEqual(["count", "threads"]);
    }).pipe(
      Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform()))),
      Effect.provideService(SearchReader, {
        threads: () =>
          Effect.sync(() => {
            calls.push("threads");
            return [];
          }),
        count: () =>
          Effect.sync(() => {
            calls.push("count");
            return 12345;
          }),
      }),
    ),
  );
});
