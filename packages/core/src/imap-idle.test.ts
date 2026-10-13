import { createServer, type Socket } from "node:net";
import { ImapFlow } from "imapflow";
import { expect, it, vi } from "vitest";
import {
  ImapIdle,
  keepInboxIdle,
  IDLE_RENEW_MS,
  idleRetryDelay,
} from "./platform/node/imap-idle.js";
import type { Account } from "./domain/domain.js";

const account: Account = {
  id: "imap:test",
  provider: "imap",
  email: "me@example.com",
  profileId: null,
  needsReauth: false,
  lastSyncError: null,
  lastSyncedAt: 1,
  createdAt: 1,
};

async function fakeImap(idle: boolean) {
  const sockets = new Set<Socket>();
  const commands: string[] = [];
  const socketErrors: Error[] = [];
  let idleCount = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", (error: Error) => {
      // Aborting IDLE can reset the peer while its final reply is still buffered.
      if (!("code" in error && error.code === "ECONNRESET")) socketErrors.push(error);
    });
    socket.on("close", () => sockets.delete(socket));
    socket.write(`* OK [CAPABILITY IMAP4rev1${idle ? " IDLE" : ""}] test ready\r\n`);
    let buffer = "";
    let idleTag = "";
    socket.on("data", (bytes) => {
      buffer += bytes.toString();
      let end: number;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        commands.push(line);
        if (line === "DONE") {
          socket.write(`${idleTag} OK idle finished\r\n`);
          continue;
        }
        const [tag, command] = line.split(" ");
        if (command === "CAPABILITY")
          socket.write(
            `* CAPABILITY IMAP4rev1${idle ? " IDLE" : ""}\r\n${tag} OK capabilities\r\n`,
          );
        else if (command === "LOGIN") socket.write(`${tag} OK login\r\n`);
        else if (command === "SELECT" || command === "EXAMINE")
          socket.write(
            `* FLAGS (\\Seen)\r\n* 1 EXISTS\r\n* OK [UIDVALIDITY 1] valid\r\n* OK [UIDNEXT 2] next\r\n${tag} OK [READ-ONLY] selected\r\n`,
          );
        else if (command === "IDLE") {
          idleTag = tag ?? "";
          idleCount++;
          socket.write("+ idling\r\n");
          if (idleCount === 1)
            socket.write("* 2 EXISTS\r\n* 1 FETCH (FLAGS (\\Seen) UID 1)\r\n* 1 EXPUNGE\r\n");
        } else if (command === "LOGOUT") socket.end(`* BYE bye\r\n${tag} OK logout\r\n`);
        else socket.write(`${tag} OK done\r\n`);
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No IMAP test port");
  return {
    commands,
    sockets,
    client: () =>
      new ImapFlow({
        host: "127.0.0.1",
        port: address.port,
        secure: false,
        doSTARTTLS: false,
        auth: { user: "me", pass: "test" },
        logger: false,
        disableAutoIdle: true,
        maxIdleTime: 50,
      }),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      expect(socketErrors).toEqual([]);
    },
  };
}

it("real IDLE socket selects only INBOX, signals changes, renews IDLE and closes on abort", async () => {
  expect(IDLE_RENEW_MS).toBe(25 * 60_000);
  const server = await fakeImap(true);
  const client = server.client();
  client.on("error", () => null);
  const signal = new AbortController();
  const changed = vi.fn();
  try {
    await client.connect();
    const watching = keepInboxIdle(client, signal.signal, changed, () => null);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(3));
    await vi.waitFor(() =>
      expect(server.commands.filter((c) => c.endsWith(" IDLE")).length).toBeGreaterThanOrEqual(2),
    );
    expect(server.commands.some((c) => /EXAMINE INBOX|EXAMINE "INBOX"/.test(c))).toBe(true);
    signal.abort();
    await watching.catch(() => null);
    await vi.waitFor(() => expect(server.sockets.size).toBe(0));
  } finally {
    client.close();
    await server.close();
  }
});

