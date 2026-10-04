import { createHmac, randomBytes } from "node:crypto";
import {
  copyFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  statSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { Option, Record, Schema } from "effect";
import { Provider } from "../../domain.js";
import {
  CORPUS_ANOMALIES,
  CORPUS_LIMITS,
  CORPUS_LOCATIONS,
  CORPUS_STAGES,
  type CorpusAnomaly,
  CorpusStage,
  type CorpusStageReport,
  CorpusSample,
  CorpusTimings,
  corpusSizeBucket,
  WorkerEvent,
  emptyAnomalies,
  type CorpusReport,
  type CorpusExplainReport,
  type ExceptionClass,
} from "./corpus-report.js";
export { CORPUS_LIMITS, type CorpusReport, type CorpusExplainReport } from "./corpus-report.js";

/** Fixed errors deliberately exclude paths, SQLite errors, message text and raw stacks. */
export class CorpusCheckError extends Error {
  constructor(
    message:
      | "Invalid corpus limit"
      | "Invalid corpus timeout"
      | "Cannot create a stable read-only corpus snapshot"
      | "Unsupported corpus database"
      | "Cannot start corpus parser worker"
      | "Invalid corpus run key file"
      | "Invalid corpus explain hash (expected 64 hex characters)"
      | "Corpus explain message not found"
      | "Cannot create corpus run key file",
  ) {
    super(message);
    this.name = "CorpusCheckError";
  }
}
interface CorpusBaseOptions {
  db: string;
  /** Core-only override for constrained/offline runners; the CLI uses the fixed default. */
  messageTimeoutMs?: number;
  signal?: AbortSignal;
}
export type CorpusScanOptions = CorpusBaseOptions & {
  limit?: number;
  runKeyFile?: string;
  explain?: never;
};
export type CorpusExplainOptions = CorpusBaseOptions & {
  explain: string;
  runKeyFile: string;
  limit?: never;
};
export type CorpusCheckOptions = CorpusScanOptions | CorpusExplainOptions;

function snapshot(source: string, directory: string): string {
  const target = join(directory, "mail.db");
  for (let attempt = 0; attempt < 3; attempt++) {
    const files = [source, `${source}-wal`].filter((file) => existsSync(file));
    if (files[0] !== source || files.some((file) => !lstatSync(file).isFile())) break;
    const before = files.map((file) => statSync(file));
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${target}${suffix}`, { force: true });
    for (const [index, file] of files.entries()) {
      const destination = index === 0 ? target : `${target}-wal`;
      copyFileSync(file, destination);
      chmodSync(destination, 0o600);
    }
    const stable = files.every((file, index) => {
      if (!existsSync(file)) return false;
      const after = statSync(file),
        prior = before[index];
      return (
        prior &&
        after.ino === prior.ino &&
        after.size === prior.size &&
        after.mtimeMs === prior.mtimeMs &&
        after.ctimeMs === prior.ctimeMs
      );
    });
    if (stable && existsSync(`${source}-wal`) === files.includes(`${source}-wal`)) return target;
  }
  throw new CorpusCheckError("Cannot create a stable read-only corpus snapshot");
}

const Metadata = Schema.Struct({
  rowid: Schema.Number,
  provider: Schema.String,
  size_bytes: Schema.Number,
  cached_bytes: Schema.Number,
  html_bytes: Schema.Number,
  body_text: Schema.String,
  body_html: Schema.String,
  headers_json: Schema.NullOr(Schema.String),
  attachments_json: Schema.String,
});

class CorpusWorker {
  private readonly worker = new Worker(new URL("./corpus-worker.js", import.meta.url), {
    execArgv: [],
    resourceLimits: {
      maxOldGenerationSizeMb: CORPUS_LIMITS.workerHeapMb,
      maxYoungGenerationSizeMb: 16,
    },
    stdout: true,
    stderr: true,
  });
  private failed = false;
  private ready: Promise<void>;
  constructor() {
    // A library warning/error must never become an output channel for message content.
    this.worker.stdout.resume();
    this.worker.stderr.resume();
    this.worker.on("error", () => {
      this.failed = true;
    });
    this.worker.on("exit", () => {
      this.failed = true;
    });
    this.ready = new Promise((accept, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.worker.off("message", message);
        this.worker.off("error", failure);
        this.worker.off("exit", failure);
      };
      const failure = () => {
        cleanup();
        reject(new CorpusCheckError("Cannot start corpus parser worker"));
      };
      const message = (raw: unknown) => {
        const event = Schema.decodeUnknownOption(WorkerEvent)(raw);
        if (Option.isSome(event) && event.value.kind === "ready") {
          cleanup();
          accept();
        } else failure();
      };
      const timer = setTimeout(failure, CORPUS_LIMITS.startupTimeoutMs);
      this.worker.once("message", message);
      this.worker.once("error", failure);
      this.worker.once("exit", failure);
    });
  }
  async close() {
    await this.worker.terminate();
  }
  async run(
    row: unknown,
    timeout: number,
    signal: AbortSignal | undefined,
    receive: (event: WorkerEvent) => void,
    explain = false,
  ): Promise<"done" | "timeout" | "failed" | "aborted"> {
    await this.ready;
    if (this.failed) return "failed";
    return new Promise((accept) => {
      const finish = (outcome: "done" | "timeout" | "failed" | "aborted") => {
        clearTimeout(timer);
        this.worker.off("message", message);
        this.worker.off("error", failure);
        this.worker.off("exit", failure);
        signal?.removeEventListener("abort", abort);
        accept(outcome);
      };
      const failure = () => finish("failed");
      const abort = () => finish("aborted");
      const message = (raw: unknown) => {
        const parsed = Schema.decodeUnknownOption(WorkerEvent)(raw);
        if (Option.isNone(parsed)) {
          failure();
          return;
        }
        const event = parsed.value;
        if (event.kind === "done") finish("done");
        else receive(event);
      };
      const timer = setTimeout(() => finish("timeout"), timeout);
      this.worker.on("message", message);
      this.worker.once("error", failure);
      this.worker.once("exit", failure);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else this.worker.postMessage({ row, explain }, []);
    });
  }
}

const stageReports = (): Record<CorpusStage, CorpusStageReport> =>
  Record.fromEntries(
    CORPUS_STAGES.map((stage): [CorpusStage, CorpusStageReport] => [
      stage,
      {
        count: 0,
        completed: 0,
        failures: [],
        timeMs: { p50: 0, p95: 0, max: 0 },
        anomalies: emptyAnomalies(),
      },
    ]),
  );
/** Explicit CLI opt-in: a private persistent key, outside every diagnostic report. */
export function createCorpusRunKeyFile(): string {
  try {
    const dir = mkdtempSync(join(tmpdir(), "openmail-corpus-key-"));
    chmodSync(dir, 0o700);
    const file = join(dir, "run.key");
    writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
    return file;
  } catch {
    throw new CorpusCheckError("Cannot create corpus run key file");
  }
}

function runKey(options: CorpusCheckOptions): Uint8Array {
  if (!options.runKeyFile) return randomBytes(32);
  try {
    if (existsSync(options.runKeyFile)) {
      const info = lstatSync(options.runKeyFile);
      if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size !== 64)
        throw new CorpusCheckError("Invalid corpus run key file");
      const key = readFileSync(options.runKeyFile, "utf8");
      if (!/^[a-f\d]{64}$/i.test(key)) throw new CorpusCheckError("Invalid corpus run key file");
      return Buffer.from(key, "hex");
    }
    if (options.explain !== undefined) throw new CorpusCheckError("Invalid corpus run key file");
    const key = randomBytes(32);
    writeFileSync(options.runKeyFile, key.toString("hex"), { mode: 0o600, flag: "wx" });
    return key;
  } catch (error) {
    if (error instanceof CorpusCheckError) throw error;
    throw new CorpusCheckError(
      options.explain === undefined
        ? "Cannot create corpus run key file"
        : "Invalid corpus run key file",
    );
  }
}

/** Offline corpus diagnostics. This never initializes or opens the user's Mailbox. */
export function corpusCheck(options: CorpusScanOptions): Promise<CorpusReport>;
export function corpusCheck(options: CorpusExplainOptions): Promise<CorpusExplainReport>;
export async function corpusCheck(
  options: CorpusCheckOptions,
): Promise<CorpusReport | CorpusExplainReport> {
  if (options.explain !== undefined && !/^[a-f\d]{64}$/i.test(options.explain))
    throw new CorpusCheckError("Invalid corpus explain hash (expected 64 hex characters)");
  const limit = options.limit ?? -1;
  if (options.limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))
    throw new CorpusCheckError("Invalid corpus limit");
  const timeout = options.messageTimeoutMs ?? CORPUS_LIMITS.messageTimeoutMs;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000)
    throw new CorpusCheckError("Invalid corpus timeout");
  const key = runKey(options);
  const hashRow = (rowid: number) => createHmac("sha256", key).update(String(rowid)).digest("hex");
  let explainReport: CorpusExplainReport | null = null;
  const report: CorpusReport = {
    version: 2,
    processed: 0,
    source: "temporary-read-only-snapshot",
    mimeSource: "reconstructed-cached-utf8",
    limits: { ...CORPUS_LIMITS, messageTimeoutMs: timeout },
    stages: stageReports(),
    anomalies: Record.fromEntries(
      CORPUS_ANOMALIES.map((kind): [CorpusAnomaly, { count: number; samples: CorpusSample[] }] => [
        kind,
        { count: 0, samples: [] },
      ]),
    ),
  };
  const timings = new Map(CORPUS_STAGES.map((stage) => [stage, new CorpusTimings()]));
  const addAnomaly = (
    stage: CorpusStage,
    kind: CorpusAnomaly,
    count: number,
    sample?: CorpusSample,
  ) => {
    if (!count) return;
    report.stages[stage].anomalies[kind] += count;
    const aggregate = report.anomalies[kind];
    aggregate.count += count;
    if (
      sample &&
      aggregate.samples.length < CORPUS_LIMITS.samplesPerDiagnostic &&
      !aggregate.samples.some((s) => s.hash === sample.hash)
    )
      aggregate.samples.push(sample);
  };
  const addFailure = (stage: CorpusStage, exceptionClass: ExceptionClass, sample: CorpusSample) => {
    const failures = report.stages[stage].failures;
    let failure = failures.find((f) => f.exceptionClass === exceptionClass);
    if (!failure) {
      failure = { exceptionClass, location: CORPUS_LOCATIONS[stage], count: 0, samples: [] };
      failures.push(failure);
    }
    failure.count++;
    if (failure.samples.length < CORPUS_LIMITS.samplesPerDiagnostic) failure.samples.push(sample);
  };
  let directory: string | undefined, db: DatabaseSync | undefined, worker: CorpusWorker | undefined;
  try {
    directory = mkdtempSync(join(tmpdir(), "openmail-corpus-"));
    chmodSync(directory, 0o700);
    let file: string;
    try {
      file = snapshot(resolve(options.db), directory);
    } catch {
      throw new CorpusCheckError("Cannot create a stable read-only corpus snapshot");
    }
    db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
    db.exec(
      "PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA cache_size=-2048; PRAGMA temp_store=FILE; PRAGMA busy_timeout=0",
    );
    if (db.prepare("PRAGMA query_only").get()?.["query_only"] !== 1)
      throw new CorpusCheckError("Unsupported corpus database");
    // Reject views: a corpus must use the real cache tables and cannot redefine projections.
    for (const name of ["messages", "accounts"]) {
      if (db.prepare("SELECT type FROM sqlite_master WHERE name=?").get(name)?.["type"] !== "table")
        throw new CorpusCheckError("Unsupported corpus database");
    }
    if (options.explain !== undefined)
      db.function("corpus_message_hash", { deterministic: true }, (rowid) => {
        if (typeof rowid !== "number") throw new CorpusCheckError("Unsupported corpus database");
        return hashRow(rowid);
      });
    const columns = [
      "id",
      "account_id",
      "provider_id",
      "thread_id",
      "subject",
      "from_name",
      "from_addr",
      "to_json",
      "cc_json",
      "body_text",
      "body_html",
      "headers_json",
      "attachments_json",
      "rfc_message_id",
    ];
    const bytes = columns.map((name) => `COALESCE(length(CAST(m.${name} AS BLOB)),0)`).join("+");
    const projection = columns
      .map(
        (name) =>
          `CASE WHEN (${bytes})<=${CORPUS_LIMITS.maxMessageBytes} THEN m.${name} ELSE ${name === "id" ? "substr(m.id,1,4096)" : name === "headers_json" || name === "rfc_message_id" ? "NULL" : name === "attachments_json" || name === "to_json" || name === "cc_json" ? "'[]'" : "''"} END AS ${name}`,
      )
      .join(",");
    const rows = db
      .prepare(`SELECT ${projection},m.rowid AS rowid,m.date,a.provider,
      CASE WHEN json_valid(a.settings_json) THEN json_extract(a.settings_json,'$.authservId') ELSE NULL END AS authserv_id,
      (${bytes}) AS cached_bytes,COALESCE(m.message_size,(${bytes})) AS size_bytes,
      length(CAST(m.body_html AS BLOB)) AS html_bytes
      FROM messages m JOIN accounts a ON a.id=m.account_id
      WHERE m.body_cached=1${options.explain === undefined ? "" : " AND corpus_message_hash(m.rowid)=?"} ORDER BY m.date DESC,m.id LIMIT ?`)
      .iterate(...(options.explain === undefined ? [limit] : [options.explain.toLowerCase(), 1]));
    for (const raw of rows) {
      if (options.signal?.aborted) break;
      const metadata = Schema.decodeUnknownSync(Metadata)(raw);
      report.processed++;
      const provider = Option.getOrNull(Schema.decodeUnknownOption(Provider)(metadata.provider));
      let sample: CorpusSample = {
        hash: hashRow(metadata.rowid),
        provider: provider ?? "unknown",
        sizeBucket: corpusSizeBucket(metadata.size_bytes),
        contentTypeStructure: "other[]",
      };
      const explanation: CorpusExplainReport | null =
        options.explain === undefined
          ? null
          : {
              version: 2,
              mode: "explain",
              sample,
              status: "complete",
              diagnostics: null,
              failures: [],
            };
      explainReport = explanation;
      if (metadata.cached_bytes > CORPUS_LIMITS.maxMessageBytes) {
        if (explanation) explanation.status = "size-limit";
        addAnomaly("cache-decode", "message-size-limit", 1, sample);
        if (metadata.html_bytes > 1024 * 1024)
          addAnomaly("cache-decode", "oversized-html", 1, sample);
        continue;
      }
      worker ??= new CorpusWorker();
      let activeStage: CorpusStage = "cache-decode";
      const state = { started: performance.now(), active: false };
      const outcome = await worker.run(
        raw,
        timeout,
        options.signal,
        (event) => {
          if (event.kind === "explanation") {
            if (explanation) explanation.diagnostics = event.diagnostics;
          } else if (event.kind === "structure") {
            sample = {
              ...sample,
              contentTypeStructure: `${event.structure.root}[${event.structure.parts.join(",")}]`,
            };
            if (explanation) explanation.sample = sample;
          } else if (event.kind === "start") {
            activeStage = event.stage;
            state.started = performance.now();
            state.active = true;
            report.stages[event.stage].count++;
          } else if (event.kind === "stage") {
            state.active = false;
            report.stages[event.stage].completed++;
            timings.get(event.stage)?.add(event.ms);
            if (event.failure) {
              addFailure(event.stage, event.failure, sample);
              if (explanation) {
                explanation.status = "failed";
                explanation.failures.push({
                  stage: event.stage,
                  exceptionClass: event.failure,
                  location: CORPUS_LOCATIONS[event.stage],
                });
              }
            }
            for (const kind of CORPUS_ANOMALIES)
              addAnomaly(event.stage, kind, event.anomalies[kind], sample);
          }
        },
        options.explain !== undefined,
      );
      if (outcome !== "done") {
        if (explanation) {
          explanation.status = outcome === "failed" ? "failed" : outcome;
          explanation.failures.push({
            stage: activeStage,
            exceptionClass: outcome === "failed" ? "WorkerError" : "TimeoutError",
            location: CORPUS_LOCATIONS[activeStage],
          });
        }
        if (!state.active) report.stages[activeStage].count++;
        timings.get(activeStage)?.add(performance.now() - state.started);
        addFailure(
          activeStage,
          outcome === "timeout" || outcome === "aborted" ? "TimeoutError" : "WorkerError",
          sample,
        );
        if (outcome === "timeout" || outcome === "aborted")
          addAnomaly(activeStage, "timeout", 1, sample);
        await worker.close();
        worker = undefined;
        if (outcome === "aborted") break;
      }
    }
    if (options.explain !== undefined) {
      if (!explainReport) throw new CorpusCheckError("Corpus explain message not found");
      return explainReport;
    }
    for (const stage of CORPUS_STAGES)
      report.stages[stage].timeMs = timings.get(stage)?.summary() ?? { p50: 0, p95: 0, max: 0 };
    return report;
  } catch (error) {
    if (error instanceof CorpusCheckError) throw error;
    throw new CorpusCheckError("Unsupported corpus database");
  } finally {
    try {
      await worker?.close();
    } finally {
      try {
        db?.close();
      } finally {
        if (directory) rmSync(directory, { recursive: true, force: true });
      }
    }
  }
}

const sampleLine = (sample: CorpusSample) =>
  `  ${sample.hash} ${sample.provider} ${sample.sizeBucket} ${sample.contentTypeStructure}`;

export function formatCorpusReport(report: CorpusReport): string {
  const lines = [
    `Corpus check: ${report.processed} cached messages`,
    `Source: ${report.source}; MIME: ${report.mimeSource}`,
    "Stage                         Count  Failures   p50 ms   p95 ms   max ms",
    ...CORPUS_STAGES.map((stage) => {
      const item = report.stages[stage],
        t = item.timeMs;
      return `${stage.padEnd(29)} ${String(item.count).padStart(6)} ${String(item.failures.reduce((sum, f) => sum + f.count, 0)).padStart(9)} ${t.p50.toFixed(2).padStart(8)} ${t.p95.toFixed(2).padStart(8)} ${t.max.toFixed(2).padStart(8)}`;
    }),
  ];
  for (const kind of CORPUS_ANOMALIES) {
    const anomaly = report.anomalies[kind];
    if (anomaly.count) lines.push(`${kind}: ${anomaly.count}`, ...anomaly.samples.map(sampleLine));
  }
  for (const stage of CORPUS_STAGES)
    for (const failure of report.stages[stage].failures) {
      lines.push(
        `${stage}: ${failure.exceptionClass} at ${failure.location} (${failure.count})`,
        ...failure.samples.map(sampleLine),
      );
    }
  return lines.join("\n");
}
