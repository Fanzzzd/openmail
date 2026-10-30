import { fileURLToPath } from "node:url";
import { nodeSearchProcess } from "./search-process.js";
import { Effect, Layer, Schema } from "effect";
import { InvalidInput } from "../../domain/errors.js";
import { ThreadSummary, type ThreadQuery } from "../../domain/message.js";
import { SearchReader, type SearchProcess, type SearchProcessLauncher } from "../search-reader.js";

const Reply = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ready") }),
  Schema.Struct({ kind: Schema.Literal("threads"), value: Schema.Array(ThreadSummary) }),
  Schema.Struct({ kind: Schema.Literal("count"), value: Schema.Number }),
  Schema.Struct({ kind: Schema.Literal("invalid"), message: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("error") }),
]);
type Reply = typeof Reply.Type;
type Request = { kind: "threads" | "count"; query: ThreadQuery };
interface Job {
  request: Request;
  resolve: (reply: Reply) => void;
  reject: (error: Error) => void;
  off: () => void;
}

/**
 * One read-only process, one query at a time. Aborting the running job kills the process, including
 * a native SQLite statement, and waits for its exit before starting a replacement. Queued jobs
 * keep their own cancellation signals, so aborting one caller never cancels another's search.
 * No obsolete reply can be routed to a newer request: each reply belongs to its child and job.
 */
class SearchChild {
  private child?: SearchProcess;
  private ready = false;
  private active?: Job;
  private readonly queue: Job[] = [];
  private stopping?: Promise<void>;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private offMessage?: () => void;
  private offFailure?: () => void;
  constructor(
    private readonly file: string,
    private readonly entry: string,
    private readonly launch: SearchProcessLauncher,
  ) {}

  run(request: Request, signal: AbortSignal): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const abort = () => {
        const index = this.queue.indexOf(job);
        if (index >= 0) this.queue.splice(index, 1);
        if (this.active === job) {
          this.active = undefined;
          void this.stop().then(() => this.dispatch());
        }
        job.off();
        reject(new Error("Search interrupted"));
      };
      const job: Job = {
        request,
        resolve,
        reject,
        off: () => signal.removeEventListener("abort", abort),
      };
      if (this.closed || signal.aborted) {
        reject(new Error("Search reader closed"));
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
      this.queue.push(job);
      this.dispatch();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failQueued("Search reader closed");
    this.failActive();
    await this.stop();
  }

  private failQueued(message: string): void {
    for (const job of this.queue.splice(0)) {
      job.off();
      job.reject(new Error(message));
    }
  }

  private dispatch() {
    if (this.closed || this.stopping || this.active || this.queue.length === 0) return;
    if (!this.child) {
      let child: SearchProcess;
      try {
        child = this.launch(this.entry, this.file);
      } catch {
        this.failQueued("Could not start local search");
        return;
      }
      this.child = child;
      this.timer = setTimeout(() => this.fail(child), 30_000);
      this.offMessage = child.onMessage((input: unknown) => {
        if (this.child !== child) return;
        let decoded: unknown;
        try {
          decoded = typeof input === "string" ? JSON.parse(input) : input;
        } catch {
          this.fail(child);
          return;
        }
        const reply = Schema.decodeUnknownExit(Reply)(decoded);
        if (reply._tag === "Failure") return this.fail(child);
        const message = reply.value;
        clearTimeout(this.timer);
        if (message.kind === "ready") this.ready = true;
        else if (this.active) {
          const job = this.active;
          this.active = undefined;
          job.off();
          job.resolve(message);
        } else return this.fail(child);
        this.dispatch();
      });
      this.offFailure = child.onFailure(() => this.fail(child));
    }
    if (!this.ready) return;
    this.active = this.queue.shift();
    if (!this.active) return;
    this.timer = setTimeout(() => {
      if (this.child) this.fail(this.child);
    }, 120_000);
    // JSON drops optional undefined keys, exactly as the renderer's RPC frames do.
    try {
      this.child.send(JSON.parse(JSON.stringify(this.active.request)));
    } catch {
      this.fail(this.child);
    }
  }

  private failActive() {
    this.active?.off();
    this.active?.reject(new Error("Local search process failed"));
    this.active = undefined;
  }

  private fail(child: SearchProcess): void {
    if (this.child !== child) return;
    if (!this.ready) this.failQueued("Local search process failed to start");
    this.failActive();
    void this.stop().then(() => this.dispatch());
  }

  private stopped(): void {
    this.stopping = undefined;
  }

  private stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const child = this.child;
    this.child = undefined;
    this.ready = false;
    clearTimeout(this.timer);
    this.offMessage?.();
    this.offFailure?.();
    this.offMessage = undefined;
    this.offFailure = undefined;
    if (!child) return Promise.resolve();
    this.stopping = child.kill().finally(() => this.stopped());
    return this.stopping;
  }
}

/** Entry override is for tests. Production always resolves the packaged core-owned module. */
export const NodeSearchReader = (
  file: string,
  entry = new URL("./search-worker.js", import.meta.url),
  launch: SearchProcessLauncher = nodeSearchProcess,
) =>
  Layer.effect(
    SearchReader,
    Effect.gen(function* () {
      const worker = yield* Effect.acquireRelease(
        Effect.sync(() => new SearchChild(file, fileURLToPath(entry), launch)),
        (reader) => Effect.promise(() => reader.close()),
      );
      const read = (request: Request) =>
        Effect.tryPromise({
          try: (signal) => worker.run(request, signal),
          catch: (error) => error,
        }).pipe(
          Effect.orDie,
          Effect.flatMap((reply) =>
            reply.kind === "invalid"
              ? Effect.fail(new InvalidInput({ message: reply.message }))
              : reply.kind === "error"
                ? Effect.die(new Error("Local search failed in the search worker"))
                : Effect.succeed(reply),
          ),
        );
      return {
        threads: (query: ThreadQuery) =>
          read({ kind: "threads", query }).pipe(
            Effect.flatMap((reply) =>
              reply.kind === "threads"
                ? Effect.succeed([...reply.value])
                : Effect.die(new Error("Invalid search worker reply")),
            ),
          ),
        count: (query: ThreadQuery) =>
          read({ kind: "count", query }).pipe(
            Effect.flatMap((reply) =>
              reply.kind === "count"
                ? Effect.succeed(reply.value)
                : Effect.die(new Error("Invalid search worker reply")),
            ),
          ),
      };
    }),
  );
