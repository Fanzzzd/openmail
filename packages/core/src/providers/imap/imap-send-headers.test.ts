import { ImapFlow } from "imapflow";
import { MailCodec } from "../../platform/mail-codec.js";
import { nodeMailCodec } from "../../platform/node/mail-codec.js";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { vi } from "vitest";
import { createTransport } from "nodemailer";
import type { Account } from "../../domain/account.js";
import { encodeProviderId } from "./imap-cursor.js";
import { makeImapWith as unboundMakeImapWith } from "../../platform/node/imap/adapter.js";
import { Secrets } from "../../platform/auth.js";
import type { SendOriginal } from "../send-original.js";

const makeImapWith = (...args: Parameters<typeof unboundMakeImapWith>) =>
  unboundMakeImapWith(...args).pipe(Effect.provideService(MailCodec, nodeMailCodec));

const account: Account = {
  id: "imap:me@example.com",
  provider: "imap",
  email: "me@example.com",
  createdAt: 0,
  lastSyncedAt: null,
  lastSyncError: null,
  profileId: null,
  needsReauth: false,
  imap: {
    preset: "custom",
    username: "me@example.com",
    imapHost: "imap.example.com",
    imapPort: 993,
    smtpHost: "smtp.example.com",
    smtpPort: 465,
    smtpSecure: true,
  },
};

const folder = (path: string, specialUse: string) => ({
  path,
  pathAsListed: path,
  name: path,
  parent: [],
  parentPath: "",
  delimiter: "/",
  flags: new Set<string>(),
  listed: true,
  subscribed: true,
  specialUse,
});

let smtpCalls = 0;
const sendWith = (
  fetchOne: () => Promise<unknown>,
  options: {
    from?: { name: string; address: string };
    cached?: SendOriginal["cached"];
    senderName?: string;
    draft?: boolean;
    events?: string[];
  } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = new ImapFlow({ host: "fake.invalid", port: 993, logger: false });
      client.usable = true;
      vi.spyOn(client, "noop").mockResolvedValue(undefined);
      vi.spyOn(client, "list").mockResolvedValue([
        folder("INBOX", "\\Inbox"),
        folder("Sent", "\\Sent"),
        folder("Drafts", "\\Drafts"),
      ] as never);
      vi.spyOn(client, "mailboxOpen").mockResolvedValue({
        path: "INBOX",
        delimiter: "/",
        flags: new Set<string>(),
        uidValidity: 7n,
        uidNext: 3,
        exists: 2,
      } as never);
      vi.spyOn(client, "search").mockResolvedValue([]);
      vi.spyOn(client, "fetchOne").mockImplementation(fetchOne as never);
      let raw = "";
      vi.spyOn(client, "append").mockImplementation(((_path: string, content: Buffer) => {
        if (options.draft) raw = content.toString();
        options.events?.push(`append ${_path}`);
        return Promise.resolve({ destination: "Sent", uid: 9, uidValidity: 7n });
      }) as never);
      const settings = {
        ...account.imap!,
        ...(options.senderName ? { senderName: options.senderName } : {}),
      };
      const sender = { ...account, imap: settings };
      const adapter = yield* makeImapWith(
        () =>
          Effect.acquireRelease(
            Effect.sync(() => ({ accountId: account.id, settings, client })),
            () => Effect.void,
          ),
        () =>
          Effect.sync(() => {
            const transport = createTransport({ host: "fake.invalid", port: 25 });
            vi.spyOn(transport, "sendMail").mockImplementation(((mail: { raw: Buffer }) => {
              smtpCalls++;
              raw = mail.raw.toString();
              return Promise.resolve({
                envelope: {},
                accepted: ["bob@example.com"],
                rejected: [],
                pending: [],
                response: "250",
                messageId: "x",
              });
            }) as never);
            return transport;
          }),
      );
      const message = {
        to: [{ name: "Bob", address: "bob@example.com" }],
        cc: [],
        bcc: [],
        subject: "Re: hello",
        text: "reply",
        attachments: [],
        mode: "reply" as const,
        ...(options.from ? { from: options.from } : {}),
      };
      const original = Option.some({
        providerId: encodeProviderId("INBOX", 7n, 1),
        threadId: "t",
        ...(options.cached ? { cached: options.cached } : {}),
      });
      if (options.draft)
        yield* adapter.saveDraft(sender, {
          message,
          original,
          remote: null,
          replaceAttachments: false,
          creation: {
            begin: () => Effect.succeed({ messageId: "<d@x>", attempted: false }),
            attempted: () => Effect.void,
            remember: () => Effect.void,
            missing: () => Effect.succeed(true),
          },
        } as never);
      else
        yield* adapter.send(sender, message, original, {
          load: Effect.succeed(Option.none()),
          save: () => Effect.void,
          accepted: (bytes) =>
            Effect.sync(() => {
              options.events?.push(`accepted ${bytes.byteLength > 0}`);
            }),
        });
      return raw;
    }),
  ).pipe(
    Effect.provide(
      Layer.succeed(Secrets, {
        get: () => Effect.succeed(Option.some("pw")),
        set: () => Effect.void,
        remove: () => Effect.void,
      }),
    ),
  );

