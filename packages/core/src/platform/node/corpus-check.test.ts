import { expectFileBytes } from "../../../test-support/file-bytes.js";
import { writeMigratedDatabase } from "../../../test-support/migrated-database.js";
import { createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  chmodSync,
  writeFileSync,
  existsSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
// The worker runs the same compiled modules shipped by the CLI, with no test runtime in its heap.
import {
  corpusCheck,
  createCorpusRunKeyFile,
  CorpusCheckError,
  formatCorpusReport,
  CORPUS_LIMITS,
} from "../../../dist/platform/node/corpus-check.js";
import { CORPUS_STAGES, CorpusTimings, type CorpusExplainReport } from "./corpus-report.js";
import { CorpusPipeline, corpusException } from "./corpus-pipeline.js";

const run = promisify(execFile);
const { Worker: RealWorker } =
  await vi.importActual<typeof import("node:worker_threads")>("node:worker_threads");
const cli = new URL("../../../../cli/dist/cli.js", import.meta.url);
const blockedParser = vi.hoisted(
  (): { enabled: boolean; workers: number; resolve?: () => void } => ({
    enabled: false,
    workers: 0,
  }),
);
vi.mock("node:worker_threads", async (original) => {
  const threads = await original<typeof import("node:worker_threads")>();
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  type Args = ConstructorParameters<typeof threads.Worker>;
  const kindOf = (event: unknown) =>
    event && typeof event === "object" && "kind" in event ? event.kind : undefined;
  // Scans reuse idle real parser threads; terminate() pools a thread unless a message is in flight.
  type Parser = { thread: InstanceType<typeof threads.Worker>; ready: Promise<boolean> };
  const idle: Parser[] = [];
  const start = (...[filename, options]: Args): Parser => {
    const thread = new threads.Worker(filename, options);
    thread.stdout.resume();
    thread.stderr.resume();
    thread.unref();
    thread.once("exit", () => {
      const index = idle.findIndex((parser) => parser.thread === thread);
      if (index >= 0) idle.splice(index, 1);
    });
    const ready = new Promise<boolean>((accept) => {
      thread.once("message", (event: unknown) => accept(kindOf(event) === "ready"));
      thread.once("error", () => accept(false));
      thread.once("exit", () => accept(false));
    });
    return { thread, ready };
  };
  class PooledWorker extends EventEmitter {
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    private parser: Parser | undefined;
    private busy = false;
    private readonly forward = (event: unknown) => {
      if (kindOf(event) === "done") this.busy = false;
      this.emit("message", event);
    };
    private readonly fail = (error: unknown) => this.emit("error", error);
    private readonly exit = (code: number) => this.emit("exit", code);
    constructor(...args: Args) {
      super();
      this.parser = idle.pop() ?? start(...args);
      void this.attach(this.parser);
    }
    private async attach(parser: Parser) {
      const ok = await parser.ready;
      if (this.parser !== parser) return;
      if (!ok) {
        this.emit("exit", 1);
        return;
      }
      parser.thread.on("message", this.forward);
      parser.thread.on("error", this.fail);
      parser.thread.on("exit", this.exit);
      this.emit("message", { kind: "ready" });
    }
    postMessage(...[value, transfer]: Parameters<Parser["thread"]["postMessage"]>) {
      this.busy = true;
      this.parser?.thread.postMessage(value, transfer);
    }
    async terminate() {
      const parser = this.parser;
      this.parser = undefined;
      if (!parser) return 0;
      parser.thread.off("message", this.forward);
      parser.thread.off("error", this.fail);
      parser.thread.off("exit", this.exit);
      if (this.busy || !(await parser.ready)) return parser.thread.terminate();
      idle.push(parser);
      return 0;
    }
  }
  class BlockedWorker extends threads.Worker {
    constructor(...[, options]: Args) {
      super(new URL("./fixtures/corpus-blocked-worker.mjs", import.meta.url), options);
      blockedParser.workers++;
      this.on("message", (event: unknown) => {
        if (kindOf(event) === "start") blockedParser.resolve?.();
      });
    }
  }
  // corpusCheck calls `new Worker()` and only uses the members both handles provide.
  function Worker(...args: Args) {
    return blockedParser.enabled ? new BlockedWorker(...args) : new PooledWorker(...args);
  }
  return { ...threads, Worker };
});

const directories: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close();
});
afterAll(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(wal = false) {
  const directory = mkdtempSync(join(tmpdir(), "openmail-corpus-test-"));
  directories.push(directory);
  const file = join(directory, "fixture.db");
  writeMigratedDatabase(file);
  const db = new DatabaseSync(file);
  db.exec("PRAGMA synchronous=OFF");
  databases.push(db);
  if (wal) db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
  db.prepare(
    "INSERT INTO accounts(id,provider,email,created_at,settings_json) VALUES (?,?,?,?,?)",
  ).run(
    "PrivateAccountMarker",
    "gmail",
    "PrivateAccountAddress@PrivateAccountDomain.invalid",
    1,
    null,
  );
  const keyDirectory = mkdtempSync(join(tmpdir(), "openmail-corpus-test-key-"));
  directories.push(keyDirectory);
  const runKeyFile = join(keyDirectory, "run.key");
  const rowids = new Map<string, number>();
  const add = (
    id: string,
    html: string,
    options: {
      date?: number;
      headers?: string;
      text?: string;
      cached?: number;
      subject?: string;
    } = {},
  ) => {
    const result = db
      .prepare(`INSERT INTO messages(id,account_id,provider_id,thread_id,subject,from_name,from_addr,to_json,cc_json,date,snippet,body_text,body_html,labels_json,attachments_json,is_unread,is_starred,body_cached,headers_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        id,
        "PrivateAccountMarker",
        `PrivateProviderMarker${id}`,
        "PrivateThreadMarker",
        options.subject ?? "SecretSubjectZephyra",
        "PrivateSenderName",
        "SecretSender@SecretSenderDomain.invalid",
        JSON.stringify([
          {
            name: "PrivateRecipientName",
            address: "SecretRecipient@SecretRecipientDomain.invalid",
          },
        ]),
        "[]",
        options.date ?? 10,
        "PrivateSnippetMarker",
        options.text ?? "SecretBodyCobalt SecretBodyNebula",
        html,
        "[]",
        JSON.stringify([
          { filename: "PrivateFileMarker.pdf", mimeType: "application/pdf", size: 123 },
        ]),
        0,
        0,
        options.cached ?? 1,
        options.headers ??
          JSON.stringify([
            {
              name: "Content-Type",
              value: "multipart/alternative; boundary=PrivateBoundaryMarker",
            },
            {
              name: "Authentication-Results",
              value: "mx.google.com; dmarc=fail; spf=fail; dkim=fail header.d=PrivateDomainMarker",
            },
            { name: "Date", value: "PrivateBadDateMarker" },
          ]),
      );
    rowids.set(id, Number(result.lastInsertRowid));
  };
  const hash = (id: string) => {
    const rowid = rowids.get(id);
    if (rowid === undefined) throw new Error("Unknown fixture ID");
    return createHmac("sha256", Buffer.from(readFileSync(runKeyFile, "utf8"), "hex"))
      .update(String(rowid))
      .digest("hex");
  };
  return { directory, file, db, add, runKeyFile, hash };
}

function sizeLimitFixture() {
  const f = fixture();
  // Size checks use raw columns, before parsing or cache bookkeeping. Avoid indexing
  // 16 MB and rewriting the entire row just to fill a counter this scan never reads.
  f.db.exec(
    "DROP TRIGGER messages_ai; DROP TRIGGER messages_words_ai; DROP TRIGGER messages_body_bytes_ai",
  );
  return f;
}

it("runs every real pipeline stage, samples newest first and emits no fixture content", async () => {
  const f = fixture();
  f.add("PrivateOldId", "<p>SecretHtmlOrion</p>", { date: 1 });
  f.add(
    "PrivateNewestId",
    '<p>SecretHtmlOrion</p><a href="https://SecretTargetDomain.invalid/PrivateUrlMarker">https://SecretDisplayDomain.invalid</a><script type="application/ld+json">{"@type":"Event","name":"PrivateEventMarker","startDate":"2026-10-05T12:00:00Z"}</script>',
    { date: 20 },
  );
  f.add("PrivateUncachedId", "<p>SecretHtmlOrion</p>", { date: 30, cached: 0 });
  f.db.close();
  chmodSync(f.file, 0o400);
  const before = readFileSync(f.file);
  const report = await corpusCheck({ db: f.file, runKeyFile: f.runKeyFile });
  expect(report.processed).toBe(2);
  for (const stage of CORPUS_STAGES) {
    expect(report.stages[stage].count).toBe(2);
    expect(report.stages[stage].completed).toBe(2);
    expect(report.stages[stage].failures).toEqual([]);
    expect(report.stages[stage].timeMs.max).toBeGreaterThanOrEqual(report.stages[stage].timeMs.p95);
  }
  expect(report.anomalies["missing-message-id"].count).toBe(2);
  expect(report.anomalies["failed-date-parse"].count).toBe(2);
  expect(report.anomalies["link-display-mismatch"].count).toBe(1);
  expect(report.anomalies["structured-events-found"].count).toBe(1);
  expect(report.anomalies["missing-message-id"].samples.map((s) => s.hash)).toEqual([
    f.hash("PrivateNewestId"),
    f.hash("PrivateOldId"),
  ]);
  expect(report.anomalies["missing-message-id"].samples[0]?.contentTypeStructure).toBe(
    "multipart/alternative[text/plain,text/html,application/pdf]",
  );
  const serialized = JSON.stringify(report);
  // Grep every word in all fixture subjects, names, addresses and plain/HTML message text,
  // plus identifiers, URL/filename/header-value canaries. Match the actual JSON output too.
  const privateText =
    "SecretSubjectZephyra PrivateSenderName SecretSender@SecretSenderDomain.invalid PrivateRecipientName SecretRecipient@SecretRecipientDomain.invalid SecretBodyCobalt SecretBodyNebula SecretHtmlOrion SecretTargetDomain.invalid SecretDisplayDomain.invalid PrivateUrlMarker PrivateEventMarker PrivateSnippetMarker PrivateFileMarker PrivateBoundaryMarker PrivateBadDateMarker PrivateDomainMarker PrivateAccountMarker PrivateAccountAddress@PrivateAccountDomain.invalid PrivateOldId PrivateNewestId PrivateProviderMarker PrivateThreadMarker";
  for (const word of new Set(privateText.match(/[A-Za-z]{3,}/g))) {
    expect(serialized).not.toContain(word);
    expect(formatCorpusReport(report)).not.toContain(word);
  }
  const key = readFileSync(f.runKeyFile, "utf8");
  expect(serialized).not.toContain(key);
  expect(serialized).not.toContain(f.runKeyFile);
  expect(serialized).not.toContain("salt");
  expectFileBytes(f.file, before);
  expect(readdirSync(f.directory)).toEqual(["fixture.db"]);
  const limited = await corpusCheck({ db: f.file, limit: 1 });
  expect(limited.processed).toBe(1);
  expect(limited).not.toHaveProperty("salt");
  expect(limited.anomalies["missing-message-id"].samples[0]?.hash).not.toBe(
    f.hash("PrivateNewestId"),
  );
  const next = await corpusCheck({ db: f.file, limit: 1 });
  expect(next.anomalies["missing-message-id"].samples[0]?.hash).not.toBe(
    limited.anomalies["missing-message-id"].samples[0]?.hash,
  );
  expect(statSync(f.runKeyFile).mode & 0o777).toBe(0o600);
  expect((await corpusCheck({ db: f.file, limit: 0 })).processed).toBe(0);
});

it("copies an open WAL database without touching source files, locks or keychain config", async () => {
  const f = fixture(true);
  try {
    f.add("PrivateWalId", "<p>SecretHtmlOrion</p>");
    f.db.exec("BEGIN IMMEDIATE");
    const files = readdirSync(f.directory);
    const before = files.map((name) => ({ name, bytes: readFileSync(join(f.directory, name)) }));
    const report = await corpusCheck({ db: f.file, runKeyFile: f.runKeyFile });
    expect(report.processed).toBe(1);
    expect(readdirSync(f.directory)).toEqual(files);
    for (const { name, bytes } of before) expectFileBytes(join(f.directory, name), bytes);
  } finally {
    f.db.close();
  }
});

it("counts parser anomalies, actual CSS budget/depth hits and bounds samples", async () => {
  const f = fixture();
  f.add("PrivateCssId", `<style>${"p{color:red}".repeat(5121)}</style><p>SecretHtmlOrion</p>`);
  f.add("PrivateDepthId", `${"<div>".repeat(520)}SecretHtmlOrion${"</div>".repeat(520)}`);
  f.add("PrivateReplacementId", "<p>\uFFFD\uFFFD\uFFFD SecretHtmlOrion</p>");
  f.add("PrivateDropId", "<form>SecretHtmlOrion</form>");
  f.add(
    "PrivateUnicodeLinkId",
    '<a href="https://xn--e1afmkfd.xn--p1ai/">https://SecretDisplayDomain.invalid</a>',
  );
  f.add(
    "PrivateHiddenLinkId",
    '<a hidden href="https://SecretTargetDomain.invalid/">https://SecretDisplayDomain.invalid</a>',
  );
  f.add("PrivateHugeHtmlId", `<p>${"a".repeat(1024 * 1024 + 1)}</p>`);
  for (let i = 0; i < 8; i++) f.add(`PrivateEmptyId${i}`, "<script>SecretHtmlOrion</script>");
  f.db.close();
  const report = await corpusCheck({ db: f.file, messageTimeoutMs: 10_000 });
  for (const kind of [
    "css-rule-budget",
    "nesting-depth-limit",
    "charset-replacements",
    "empty-visible-text",
    "budget-exceeded",
    "oversized-html",
  ] as const)
    expect(report.anomalies[kind].count, kind).toBeGreaterThan(0);
  expect(report.anomalies["empty-visible-text"].samples).toHaveLength(
    CORPUS_LIMITS.samplesPerDiagnostic,
  );
  expect(report.anomalies["css-rule-budget"].count).toBe(1);
  expect(report.anomalies["sanitizer-text-loss"].count).toBe(0);
  expect(report.anomalies["link-display-mismatch"].count).toBe(1);
});

it("redacts malformed cached JSON and attacker-controlled exception names/messages", async () => {
  const f = fixture();
  f.add("PrivateBrokenId", "", { headers: "PrivateMalformedSecretContent" });
  f.db.close();
  const report = await corpusCheck({ db: f.file, runKeyFile: f.runKeyFile });
  expect(report.stages["cache-decode"].failures[0]).toMatchObject({
    exceptionClass: "SchemaError",
    count: 1,
    location: "platform/node/corpus-pipeline.ts:decodeCache",
  });
  expect(JSON.stringify(report)).not.toContain("PrivateMalformedSecretContent");
  expect(report.stages["mime-decode"].count).toBe(0);
  const attacker = new Error("PrivateErrorContent");
  attacker.name = "PrivateErrorClass";
  attacker.stack = "PrivateErrorStack";
  expect(corpusException(attacker)).toBe("Error");
});

it("terminates a blocked parser worker on deadline and continues with the next message", async () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) f.add(`PrivateTimeoutId${i}`, "<p>SecretHtmlOrion</p>");
  f.db.close();
  blockedParser.enabled = true;
  blockedParser.workers = 0;
  const started = () =>
    new Promise<void>((resolve) => {
      blockedParser.resolve = resolve;
    });
  let nextStart = started();
  const termination = vi.spyOn(RealWorker.prototype, "terminate");
  const controller = new AbortController();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const running = corpusCheck({ db: f.file, messageTimeoutMs: 1, signal: controller.signal });
  try {
    for (let i = 0; i < 2; i++) {
      // Advance only after the real thread enters its synchronous blocking stage.
      await nextStart;
      nextStart = started();
      await vi.advanceTimersByTimeAsync(1);
    }
    const report = await running;
    expect(report.processed).toBe(2);
    expect(report.anomalies.timeout.count).toBe(2);
    expect(blockedParser.workers).toBe(2);
    expect(termination).toHaveBeenCalledTimes(2);
    expect(
      Object.values(report.stages)
        .flatMap((stage) => stage.failures)
        .every((failure) => failure.exceptionClass === "TimeoutError"),
    ).toBe(true);
  } finally {
    controller.abort();
    try {
      await running;
    } finally {
      termination.mockRestore();
      vi.useRealTimers();
      blockedParser.enabled = false;
      delete blockedParser.resolve;
    }
  }
});

it("caps a row before allocating its oversized fields and rejects unsafe inputs", async () => {
  const f = sizeLimitFixture();
  f.add("PrivateOversizeId", "", { text: "a".repeat(CORPUS_LIMITS.maxMessageBytes + 1) });
  f.db.close();
  const report = await corpusCheck({ db: f.file, runKeyFile: f.runKeyFile });
  expect(report.anomalies["message-size-limit"].count).toBe(1);
  expect(report.stages["mime-decode"].count).toBe(0);
  for (const limit of [-1, 1.5, Infinity])
    await expect(corpusCheck({ db: f.file, limit })).rejects.toBeInstanceOf(CorpusCheckError);
  await expect(corpusCheck({ db: join(f.directory, "PrivateMissingPath") })).rejects.toThrow(
    "Cannot create a stable read-only corpus snapshot",
  );
  expect(existsSync(join(f.directory, "PrivateMissingPath"))).toBe(false);
  const secretFile = join(f.directory, "PrivateInvalidDbPath");
  writeFileSync(secretFile, "PrivateInvalidDbContent");
  await expect(corpusCheck({ db: secretFile })).rejects.toThrow("Unsupported corpus database");
});

it("keeps fixed-memory percentile estimates within the documented error", () => {
  const times = new CorpusTimings();
  for (let i = 1; i <= 10000; i++) times.add(i / 100);
  const summary = times.summary();
  expect(summary.max).toBe(100);
  expect(summary.p50).toBeGreaterThanOrEqual(50);
  expect(summary.p50).toBeLessThanOrEqual(52.5);
  expect(summary.p95).toBeGreaterThanOrEqual(95);
  expect(summary.p95).toBeLessThanOrEqual(99.75);
});

it("invalid pipeline input fails at the cache boundary before downstream work", async () => {
  const pipeline = new CorpusPipeline();
  try {
    const events: unknown[] = [];
    await pipeline.run({ invalid: true }, (event) => events.push(event));
    expect(events).toHaveLength(2);
  } finally {
    pipeline.close();
  }
});

// The CLI tests below wait on child processes; they run concurrently with each other.
it.concurrent("CLI JSON is content-free and bypasses Mailbox/network/keychain initialization", async ({
  expect,
}) => {
  const f = fixture();
  f.add("PrivateCliId", "<p>SecretHtmlOrion</p>");
  f.db.close();
  const guard = join(f.directory, "no-network.mjs");
  writeFileSync(
    guard,
    `import net from 'node:net'; import tls from 'node:tls';\nnet.Socket.prototype.connect = () => { throw new Error('Network forbidden'); };\ntls.connect = () => { throw new Error('Network forbidden'); };\nglobalThis.fetch = () => { throw new Error('Network forbidden'); };`,
  );
  const { stdout, stderr } = await run(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--import",
      guard,
      cli.pathname,
      "corpus-check",
      "--db",
      f.file,
      "--json",
    ],
    {
      env: { ...process.env, OPENMAIL_HOME: join(f.directory, "must-not-exist") },
      timeout: 30_000,
    },
  );
  const result = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ processed: Schema.Int })),
  )(stdout);
  expect(result.processed).toBe(1);
  expect(stderr).toBe("");
  expect(existsSync(join(f.directory, "must-not-exist"))).toBe(false);
  for (const word of [
    "SecretSubjectZephyra",
    "PrivateSenderName",
    "SecretSender",
    "SecretSenderDomain",
    "PrivateRecipientName",
    "SecretRecipient",
    "SecretRecipientDomain",
    "SecretBodyCobalt",
    "SecretBodyNebula",
    "SecretHtmlOrion",
    "invalid",
    "PrivateSnippetMarker",
    "PrivateFileMarker",
    "PrivateBoundaryMarker",
    "PrivateBadDateMarker",
    "PrivateDomainMarker",
    "PrivateCliId",
    "PrivateAccountMarker",
  ])
    expect(stdout).not.toContain(word);
});

describe.concurrent("corpus explain", () => {
  let f: ReturnType<typeof fixture>;
  let target: string;
  let explained: CorpusExplainReport;
  let before: Uint8Array;
  beforeAll(async () => {
    f = fixture();
    const html =
      '<html><head><style>@media screen {.PrivateSelectorCanary:not(#PrivateIdCanary){display:none}}</style><body><p class="PrivateSelectorCanary">PrivateBodyCanary</p><!--[if mso]><p>PrivateMsoCanary</p><![endif]--></body></html>';
    f.add("PrivateExplainId", html, { date: 1 });
    f.add("PrivateOtherId", "<p>PrivateOtherBodyCanary</p>", { date: 2 });
    f.db.close();
    writeFileSync(f.runKeyFile, "b".repeat(64), { mode: 0o600 });
    before = readFileSync(f.file);
    target = f.hash("PrivateExplainId");
    explained = await corpusCheck({ db: f.file, explain: target, runKeyFile: f.runKeyFile });
  });

  it("explains exactly one previous hash with structural output only", ({ expect }) => {
    expect(explained).toMatchObject({
      mode: "explain",
      status: "complete",
      sample: { hash: target },
      failures: [],
    });
    expect(explained.diagnostics?.textPlainNonEmpty).toBe(true);
    expect(explained.diagnostics?.cachedHtml.tagCounts.p).toBe(1);
    expect(explained.diagnostics?.original.structure.bodyInsideHead).toBe(0);
    expect(explained.diagnostics?.original.removedByRule["omit-tag"].textNodes).toBe(1);
    expect(explained.diagnostics?.original.removedBySource["stylesheet-rule"].textNodes).toBe(1);
    expect(explained.diagnostics?.original.removedByRule["mso-conditional-comment"]).toEqual({
      textNodes: 1,
      characters: "PrivateMsoCanary".length,
    });
    expect(explained.diagnostics?.original.structure.stylesheetSelectorShapes).toMatchObject({
      "class-selector": 1,
      ":not": 1,
      "@media": 1,
    });
    const serialized = JSON.stringify(explained).toLowerCase();
    for (const word of [
      "SecretSubjectZephyra",
      "PrivateSenderName",
      "SecretSender",
      "SecretSenderDomain",
      "PrivateRecipientName",
      "SecretRecipient",
      "SecretRecipientDomain",
      "SecretBodyCobalt",
      "SecretBodyNebula",
      "PrivateSelectorCanary",
      "PrivateIdCanary",
      "PrivateBodyCanary",
      "PrivateMsoCanary",
      "PrivateOtherBodyCanary",
      "PrivateExplainId",
      "PrivateOtherId",
      "PrivateFileMarker",
      "PrivateBadDateMarker",
      "PrivateDomainMarker",
      "invalid",
    ])
      expect(serialized).not.toContain(word.toLowerCase());
    const key = readFileSync(f.runKeyFile, "utf8");
    expect(serialized).not.toContain(key);
    expect(serialized).not.toContain(f.runKeyFile);
    expect(serialized).not.toContain("salt");
    expectFileBytes(f.file, before);
  });

  it("uses the same private run key for repeat aggregate reports", async ({ expect }) => {
    const report = await corpusCheck({ db: f.file, runKeyFile: f.runKeyFile });
    const sameKey = await corpusCheck({ db: f.file, runKeyFile: f.runKeyFile });
    expect(sameKey.anomalies["missing-message-id"].samples.map((s) => s.hash)).toEqual(
      report.anomalies["missing-message-id"].samples.map((s) => s.hash),
    );
  });

  it("rejects a different run key, an invalid explain hash and a missing key file", async ({
    expect,
  }) => {
    const otherKey = join(f.directory, "other.key");
    writeFileSync(otherKey, "a".repeat(64), { mode: 0o600 });
    await expect(
      corpusCheck({ db: f.file, explain: target, runKeyFile: otherKey }),
    ).rejects.toThrow("Corpus explain message not found");
    await expect(
      corpusCheck({ db: f.file, explain: "PrivateBadHashCanary", runKeyFile: f.runKeyFile }),
    ).rejects.toThrow("Invalid corpus explain hash");
    await expect(
      corpusCheck({ db: f.file, explain: target, runKeyFile: "PrivateMissingKeyCanary" }),
    ).rejects.toThrow("Invalid corpus run key file");
    expectFileBytes(f.file, before);
  });

  it("CLI explain matches the core explanation and keeps fixture content private", async ({
    expect,
  }) => {
    const { stdout, stderr } = await run(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        cli.pathname,
        "corpus-check",
        "--db",
        f.file,
        "--explain",
        target,
        "--run-key",
        f.runKeyFile,
        "--json",
      ],
      {
        env: { ...process.env, OPENMAIL_HOME: join(f.directory, "must-not-exist") },
        timeout: 30_000,
      },
    );
    expect(JSON.parse(stdout)).toEqual(explained);
    expect(stderr).toBe("");
    expect(existsSync(join(f.directory, "must-not-exist"))).toBe(false);
    for (const word of [
      "SecretSubjectZephyra",
      "SecretSender",
      "SecretRecipient",
      "SecretBodyCobalt",
      "SecretBodyNebula",
      "PrivateSelectorCanary",
      "PrivateIdCanary",
      "PrivateBodyCanary",
      "PrivateMsoCanary",
    ])
      expect(stdout.toLowerCase()).not.toContain(word.toLowerCase());
  });

  it("CLI explain requires an explicit run key", async ({ expect }) => {
    await expect(
      run(
        process.execPath,
        [
          "--disable-warning=ExperimentalWarning",
          cli.pathname,
          "corpus-check",
          "--db",
          f.file,
          "--explain",
          target,
        ],
        {
          env: { ...process.env, OPENMAIL_HOME: join(f.directory, "must-not-exist") },
          timeout: 30_000,
        },
      ),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("Explain requires --run-key") });
  });
});

describe.concurrent("CLI explain-ready", () => {
  let f: ReturnType<typeof fixture>;
  let args: string[];
  let options: { env: NodeJS.ProcessEnv; timeout: number };
  let stdout: string;
  let stderr: string;
  let file: string;
  let key: string;
  let target: string;
  beforeAll(async () => {
    f = fixture();
    f.add("PrivateExplainReadyId", "<p>PrivateExplainReadyBody</p>");
    f.db.close();
    args = [
      "--disable-warning=ExperimentalWarning",
      cli.pathname,
      "corpus-check",
      "--db",
      f.file,
      "--json",
    ];
    options = {
      env: { ...process.env, OPENMAIL_HOME: join(f.directory, "must-not-exist") },
      timeout: 30_000,
    };
    ({ stdout, stderr } = await run(process.execPath, [...args, "--explain-ready"], options));
    const path = /^Run key file: (.+)\n$/.exec(stderr)?.[1];
    if (!path) throw new Error("Missing run key file path");
    file = path;
    directories.push(join(file, ".."));
    key = readFileSync(file, "utf8");
    target = createHmac("sha256", Buffer.from(key, "hex")).update("1").digest("hex");
  });
  it("writes only its private key path to stderr", ({ expect }) => {
    expect(stdout).toContain(target);
    expect(stdout).not.toContain(file);
    expect(stdout).not.toContain(key);
    expect(stderr).not.toContain(key);
    expect(existsSync(join(f.directory, "must-not-exist"))).toBe(false);
    expect(readdirSync(f.directory)).toEqual(["fixture.db"]);
  });
  it("can explain a sample with the generated run key", async ({ expect }) => {
    const explained = await run(
      process.execPath,
      [...args, "--explain", target, "--run-key", file],
      options,
    );
    expect(JSON.parse(explained.stdout)).toMatchObject({
      mode: "explain",
      status: "complete",
      sample: { hash: target },
    });
    expect(explained.stdout).not.toContain(key);
    expect(explained.stderr).toBe("");
    expect(existsSync(join(f.directory, "must-not-exist"))).toBe(false);
    expect(readdirSync(f.directory)).toEqual(["fixture.db"]);
  });
});

it("counts only whole-label URL/domain mismatches and ignores plain-word redirect anchors", async () => {
  const f = fixture();
  f.add(
    "PrivateTrackingId",
    '<style>.PrivateHiddenClassCanary{display:none}</style><div hidden><a href="https://PrivateTrackerDomain.invalid/r">PrivateDisplayedDomain.invalid</a></div><a class="PrivateHiddenClassCanary" href="https://PrivateTrackerDomain.invalid/r">PrivateDisplayedDomain.invalid</a><p><a href="https://PrivateTrackerDomain.invalid/r">PrivateCallToAction</a><a href="https://xn--e1afmkfd.xn--p1ai/r">PrivatePlainWords</a><a href="https://PrivateTrackerDomain.invalid/r">Review PrivateBrandDomain.invalid account</a><a href="https://PrivateTrackerDomain.invalid/r">https://PrivateDisplayedDomain.invalid</a><a href="https://sub.PrivateSameDomain.invalid/r">PrivateSameDomain.invalid</a><a href="https://PrivateTrackerDomain.invalid/r">PrivateDisplayedDomain.invalid</a></p>',
  );
  f.db.close();
  const report = await corpusCheck({ db: f.file, runKeyFile: f.runKeyFile });
  expect(report.anomalies["link-display-mismatch"].count).toBe(2);
});

it("Outlook newsletter gap styles retain readable descendants across the real corpus pipeline", async () => {
  const f = fixture();
  f.db.prepare("UPDATE accounts SET provider='outlook'").run();
  f.add(
    "PrivateInlineNewsletterId",
    '<table><tr><td style="font-size:0"><div style="font-size:14px">PrivateNewsletterBodyCanary</div></td></tr></table>',
    { text: "PrivateNewsletterBodyCanary" },
  );
  f.add(
    "PrivateCssNewsletterId",
    '<style>.PrivateGapCanary{font-size:0;visibility:hidden}.PrivateCopyCanary{font-size:12pt;visibility:visible}</style><table><tr><td class="PrivateGapCanary"><div class="PrivateCopyCanary">PrivateNewsletterBodyCanary</div></td></tr></table>',
    { text: "PrivateNewsletterBodyCanary" },
  );
  for (const size of ["1em", "100%", "1px"])
    f.add(
      `PrivateFontAttackId${size}`,
      `<table><tr><td style="font-size:0"><div style="font-size:${size}">PrivateAttackBodyCanary</div></td></tr></table>`,
      { text: "PrivateAttackBodyCanary" },
    );
  f.db.close();
  const report = await corpusCheck({ db: f.file, runKeyFile: f.runKeyFile });
  expect(report.processed).toBe(5);
  expect(report.anomalies["empty-visible-text"].count).toBe(3);
  for (const stage of Object.values(report.stages)) expect(stage.failures).toEqual([]);
  for (const id of ["PrivateInlineNewsletterId", "PrivateCssNewsletterId"]) {
    const explained = await corpusCheck({
      db: f.file,
      explain: f.hash(id),
      runKeyFile: f.runKeyFile,
    });
    expect(explained.status).toBe("complete");
    expect(explained.sample.provider).toBe("outlook");
    expect(explained.diagnostics?.original.visibleCharacters).toBe(
      "PrivateNewsletterBodyCanary".length,
    );
    expect(explained.diagnostics?.sanitized.visibleCharacters).toBe(
      "PrivateNewsletterBodyCanary".length,
    );
    expect(explained.diagnostics?.original.removedByRule["font-size-zero"].textNodes).toBe(0);
    expect(explained.diagnostics?.original.removedByRule.visibility.textNodes).toBe(0);
    for (const word of [
      "PrivateNewsletterBodyCanary",
      "PrivateGapCanary",
      "PrivateCopyCanary",
      "PrivateAttackBodyCanary",
    ])
      expect(JSON.stringify(explained)).not.toContain(word);
  }
});

it.each([
  ["desktop", "inline"],
  ["desktop", "stylesheet"],
  ["mobile", "inline"],
  ["mobile", "stylesheet"],
])(
  "responsive Outlook %s/%s retains its visible branch in aggregate and explain reports",
  async (variant, hiding) => {
    const f = fixture();
    f.db.prepare("UPDATE accounts SET provider='outlook'").run();

    const id = `PrivateResponsiveId${variant}${hiding}`;
    const active = variant === "desktop" ? "min-width:0px" : "max-width:8000px";
    const inactive = "min-width:8001px";
    const other = variant === "desktop" ? "mobile" : "desktop";
    const style = hiding === "inline" ? ' style="display:none"' : "";
    f.add(
      id,
      `<style>${hiding === "stylesheet" ? ".desktop,.mobile{display:none}" : ""}@media screen and (${active}){table[class~="${variant}"]:not(.excluded){display:block!important}}@media screen and (${inactive}){.${other}{display:block!important}}</style><table class="${variant}"${style}><tr><td>PrivateVisibleCanary</td></tr></table><table class="${other}"${style}><tr><td>PrivateHiddenCanary</td></tr></table>`,
      { text: "PrivateVisibleCanary" },
    );
    f.add(
      "PrivatePrintAttackId",
      '<style>.copy{display:none}@media print{.copy{display:block!important}}@media screen and (max-width:0){.copy{display:block!important}}</style><p class="copy">PrivateAttackCanary</p>',
    );
    f.db.close();
    const report = await corpusCheck({ db: f.file, runKeyFile: f.runKeyFile });
    expect(report.anomalies["empty-visible-text"].count).toBe(1);
    for (const stage of Object.values(report.stages)) expect(stage.failures).toEqual([]);

    const explained = await corpusCheck({
      db: f.file,
      explain: f.hash(id),
      runKeyFile: f.runKeyFile,
    });
    expect(explained.status).toBe("complete");
    expect(explained.diagnostics?.original.visibleCharacters).toBe("PrivateVisibleCanary".length);
    expect(explained.diagnostics?.sanitized.visibleCharacters).toBe("PrivateVisibleCanary".length);
    expect(explained.diagnostics?.original.removedByRule["display-none"].textNodes).toBe(1);
    for (const word of ["PrivateVisibleCanary", "PrivateHiddenCanary", "PrivateAttackCanary"])
      expect(JSON.stringify(explained)).not.toContain(word);
  },
);

it("persists explain keys only outside reports and rejects unsafe key files", async () => {
  const f = fixture();
  f.add("PrivateRowIdCanary", "<p>PrivateBodyCanary</p>");
  f.db.close();
  const keyFile = createCorpusRunKeyFile();
  directories.push(join(keyFile, ".."));
  expect(statSync(keyFile).mode & 0o777).toBe(0o600);
  expect(statSync(join(keyFile, "..")).mode & 0o777).toBe(0o700);
  const key = readFileSync(keyFile, "utf8");
  expect(key).toMatch(/^[a-f\d]{64}$/);
  const report = await corpusCheck({ db: f.file, runKeyFile: keyFile });
  const expected = createHmac("sha256", Buffer.from(key, "hex")).update("1").digest("hex");
  const idHash = createHmac("sha256", Buffer.from(key, "hex"))
    .update("PrivateRowIdCanary")
    .digest("hex");
  expect(report.anomalies["missing-message-id"].samples[0]?.hash).toBe(expected);
  expect(expected).not.toBe(idHash);
  for (const output of [JSON.stringify(report), formatCorpusReport(report)]) {
    expect(output).not.toContain(key);
    expect(output).not.toContain(keyFile);
    expect(output).not.toContain("salt");
  }
  const link = join(f.directory, "key-link");
  symlinkSync(keyFile, link);
  await expect(corpusCheck({ db: f.file, runKeyFile: link })).rejects.toThrow(
    "Invalid corpus run key file",
  );
  chmodSync(keyFile, 0o644);
  await expect(corpusCheck({ db: f.file, runKeyFile: keyFile })).rejects.toThrow(
    "Invalid corpus run key file",
  );
  chmodSync(keyFile, 0o600);
  for (const value of ["PrivateInvalidKeyCanary", "x".repeat(64)]) {
    writeFileSync(keyFile, value);
    await expect(corpusCheck({ db: f.file, runKeyFile: keyFile })).rejects.toThrow(
      "Invalid corpus run key file",
    );
  }
  const missing = join(f.directory, "missing.key");
  await expect(corpusCheck({ db: f.file, explain: expected, runKeyFile: missing })).rejects.toThrow(
    "Invalid corpus run key file",
  );
  expect(existsSync(missing)).toBe(false);
});

it("oversized IDs and bodies still have rowid samples that explain without truncation", async () => {
  const f = sizeLimitFixture();
  const id = "PrivateLongIdCanary".repeat(300);
  f.add(id, "", { text: "a".repeat(CORPUS_LIMITS.maxMessageBytes + 1) });
  f.db.close();
  const report = await corpusCheck({ db: f.file, runKeyFile: f.runKeyFile });
  const target = f.hash(id);
  expect(report.anomalies["message-size-limit"].samples[0]?.hash).toBe(target);
  const explained = await corpusCheck({ db: f.file, explain: target, runKeyFile: f.runKeyFile });
  expect(explained).toMatchObject({
    status: "size-limit",
    sample: { hash: target },
    diagnostics: null,
  });
  expect(JSON.stringify(explained)).not.toContain("PrivateLongIdCanary");
});

it("responsive Outlook fixture corpus retains desktop text without uncertain-css losses", async () => {
  const f = fixture();
  f.db.prepare("UPDATE accounts SET provider='outlook'").run();
  const body = "PrivateDesktopBodyCanary ".repeat(1000).trim();
  const html = `<style>.mobile{display:none}@media screen and (max-width:600px){.desktop{display:none!important}.mobile{display:block!important}}@media screen and (min-width:601px){.desktop{font-size:14px;color:#222;line-height:1.4}}@media screen and (min-width:900px){.desktop td{padding:10px}}</style><table class="desktop"><tr><td>${body}</td></tr></table><div class="mobile">PrivateMobileBodyCanary</div>`;
  f.add("PrivateResponsiveFixtureId", html, { text: body });
  f.db.close();
  const report = await corpusCheck({ db: f.file, runKeyFile: f.runKeyFile });
  expect(report.processed).toBe(1);
  expect(report.anomalies["empty-visible-text"].count).toBe(0);
  expect(report.anomalies["sanitizer-text-loss"].count).toBe(0);
  for (const stage of Object.values(report.stages)) expect(stage.failures).toEqual([]);
  const explained = await corpusCheck({
    db: f.file,
    explain: f.hash("PrivateResponsiveFixtureId"),
    runKeyFile: f.runKeyFile,
  });
  expect(explained.status).toBe("complete");
  for (const visibility of [explained.diagnostics?.original, explained.diagnostics?.sanitized]) {
    expect(visibility?.visibleCharacters).toBe(body.length);
    expect(visibility?.removedByRule["uncertain-css"].textNodes).toBe(0);
    expect(visibility?.removedByRule["display-none"].textNodes).toBe(1);
    expect(visibility?.retainedTextNodes).toBe(1);
  }
  for (const output of [JSON.stringify(report), JSON.stringify(explained)]) {
    expect(output).not.toContain("PrivateDesktopBodyCanary");
    expect(output).not.toContain("PrivateMobileBodyCanary");
    expect(output).not.toContain("PrivateResponsiveFixtureId");
  }
});

it("notification colour schemes stay coherent through aggregate and explain corpus paths", async () => {
  const f = fixture();
  f.db.prepare("UPDATE accounts SET provider='outlook'").run();
  const words = Array.from({ length: 10 }, (_, i) => `NotificationCanary${i}`);
  const body = words.join("\n");
  const rows = words.map((word) => `<p class="dark-font">${word}</p>`).join("");
  const html = `<style>body{background-color:#140606}.main-container{background-color:#fff}.dark-font{color:#000!important}@media(prefers-color-scheme:dark){body{background-color:#262626}.dark-main-container{background-color:#333!important}.dark-font{color:#fff!important}}[data-ogsc] .dark-font{color:#fff!important}[data-ogsc] .dark-main-container{background-color:#333!important}[data-ogsb] .dark-font{color:#fff!important}</style><table><tr><td class="main-container dark-main-container" bgcolor="#fff"><table><tr><td style="color:#000">${rows}</td></tr></table></td></tr></table>`;
  f.add("NotificationFixtureId", html, { text: body });
  f.db.close();
  const report = await corpusCheck({ db: f.file, runKeyFile: f.runKeyFile });
  expect(report.processed).toBe(1);
  expect(report.anomalies["empty-visible-text"].count).toBe(0);
  for (const stage of Object.values(report.stages)) expect(stage.failures).toEqual([]);
  const explanation = await corpusCheck({
    db: f.file,
    runKeyFile: f.runKeyFile,
    explain: f.hash("NotificationFixtureId"),
  });
  expect(explanation.status).toBe("complete");
  for (const visibility of [
    explanation.diagnostics?.original,
    explanation.diagnostics?.sanitized,
  ]) {
    expect(visibility?.visibleCharacters).toBe(body.length);
    expect(visibility?.retainedTextNodes).toBe(10);
    expect(visibility?.removedByRule["colour-match"].textNodes).toBe(0);
  }
  const serialized = JSON.stringify({ report, explanation });
  for (const word of words) expect(serialized).not.toContain(word);
  expect(serialized).not.toContain("NotificationFixtureId");
});
