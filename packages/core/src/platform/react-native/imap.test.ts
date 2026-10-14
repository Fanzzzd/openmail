import { backfillCachedHeaders } from "../../sync/header-backfill.js";
import { readOnlyAdapter } from "../../mailbox/read-only.js";
import { makeResetGuard } from "../../sync/sync-reset.js";
import { readCursor } from "../../providers/imap/imap-cursor.js";
import { expect, it, vi } from "vitest";
import { Effect, Fiber, Layer, Logger, ManagedRuntime, Option, Stream } from "effect";
import {
  type MailSocket,
  MailTransport,
  MailWire,
  ImapWire,
  encodeFolder,
  decodeFolder,
} from "../mail-socket.js";
import { makeMobileImap } from "./imap.js";
import { fetchFields, mobileIncoming } from "./imap-parse.js";
import { smtpSession } from "./smtp.js";
import { parseMobileMime, mobileMailCodecLayer } from "./mail-codec.js";
import { MemoryPlatform } from "../node/platform-memory.js";
import { StoreLive } from "../../store/store.js";
import { Providers } from "../../providers/adapter.js";
import { Secrets } from "../auth.js";
import { Store } from "../../store/service.js";
import { MailboxLive } from "../../mailbox/mailbox-live.js";
import { Mailbox } from "../../mailbox/mailbox.js";
import { Buffer } from "../bytes.js";
const raw = Buffer.from(
  [
    "From: Alice <alice@example.test>",
    "To: me@example.test",
    "Message-ID: <one@example.test>",
    "Subject: Mobile IMAP",
    "Date: Fri, 02 Oct 2026 00:00:00 +0000",
    "MIME-Version: 1.0",
    'Content-Type: multipart/related; boundary="mix"',
    "",
    "--mix",
    "Content-Type: text/html; charset=utf-8",
    "",
    '<img src="cid:photo">Hello',
    "--mix",
    "Content-Type: image/png",
    "Content-ID: <photo>",
    "Content-Disposition: inline; filename=photo.png",
    "Content-Transfer-Encoding: base64",
    "",
    "AQID",
    "--mix",
    "Content-Type: application/pdf",
    "Content-Disposition: attachment; filename=report.pdf",
    "Content-Transfer-Encoding: base64",
    "",
    "BAUG",
    "--mix--",
    "",
  ].join("\r\n"),
);
class ScriptSocket implements MailSocket {
  private readonly chunks: Uint8Array[] = [];
  private reader: { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void } | null =
    null;
  closed = false;
  constructor(
    private readonly onWrite: (bytes: Uint8Array, socket: ScriptSocket) => void,
    readonly upgraded: () => void = () => {
      /* No native side effect in this protocol fixture. */
    },
  ) {}
  enqueue(value: string | Uint8Array) {
    const bytes = typeof value === "string" ? Buffer.from(value) : value;
    // Fragment CRLF and binary literal boundaries without a real network.
    for (let offset = 0; offset < bytes.length; offset += 11)
      this.chunks.push(bytes.slice(offset, offset + 11));
    if (this.reader) {
      const reader = this.reader;
      this.reader = null;
      void this.read().then(reader.resolve, reader.reject);
    }
  }
  read(): Promise<Uint8Array> {
    const next = this.chunks.shift();
    if (next) return Promise.resolve(next);
    if (this.closed) return Promise.reject(new Error("closed"));
    return new Promise((resolve, reject) => {
      this.reader = { resolve, reject };
    });
  }
  async write(bytes: Uint8Array) {
    this.onWrite(bytes, this);
  }
  async startTLS() {
    this.upgraded();
  }
  close() {
    this.closed = true;
    this.reader?.reject(new Error("closed"));
    this.reader = null;
  }
}
function server(
  options: {
    tls?: boolean;
    noMove?: boolean;
    noUidplus?: boolean;
    copyUid?: boolean;
    copyUidResponse?: string;
    authReject?: boolean;
    noStarttls?: boolean;
    validity?: string;
    appendReject?: boolean;
    appendFailures?: number;
    smtpDataReply?: number | "disconnect";
    rejectDeleteOnce?: boolean;
    disconnectAfterDeleteOnce?: boolean;
    folderRows?: string;
    createAlreadyExists?: boolean;
    unresolvedCopy?: boolean;
    rejectCopyTargetOnce?: string;
    source?: Uint8Array;
    uidNext?: number;
    stallStore?: () => void;
    stallStoreAt?: number;
    resetSearch?: (command: string, path: string) => readonly number[];
  } = {},
) {
  const commands: string[] = [];
  const sockets: ScriptSocket[] = [];
  const delivered: string[] = [];
  const upgrades: string[] = [];
  let seen = false;
  let starred = false;
  let exists = true;
  let deleted = false;
  let stores = 0;
  let copies = 0;
  let deleteRejected = false;
  let deleteDisconnected = false;
  let appends = 0;
  let copyRejected = false;
  const transport = Layer.succeed(MailTransport, {
    connect: async ({ host, tls, signal }) => {
      const smtp = host.startsWith("smtp");
      let data = false;
      let appendTag = "";
      let loginTag = "";
      let selectedPath = "";
      const socket = new ScriptSocket(
        (bytes, current) => {
          const line = Buffer.from(bytes).toString("latin1").replace(/\r\n$/, "");
          commands.push(line);
          if (smtp) {
            if (data) {
              delivered.push(line);
              data = false;
              if (options.smtpDataReply === "disconnect") current.close();
              else current.enqueue(`${options.smtpDataReply ?? 250} accepted\r\n`);
            } else if (line.startsWith("EHLO"))
              current.enqueue(
                `250-host\r\n${options.noStarttls ? "" : "250-STARTTLS\r\n"}250 AUTH PLAIN\r\n`,
              );
            else if (line === "STARTTLS") current.enqueue("220 ready\r\n");
            else if (line.startsWith("AUTH"))
              current.enqueue(options.authReject ? "535 rejected\r\n" : "235 authenticated\r\n");
            else if (line.startsWith("MAIL") || line.startsWith("RCPT"))
              current.enqueue("250 ok\r\n");
            else if (line === "DATA") {
              data = true;
              current.enqueue("354 continue\r\n");
            } else if (line === "QUIT") current.enqueue("221 goodbye\r\n");
            else throw new Error(`Unhandled SMTP ${line}`);
            return;
          }
          if (loginTag) {
            if (line === "") {
              current.enqueue(`${loginTag} OK login\r\n`);
              loginTag = "";
            }
            return;
          }
          if (appendTag) {
            if (line === "") {
              current.enqueue(`${appendTag} OK appended\r\n`);
              appendTag = "";
            }
            return;
          }
          const space = line.indexOf(" ");
          const tag = line.slice(0, space);
          const command = line.slice(space + 1);
          const done = () => current.enqueue(`${tag} OK done\r\n`);
          if (command === "CAPABILITY") {
            current.enqueue(
              `* CAPABILITY IMAP4rev1 ${options.noUidplus ? "" : "UIDPLUS"} ${options.noMove ? "" : "MOVE"} ID ${options.noStarttls ? "" : "STARTTLS"}\r\n`,
            );
            done();
          } else if (command === "STARTTLS") done();
          else if (command.startsWith("LOGIN")) {
            if (/\{\d+\}$/.test(command)) {
              loginTag = tag;
              current.enqueue("+ password\r\n");
            } else current.enqueue(`${tag} ${options.authReject ? "NO" : "OK"} login\r\n`);
          } else if (command.startsWith("ID ") || command === "NOOP") done();
          else if (command.startsWith("LIST")) {
            current.enqueue(
              options.folderRows ??
                '* LIST (\\Inbox) "/" "INBOX"\r\n* LIST (\\Sent) "/" "Sent"\r\n* LIST () "/" "Projects"\r\n* LIST () "/" "Projects/Child"\r\n',
            );
            done();
          } else if (command.startsWith("EXAMINE") || command.startsWith("SELECT")) {
            selectedPath = /"([^"\r\n]+)"/.exec(command)?.[1] ?? "";
            current.enqueue(`* OK [UIDVALIDITY ${options.validity ?? "9"}] valid\r\n`);
            if (options.uidNext !== undefined)
              current.enqueue(`* OK [UIDNEXT ${options.uidNext}] next\r\n`);
            done();
          } else if (command.startsWith("UID SEARCH")) {
            const found =
              options.resetSearch?.(command, selectedPath) ??
              (command.includes("HEADER Message-ID") &&
              selectedPath !== "INBOX" &&
              selectedPath !== "Sent"
                ? copies && !options.unresolvedCopy
                  ? [4]
                  : []
                : undefined);
            current.enqueue(
              `* SEARCH${found ? (found.length ? ` ${found.join(" ")}` : "") : exists && !(deleted && command.includes("UNDELETED")) ? " 1" : ""}\r\n`,
            );
            done();
          } else if (command.startsWith("UID FETCH")) {
            if (exists) {
              const flags = [
                seen ? "\\Seen" : "",
                starred ? "\\Flagged" : "",
                deleted ? "\\Deleted" : "",
              ]
                .filter(Boolean)
                .join(" ");
              if (command.includes("BODY.PEEK")) {
                current.enqueue(
                  `* 1 FETCH (UID 1 FLAGS (${flags}) RFC822.SIZE ${(options.source ?? raw).length} BODY[] {${(options.source ?? raw).length}}\r\n`,
                );
                current.enqueue(options.source ?? raw);
                current.enqueue(")\r\n");
              } else
                current.enqueue(
                  `* 1 FETCH (UID 1 FLAGS (${flags}) RFC822.SIZE ${(options.source ?? raw).length})\r\n`,
                );
            }
            done();
          } else if (command.startsWith("UID STORE")) {
            if (options.stallStore && ++stores === (options.stallStoreAt ?? 1)) {
              options.stallStore();
              return;
            }
            if (command.includes("\\Deleted") && options.rejectDeleteOnce && !deleteRejected) {
              deleteRejected = true;
              current.enqueue(`${tag} NO temporarily unavailable\r\n`);
              return;
            }
            if (command.includes("\\Deleted")) deleted = command.includes("+FLAGS");
            if (
              command.includes("\\Deleted") &&
              options.disconnectAfterDeleteOnce &&
              !deleteDisconnected
            ) {
              deleteDisconnected = true;
              current.close();
              return;
            }
            if (command.includes("\\Seen")) seen = command.includes("+FLAGS");
            if (command.includes("\\Flagged")) starred = command.includes("+FLAGS");
            done();
          } else if (command.startsWith("CREATE")) {
            if (options.createAlreadyExists)
              current.enqueue(`${tag} NO [ALREADYEXISTS] exists\r\n`);
            else done();
          } else if (command.startsWith("UID COPY")) {
            if (
              options.rejectCopyTargetOnce &&
              command.includes(`"${options.rejectCopyTargetOnce}"`) &&
              !copyRejected
            ) {
              copyRejected = true;
              current.enqueue(`${tag} NO temporarily unavailable\r\n`);
              return;
            }
            copies++;
            current.enqueue(
              `${tag} OK${options.copyUidResponse ? ` [COPYUID ${options.copyUidResponse}]` : options.copyUid ? " [COPYUID 11 1 4]" : ""} copied\r\n`,
            );
          } else if (command.startsWith("UID EXPUNGE")) {
            if (deleted) exists = false;
            done();
          } else if (command.startsWith("UID MOVE")) {
            exists = false;
            done();
          } else if (command.startsWith("APPEND")) {
            if (options.appendReject || ++appends <= (options.appendFailures ?? 0))
              current.enqueue(`${tag} NO server-supplied-secret@example.test\r\n`);
            else {
              appendTag = tag;
              current.enqueue("+ continue\r\n");
            }
          } else throw new Error(`Unhandled IMAP ${command}`);
        },
        () => upgrades.push(host),
      );
      expect(tls).toBe(smtp ? options.tls !== false : true);
      socket.enqueue(smtp ? "220 ready\r\n" : "* OK ready\r\n");
      signal.addEventListener("abort", () => socket.close(), { once: true });
      sockets.push(socket);
      return socket;
    },
  });
  const platform = Layer.mergeAll(MemoryPlatform(), transport);
  const providers = Layer.effect(
    Providers,
    makeMobileImap.pipe(
      Effect.map((adapter) => Providers.of({ get: () => adapter })),
      Effect.provide(mobileMailCodecLayer),
    ),
  );
  const services = Layer.mergeAll(StoreLive, providers).pipe(Layer.provideMerge(platform));
  const runtime = ManagedRuntime.make(
    MailboxLive({ imapIdle: false, backgroundFlush: false, localDraftQueue: true }).pipe(
      Layer.provideMerge(services),
    ),
  );
  return {
    runtime,
    commands,
    sockets,
    delivered,
    upgrades,
    /** Another client clears \\Deleted on UID 1. */
    undelete: () => {
      deleted = false;
    },
  };
}
it("runs mobile IMAP through shared connect, sync, reader, contacts, flags, move and audited send commands", async () => {
  const test = server();
  try {
    await test.runtime.runPromise(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const account = yield* mailbox.accounts.connect({
          provider: "imap",
          input: { preset: "fastmail", email: "me@example.test", password: "app-password" },
        });
        expect(account.imap?.imapHost).toBe("imap.fastmail.com");
        const stored = yield* (yield* Secrets).get(account.id);
        expect(stored).toEqual(expect.objectContaining({ value: "app-password" }));
        expect((yield* mailbox.sync.sync(account.id)).every((item) => !item.error)).toBe(true);
        const message = (yield* mailbox.reading.threads({
          accountIds: [account.id],
          label: "INBOX",
        }))[0];
        if (!message) throw new Error("No synced message");
        expect((yield* mailbox.reading.readerThread(message.id))[0]?.bodyHtml).toContain(
          "cid:photo",
        );
        expect((yield* mailbox.reading.inlineImages(message.id))["photo"]).toBe(
          "data:image/png;base64,AQID",
        );
        expect((yield* mailbox.reading.attachment(message.id, 0)).data).toEqual(
          new Uint8Array([4, 5, 6]),
        );
        expect(
          (yield* mailbox.contacts.suggestContacts("alice", { accountIds: [account.id] }))[0]
            ?.address,
        ).toBe("alice@example.test");
        expect((yield* mailbox.reading.unreadByLabel([account.id])).INBOX).toBe(1);
        for (const op of [
          { kind: "read", value: true },
          { kind: "star", value: true },
        ] as const) {
          yield* mailbox.organize.perform(
            { kind: "modify", threads: [message.id], op },
            { kind: "user", surface: "app" },
          );
        }
        const draft = {
          id: "draft:imap-mobile",
          accountId: account.id,
          message: {
            to: [{ name: "", address: "alice@example.test" }],
            cc: [],
            bcc: [{ name: "", address: "private@example.test" }],
            subject: "Send",
            text: ".dot\nHello",
            attachments: [],
          },
        };
        yield* mailbox.outbox.queueSend(draft, 0);
        yield* mailbox.outbox.flushQueuedSends();
        expect(yield* mailbox.outbox.queuedSends).toEqual([]);
        expect(
          (yield* mailbox.proposals.audit(100)).some(
            (entry) => entry.action === "send" && entry.actor === "user:app",
          ),
        ).toBe(true);
        yield* mailbox.organize.perform(
          {
            kind: "modify",
            threads: [message.id],
            op: { kind: "move", labelId: "Projects/Child", removeLabelId: "INBOX" },
          },
          { kind: "user", surface: "app" },
        );
      }),
    );
    expect(test.commands.some((line) => line.includes("+FLAGS.SILENT (\\Seen)"))).toBe(true);
    expect(test.commands.some((line) => line.includes("+FLAGS.SILENT (\\Flagged)"))).toBe(true);
    expect(test.commands.some((line) => line.includes('UID COPY 1 "Projects/Child"'))).toBe(true);
    expect(test.commands).toContain("RCPT TO:<private@example.test>");
    expect(test.delivered[0]).not.toMatch(/^Bcc:/im);
    expect(test.delivered[0]).toContain("LmRvdApIZWxsbw==");
    await test.runtime.runPromise(
      Effect.flatMap(Mailbox, (mailbox) => mailbox.sync.closeSessions()),
    );
    expect(test.sockets.every((socket) => socket.closed)).toBe(true);
  } finally {
    await test.runtime.dispose();
  }
});
it("requires SMTP STARTTLS before credentials and rejects missing TLS support", async () => {
  const test = server({ tls: false });
  const blocked = server({ tls: false, noStarttls: true });
  const input = {
    provider: "imap",
    input: { preset: "icloud", email: "me@example.test", password: "secret" },
  } as const;
  try {
    await test.runtime.runPromise(
      Effect.flatMap(Mailbox, (mailbox) => mailbox.accounts.connect(input)),
    );
    expect(test.upgrades).toContain("smtp.mail.me.com");
    expect(test.commands.indexOf("STARTTLS")).toBeLessThan(
      test.commands.findIndex((line) => line.startsWith("AUTH PLAIN")),
    );
    const result = await blocked.runtime.runPromise(
      Effect.flatMap(Mailbox, (mailbox) => mailbox.accounts.connect(input)).pipe(Effect.result),
    );
    expect(result._tag).toBe("Failure");
    expect(blocked.commands.some((line) => line.startsWith("AUTH"))).toBe(false);
    expect(blocked.sockets.every((socket) => socket.closed)).toBe(true);
  } finally {
    await test.runtime.dispose();
    await blocked.runtime.dispose();
  }
});
it("round-trips modified UTF-7 folders and refuses oversized literals before downloading them", async () => {
  expect(decodeFolder(encodeFolder("收件箱/日本語 & Projects"))).toBe("收件箱/日本語 & Projects");
  const socket = new ScriptSocket(() => {
    /* No native side effect in this protocol fixture. */
  });
  socket.enqueue("* 1 FETCH (BODY[] {26214401}\r\n");
  await expect(new ImapWire(new MailWire(socket)).response()).rejects.toThrow("too large");
  socket.close();
});
it("rejects stale UIDVALIDITY before reading or mutating a message", async () => {
  const test = server({ validity: "10" });
  try {
    await test.runtime.runPromise(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const account = yield* mailbox.accounts.connect({
          provider: "imap",
          input: { preset: "fastmail", email: "me@example.test", password: "secret" },
        });
        const providers = yield* Providers;
        const result = yield* providers
          .get("imap")
          .push(account, "9:1:INBOX", { kind: "read", value: true })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
      }),
    );
    expect(test.commands.some((line) => line.includes("UID STORE"))).toBe(false);
  } finally {
    await test.runtime.dispose();
  }
});

