import { expect, it, vi } from "vitest";
import { Effect, Layer, Logger, ManagedRuntime, Option, Stream } from "effect";
import {
  type MailSocket,
  MailTransport,
  MailWire,
  ImapWire,
  encodeFolder,
  decodeFolder,
} from "../mail-socket.js";
import { fetchFields, makeMobileImap, smtpSession } from "./imap.js";
import { mobileMailCodecLayer } from "./mail-codec.js";
import { MemoryPlatform } from "../node/platform-memory.js";
import { StoreLive } from "../../store.js";
import { Providers, Secrets } from "../../services.js";
import { MailboxLive } from "../../mailbox-live.js";
import { Mailbox } from "../../mailbox.js";
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
    authReject?: boolean;
    noStarttls?: boolean;
    validity?: string;
    appendReject?: boolean;
    source?: Uint8Array;
  } = {},
) {
  const commands: string[] = [];
  const sockets: ScriptSocket[] = [];
  const delivered: string[] = [];
  const upgrades: string[] = [];
  let seen = false;
  let starred = false;
  let exists = true;
  const transport = Layer.succeed(MailTransport, {
    connect: async ({ host, tls, signal }) => {
      const smtp = host.startsWith("smtp");
      let data = false;
      let appendTag = "";
      let loginTag = "";
      const socket = new ScriptSocket(
        (bytes, current) => {
          const line = Buffer.from(bytes).toString("latin1").replace(/\r\n$/, "");
          commands.push(line);
          if (smtp) {
            if (data) {
              delivered.push(line);
              data = false;
              current.enqueue("250 accepted\r\n");
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
              `* CAPABILITY IMAP4rev1 UIDPLUS MOVE ID ${options.noStarttls ? "" : "STARTTLS"}\r\n`,
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
              '* LIST (\\Inbox) "/" "INBOX"\r\n* LIST (\\Sent) "/" "Sent"\r\n* LIST () "/" "Projects"\r\n* LIST () "/" "Projects/Child"\r\n',
            );
            done();
          } else if (command.startsWith("EXAMINE") || command.startsWith("SELECT")) {
            current.enqueue(`* OK [UIDVALIDITY ${options.validity ?? "9"}] valid\r\n`);
            done();
          } else if (command.startsWith("UID SEARCH")) {
            current.enqueue(`* SEARCH${exists ? " 1" : ""}\r\n`);
            done();
          } else if (command.startsWith("UID FETCH")) {
            if (exists) {
              const flags = [seen ? "\\Seen" : "", starred ? "\\Flagged" : ""]
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
            if (command.includes("\\Seen")) seen = command.includes("+FLAGS");
            if (command.includes("\\Flagged")) starred = command.includes("+FLAGS");
            done();
          } else if (command.startsWith("UID MOVE")) {
            exists = false;
            done();
          } else if (command.startsWith("APPEND")) {
            if (options.appendReject)
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
  return { runtime, commands, sockets, delivered, upgrades };
}
it("runs mobile IMAP through shared connect, sync, reader, contacts, flags, move and audited send commands", async () => {
  const test = server();
  try {
    await test.runtime.runPromise(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const account = yield* mailbox.connect({
          provider: "imap",
          input: { preset: "fastmail", email: "me@example.test", password: "app-password" },
        });
        expect(account.imap?.imapHost).toBe("imap.fastmail.com");
        const stored = yield* (yield* Secrets).get(account.id);
        expect(stored).toEqual(expect.objectContaining({ value: "app-password" }));
        expect((yield* mailbox.sync(account.id)).every((item) => !item.error)).toBe(true);
        const message = (yield* mailbox.threads({ accountIds: [account.id], label: "INBOX" }))[0];
        if (!message) throw new Error("No synced message");
        expect((yield* mailbox.readerThread(message.id))[0]?.bodyHtml).toContain("cid:photo");
        expect((yield* mailbox.inlineImages(message.id))["photo"]).toBe(
          "data:image/png;base64,AQID",
        );
        expect((yield* mailbox.attachment(message.id, 0)).data).toEqual(new Uint8Array([4, 5, 6]));
        expect(
          (yield* mailbox.suggestContacts("alice", { accountIds: [account.id] }))[0]?.address,
        ).toBe("alice@example.test");
        expect((yield* mailbox.unreadByLabel([account.id])).INBOX).toBe(1);
        for (const op of [
          { kind: "read", value: true },
          { kind: "star", value: true },
        ] as const) {
          yield* mailbox.perform(
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
        yield* mailbox.queueSend(draft, 0);
        yield* mailbox.flushQueuedSends();
        expect(yield* mailbox.queuedSends).toEqual([]);
        expect(
          (yield* mailbox.audit(100)).some(
            (entry) => entry.action === "send" && entry.actor === "user:app",
          ),
        ).toBe(true);
        yield* mailbox.perform(
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
    expect(test.commands.some((line) => line.includes('UID MOVE 1 "Projects/Child"'))).toBe(true);
    expect(test.commands).toContain("RCPT TO:<private@example.test>");
    expect(test.delivered[0]).not.toMatch(/^Bcc:/im);
    expect(test.delivered[0]).toContain("LmRvdApIZWxsbw==");
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
    await test.runtime.runPromise(Effect.flatMap(Mailbox, (mailbox) => mailbox.connect(input)));
    expect(test.upgrades).toContain("smtp.mail.me.com");
    expect(test.commands.indexOf("STARTTLS")).toBeLessThan(
      test.commands.findIndex((line) => line.startsWith("AUTH PLAIN")),
    );
    const result = await blocked.runtime.runPromise(
      Effect.flatMap(Mailbox, (mailbox) => mailbox.connect(input)).pipe(Effect.result),
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
        const account = yield* mailbox.connect({
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
        mailbox.connect({
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
        const account = yield* mailbox.connect({
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
  const test = server({ appendReject: true });
  const warnings: unknown[] = [];
  const logger = Logger.make((options) => {
    warnings.push(options.message);
  });
  try {
    await test.runtime.runPromise(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const account = yield* mailbox.connect({
          provider: "imap",
          input: { preset: "fastmail", email: "me@example.test", password: "secret" },
        });
        yield* mailbox.queueSend(
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
        yield* mailbox.flushQueuedSends();
        yield* mailbox.flushQueuedSends();
        expect(yield* mailbox.queuedSends).toEqual([]);
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

it("background IMAP pull refuses absent cursors and changed UIDVALIDITY before fetching history", async () => {
  const test = server({ validity: "10" });
  try {
    await test.runtime.runPromise(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const account = yield* mailbox.connect({
          provider: "imap",
          input: { preset: "fastmail", email: "me@example.test", password: "secret" },
        });
        yield* mailbox.sync();
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