const headerOf = (raw: string, name: string) =>
  raw
    .split(/\r?\n\r?\n/)[0]!
    .split(/\r?\n/)
    .find((l) => l.toLowerCase().startsWith(name.toLowerCase() + ":"));

const cached = { messageId: "<cached@x>", references: "<root@x>" };
const timeout = async () => {
  throw Object.assign(new Error("Connection timed out"), { code: "ETIMEOUT" });
};

it.effect("a reply threads on the original's headers read from IMAP", () =>
  Effect.gen(function* () {
    const raw = yield* sendWith(async () => ({
      uid: 1,
      headers: Buffer.from("Message-ID: <orig@x>\r\nReferences: <root@x>\r\n\r\n"),
    }));
    assert.strictEqual(headerOf(raw, "In-Reply-To"), "In-Reply-To: <orig@x>");
  }),
);

// E9-6: a timeout reading the original used to send the reply without In-Reply-To.
it.effect("a transient IMAP error reading the original threads on the cached headers", () =>
  Effect.gen(function* () {
    const raw = yield* sendWith(timeout, { cached });
    assert.strictEqual(headerOf(raw, "In-Reply-To"), "In-Reply-To: <cached@x>");
    assert.strictEqual(headerOf(raw, "References"), "References: <root@x> <cached@x>");
  }),
);

it.effect("a transient IMAP error with nothing cached fails retryably before SMTP", () =>
  Effect.gen(function* () {
    smtpCalls = 0;
    const result = yield* sendWith(timeout).pipe(Effect.result);
    assert.isTrue(result._tag === "Failure" && result.failure._tag === "ProviderError");
    assert.strictEqual(smtpCalls, 0);
  }),
);

it.effect("an original moved since the last sync threads on the cached headers", () =>
  Effect.gen(function* () {
    const raw = yield* sendWith(async () => false, { cached });
    assert.strictEqual(headerOf(raw, "In-Reply-To"), "In-Reply-To: <cached@x>");
  }),
);

// E9-8: IMAP mail went out as a bare address.
it.effect("IMAP From carries the composer's display name", () =>
  Effect.gen(function* () {
    const raw = yield* sendWith(
      async () => ({ uid: 1, headers: Buffer.from("Message-ID: <orig@x>\r\n\r\n") }),
      { from: { name: "Jane Doe", address: "me@example.com" } },
    );
    assert.strictEqual(headerOf(raw, "From"), "From: Jane Doe <me@example.com>");
  }),
);

it.effect("IMAP From falls back to the account's sender name", () =>
  Effect.gen(function* () {
    const raw = yield* sendWith(async () => false, { senderName: "Jane Sender" });
    assert.strictEqual(headerOf(raw, "From"), "From: Jane Sender <me@example.com>");
  }),
);

it.effect("the Drafts APPEND uses the account's sender name", () =>
  Effect.gen(function* () {
    const raw = yield* sendWith(async () => false, { senderName: "Jane Sender", draft: true });
    assert.strictEqual(headerOf(raw, "From"), "From: Jane Sender <me@example.com>");
  }),
);

// E9-9: a crash between SMTP 250 and the Sent APPEND must leave a durable record.
it.effect("SMTP acceptance is recorded before the Sent APPEND", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    yield* sendWith(async () => false, { events });
    assert.deepStrictEqual(events, ["accepted true", "append Sent"]);
  }),
);
