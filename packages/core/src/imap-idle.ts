import { ImapFlow } from "imapflow";
import type { Account, ImapSettings } from "./domain.js";

export const IDLE_RENEW_MS = 25 * 60_000;
export const idleRetryDelay = (failures: number) =>
  Math.min(5 * 60_000, 1000 * 2 ** Math.min(failures, 9));

export async function watchImapInbox(
  settings: ImapSettings,
  password: string,
  signal: AbortSignal,
  changed: () => void,
  ready: () => void,
) {
  const client = new ImapFlow({
    host: settings.imapHost,
    port: settings.imapPort,
    secure: settings.imapPort === 993,
    doSTARTTLS: settings.imapPort !== 993,
    auth: { user: settings.username, pass: password },
    logger: false,
    clientInfo: { name: "openmail", version: "0.1.0", vendor: "openmail" },
    disableAutoIdle: true,
    maxIdleTime: IDLE_RENEW_MS,
    connectionTimeout: 20_000,
  });
  const close = () => client.close();
  client.on("error", close);
  signal.addEventListener("abort", close, { once: true });
  try {
    if (signal.aborted) return;
    await client.connect();
    return await keepInboxIdle(client, signal, changed, ready);
  } finally {
    signal.removeEventListener("abort", close);
    client.close();
  }
}

/** The signal owns the socket, including connection/SELECT failures and sleep. */
export async function keepInboxIdle(
  client: ImapFlow,
  signal: AbortSignal,
  changed: () => void,
  ready: () => void,
): Promise<"unsupported" | void> {
  const close = () => client.close();
  signal.addEventListener("abort", close, { once: true });
  if (signal.aborted) close();
  try {
    if (!client.capabilities.has("IDLE")) return "unsupported";
    await client.mailboxOpen("INBOX", { readOnly: true });
    if (signal.aborted) return;
    client.on("exists", changed);
    client.on("flags", changed);
    client.on("expunge", changed);
    ready();
    const aborted = () => signal.aborted;
    while (!aborted() && client.usable) await client.idle();
    if (!aborted()) throw new Error("IMAP IDLE connection closed");
  } finally {
    signal.removeEventListener("abort", close);
    client.off("exists", changed);
    client.off("flags", changed);
    client.off("expunge", changed);
    close();
  }
}

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
    worker.timer = setTimeout(() => {
      void this.connect(worker, attempts);
    }, idleRetryDelay(attempts));
    worker.timer.unref();
  }
  private signal(accountId: string) {
    if (this.paused || !this.workers.has(accountId)) return;
    this.dirty.add(accountId);
    if (this.syncing || this.signalTimer) return;
    this.signalTimer = setTimeout(() => {
      this.signalTimer = undefined;
      void this.drain();
    }, 50);
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