it("counts literal bytes against the whole command cap before reading a second oversized total", async () => {
  const size = 14 * 1024 * 1024;
  const chunks = [
    Buffer.from(`* 1 FETCH (UID 1 BODY[] {${size}}\r\n`),
    new Uint8Array(size),
    Buffer.from(")\r\n"),
    Buffer.from(`* 2 FETCH (UID 2 BODY[] {${size}}\r\n`),
  ];
  const read = vi.fn(async () => {
    const chunk = chunks.shift();
    if (!chunk) throw new Error("Second literal was requested");
    return chunk;
  });
  const socket: MailSocket = {
    read,
    write: async () => {
      /* Scripted command. */
    },
    close: () => {
      /* No native handle. */
    },
    startTLS: async () => {
      /* No TLS in framing test. */
    },
  };
  await expect(
    new ImapWire(new MailWire(socket)).command("UID FETCH 1:2 (BODY.PEEK[])"),
  ).rejects.toThrow("command response too large");
  expect(read).toHaveBeenCalledTimes(4);
});
it("rejects duplicate FETCH UIDs and preserves fragmented binary framing and buffered TLS guards", async () => {
  const socket = new ScriptSocket(() => {
    /* Protocol fixture. */
  });
  socket.enqueue("* 1 FETCH (UID 4 FLAGS ())\r\n* 2 FETCH (UID 4 FLAGS (\\Seen))\r\n");
  const imap = new ImapWire(new MailWire(socket));
  const rows = [await imap.response(), await imap.response()];
  expect(() => fetchFields(rows)).toThrow("duplicate IMAP FETCH UID");
  socket.close();
  const chunks = [
    Buffer.from("line\r"),
    Buffer.from("\n"),
    ...Array.from({ length: 2048 }, (_, i) => new Uint8Array([i % 256])),
    Buffer.from("next\r\ninjected"),
  ];
  const startTLS = vi.fn(async () => {
    /* Secure event fixture. */
  });
  const framed: MailSocket = {
    read: async () => {
      const chunk = chunks.shift();
      if (!chunk) throw new Error("EOF");
      return chunk;
    },
    write: async () => {
      /* Protocol fixture. */
    },
    close: () => {
      /* No handle. */
    },
    startTLS,
  };
  const wire = new MailWire(framed);
  expect(await wire.line()).toBe("line");
  expect(await wire.bytes(2048)).toEqual(Uint8Array.from({ length: 2048 }, (_, i) => i % 256));
  expect(await wire.line()).toBe("next");
  await expect(wire.upgrade()).rejects.toThrow("Unexpected data before TLS");
  expect(startTLS).not.toHaveBeenCalled();
});
it("sends a UTF-8 password as an IMAP literal", async () => {
  const test = server();
  try {
    await test.runtime.runPromise(
      Effect.flatMap(Mailbox, (mailbox) =>
        mailbox.accounts.connect({
          provider: "imap",
          input: { preset: "fastmail", email: "me@example.test", password: "密碼é" },
        }),
      ),
    );
    expect(test.commands.some((command) => /LOGIN "me@example.test" \{8\}$/.test(command))).toBe(
      true,
    );
    expect(test.commands.some((command) => command.includes('LOGIN "me@example.test" "'))).toBe(
      false,
    );
  } finally {
    await test.runtime.dispose();
  }
});
it("unfolds References and appends the original Message-ID exactly once in reply MIME", async () => {
  const source = Buffer.from(
    "From: Alice <alice@example.test>\r\nMessage-ID: <parent@example.test>\r\nReferences: <root@example.test>\r\n <middle@example.test>\r\nSubject: Original\r\n\r\nOriginal text",
  );
  const test = server({ source });
  try {
    await test.runtime.runPromise(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const account = yield* mailbox.accounts.connect({
          provider: "imap",
          input: { preset: "fastmail", email: "me@example.test", password: "secret" },
        });
        const provider = (yield* Providers).get("imap");
        yield* provider.send(
          account,
          {
            mode: "reply",
            to: [{ name: "", address: "alice@example.test" }],
            cc: [],
            bcc: [],
            subject: "Reply",
            text: "Reply text",
            attachments: [],
          },
          Option.some({ providerId: "9:1:INBOX", threadId: "parent@example.test" }),
        );
      }),
    );
    expect(test.delivered[0]).toContain(
      "References: <root@example.test> <middle@example.test> <parent@example.test>\r\n",
    );
    expect(test.delivered[0]?.match(/<parent@example.test>/g)).toHaveLength(2);
  } finally {
    await test.runtime.dispose();
  }
});
it("logs a redacted Sent warning after acknowledged SMTP without resending", async () => {
  const test = server({
    appendReject: true,
    resetSearch: (command) => (command.includes("HEADER Message-ID") ? [] : [1]),
  });
  const warnings: unknown[] = [];
  const logger = Logger.make((options) => {
    warnings.push(options.message);
  });
  try {
    await test.runtime.runPromise(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const account = yield* mailbox.accounts.connect({
          provider: "imap",
          input: { preset: "fastmail", email: "me@example.test", password: "secret" },
        });
        yield* mailbox.outbox.queueSend(
          {
            id: "draft:sent-warning",
            accountId: account.id,
            message: {
              to: [{ name: "", address: "alice@example.test" }],
              cc: [],
              bcc: [],
              subject: "Sent warning",
              text: "Body",
              attachments: [],
            },
          },
          0,
        );
        yield* mailbox.outbox.flushQueuedSends();
        yield* mailbox.outbox.flushQueuedSends();
        expect(yield* mailbox.outbox.queuedSends).toEqual([]);
      }).pipe(Effect.provide(Logger.layer([logger]))),
    );
    expect(test.delivered).toHaveLength(1);
    expect(JSON.stringify(warnings)).toContain("not saved to Sent");
    expect(JSON.stringify(warnings)).not.toContain("server-supplied-secret");
  } finally {
    await test.runtime.dispose();
  }
});

