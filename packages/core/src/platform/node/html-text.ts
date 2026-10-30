import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { Parser } from "htmlparser2";
import { Effect, Layer } from "effect";
import { htmlToText } from "../../mime/mime.js";
import { HtmlText } from "../html-text.js";

export const HTML_TEXT_POOL_SIZE = Math.max(1, Math.min(2, availableParallelism() - 1));
/** Per message, from posting it to an idle worker. Worker startup and queueing do not count. */
export const HTML_TEXT_TIMEOUT_MS = 2_000;
/** A worker that has not loaded its modules by then counts as a failed start. */
const STARTUP_MS = 10_000;
/** After this many failed starts in a row, extraction stays inline. */
const STARTUP_FAILURES = 3;

const SKIPPED = new Set(["head", "script", "style", "template"]);
const BLOCK =
  /^(?:address|article|aside|blockquote|br|dd|div|dl|dt|footer|h[1-6]|header|hr|li|ol|p|pre|section|table|td|th|tr|ul)$/;

/**
 * Fallback when a worker times out or fails: one linear tokenizer pass. Like the
 * index fallback of `htmlToText` it keeps hidden text, so search still finds the words.
 */
export function strippedHtmlText(html: string): string {
  const out: string[] = [];
  let skipped = 0;
  const parser = new Parser({
    onopentagname: (name) => {
      if (SKIPPED.has(name)) skipped++;
      else out.push(BLOCK.test(name) ? "\n" : " ");
    },
    onclosetag: (name) => {
      if (SKIPPED.has(name)) skipped = Math.max(0, skipped - 1);
      else if (BLOCK.test(name)) out.push("\n");
    },
    ontext: (text) => {
      if (!skipped) out.push(text);
    },
  });
  parser.end(html);
  return out
    .join("")
    .replace(/[\t  ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** What a worker gets: HTML for htmlToText, or [plain, html] for search's visible text. */
type Input = string | readonly [plain: string, html: string];

interface Job {
  readonly input: Input;
  readonly resolve: (text: string) => void;
  readonly reject: (error: Error) => void;
}
interface Slot {
  readonly worker: Worker;
  ready: boolean;
  job?: Job;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * A timed-out or crashed job. Index text keeps hidden text, so search still finds the words.
 * Visible text gets nothing: a snippet must never show what the HTML hides.
 */
const fallbackText = (input: Input) => (typeof input === "string" ? strippedHtmlText(input) : "");

/**
 * Lazily started workers; an idle worker does not keep the process alive. After
 * repeated failed starts, provider parsing runs inline as before. Visible-text work fails and
 * stays queued in the database, rather than falling back to expensive main-thread CSS parsing.
 */
class HtmlWorkers {
  private readonly slots = new Set<Slot>();
  private readonly queue: Job[] = [];
  private starting = 0;
  private failedStarts = 0;
  private inline = false;
  constructor(
    private readonly url: URL,
    private readonly timeoutMs: number,
    private readonly startupMs: number,
    private readonly size: number,
  ) {}

  /** `urgent` jobs go ahead of queued ones: a search waits on them, a background fill does not. */
  run(input: Input, signal: AbortSignal, urgent = false): Promise<string> {
    if (signal.aborted) return Promise.resolve("");
    if (this.inline)
      return typeof input === "string"
        ? Promise.resolve(htmlToText(input))
        : Promise.reject(new Error("Visible text worker unavailable"));
    return new Promise<string>((resolve, reject) => {
      const abort = () => {
        const index = this.queue.indexOf(job);
        if (index >= 0) this.queue.splice(index, 1);
        job.resolve("");
      };
      const job: Job = {
        input,
        resolve: (text) => {
          signal.removeEventListener("abort", abort);
          resolve(text);
        },
        reject: (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      };
      signal.addEventListener("abort", abort, { once: true });
      if (urgent) this.queue.unshift(job);
      else this.queue.push(job);
      this.dispatch();
    });
  }

  close(): Promise<number[]> {
    this.inline = true;
    for (const job of this.queue.splice(0)) job.resolve(fallbackText(job.input));
    const slots = [...this.slots];
    this.slots.clear();
    for (const slot of slots) {
      if (slot.job) slot.job.resolve(fallbackText(slot.job.input));
    }
    return Promise.all(slots.map((slot) => this.stop(slot)));
  }

  private dispatch() {
    for (const slot of this.slots) {
      const job = slot.ready && !slot.job ? this.queue.shift() : undefined;
      if (!job) continue;
      slot.job = job;
      slot.timer = setTimeout(() => this.fail(slot), this.timeoutMs);
      slot.worker.ref();
      slot.worker.postMessage(job.input, []);
    }
    while (this.queue.length > this.starting && this.slots.size < this.size) this.spawn();
  }

  private spawn() {
    const worker = new Worker(this.url, {
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
    });
    const slot: Slot = {
      worker,
      ready: false,
      timer: setTimeout(() => this.fail(slot), this.startupMs),
    };
    this.starting++;
    this.slots.add(slot);
    worker.on("message", (message: unknown) => {
      if (!slot.ready) {
        clearTimeout(slot.timer);
        slot.ready = true;
        this.starting--;
        this.failedStarts = 0;
        worker.unref();
      } else if (slot.job && typeof message === "string") {
        clearTimeout(slot.timer);
        slot.job.resolve(message);
        slot.job = undefined;
        worker.unref();
      } else return this.fail(slot);
      this.dispatch();
    });
    worker.on("error", () => this.fail(slot));
    worker.on("exit", () => this.fail(slot));
  }

  /** Timeout, crash or a bad reply: the job gets the fallback text and the worker is replaced. */
  private fail(slot: Slot) {
    if (!this.slots.delete(slot)) return;
    void this.stop(slot);
    if (slot.job) slot.job.resolve(fallbackText(slot.job.input));
    if (!slot.ready) {
      this.starting--;
      // Running jobs on other workers still finish. Visible text never moves onto main.
      if (++this.failedStarts >= STARTUP_FAILURES) {
        this.inline = true;
        for (const job of this.queue.splice(0)) {
          if (typeof job.input === "string") job.resolve(htmlToText(job.input));
          else job.reject(new Error("Visible text worker unavailable"));
        }
      }
    }
    this.dispatch();
  }

  private stop(slot: Slot) {
    clearTimeout(slot.timer);
    slot.worker.removeAllListeners();
    slot.worker.on("error", () => {
      // Termination can still emit an error; the job has already settled.
    });
    return slot.worker.terminate();
  }
}

const workerPool = (
  options: { readonly timeoutMs?: number; readonly startupMs?: number; readonly workerUrl?: URL },
  size: number,
) =>
  Effect.acquireRelease(
    Effect.sync(
      () =>
        new HtmlWorkers(
          options.workerUrl ?? new URL("./html-worker.js", import.meta.url),
          options.timeoutMs ?? HTML_TEXT_TIMEOUT_MS,
          options.startupMs ?? STARTUP_MS,
          size,
        ),
    ),
    (workers) => Effect.promise(() => workers.close()),
  );

/**
 * HtmlText on two worker_threads pools, closed with the Layer's scope. Provider parsing gets
 * HTML_TEXT_POOL_SIZE workers. Search's visible text gets one of its own, so filling it in the
 * background never holds up a sync, and a search's few urgent bodies wait for at most one job.
 */
export const NodeHtmlText = (
  options: {
    readonly timeoutMs?: number;
    readonly startupMs?: number;
    readonly workerUrl?: URL;
  } = {},
) =>
  Layer.effect(
    HtmlText,
    Effect.gen(function* () {
      const parsing = yield* workerPool(options, HTML_TEXT_POOL_SIZE);
      const visible = yield* workerPool(options, 1);
      return {
        htmlToText: (html: string) => Effect.promise((signal) => parsing.run(html, signal)),
        visibleText: (plain: string, html: string, run?: { readonly urgent?: boolean }) =>
          Effect.promise((signal) => visible.run([plain, html], signal, run?.urgent)),
        concurrency: HTML_TEXT_POOL_SIZE,
      };
    }),
  );
