import { jittered } from "../../sync/backoff.js";
import type { Account } from "../../domain/account.js";
export const IDLE_RENEW_MS = 25 * 60_000;
/** Capped exponential backoff with jitter, so accounts do not reconnect in lockstep. */
export const idleRetryDelay = (failures: number, random = Math.random()) =>
  jittered(Math.min(5 * 60_000, 1000 * 2 ** Math.min(failures, 9)), random);
type Watch = (
  account: Account,
  signal: AbortSignal,
  changed: () => void,
  ready: () => void,
) => Promise<"unsupported" | void>;
type Worker = {
  account: Account;
  controller: AbortController;
  state: "connecting" | "active" | "waiting" | "unsupported";
  timer?: ReturnType<typeof setTimeout>;
  failures?: number;
};

/** One signal connection per enabled IMAP account; all signals share a sync queue. */
export class ImapIdle {
  private readonly workers = new Map<string, Worker>();
  private paused = false;
  private accounts: readonly Account[] = [];
  private readonly dirty = new Set<string>();
  private syncing = false;
  private signalTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly watch: Watch,
    private readonly sync: (accountIds: readonly string[]) => Promise<unknown>,
  ) {}
  active(id: string) {
    return this.workers.get(id)?.state === "active";
  }
  reconnecting(id: string) {
    return this.workers.get(id)?.state === "connecting";
  }
  reconcile(accounts: readonly Account[]) {
    this.accounts = accounts;
    const enabled = accounts.filter(
      (a) => a.provider === "imap" && a.enabled !== false && !a.needsReauth,
    );
    for (const [id, worker] of this.workers) {
      const account = enabled.find((a) => a.id === id);
      if (
        this.paused ||
        !account ||
        JSON.stringify(account.imap) !== JSON.stringify(worker.account.imap)
      )
        this.remove(id);
    }
    if (this.paused) return;
    for (const account of enabled)
      if (!this.workers.has(account.id)) {
        const worker: Worker = { account, controller: new AbortController(), state: "connecting" };
        this.workers.set(account.id, worker);
        void this.connect(worker, 0);
      }
  }
  private async connect(worker: Worker, failures: number) {
    worker.state = "connecting";
    const connection = { active: false };
    try {
      const result = await this.watch(
        worker.account,
        worker.controller.signal,
        () => this.signal(worker.account.id),
        () => {
          worker.state = "active";
          connection.active = true;
          // Reconnect fills changes missed while the socket was offline.
          this.signal(worker.account.id);
        },
      );
      if (result === "unsupported") {
        worker.state = "unsupported";
        return;
      }
    } catch {
      /* Polling remains available while a connection retries. */
    }
    if (worker.controller.signal.aborted || this.workers.get(worker.account.id) !== worker) return;
    const attempts = connection.active ? 0 : failures + 1;
    worker.state = "waiting";
    worker.failures = attempts;
    worker.timer = setTimeout(() => {
      void this.connect(worker, attempts);
    }, idleRetryDelay(attempts));
    if (typeof worker.timer === "object" && "unref" in worker.timer) worker.timer.unref();
  }
  private signal(accountId: string) {
    if (this.paused || !this.workers.has(accountId)) return;
    this.dirty.add(accountId);
    if (this.syncing || this.signalTimer) return;
    this.signalTimer = setTimeout(() => {
      this.signalTimer = undefined;
      void this.drain();
    }, 50);
    if (typeof this.signalTimer === "object" && "unref" in this.signalTimer)
      this.signalTimer.unref();
  }
  private async drain() {
    this.syncing = true;
    try {
      while (this.dirty.size && !this.paused) {
        const accountIds = [...this.dirty];
        this.dirty.clear();
        await this.sync(accountIds).catch(() => null);
      }
    } finally {
      this.syncing = false;
    }
  }
  /** The network came back: reconnect waiting accounts now instead of after their backoff. */
  retryNow() {
    if (this.paused) return;
    for (const worker of this.workers.values())
      if (worker.state === "waiting") {
        clearTimeout(worker.timer);
        void this.connect(worker, worker.failures ?? 0);
      }
  }
  remove(id: string) {
    const worker = this.workers.get(id);
    if (!worker) return;
    this.workers.delete(id);
    this.dirty.delete(id);
    clearTimeout(worker.timer);
    worker.controller.abort();
  }
  pause(paused: boolean) {
    this.paused = paused;
    if (paused) {
      clearTimeout(this.signalTimer);
      this.signalTimer = undefined;
      this.dirty.clear();
    }
    this.reconcile(this.accounts);
  }
  close() {
    this.pause(true);
    this.accounts = [];
  }
}