it("APPEND writes bounded chunks in sequence before ending the literal", async () => {
  const payload = new Uint8Array(130 * 1024).fill(1);
  const writes: Uint8Array[] = [];
  let total = 0;
  const socket = new ScriptSocket((bytes, current) => {
    writes.push(new Uint8Array(bytes));
    if (writes.length === 1) current.enqueue("+ literal\r\n");
    else if (bytes.length === 2 && bytes[0] === 13 && bytes[1] === 10) {
      expect(total).toBe(payload.length);
      current.enqueue("M1 OK appended\r\n");
    } else total += bytes.length;
  });
  await new ImapWire(new MailWire(socket)).command(`APPEND "Sent" {${payload.length}}`, payload);
  expect(writes.slice(1, -1).map((chunk) => chunk.length)).toEqual([65536, 65536, 2048]);
  expect(Buffer.concat(writes.slice(1, -1))).toEqual(Buffer.from(payload));
  socket.close();
});

it("SMTP DATA writes a large body in bounded chunks and waits for the final acceptance", async () => {
  const writes: Uint8Array[] = [];
  let data = false;
  let bytes = 0;
  let accepted = false;
  const socket = new ScriptSocket((chunk, current) => {
    const line = Buffer.from(chunk).toString("latin1");
    if (data) {
      writes.push(new Uint8Array(chunk));
      bytes += chunk.length;
      if (line.endsWith("\r\n.\r\n")) {
        data = false;
        accepted = true;
        current.enqueue("250 accepted\r\n");
      }
    } else if (line.startsWith("EHLO")) current.enqueue("250 AUTH PLAIN\r\n");
    else if (line.startsWith("AUTH")) current.enqueue("235 authenticated\r\n");
    else if (line.startsWith("MAIL") || line.startsWith("RCPT")) current.enqueue("250 ok\r\n");
    else if (line.startsWith("DATA")) {
      data = true;
      current.enqueue("354 continue\r\n");
    } else if (line.startsWith("QUIT")) {
      expect(accepted).toBe(true);
      current.enqueue("221 bye\r\n");
    } else throw new Error("Unexpected SMTP command");
  });
  socket.enqueue("220 ready\r\n");
  const transport: MailTransport["Service"] = { connect: async () => socket };
  const source = Buffer.from(
    `From: me@example.test\r\nBcc: hidden@example.test\r\nSubject: Large\r\n\r\n${".dot\r\n".repeat(30000)}`,
  );
  await smtpSession(
    transport,
    {
      preset: "custom",
      username: "me",
      imapHost: "imap.example.test",
      imapPort: 993,
      smtpHost: "smtp.example.test",
      smtpPort: 465,
      smtpSecure: true,
    },
    "secret",
    "account",
    new AbortController().signal,
    { from: "me@example.test", to: ["alice@example.test", "hidden@example.test"], raw: source },
  );
  expect(bytes).toBeGreaterThan(128 * 1024);
  expect(writes.every((chunk) => chunk.length <= 65536)).toBe(true);
  const delivered = Buffer.concat(writes).toString("latin1");
  expect(delivered).not.toContain("Bcc:");
  expect(delivered).toContain("\r\n..dot\r\n");
  expect(accepted).toBe(true);
});

it("mobile pushes reuse one connection and preserve COPYUID without unsafe EXPUNGE", async () => {
  const test = server({ noMove: true, noUidplus: true, copyUid: true });
  try {
    await test.runtime.runPromise(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const account = yield* mailbox.accounts.connect({
          provider: "imap",
          input: { preset: "fastmail", email: "me@example.test", password: "secret" },
        });
        const provider = (yield* Providers).get("imap");
        const before = test.sockets.length;
        yield* provider.push(account, "9:1:INBOX", { kind: "read", value: true });
        const moved = yield* provider.push(account, "9:1:INBOX", {
          kind: "move",
          labelId: "Projects",
          removeLabelId: "INBOX",
        });
        expect(test.sockets.length - before).toBe(1);
        expect(moved).toEqual([{ from: "9:1:INBOX", to: "11:4:Projects" }]);
      }),
    );
    expect(test.commands.some((c) => c.includes("UID COPY"))).toBe(true);
    expect(test.commands.some((c) => /EXPUNGE/.test(c))).toBe(false);
  } finally {
    await test.runtime.dispose();
  }
});