it("unsupported IDLE returns to polling without selecting or looping", async () => {
  const server = await fakeImap(false);
  const client = server.client();
  client.on("error", () => null);
  try {
    await client.connect();
    expect(
      await keepInboxIdle(
        client,
        new AbortController().signal,
        () => null,
        () => null,
      ),
    ).toBe("unsupported");
    expect(server.commands.some((c) => /IDLE|EXAMINE/.test(c))).toBe(false);
  } finally {
    client.close();
    await server.close();
  }
});

it("supervisor owns one connection per account, coalesces sync and reconnects with bounded backoff", async () => {
  vi.useFakeTimers();
  const opened: { signal: AbortSignal; changed: () => void; reject: (error: Error) => void }[] = [];
  let finishSync: (() => void) | undefined;
  const sync = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishSync = resolve;
      }),
  );
  const watcher = new ImapIdle(
    (_a, signal, changed, ready) =>
      new Promise((_resolve, reject) => {
        opened.push({ signal, changed, reject });
        signal.addEventListener("abort", () => reject(new Error("closed")));
        ready();
      }),
    sync,
  );
  try {
    watcher.reconcile([account]);
    watcher.reconcile([account]);
    expect(opened).toHaveLength(1);
    for (let i = 0; i < 10; i++) opened[0]?.changed();
    await vi.advanceTimersByTimeAsync(50);
    expect(sync).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 10; i++) opened[0]?.changed();
    finishSync?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(sync).toHaveBeenCalledTimes(2);
    finishSync?.();
    opened[0]?.reject(new Error("offline"));
    // The first retry waits 800-1000 ms; jitter only shortens it.
    await vi.advanceTimersByTimeAsync(799);
    expect(opened).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(201);
    expect(opened).toHaveLength(2);
    watcher.pause(true);
    expect(opened[1]?.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(opened).toHaveLength(2);
    watcher.pause(false);
    expect(opened).toHaveLength(3);
    watcher.reconcile([{ ...account, enabled: false }]);
    expect(opened[2]?.signal.aborted).toBe(true);
    expect(idleRetryDelay(99, 0)).toBe(300_000);
    expect(idleRetryDelay(99, 1)).toBe(240_000);
  } finally {
    watcher.close();
    finishSync?.();
    vi.useRealTimers();
  }
});

it("a network change reconnects a waiting IDLE account at once instead of after its backoff", async () => {
  vi.useFakeTimers();
  const opened: ((error: Error) => void)[] = [];
  const watcher = new ImapIdle(
    (_a, signal) =>
      new Promise((_resolve, reject) => {
        opened.push(reject);
        signal.addEventListener("abort", () => reject(new Error("closed")));
      }),
    async () => null,
  );
  try {
    watcher.reconcile([account]);
    for (let failures = 1; failures <= 6; failures++) {
      opened.at(-1)?.(new Error("getaddrinfo ENOTFOUND imap.example.com"));
      await vi.advanceTimersByTimeAsync(idleRetryDelay(failures, 0));
    }
    expect(opened).toHaveLength(7);
    opened.at(-1)?.(new Error("getaddrinfo ENOTFOUND imap.example.com"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(opened).toHaveLength(7);
    expect(watcher.reconnecting(account.id)).toBe(false);
    watcher.retryNow();
    expect(opened).toHaveLength(8);
    expect(watcher.reconnecting(account.id)).toBe(true);
  } finally {
    watcher.close();
    vi.useRealTimers();
  }
});

it("IDLE coalesces dirty account ids instead of syncing every account", async () => {
  vi.useFakeTimers();
  const signals = new Map<string, () => void>();
  const sync = vi.fn(async (_ids: readonly string[]) => null);
  const watcher = new ImapIdle(
    (a, signal, changed, ready) =>
      new Promise((_resolve, reject) => {
        signals.set(a.id, changed);
        signal.addEventListener("abort", () => reject(new Error("closed")));
        ready();
      }),
    sync,
  );
  try {
    watcher.reconcile([account, { ...account, id: "imap:second" }]);
    await vi.advanceTimersByTimeAsync(50);
    sync.mockClear();
    for (let i = 0; i < 10; i++) signals.get(account.id)?.();
    await vi.advanceTimersByTimeAsync(50);
    expect(sync).toHaveBeenCalledExactlyOnceWith([account.id]);
  } finally {
    watcher.close();
    vi.useRealTimers();
  }
});
