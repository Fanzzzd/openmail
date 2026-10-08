import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { Parser } from "htmlparser2";
import { Effect, Layer } from "effect";
import { htmlToText } from "../../mime.js";
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

interface Job {
  readonly html: string;
  readonly resolve: (text: string) => void;
}
interface Slot {
  readonly worker: Worker;
  ready: boolean;
  job?: Job;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Lazily started workers; an idle worker does not keep the process alive. After
 * close, or after repeated failed starts, extraction runs inline as on mobile.
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
  ) {}

  run(html: string, signal: AbortSignal) {
    if (this.inline) return Promise.resolve(htmlToText(html));
    return new Promise<string>((resolve) => {
      const job = { html, resolve };
      signal.addEventListener(
        "abort",
        () => {
          const index = this.queue.indexOf(job);
          if (index >= 0) this.queue.splice(index, 1);
        },
        { once: true },
      );
      this.queue.push(job);
      this.dispatch();
    });
  }

  close() {
    this.inline = true;
    const slots = [...this.slots];
    this.slots.clear();
    return Promise.all(slots.map((slot) => this.stop(slot)));
  }

  private dispatch() {
    for (const slot of this.slots) {
      const job = slot.ready && !slot.job ? this.queue.shift() : undefined;
      if (!job) continue;
      slot.job = job;
      slot.timer = setTimeout(() => this.fail(slot), this.timeoutMs);
      slot.worker.ref();
      slot.worker.postMessage(job.html, []);
    }
    while (this.queue.length > this.starting && this.slots.size < HTML_TEXT_POOL_SIZE) this.spawn();
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

  /** Timeout, crash or a bad reply: the job gets the stripped text and the worker is replaced. */
  private fail(slot: Slot) {
    if (!this.slots.delete(slot)) return;
    void this.stop(slot);
    slot.job?.resolve(strippedHtmlText(slot.job.html));
    if (!slot.ready) {
      this.starting--;
      // Running jobs on other workers still finish; new work stays inline.
      if (++this.failedStarts >= STARTUP_FAILURES) {
        this.inline = true;
        for (const job of this.queue.splice(0)) job.resolve(htmlToText(job.html));
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

/** HtmlText on a worker_threads pool, closed with the Layer's scope. */
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
      const pool = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new HtmlWorkers(
              options.workerUrl ?? new URL("./html-worker.js", import.meta.url),
              options.timeoutMs ?? HTML_TEXT_TIMEOUT_MS,
              options.startupMs ?? STARTUP_MS,
            ),
        ),
        (workers) => Effect.promise(() => workers.close()),
      );
      return {
        htmlToText: (html: string) => Effect.promise((signal) => pool.run(html, signal)),
        concurrency: HTML_TEXT_POOL_SIZE,
      };
    }),
  );