it("mobile custom Office365 SMTP infers the server's Sent copy", async () => {
  const test = server();
  try {
    await test.runtime.runPromise(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const account = yield* mailbox.accounts.connect({
          provider: "imap",
          input: { preset: "fastmail", email: "me@example.test", password: "secret" },
        });
        if (!account.imap) throw new Error("Missing settings");
        const provider = (yield* Providers).get("imap");
        yield* provider.send(
          {
            ...account,
            imap: { ...account.imap, preset: "custom", smtpHost: "smtp.office365.com" },
          },
          {
            to: [{ name: "", address: "bob@example.test" }],
            cc: [],
            bcc: [],
            subject: "Test",
            text: "hello",
            attachments: [],
          },
          Option.none(),
        );
      }),
    );
    expect(test.commands.some((c) => c.includes("HEADER Message-ID"))).toBe(true);
    expect(test.commands.some((c) => c.includes("APPEND"))).toBe(false);
    expect(test.delivered).toHaveLength(1);
  } finally {
    await test.runtime.dispose();
  }
});

it("a successful mobile move tolerates malformed COPYUID metadata", async () => {
  const test = server({ noMove: true, noUidplus: true, copyUidResponse: "11 1 4:3" });
  try {
    await test.runtime.runPromise(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const account = yield* mailbox.accounts.connect({
          provider: "imap",
          input: { preset: "fastmail", email: "me@example.test", password: "secret" },
        });
        const provider = (yield* Providers).get("imap");
        yield* provider.push(account, "9:1:INBOX", {
          kind: "move",
          labelId: "Projects",
          removeLabelId: "INBOX",
        });
      }),
    );
    expect(test.commands.some((command) => command.includes("UID COPY"))).toBe(true);
  } finally {
    await test.runtime.dispose();
  }
});

it("mobile rebuilds remap rows that backfill did not put in the cursor", async () => {
  const test = server();
  try {
    await test.runtime.runPromise(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const store = yield* Store;
        const account = yield* mailbox.accounts.connect({
          provider: "imap",
          input: { preset: "fastmail", email: "me@example.test", password: "secret" },
        });
        const cached = mobileIncoming(
          yield* Effect.promise(() => parseMobileMime(raw)),
          { path: "INBOX", label: "INBOX", name: "Inbox" },
          "6",
          99,
          [],
          raw.length,
        );
        yield* store.upsertMessage(account.id, cached);
        yield* store.saveSyncCursor(
          account.id,
          JSON.stringify({
            folders: {
              INBOX: { uidValidity: "6", lastUid: 99, uids: "1", unread: "1", starred: "" },
            },
          }),
        );
        yield* mailbox.sync.sync();
        expect((yield* store.messageRef(`${account.id}/6:99:INBOX`)).providerId).toBe("9:1:INBOX");
        expect(yield* store.messageIdForProvider(account.id, "9:1:INBOX")).toBe(
          `${account.id}/6:99:INBOX`,
        );
      }),
    );
    expect(test.commands.some((command) => command.includes("UID SEARCH ALL"))).toBe(false);
  } finally {
    await test.runtime.dispose();
  }
});

it("background IMAP pull refuses absent cursors and changed UIDVALIDITY before fetching history", async () => {
  const test = server({ validity: "10" });
  try {
    await test.runtime.runPromise(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const account = yield* mailbox.accounts.connect({
          provider: "imap",
          input: { preset: "fastmail", email: "me@example.test", password: "secret" },
        });
        yield* mailbox.sync.sync();
        test.commands.length = 0;
        const adapter = (yield* Providers).get("imap");
        const stale = JSON.stringify({
          folders: { INBOX: { uidValidity: "9", lastUid: 1, uids: "1", unread: "1", starred: "" } },
        });
        for (const cursor of [Option.none<string>(), Option.some(stale)]) {
          const result = yield* Stream.runCollect(
            adapter.pull(account, cursor, "inbox", true),
          ).pipe(Effect.result);
          expect(result._tag).toBe("Failure");
        }
      }),
    );
    expect(test.commands.some((command) => /UID SEARCH|UID FETCH/.test(command))).toBe(false);
  } finally {
    await test.runtime.dispose();
  }
});

it("concurrent commands on one IMAP wire are serialized", async () => {
  const writes: string[] = [];
  let firstTag = "";
  const socket = new ScriptSocket((bytes, current) => {
    const line = Buffer.from(bytes).toString().trim();
    writes.push(line);
    const tag = line.split(" ")[0]!;
    if (!firstTag) firstTag = tag;
    else current.enqueue(`${tag} OK second\r\n`);
  });
  const client = new ImapWire(new MailWire(socket));
  const first = client.command("NOOP");
  const second = client.command("NOOP");
  await Promise.resolve();
  await Promise.resolve();
  const overlapping = writes.length;
  socket.enqueue(`${firstTag} OK first\r\n`);
  // A broken wire races its readers; close it after recording the actual overlap.
  if (overlapping > 1) socket.close();
  await Promise.allSettled([first, second]);
  expect(overlapping).toBe(1);
  expect(writes).toHaveLength(2);
});

it("In-Reply-To with multiple ids uses only the first parent", async () => {
  const parsed = await parseMobileMime(
    Buffer.from("Message-ID: <child@x>\r\nIn-Reply-To: <one@x> <two@x>\r\n\r\nbody"),
  );
  expect(
    mobileIncoming(parsed, { path: "INBOX", name: "INBOX", label: "INBOX" }, "9", 1, [], 10)
      .parentRfcMessageId,
  ).toBe("one@x");
});

it("interrupted pooled mobile pushes evict and close the socket", async () => {
  let began: () => void = () => {
    // The Promise constructor installs the resolver before any command starts.
  };
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const test = server({ stallStore: () => began(), stallStoreAt: 2 });
  try {
    const account = await test.runtime.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Mailbox).accounts.connect({
          provider: "imap",
          input: { preset: "fastmail", email: "me@example.test", password: "secret" },
        });
      }),
    );
    const adapter = await test.runtime.runPromise(Effect.map(Providers, (p) => p.get("imap")));
    await test.runtime.runPromise(
      adapter.push(account, "9:1:INBOX", { kind: "read", value: false }),
    );
    const fiber = test.runtime.runFork(
      adapter.push(account, "9:1:INBOX", { kind: "read", value: true }),
    );
    await started;
    const interruptedSocket = test.sockets.at(-1)!;
    const before = test.sockets.length;
    await test.runtime.runPromise(Fiber.interrupt(fiber));
    expect(interruptedSocket.closed).toBe(true);
    await test.runtime.runPromise(
      adapter.push(account, "9:1:INBOX", { kind: "star", value: true }),
    );
    expect(test.sockets.length).toBe(before + 1);
  } finally {
    await test.runtime.dispose();
  }
});

it("mobile sync omits Deleted copies on a server without MOVE or UIDPLUS", async () => {
  const test = server({ noMove: true, noUidplus: true });
  try {
    await test.runtime.runPromise(
      Effect.gen(function* () {
        const account = yield* (yield* Mailbox).accounts.connect({
          provider: "imap",
          input: { preset: "fastmail", email: "me@example.test", password: "secret" },
        });
        const adapter = (yield* Providers).get("imap");
        yield* adapter.push(account, "9:1:INBOX", {
          kind: "move",
          labelId: "Projects",
          removeLabelId: "INBOX",
        });
        const cursor = Option.some(
          JSON.stringify({
            folders: {
              INBOX: { uidValidity: "9", lastUid: 1, uids: "1", unread: "1", starred: "" },
            },
          }),
        );
        const changes = yield* Stream.runCollect(adapter.pull(account, cursor, "inbox"));
        expect(
          changes.some((c) => c._tag === "RebuildFolder" && c.candidates?.includes("9:1:INBOX")),
        ).toBe(true);
        expect(
          changes.some(
            (c) =>
              (c._tag === "Upsert" || c._tag === "Remap") && c.message.providerId === "9:1:INBOX",
          ),
        ).toBe(false);
      }),
    );
    expect(test.commands.some((c) => /UID EXPUNGE/.test(c))).toBe(false);
  } finally {
    await test.runtime.dispose();
  }
});

it("mobile sync brings back a message another client undeletes", async () => {
  const test = server({ noMove: true, noUidplus: true });
  try {
    await test.runtime.runPromise(
      Effect.gen(function* () {
        const account = yield* (yield* Mailbox).accounts.connect({
          provider: "imap",
          input: { preset: "fastmail", email: "me@example.test", password: "secret" },
        });
        const adapter = (yield* Providers).get("imap");
        // Without MOVE or UIDPLUS the source is only marked \\Deleted.
        yield* adapter.push(account, "9:1:INBOX", {
          kind: "move",
          labelId: "Projects",
          removeLabelId: "INBOX",
        });
        const pull = (cursor: Option.Option<string>) =>
          Stream.runCollect(adapter.pull(account, cursor, "inbox")).pipe(
            Effect.map((changes) => {
              const last = changes.findLast((c) => c._tag === "Cursor");
              return {
                changes,
                cursor: Option.some(last?._tag === "Cursor" ? last.cursor : ""),
              };
            }),
          );
        const first = yield* pull(
          Option.some(
            JSON.stringify({
              folders: {
                INBOX: { uidValidity: "9", lastUid: 1, uids: "1", unread: "1", starred: "" },
              },
            }),
          ),
        );
        expect(readCursor(first.cursor).folders.INBOX?.deleted).toBe("1");
        test.undelete();
        const second = yield* pull(first.cursor);
        expect(
          second.changes.some((c) => c._tag === "Upsert" && c.message.providerId === "9:1:INBOX"),
        ).toBe(true);
        expect(readCursor(second.cursor).folders.INBOX).toMatchObject({ uids: "1" });
        expect(readCursor(second.cursor).folders.INBOX?.deleted).toBeUndefined();
      }),
    );
  } finally {
    await test.runtime.dispose();
  }
});

it("mobile UIDNEXT regression invalidates old mappings before any refetch", async () => {
  const test = server({ uidNext: 2 });
  try {
    await test.runtime.runPromise(
      Effect.gen(function* () {
        const account = yield* (yield* Mailbox).accounts.connect({
          provider: "imap",
          input: { preset: "fastmail", email: "me@example.test", password: "secret" },
        });
        const cursor = Option.some(
          JSON.stringify({
            folders: {
              INBOX: { uidValidity: "9", lastUid: 100, uids: "1", unread: "1", starred: "" },
            },
          }),
        );
        const changes = yield* Stream.runCollect(
          (yield* Providers).get("imap").pull(account, cursor, "inbox"),
        );
        const invalidate = changes.findIndex((c) => c._tag === "InvalidateFolder");
        expect(invalidate).toBeGreaterThanOrEqual(0);
        expect(changes.findIndex((c) => c._tag === "Upsert")).toBeGreaterThan(invalidate);
        expect(changes.some((c) => c._tag === "Remap")).toBe(false);
      }),
    );
  } finally {
    await test.runtime.dispose();
  }
});

it("mobile pushes refuse regressed UIDNEXT before STORE or COPY", async () => {
  const test = server({ uidNext: 2 });
  try {
    await test.runtime.runPromise(
      Effect.gen(function* () {
        const account = yield* (yield* Mailbox).accounts.connect({
          provider: "imap",
          input: { preset: "fastmail", email: "me@example.test", password: "secret" },
        });
        const adapter = (yield* Providers).get("imap");
        const cursor = JSON.stringify({
          folders: {
            INBOX: { uidValidity: "9", lastUid: 100, uids: "1", unread: "1", starred: "" },
          },
        });
        test.commands.length = 0;
        for (const effect of [
          adapter.push(account, "9:1:INBOX", { kind: "star", value: true }, cursor),
          adapter.pushBatch?.(
            account,
            ["9:1:INBOX"],
            { kind: "move", labelId: "Projects", removeLabelId: "INBOX" },
            cursor,
          ),
        ]) {
          if (!effect) throw new Error("Missing batch push");
          const result = yield* effect.pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") expect(result.failure._tag).toBe("PermanentError");
        }
      }),
    );
    expect(test.commands.some((command) => /UID STORE|UID COPY|UID MOVE/.test(command))).toBe(
      false,
    );
  } finally {
    await test.runtime.dispose();
  }
});

for (const outcome of ["present", "gone", "moved"] as const) {
  it(`mobile IMAP reset verifies ${outcome} by UID and Message-ID`, async () => {
    const test = server({
      resetSearch: (command, path) => {
        if (command.includes("HEADER Message-ID")) {
          const uid = Number(/m(\d+)@/.exec(command)?.[1]);
          return (outcome === "present" && path === "INBOX") ||
            (outcome === "moved" && path === "Projects")
            ? [uid]
            : [];
        }
        return outcome === "present" && path === "INBOX"
          ? Array.from({ length: 90 }, (_value, index) => index + 11)
          : [];
      },
    });
    try {
      await test.runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* Store;
          const account = yield* store.upsertAccount("imap", "me@example.test");
          const settings = {
            preset: "custom",
            username: "me@example.test",
            imapHost: "imap.example.test",
            imapPort: 993,
            smtpHost: "smtp.example.test",
            smtpPort: 465,
            smtpSecure: true,
          } as const;
          yield* store.setImapSettings(account.id, settings);
          yield* (yield* Secrets).set(account.id, "password");
          for (let uid = 1; uid <= 100; uid++)
            yield* store.upsertMessage(account.id, {
              providerId: `9:${uid}:INBOX`,
              rfcMessageId: `<m${uid}@example.test>`,
              threadId: `m${uid}`,
              subject: "Cached",
              from: { name: "", address: "sender@example.test" },
              to: [],
              cc: [],
              date: 1000,
              snippet: "cached",
              bodyText: "cached body",
              bodyHtml: "",
              labels: ["INBOX", "UNREAD"],
              attachments: [],
              isUnread: true,
              isStarred: false,
            });
          const adapter = (yield* Providers).get("imap");
          const guard = makeResetGuard(
            store,
            adapter,
            { ...account, imap: settings },
            { changed: 0, deleted: 0 },
            { remaining: 500 },
          );
          yield* guard.reset({
            _tag: "RebuildFolder",
            previous: { path: "INBOX", uidValidity: "9" },
            keep: Array.from({ length: 10 }, (_value, index) => `9:${index + 1}:INBOX`),
          });
          yield* guard.verify();
          expect(
            yield* store.countThreads({ accountIds: [account.id], mailbox: "all", flat: true }),
          ).toBe(outcome === "gone" ? 10 : 100);
          if (outcome === "moved") {
            const id = yield* store.messageIdForProvider(account.id, "9:11:Projects");
            if (!id) throw new Error("Missing moved message");
            expect((yield* store.getMessage(id)).labels).toEqual(["Projects", "UNREAD"]);
            expect((yield* store.getMessage(id)).bodyText).toBe("cached body");
          }
        }),
      );
      expect(test.commands.some((command) => command.includes("UID SEARCH UNDELETED UID"))).toBe(
        true,
      );
      if (outcome !== "present")
        expect(test.commands.some((command) => command.includes("HEADER Message-ID"))).toBe(true);
    } finally {
      await test.runtime.dispose();
    }
  });
}

it("successful IMAP command without a SEARCH reply is not proof of absence", async () => {
  const socket = new ScriptSocket((bytes, current) => {
    const tag = Buffer.from(bytes).toString("utf8").split(" ")[0];
    current.enqueue(`${tag} OK completed\r\n`);
  });
  try {
    await expect(new ImapWire(new MailWire(socket)).search("UID 1:100")).rejects.toThrow(
      "SEARCH response",
    );
  } finally {
    socket.close();
  }
});

for (const outcome of ["present", "gone", "moved"] as const) {
  it(`mobile invalidation verifies ${outcome} through Message-ID and preserves cached rows first`, async () => {
    const test = server({
      resetSearch: (command, path) => {
        if (!command.includes("HEADER Message-ID")) throw new Error("Unsafe reused UID probe");
        const uid = Number(/m(\d+)@/.exec(command)?.[1]);
        return (outcome === "present" && path === "INBOX") ||
          (outcome === "moved" && path === "Projects")
          ? [uid + 100]
          : [];
      },
    });
    try {
      await test.runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* Store;
          const account = yield* store.upsertAccount("imap", "me@example.test");
          const settings = {
            preset: "custom",
            username: "me@example.test",
            imapHost: "imap.example.test",
            imapPort: 993,
            smtpHost: "smtp.example.test",
            smtpPort: 465,
            smtpSecure: true,
          } as const;
          yield* store.setImapSettings(account.id, settings);
          yield* (yield* Secrets).set(account.id, "password");
          for (let uid = 1; uid <= 100; uid++)
            yield* store.upsertMessage(account.id, {
              providerId: `9:${uid}:INBOX`,
              rfcMessageId: `<m${uid}@example.test>`,
              threadId: `m${uid}`,
              subject: "Cached",
              from: { name: "", address: "sender@example.test" },
              to: [],
              cc: [],
              date: 1000,
              snippet: "cached",
              bodyText: "cached body",
              bodyHtml: "",
              labels: ["INBOX", "UNREAD"],
              attachments: [],
              isUnread: true,
              isStarred: false,
            });
          yield* store.invalidateImapFolder(account.id, { path: "INBOX", uidValidity: "9" });
          expect(
            yield* store.countThreads({ accountIds: [account.id], mailbox: "all", flat: true }),
          ).toBe(100);
          expect((yield* store.pendingResetCandidates(account.id)).length).toBe(100);
          const adapter = (yield* Providers).get("imap");
          yield* makeResetGuard(
            store,
            adapter,
            { ...account, imap: settings },
            { changed: 0, deleted: 0 },
            { remaining: 500 },
          ).verify();
          expect(
            yield* store.countThreads({ accountIds: [account.id], mailbox: "all", flat: true }),
          ).toBe(outcome === "gone" ? 0 : 100);
          expect((yield* store.pendingResetCandidates(account.id)).length).toBe(0);
          if (outcome !== "gone") {
            const id = yield* store.messageIdForProvider(
              account.id,
              `9:111:${outcome === "present" ? "INBOX" : "Projects"}`,
            );
            if (!id) throw new Error("Missing verified message");
            expect(id).not.toBe(`${account.id}/9:11:INBOX`);
            expect(yield* store.hasMessage(`${account.id}/9:11:INBOX`)).toBe(false);
            expect((yield* store.getMessage(id)).bodyText).toBe("cached body");
          }
        }),
      );
      expect(test.commands.some((command) => command.includes("UNDELETED HEADER Message-ID"))).toBe(
        true,
      );
    } finally {
      await test.runtime.dispose();
    }
  });
}

const testMessage = {
  to: [{ name: "", address: "alice@example.test" }],
  cc: [],
  bcc: [],
  subject: "Slice 63",
  text: "Body",
  attachments: [],
};

for (const response of ["disconnect", 554] as const) {
  it(`SMTP DATA ${response} distinguishes uncertainty from definite rejection`, async () => {
    const test = server({ smtpDataReply: response });
    try {
      await test.runtime.runPromise(
        Effect.gen(function* () {
          const account = yield* (yield* Mailbox).accounts.connect({
            provider: "imap",
            input: { preset: "fastmail", email: "me@example.test", password: "secret" },
          });
          const adapter = (yield* Providers).get("imap");
          const result = yield* adapter
            .send(account, testMessage, Option.none())
            .pipe(Effect.result);
          expect(result._tag).toBe(response === "disconnect" ? "Success" : "Failure");
          if (result._tag === "Failure") expect(result.failure._tag).toBe("PermanentError");
        }),
      );
      expect(test.delivered).toHaveLength(1);
      expect(test.commands.some((c) => c.includes("HEADER Message-ID"))).toBe(
        response === "disconnect",
      );
      expect(test.commands.some((c) => c.includes("APPEND"))).toBe(false);
    } finally {
      await test.runtime.dispose();
    }
  });
}

it("mobile copy/move retries reuse the destination and resolve missing COPYUID", async () => {
  const test = server({ noMove: true, noUidplus: true, rejectDeleteOnce: true });
  try {
    await test.runtime.runPromise(
      Effect.gen(function* () {
        const account = yield* (yield* Mailbox).accounts.connect({
          provider: "imap",
          input: { preset: "fastmail", email: "me@example.test", password: "secret" },
        });
        const adapter = (yield* Providers).get("imap");
        const op = { kind: "move", labelId: "Projects", removeLabelId: "INBOX" } as const;
        expect((yield* adapter.push(account, "9:1:INBOX", op).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(yield* adapter.push(account, "9:1:INBOX", op)).toEqual([
          { from: "9:1:INBOX", to: "9:4:Projects" },
        ]);
      }),
    );
    expect(test.commands.filter((c) => c.includes("UID COPY"))).toHaveLength(1);
  } finally {
    await test.runtime.dispose();
  }
});

for (const existing of [true, false]) {
  it(`mobile special folders ${existing ? "reuse path aliases" : "accept ALREADYEXISTS"}`, async () => {
    const test = server({
      noMove: true,
      noUidplus: true,
      folderRows: `* LIST () "/" "INBOX"\r\n* LIST () "/" "Sent"\r\n${existing ? '* LIST () "/" "Trash"\r\n' : ""}`,
      createAlreadyExists: true,
    });
    try {
      await test.runtime.runPromise(
        Effect.gen(function* () {
          const account = yield* (yield* Mailbox).accounts.connect({
            provider: "imap",
            input: { preset: "fastmail", email: "me@example.test", password: "secret" },
          });
          expect(
            yield* (yield* Providers).get("imap").push(account, "9:1:INBOX", { kind: "trash" }),
          ).toEqual([{ from: "9:1:INBOX", to: "9:4:Trash" }]);
        }),
      );
      expect(test.commands.some((c) => c.includes("CREATE"))).toBe(!existing);
    } finally {
      await test.runtime.dispose();
    }
  });
}

it("mobile move holds queued operations when destination UID remains unresolved", async () => {
  const test = server({ noMove: true, noUidplus: true, unresolvedCopy: true });
  try {
    await test.runtime.runPromise(
      Effect.gen(function* () {
        const account = yield* (yield* Mailbox).accounts.connect({
          provider: "imap",
          input: { preset: "fastmail", email: "me@example.test", password: "secret" },
        });
        const result = yield* (yield* Providers)
          .get("imap")
          .push(account, "9:1:INBOX", { kind: "move", labelId: "Projects", removeLabelId: "INBOX" })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure._tag).toBe("ProviderError");
      }),
    );
    expect(test.commands.some((c) => c.includes("\\Deleted"))).toBe(false);
  } finally {
    await test.runtime.dispose();
  }
});

for (const failures of [1, 2]) {
  it(`mobile Sent APPEND retries once after ${failures} failure(s) and reports missing copy`, async () => {
    const test = server({
      appendFailures: failures,
      resetSearch: (command) => (command.includes("HEADER Message-ID") ? [] : [1]),
    });
    try {
      await test.runtime.runPromise(
        Effect.gen(function* () {
          const account = yield* (yield* Mailbox).accounts.connect({
            provider: "imap",
            input: { preset: "fastmail", email: "me@example.test", password: "secret" },
          });
          const result = yield* (yield* Providers)
            .get("imap")
            .send(account, testMessage, Option.none());
          expect(result).toEqual(failures === 2 ? { sentCopyMissing: true } : undefined);
        }),
      );
      expect(test.commands.filter((c) => c.includes("APPEND"))).toHaveLength(2);
      expect(test.delivered).toHaveLength(1);
    } finally {
      await test.runtime.dispose();
    }
  });
}

it("multi-destination mobile copy waits for completed destinations while SEARCH lags", async () => {
  let visible = false;
  const test = server({
    noMove: true,
    noUidplus: true,
    rejectCopyTargetOnce: "Projects/Child",
    resetSearch: (command, path) =>
      command.includes("HEADER Message-ID") && path !== "INBOX" ? (visible ? [4] : []) : [1],
  });
  try {
    await test.runtime.runPromise(
      Effect.gen(function* () {
        const account = yield* (yield* Mailbox).accounts.connect({
          provider: "imap",
          input: { preset: "fastmail", email: "me@example.test", password: "secret" },
        });
        const adapter = (yield* Providers).get("imap");
        const op = { kind: "copy", labelIds: ["Projects", "Projects/Child"] } as const;
        expect((yield* adapter.push(account, "9:1:INBOX", op).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        const waiting = yield* adapter.push(account, "9:1:INBOX", op).pipe(Effect.result);
        expect(waiting._tag).toBe("Failure");
        if (waiting._tag === "Failure") expect(waiting.failure._tag).toBe("ProviderError");
        visible = true;
        yield* adapter.push(account, "9:1:INBOX", op);
      }),
    );
    expect(test.commands.filter((c) => c.endsWith('UID COPY 1 "Projects"'))).toHaveLength(1);
    expect(test.commands.filter((c) => c.endsWith('UID COPY 1 "Projects/Child"'))).toHaveLength(2);
  } finally {
    await test.runtime.dispose();
  }
});

it("lost SMTP acknowledgement without a Sent match preserves SendUncertain", async () => {
  const test = server({ smtpDataReply: "disconnect", resetSearch: () => [] });
  try {
    const account = await test.runtime.runPromise(
      Effect.flatMap(Mailbox, (mailbox) =>
        mailbox.accounts.connect({
          provider: "imap",
          input: { preset: "fastmail", email: "me@example.test", password: "secret" },
        }),
      ),
    );
    const adapter = await test.runtime.runPromise(
      Effect.map(Providers, (providers) => providers.get("imap")),
    );
    vi.useFakeTimers();
    const sending = test.runtime.runPromise(
      adapter.send(account, testMessage, Option.none()).pipe(Effect.result),
    );
    await vi.advanceTimersByTimeAsync(35000);
    const result = await sending;
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure._tag).toBe("SendUncertain");
    expect(test.delivered).toHaveLength(1);
    expect(test.commands.some((c) => c.includes("APPEND"))).toBe(false);
  } finally {
    vi.useRealTimers();
    await test.runtime.dispose();
  }
});

it("advertised native MOVE keeps the source when COPYUID and destination lookup are unavailable", async () => {
  const test = server({ unresolvedCopy: true });
  try {
    await test.runtime.runPromise(
      Effect.gen(function* () {
        const account = yield* (yield* Mailbox).accounts.connect({
          provider: "imap",
          input: { preset: "fastmail", email: "me@example.test", password: "secret" },
        });
        const adapter = (yield* Providers).get("imap");
        const result = yield* adapter
          .push(account, "9:1:INBOX", { kind: "move", labelId: "Projects", removeLabelId: "INBOX" })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure._tag).toBe("ProviderError");
        expect(yield* adapter.fetchRaw(account, "9:1:INBOX")).toEqual(Uint8Array.from(raw));
      }),
    );
    expect(test.commands.some((c) => c.includes("UID MOVE"))).toBe(false);
    expect(test.commands.some((c) => c.includes("UID COPY"))).toBe(true);
    expect(test.commands.some((c) => c.includes("\\Deleted"))).toBe(false);
  } finally {
    await test.runtime.dispose();
  }
});

it("persisted Message-ID remaps an expunged source after mobile adapter restart", async () => {
  const test = server();
  try {
    await test.runtime.runPromise(
      Effect.gen(function* () {
        const account = yield* (yield* Mailbox).accounts.connect({
          provider: "imap",
          input: { preset: "fastmail", email: "me@example.test", password: "secret" },
        });
        const adapter = (yield* Providers).get("imap");
        const op = { kind: "move", labelId: "Projects", removeLabelId: "INBOX" } as const;
        const mapping = [{ from: "9:1:INBOX", to: "9:4:Projects" }];
        expect(yield* adapter.push(account, "9:1:INBOX", op)).toEqual(mapping);
        const restarted = yield* makeMobileImap.pipe(Effect.provide(mobileMailCodecLayer));
        const context = {
          messageIds: new Map([["9:1:INBOX", "<one@example.test>"]]),
          progress: new Set([
            JSON.stringify(["9:1:INBOX", "Projects"]),
            JSON.stringify(["9:1:INBOX", "Projects", "accepted"]),
          ]),
        };
        expect(yield* restarted.push(account, "9:1:INBOX", op, undefined, context)).toEqual(
          mapping,
        );
        if (!restarted.pushBatch) throw new Error("Missing batch push");
        expect(yield* restarted.pushBatch(account, ["9:1:INBOX"], op, undefined, context)).toEqual(
          mapping,
        );
      }),
    );
    expect(test.commands.filter((c) => c.includes("UID COPY"))).toHaveLength(1);
    expect(test.commands.filter((c) => c.includes("+FLAGS.SILENT (\\Deleted)"))).toHaveLength(1);
    expect(test.commands.filter((c) => c.includes("UID EXPUNGE"))).toHaveLength(1);
  } finally {
    await test.runtime.dispose();
  }
});

it("mobile move retries accepted Deleted flags after a lost acknowledgement", async () => {
  const test = server({ disconnectAfterDeleteOnce: true });
  try {
    await test.runtime.runPromise(
      Effect.gen(function* () {
        const account = yield* (yield* Mailbox).accounts.connect({
          provider: "imap",
          input: { preset: "fastmail", email: "me@example.test", password: "secret" },
        });
        const adapter = (yield* Providers).get("imap");
        const op = { kind: "move", labelId: "Projects", removeLabelId: "INBOX" } as const;
        expect((yield* adapter.push(account, "9:1:INBOX", op).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        const restarted = yield* makeMobileImap.pipe(Effect.provide(mobileMailCodecLayer));
        expect(
          yield* restarted.push(account, "9:1:INBOX", op, undefined, {
            messageIds: new Map([["9:1:INBOX", "<one@example.test>"]]),
            progress: new Set([
              JSON.stringify(["9:1:INBOX", "Projects"]),
              JSON.stringify(["9:1:INBOX", "Projects", "accepted"]),
            ]),
          }),
        ).toEqual([{ from: "9:1:INBOX", to: "9:4:Projects" }]);
      }),
    );
    expect(test.commands.filter((c) => c.includes("UID COPY"))).toHaveLength(1);
    expect(test.commands.filter((c) => c.includes("+FLAGS.SILENT (\\Deleted)"))).toHaveLength(2);
    expect(test.commands.filter((c) => c.includes("UID EXPUNGE"))).toHaveLength(1);
  } finally {
    await test.runtime.dispose();
  }
});

for (const operation of ["move", "copy"] as const) {
  it(`queued identity refuses silently reused mobile UID before ${operation}`, async () => {
    const test = server();
    try {
      await test.runtime.runPromise(
        Effect.gen(function* () {
          const account = yield* (yield* Mailbox).accounts.connect({
            provider: "imap",
            input: { preset: "fastmail", email: "me@example.test", password: "secret" },
          });
          const adapter = (yield* Providers).get("imap");
          const op =
            operation === "move"
              ? ({ kind: "move", labelId: "Projects", removeLabelId: "INBOX" } as const)
              : ({ kind: "copy", labelIds: ["Projects"] } as const);
          const result = yield* adapter
            .push(account, "9:1:INBOX", op, undefined, {
              messageIds: new Map([["9:1:INBOX", "<original@example.test>"]]),
            })
            .pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") expect(result.failure._tag).toBe("PermanentError");
        }),
      );
      expect(test.commands.some((c) => /UID COPY|UID STORE|UID EXPUNGE/.test(c))).toBe(false);
    } finally {
      await test.runtime.dispose();
    }
  });
}

it("an externally removed source without persisted COPY progress fails permanently", async () => {
  const test = server({ resetSearch: () => [] });
  try {
    await test.runtime.runPromise(
      Effect.gen(function* () {
        const account = yield* (yield* Mailbox).accounts.connect({
          provider: "imap",
          input: { preset: "fastmail", email: "me@example.test", password: "secret" },
        });
        const result = yield* (yield* Providers)
          .get("imap")
          .push(
            account,
            "9:1:INBOX",
            { kind: "move", labelId: "Projects", removeLabelId: "INBOX" },
            undefined,
            { messageIds: new Map([["9:1:INBOX", "<one@example.test>"]]), progress: new Set() },
          )
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure._tag).toBe("PermanentError");
      }),
    );
    expect(test.commands.some((c) => c.includes("UID COPY"))).toBe(false);
  } finally {
    await test.runtime.dispose();
  }
});

it("first COPY preserves a distinct source with the same Message-ID already in destination", async () => {
  const test = server({ copyUid: true, resetSearch: () => [1] });
  let marked = false;
  try {
    await test.runtime.runPromise(
      Effect.gen(function* () {
        const account = yield* (yield* Mailbox).accounts.connect({
          provider: "imap",
          input: { preset: "fastmail", email: "me@example.test", password: "secret" },
        });
        const result = yield* (yield* Providers)
          .get("imap")
          .push(
            account,
            "9:1:INBOX",
            { kind: "move", labelId: "Projects", removeLabelId: "INBOX" },
            undefined,
            {
              messageIds: new Map([["9:1:INBOX", "<one@example.test>"]]),
              progress: new Set(),
              beforeCopy: (destination, ids) =>
                Effect.sync(() => {
                  expect(destination).toBe("Projects");
                  expect(ids).toEqual(["9:1:INBOX"]);
                  expect(test.commands.some((c) => c.includes("UID COPY"))).toBe(false);
                  marked = true;
                }),
            },
          );
        expect(result).toEqual([{ from: "9:1:INBOX", to: "11:4:Projects" }]);
      }),
    );
    expect(marked).toBe(true);
    expect(test.commands.filter((c) => c.includes("UID COPY"))).toHaveLength(1);
    expect(test.commands.some((c) => c.includes("HEADER Message-ID"))).toBe(false);
  } finally {
    await test.runtime.dispose();
  }
});

for (const copyUid of [true, false]) {
  it(`mobile moves a source without Message-ID ${copyUid ? "with COPYUID" : "and requests reconcile"}`, async () => {
    const source = Buffer.from(
      Buffer.from(raw)
        .toString("latin1")
        .replace(/^Message-ID:[^\r\n]*\r?\n/im, ""),
      "latin1",
    );
    const test = server({ source, copyUid, noUidplus: !copyUid });
    try {
      await test.runtime.runPromise(
        Effect.gen(function* () {
          const account = yield* (yield* Mailbox).accounts.connect({
            provider: "imap",
            input: { preset: "fastmail", email: "me@example.test", password: "secret" },
          });
          expect(
            yield* (yield* Providers).get("imap").push(account, "9:1:INBOX", {
              kind: "move",
              labelId: "Projects",
              removeLabelId: "INBOX",
            }),
          ).toEqual(copyUid ? [{ from: "9:1:INBOX", to: "11:4:Projects" }] : { reconcile: true });
        }),
      );
      expect(test.commands.filter((c) => c.includes("UID COPY"))).toHaveLength(1);
      expect(test.commands.some((c) => c.includes("+FLAGS.SILENT (\\Deleted)"))).toBe(true);
      expect(test.commands.some((c) => c.includes("UID EXPUNGE"))).toBe(copyUid);
      expect(test.commands.some((c) => /(?:^| )EXPUNGE$/.test(c))).toBe(false);
    } finally {
      await test.runtime.dispose();
    }
  });
}

it("mobile normalizes stored Message-ID brackets and whitespace before identity checks", async () => {
  const test = server({ copyUid: true });
  try {
    await test.runtime.runPromise(
      Effect.gen(function* () {
        const account = yield* (yield* Mailbox).accounts.connect({
          provider: "imap",
          input: { preset: "fastmail", email: "me@example.test", password: "secret" },
        });
        expect(
          yield* (yield* Providers)
            .get("imap")
            .push(
              account,
              "9:1:INBOX",
              { kind: "move", labelId: "Projects", removeLabelId: "INBOX" },
              undefined,
              {
                messageIds: new Map([["9:1:INBOX", "  one@example.test \t"]]),
                progress: new Set(),
              },
            ),
        ).toEqual([{ from: "9:1:INBOX", to: "11:4:Projects" }]);
      }),
    );
    expect(test.commands.filter((c) => c.includes("UID COPY"))).toHaveLength(1);
  } finally {
    await test.runtime.dispose();
  }
});

it("Courier INBOX-prefixed special folders match their leaf aliases", async () => {
  const test = server({
    copyUid: true,
    noUidplus: true,
    folderRows:
      '* LIST () "." "INBOX"\r\n* LIST () "." "INBOX.Sent"\r\n* LIST () "." "INBOX.Trash"\r\n',
  });
  try {
    await test.runtime.runPromise(
      Effect.gen(function* () {
        const account = yield* (yield* Mailbox).accounts.connect({
          provider: "imap",
          input: { preset: "fastmail", email: "me@example.test", password: "secret" },
        });
        const adapter = (yield* Providers).get("imap");
        yield* adapter.send(account, testMessage, Option.none());
        expect(yield* adapter.push(account, "9:1:INBOX", { kind: "trash" })).toEqual([
          { from: "9:1:INBOX", to: "11:4:INBOX.Trash" },
        ]);
      }),
    );
    expect(test.commands.some((c) => c.includes('APPEND "INBOX.Sent"'))).toBe(true);
    expect(test.commands.some((c) => c.includes('UID COPY 1 "INBOX.Trash"'))).toBe(true);
    expect(test.commands.some((c) => c.includes("CREATE"))).toBe(false);
  } finally {
    await test.runtime.dispose();
  }
});

it("accepted COPY without Message-ID retries only Deleted after restart", async () => {
  const source = Buffer.from(
    Buffer.from(raw)
      .toString("latin1")
      .replace(/^Message-ID:[^\r\n]*\r?\n/im, ""),
    "latin1",
  );
  const progress = new Set<string>();
  const test = server({ source, noUidplus: true, disconnectAfterDeleteOnce: true });
  try {
    await test.runtime.runPromise(
      Effect.gen(function* () {
        const account = yield* (yield* Mailbox).accounts.connect({
          provider: "imap",
          input: { preset: "fastmail", email: "me@example.test", password: "secret" },
        });
        const adapter = (yield* Providers).get("imap");
        const op = { kind: "move", labelId: "Projects", removeLabelId: "INBOX" } as const;
        const context = {
          messageIds: new Map<string, string>(),
          progress,
          beforeCopy: (destination: string, ids: readonly string[]) =>
            Effect.sync(() => {
              for (const id of ids) progress.add(JSON.stringify([id, destination]));
            }),
          afterCopy: (destination: string, ids: readonly string[]) =>
            Effect.sync(() => {
              for (const id of ids) progress.add(JSON.stringify([id, destination, "accepted"]));
            }),
        };
        expect(
          (yield* adapter.push(account, "9:1:INBOX", op, undefined, context).pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
        const restarted = yield* makeMobileImap.pipe(Effect.provide(mobileMailCodecLayer));
        expect(yield* restarted.push(account, "9:1:INBOX", op, undefined, context)).toEqual({
          reconcile: true,
        });
      }),
    );
    expect(test.commands.filter((c) => c.includes("UID COPY"))).toHaveLength(1);
    expect(test.commands.filter((c) => c.includes("+FLAGS.SILENT (\\Deleted)"))).toHaveLength(2);
    expect(test.commands.some((c) => c.includes("UID EXPUNGE"))).toBe(false);
  } finally {
    await test.runtime.dispose();
  }
});

it("persisted COPY intent with source and destination absent waits without re-copying", async () => {
  const test = server({ resetSearch: () => [] });
  try {
    await test.runtime.runPromise(
      Effect.gen(function* () {
        const account = yield* (yield* Mailbox).accounts.connect({
          provider: "imap",
          input: { preset: "fastmail", email: "me@example.test", password: "secret" },
        });
        const result = yield* (yield* Providers)
          .get("imap")
          .push(
            account,
            "9:1:INBOX",
            { kind: "move", labelId: "Projects", removeLabelId: "INBOX" },
            undefined,
            {
              messageIds: new Map([["9:1:INBOX", "<one@example.test>"]]),
              progress: new Set([JSON.stringify(["9:1:INBOX", "Projects"])]),
            },
          )
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure._tag).toBe("ProviderError");
      }),
    );
    expect(test.commands.some((c) => /UID COPY|UID STORE|UID EXPUNGE/.test(c))).toBe(false);
  } finally {
    await test.runtime.dispose();
  }
});

it("a new queued move ignores an earlier operation's local COPY progress", async () => {
  const test = server({ noUidplus: true, copyUid: true });
  try {
    await test.runtime.runPromise(
      Effect.gen(function* () {
        const account = yield* (yield* Mailbox).accounts.connect({
          provider: "imap",
          input: { preset: "fastmail", email: "me@example.test", password: "secret" },
        });
        const adapter = (yield* Providers).get("imap");
        const op = { kind: "move", labelId: "Projects", removeLabelId: "INBOX" } as const;
        yield* adapter.push(account, "9:1:INBOX", op);
        yield* adapter.push(account, "9:1:INBOX", op, undefined, {
          messageIds: new Map([["9:1:INBOX", "<one@example.test>"]]),
          progress: new Set(),
        });
      }),
    );
    expect(test.commands.filter((c) => c.includes("UID COPY"))).toHaveLength(2);
  } finally {
    await test.runtime.dispose();
  }
});

it("mobile IMAP header backfill uses folder-scoped PEEK fields, preserves flags and resumes its cache cursor", async () => {
  const test = server({
    source: Buffer.from(
      "Message-ID: <one@example.test>\r\nList-ID: List\r\n folded\r\nDelivered-To: a\r\nDelivered-To: b\r\n\r\n",
    ),
  });
  try {
    await test.runtime.runPromise(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const store = yield* Store;
        const account = yield* mailbox.accounts.connect({
          provider: "imap",
          input: { preset: "fastmail", email: "me@example.test", password: "app-password" },
        });
        yield* store.upsertMessage(account.id, {
          providerId: "9:1:INBOX",
          threadId: "old",
          subject: "Old cache",
          from: { name: "Alice", address: "a@example.test" },
          to: [],
          cc: [],
          date: 1,
          snippet: "cache",
          bodyText: "body",
          bodyHtml: "",
          labels: ["INBOX", "UNREAD", "STARRED"],
          isUnread: true,
          isStarred: true,
          attachments: [],
        });
        const adapter = (yield* Providers).get("imap");
        const readonly = readOnlyAdapter(adapter);
        expect(typeof readonly.fetchCachedHeaders).toBe("function");
        const cached = yield* store.getMessage(`${account.id}/9:1:INBOX`);
        yield* backfillCachedHeaders(store, readonly, account);
        const patched = yield* store.getMessage(cached.id);
        expect(patched.rfcMessageId).toBe("<one@example.test>");
        expect(patched.headers).toEqual([
          { name: "message-id", value: "<one@example.test>" },
          { name: "list-id", value: "List folded" },
          { name: "delivered-to", value: "a" },
          { name: "delivered-to", value: "b" },
        ]);
        expect(patched.labels).toEqual(cached.labels);
        expect(patched.isUnread).toBe(true);
        expect(patched.isStarred).toBe(true);
        expect(patched.bodyText).toBe("body");
        expect((yield* store.headerBackfillState(account.id)).kind).toBe("done");
        const count = test.commands.length;
        yield* backfillCachedHeaders(store, readonly, account);
        expect(test.commands.length).toBe(count);
        if (!readonly.fetchCachedHeaders) throw new Error("Missing header reader");
        const unavailable = yield* readonly.fetchCachedHeaders(account, [
          "8:1:INBOX",
          "quarantined",
        ]);
        expect(unavailable.every((row) => row.kind === "unavailable")).toBe(true);
      }),
    );
    const fetches = test.commands.filter((command) => command.includes("UID FETCH"));
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toContain("BODY.PEEK[HEADER.FIELDS");
    expect(fetches[0]).not.toContain("FLAGS");
    expect(test.commands.some((command) => /UID STORE|SELECT |APPEND|EXPUNGE/.test(command))).toBe(
      false,
    );
  } finally {
    await test.runtime.dispose();
  }
});

for (const operation of ["move", "copy"] as const) {
  it(`MailboxLive mobile identity changed before ${operation} restores the remote message and exposes the failure`, async () => {
    const test = server();
    try {
      await test.runtime.runPromise(
        Effect.gen(function* () {
          const mailbox = yield* Mailbox;
          const store = yield* Store;
          const account = yield* mailbox.accounts.connect({
            provider: "imap",
            input: { preset: "fastmail", email: "me@example.test", password: "secret" },
          });
          yield* mailbox.sync.sync(account.id);
          const id = `${account.id}/9:1:INBOX`;
          const before = yield* store.getMessage(id);
          yield* store.upsertMessage(account.id, {
            ...before,
            providerId: "9:1:INBOX",
            threadId: "stale-thread",
            rfcMessageId: "<original@example.test>",
          });
          yield* store.putDraft({
            id: "keep-draft",
            accountId: account.id,
            message: { to: [], cc: [], bcc: [], subject: "local", text: "keep", attachments: [] },
          });
          const commandStart = test.commands.length;
          yield* mailbox.organize.perform(
            {
              kind: "modify",
              threads: [id],
              op:
                operation === "move"
                  ? { kind: "move", labelId: "Projects", removeLabelId: "INBOX" }
                  : { kind: "copy", labelIds: ["Projects"] },
            },
            { kind: "user", surface: "app" },
          );
          const failures = yield* mailbox.proposals.listFailedOps;
          expect(failures).toHaveLength(1);
          expect(failures[0]?.reason).toBe(
            "Message identity changed; sync before changing this message",
          );
          expect(failures[0]?.kind).toBe(operation);
          const restored = yield* store.getMessage(id);
          expect(restored.bodyText).toBe(before.bodyText);
          expect(restored.rfcMessageId).toBe(before.rfcMessageId);
          expect(restored.labels).toEqual(before.labels);
          expect(Option.isSome(yield* store.getDraft("keep-draft"))).toBe(true);
          expect(yield* store.listPendingOps).toEqual([]);
          expect(
            test.commands
              .slice(commandStart)
              .some((command) => /UID COPY|UID STORE|UID EXPUNGE|UID MOVE/.test(command)),
          ).toBe(false);
          yield* mailbox.sync.sync(account.id);
          expect((yield* store.getMessage(id)).bodyText).toBe(before.bodyText);
          yield* mailbox.proposals.acknowledgeFailedOps(failures.map((item) => item.id));
          expect(yield* mailbox.proposals.listFailedOps).toEqual([]);
        }),
      );
    } finally {
      await test.runtime.dispose();
    }
  });
}
