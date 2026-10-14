import { draftCreation } from "./draft-create-fixture.js";
import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Option, Stream } from "effect";
import { TestClock } from "effect/testing";
import { vi } from "vitest";
import { ImapFlow } from "imapflow";
import { createTransport } from "nodemailer";
import { createServer, type Socket } from "node:net";
import { MailCodec } from "../mail-codec.js";
import { nodeMailCodec } from "./mail-codec.js";
import { makeImapWith } from "./imap/adapter.js";
import { incoming, fakeServer } from "./testing.js";
import { makeFakeProvider } from "./fake-provider.js";
import { ProviderError } from "../../domain/errors.js";
import { parseHeaders } from "./imap/parse.js";
import { parseUidSet } from "../../providers/imap/imap-cursor.js";
import { smtpTransport } from "./imap/session.js";
import { buildMime } from "./compose.js";
import { MemoryPlatform } from "./platform-memory.js";
import { Mailbox } from "../../mailbox/mailbox.js";
import { MailboxLive } from "../../mailbox/mailbox-live.js";
import { StoreLive } from "../../store/store.js";
import {
  Providers,
  type ProviderAdapter,
  type ProviderPushContext,
} from "../../providers/adapter.js";
import { Secrets } from "../auth.js";
import { Store } from "../../store/service.js";
import type { Account } from "../../domain/account.js";
const settings = {
  preset: "custom",
  username: "me@example.com",
  imapHost: "imap.example.com",
  imapPort: 993,
  smtpHost: "smtp.example.com",
  smtpPort: 465,
  smtpSecure: true,
};
const account: Account = {
  id: "imap:me@example.com",
  provider: "imap",
  email: "me@example.com",
  createdAt: 0,
  lastSyncedAt: null,
  lastSyncError: null,
  profileId: null,
  needsReauth: false,
  imap: settings,
};
const message = {
  to: [{ name: "", address: "bob@example.com" }],
  cc: [],
  bcc: [],
  subject: "test",
  text: "body",
  attachments: [],
};
const previous = { draftId: "7:1:Drafts", messageId: "7:1:Drafts" };
const copyKey = (id: string, destination: string) => JSON.stringify([id, destination]);
function queuedContext(messageIds = new Map<string, string>(), progress = new Set<string>()) {
  let appendedDraftMessageId: string | undefined;
  return {
    messageIds,
    progress,
    beforeCopy: (destination: string, ids: readonly string[]) =>
      Effect.sync(() => {
        for (const id of ids) progress.add(copyKey(id, destination));
      }),
    afterCopy: (destination: string, ids: readonly string[]) =>
      Effect.sync(() => {
        for (const id of ids) progress.add(JSON.stringify([id, destination, "accepted"]));
      }),
    clearCopy: (destination: string, ids: readonly string[]) =>
      Effect.sync(() => {
        for (const id of ids) {
          progress.delete(copyKey(id, destination));
          progress.delete(JSON.stringify([id, destination, "accepted"]));
        }
      }),
    beforeAppendDraft: (messageId: string) =>
      Effect.sync(() => {
        appendedDraftMessageId = messageId;
      }),
    get appendedDraftMessageId() {
      return appendedDraftMessageId;
    },
  } satisfies ProviderPushContext;
}
const noData = () => {
  // The fake SMTP observer is installed when a send starts.
};
function fixture<A, E>(
  work: (
    adapter: ProviderAdapter,
    client: ImapFlow,
    transport: Effect.Success<ReturnType<typeof smtpTransport>>,
    opens: () => number,
    markDataSent: () => void,
  ) => Effect.Effect<A, E>,
  smtpOverride?: typeof smtpTransport,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const client = new ImapFlow({ host: "fake.invalid", port: 993, logger: false });
      client.usable = true;
      vi.spyOn(client, "noop").mockResolvedValue(undefined);
      vi.spyOn(client, "list").mockResolvedValue(
        ["INBOX", "A", "B", "Archive", "Drafts", "Sent"].map((path) => ({
          path,
          pathAsListed: path,
          name: path,
          parent: [],
          parentPath: "",
          delimiter: "/",
          flags: new Set<string>(),
          listed: true,
          subscribed: true,
        })),
      );
      let selected = "INBOX";
      vi.spyOn(client, "mailboxOpen").mockImplementation(async (input) => {
        const path = typeof input === "string" ? input : input.join("/");
        selected = path;
        return {
          path,
          delimiter: "/",
          flags: new Set<string>(),
          permanentFlags: new Set(["\\Seen", "\\Flagged", "\\Deleted"]),
          uidValidity: 7n,
          uidNext: 10,
          exists: 1,
        };
      });
      vi.spyOn(client, "search").mockImplementation(async (query) =>
        query.header ? [] : selected === "INBOX" ? [1] : [],
      );
      vi.spyOn(client, "fetchAll").mockResolvedValue([
        { seq: 1, uid: 1, envelope: { messageId: "<source@example.com>" } },
      ]);
      vi.spyOn(client, "fetchOne").mockResolvedValue({ seq: 1, uid: 1, flags: new Set<string>() });
      vi.spyOn(client, "messageFlagsAdd").mockResolvedValue(true);
      vi.spyOn(client, "messageFlagsRemove").mockResolvedValue(true);
      vi.spyOn(client, "messageCopy").mockResolvedValue({
        path: "INBOX",
        destination: "A",
        uidValidity: 7n,
        uidMap: new Map([[1, 4]]),
      });
      vi.spyOn(client, "append").mockResolvedValue({
        destination: "Drafts",
        uidValidity: 7n,
        uid: 9,
      });
      const transport = createTransport({ host: "fake.invalid", port: 25 });
      vi.spyOn(transport, "sendMail").mockImplementation(() =>
        Promise.resolve({
          envelope: { from: account.email, to: ["bob@example.com"] },
          accepted: ["bob@example.com"],
          rejected: [],
          pending: [],
          response: "250 OK",
          messageId: "<sent@example.com>",
          envelopeTime: 0,
          messageTime: 0,
          messageSize: 100,
        }),
      );
      let opens = 0;
      let markDataSent = noData;
      const adapter = yield* makeImapWith(
        () =>
          Effect.sync(() => {
            opens++;
            return { accountId: account.id, settings, client };
          }),
        smtpOverride ??
          ((_accountId, _settings, _password, onDataSent) =>
            Effect.sync(() => {
              markDataSent = onDataSent ?? noData;
              return transport;
            })),
      );
      return yield* work(
        adapter,
        client,
        transport,
        () => opens,
        () => markDataSent(),
      );
    }),
  ).pipe(
    Effect.provideService(MailCodec, nodeMailCodec),
    Effect.provideService(Secrets, {
      get: () => Effect.succeed(Option.some("password")),
      set: () => Effect.void,
      remove: () => Effect.void,
    }),
  );
}

it.effect("Node flags false stays queued", () =>
  fixture((a, c) =>
    Effect.gen(function* () {
      vi.spyOn(c, "messageFlagsAdd").mockResolvedValue(false);
      const error = yield* Effect.flip(a.push(account, "7:1:INBOX", { kind: "read", value: true }));
      assert.strictEqual(error._tag, "ProviderError");
    }),
  ),
);
it.effect("Node forbidden permanent flag fails permanently", () =>
  fixture((a, c) =>
    Effect.gen(function* () {
      vi.spyOn(c, "mailboxOpen").mockResolvedValue({
        path: "INBOX",
        delimiter: "/",
        flags: new Set<string>(),
        permanentFlags: new Set(["\\Seen"]),
        uidValidity: 7n,
        uidNext: 10,
        exists: 1,
      });
      const error = yield* Effect.flip(a.push(account, "7:1:INBOX", { kind: "star", value: true }));
      assert.strictEqual(error._tag, "PermanentError");
      assert.strictEqual(vi.spyOn(c, "messageFlagsAdd").mock.calls.length, 0);
    }),
  ),
);
it.effect("Node failed draft deletion stays queued", () =>
  fixture((a, c) =>
    Effect.gen(function* () {
      vi.spyOn(c, "messageFlagsAdd").mockResolvedValue(false);
      const error = yield* Effect.flip(a.deleteDraft(account, previous));
      assert.strictEqual(error._tag, "ProviderError");
    }),
  ),
);
it.effect("Node unknown appended draft UID preserves previous copy", () =>
  fixture((a, c) =>
    Effect.gen(function* () {
      vi.spyOn(c, "append").mockResolvedValue({ destination: "Drafts" });
      yield* Effect.flip(
        a.saveDraft(account, {
          creation: draftCreation(),
          message,
          original: Option.none(),
          remote: previous,
          replaceAttachments: true,
        }),
      );
      assert.strictEqual(vi.spyOn(c, "messageFlagsAdd").mock.calls.length, 0);
    }),
  ),
);
it.effect("Node failed previous draft cleanup returns cleanup reference", () =>
  fixture((a, c) =>
    Effect.gen(function* () {
      vi.spyOn(c, "messageFlagsAdd").mockResolvedValue(false);
      const remote = yield* a.saveDraft(account, {
        creation: draftCreation(),
        message,
        original: Option.none(),
        remote: previous,
        replaceAttachments: true,
      });
      assert.ok("cleanupMessageId" in remote && remote.cleanupMessageId === previous.messageId);
      assert.strictEqual(remote.messageId, "7:9:Drafts");
    }),
  ),
);
it.effect("Node copy retry skips completed destination after reconnect", () =>
  fixture((a, c) =>
    Effect.gen(function* () {
      const copied = new Set<string>();
      vi.spyOn(c, "messageCopy").mockImplementation(async (_range, input) => {
        const destination = typeof input === "string" ? input : input.join("/");
        if (destination === "B" && !copied.has("B")) {
          copied.add("B");
          throw new Error("offline");
        }
        copied.add(destination);
        return { path: "INBOX", destination, uidValidity: 7n, uidMap: new Map([[1, 4]]) };
      });
      let path = "INBOX";
      vi.spyOn(c, "mailboxOpen").mockImplementation(async (input) => {
        const p = typeof input === "string" ? input : input.join("/");
        path = p;
        return {
          path: p,
          delimiter: "/",
          flags: new Set<string>(),
          uidValidity: 7n,
          uidNext: 10,
          exists: 1,
        };
      });
      vi.spyOn(c, "search").mockImplementation(async (query) =>
        query.header ? (copied.has(path) && path !== "B" ? [4] : []) : [1],
      );
      const op = { kind: "copy", labelIds: ["A", "B"] } as const;
      const queued = queuedContext();
      yield* Effect.flip(a.push(account, "7:1:INBOX", op, undefined, queued));
      if (a.closeSessions) yield* a.closeSessions(account.id);
      yield* a.push(account, "7:1:INBOX", op, undefined, queued);
      assert.deepStrictEqual(
        vi.spyOn(c, "messageCopy").mock.calls.map((call) => call[1]),
        ["A", "B", "B"],
      );
    }),
  ),
);
it.effect("Node emulated move retries only deletion", () =>
  fixture((a, c) =>
    Effect.gen(function* () {
      vi.spyOn(c, "messageFlagsAdd").mockResolvedValueOnce(false).mockResolvedValue(true);
      let copied = false,
        path = "INBOX";
      vi.spyOn(c, "messageCopy").mockImplementation(async () => {
        copied = true;
        return {
          path: "INBOX",
          destination: "Archive",
          uidValidity: 7n,
          uidMap: new Map([[1, 4]]),
        };
      });
      vi.spyOn(c, "mailboxOpen").mockImplementation(async (input) => {
        const p = typeof input === "string" ? input : input.join("/");
        path = p;
        return {
          path: p,
          delimiter: "/",
          flags: new Set<string>(),
          uidValidity: 7n,
          uidNext: 10,
          exists: 1,
        };
      });
      vi.spyOn(c, "search").mockImplementation(async (query) =>
        query.header ? (copied && path === "Archive" ? [4] : []) : [1],
      );
      const queued = queuedContext();
      yield* Effect.flip(a.push(account, "7:1:INBOX", { kind: "archive" }, undefined, queued));
      yield* a.push(account, "7:1:INBOX", { kind: "archive" }, undefined, queued);
      assert.strictEqual(vi.spyOn(c, "messageCopy").mock.calls.length, 1);
      assert.strictEqual(vi.spyOn(c, "messageFlagsAdd").mock.calls.length, 2);
    }),
  ),
);
it.effect("Node move without COPYUID resolves destination Message-ID", () =>
  fixture((a, c) =>
    Effect.gen(function* () {
      let copied = false;
      vi.spyOn(c, "messageCopy").mockImplementation(async () => {
        copied = true;
        return { path: "INBOX", destination: "Archive" };
      });
      vi.spyOn(c, "search").mockImplementation(async (query) =>
        query.header ? (copied ? [4] : []) : [1],
      );
      const mappings = yield* a.push(account, "7:1:INBOX", { kind: "archive" });
      assert.deepStrictEqual(mappings, [{ from: "7:1:INBOX", to: "7:4:Archive" }]);
    }),
  ),
);
it.effect("Node DATA disconnect confirms Sent without SMTP resend", () =>
  fixture((a, c, t, _opens, markDataSent) =>
    Effect.gen(function* () {
      vi.spyOn(t, "sendMail").mockImplementation(() => {
        markDataSent();
        return Promise.reject({
          code: "ECONNECTION",
          command: "CONN",
          message: "Connection closed unexpectedly",
        });
      });
      vi.spyOn(c, "search").mockResolvedValue([4]);
      yield* a.send(account, message, Option.none());
      assert.strictEqual(vi.spyOn(t, "sendMail").mock.calls.length, 1);
      assert.ok(vi.spyOn(c, "search").mock.calls.some(([query]) => query.header));
    }),
  ),
);
it.effect("Node DATA disconnect without Sent is SendUncertain", () =>
  fixture((a, _c, t, _opens, markDataSent) =>
    Effect.gen(function* () {
      vi.spyOn(t, "sendMail").mockImplementation(() => {
        markDataSent();
        return Promise.reject({
          code: "ETIMEDOUT",
          command: "DATA",
          message: "Timeout",
        });
      });
      const fiber = yield* a
        .send(account, message, Option.none())
        .pipe(Effect.flip, Effect.forkChild);
      for (let step = 0; step < 10; step++) yield* TestClock.adjust("10 seconds");
      const error = yield* Fiber.join(fiber);
      assert.strictEqual(error._tag, "SendUncertain");
      assert.strictEqual(vi.spyOn(t, "sendMail").mock.calls.length, 1);
    }),
  ),
);
it.effect("Node definite DATA 550 is permanent", () =>
  fixture((a, c, t) =>
    Effect.gen(function* () {
      vi.spyOn(t, "sendMail").mockRejectedValue({
        code: "EMESSAGE",
        command: "DATA",
        responseCode: 550,
        message: "Rejected",
      });
      const error = yield* Effect.flip(a.send(account, message, Option.none()));
      assert.strictEqual(error._tag, "PermanentError");
      assert.strictEqual(vi.spyOn(c, "search").mock.calls.length, 0);
    }),
  ),
);
it.effect("Node partial SMTP delivery returns rejected recipients", () =>
  fixture((a, _c, t) =>
    Effect.gen(function* () {
      vi.spyOn(t, "sendMail").mockImplementation(() =>
        Promise.resolve({
          envelope: { from: account.email, to: ["bob@example.com"] },
          accepted: ["bob@example.com"],
          rejected: ["eve@example.com"],
          pending: [],
          response: "250 OK",
          messageId: "id",
          envelopeTime: 0,
          messageTime: 0,
          messageSize: 100,
        }),
      );
      const result = yield* a.send(account, message, Option.none());
      assert.deepStrictEqual(result, { rejected: ["eve@example.com"] });
    }),
  ),
);
it.effect("Node Sent append reconnects once and reports missing copy", () =>
  fixture((a, c, _t, opens) =>
    Effect.gen(function* () {
      vi.spyOn(c, "append").mockResolvedValue(false);
      const result = yield* a.send(account, message, Option.none());
      assert.deepStrictEqual(result, { sentCopyMissing: true });
      assert.strictEqual(vi.spyOn(c, "append").mock.calls.length, 2);
      assert.strictEqual(opens(), 2);
    }),
  ),
);

it.effect("Node flags removal false stays queued", () =>
  fixture((a, c) =>
    Effect.gen(function* () {
      vi.spyOn(c, "messageFlagsRemove").mockResolvedValue(false);
      const error = yield* Effect.flip(
        a.push(account, "7:1:INBOX", { kind: "read", value: false }),
      );
      assert.strictEqual(error._tag, "ProviderError");
    }),
  ),
);
it.effect("Node UIDPLUS draft deletion false stays queued", () =>
  fixture((a, c) =>
    Effect.gen(function* () {
      c.capabilities.set("UIDPLUS", true);
      vi.spyOn(c, "messageDelete").mockResolvedValue(false);
      const error = yield* Effect.flip(a.deleteDraft(account, previous));
      assert.strictEqual(error._tag, "ProviderError");
    }),
  ),
);
it.effect("Node unresolved destination UID holds source even with MOVE", () =>
  fixture((a, c) =>
    Effect.gen(function* () {
      c.capabilities.set("MOVE", true);
      vi.spyOn(c, "messageCopy").mockResolvedValue({ path: "INBOX", destination: "Archive" });
      const move = vi
        .spyOn(c, "messageMove")
        .mockResolvedValue({ path: "INBOX", destination: "Archive" });
      const error = yield* Effect.flip(a.push(account, "7:1:INBOX", { kind: "archive" }));
      assert.strictEqual(error._tag, "ProviderError");
      assert.strictEqual(move.mock.calls.length, 0);
      assert.strictEqual(vi.spyOn(c, "messageFlagsAdd").mock.calls.length, 0);
    }),
  ),
);
it.effect("Node Sent append reconnects once and recovers", () =>
  fixture((a, c, _t, opens) =>
    Effect.gen(function* () {
      vi.spyOn(c, "append")
        .mockResolvedValueOnce(false)
        .mockResolvedValue({ destination: "Sent", uidValidity: 7n, uid: 9 });
      const result = yield* a.send(account, message, Option.none());
      assert.isUndefined(result);
      assert.strictEqual(vi.spyOn(c, "append").mock.calls.length, 2);
      assert.strictEqual(opens(), 2);
    }),
  ),
);

for (const sourceState of ["deleted", "expunged", "folderGone"] as const) {
  it.effect(`Node queued Message-ID resumes a move after source ${sourceState}`, () =>
    fixture((a, c) =>
      Effect.gen(function* () {
        const queued = queuedContext(
          new Map([["7:1:INBOX", "<source@example.com>"]]),
          new Set([
            copyKey("7:1:INBOX", "Archive"),
            copyKey("7:1:INBOX", "A"),
            copyKey("7:1:INBOX", "B"),
          ]),
        );
        vi.spyOn(c, "search").mockImplementation(async (query) =>
          query.header ? [4] : query.deleted === false || sourceState !== "deleted" ? [] : [1],
        );
        if (sourceState === "folderGone") {
          vi.spyOn(c, "mailboxOpen").mockImplementation(async (input) => {
            const path = typeof input === "string" ? input : input.join("/");
            if (path === "INBOX")
              throw Object.assign(new Error("Folder not found"), {
                responseStatus: "NO",
                responseText: "Folder not found",
              });
            return {
              path,
              delimiter: "/",
              flags: new Set<string>(),
              uidValidity: 7n,
              uidNext: 10,
              exists: 1,
            };
          });
        }
        const mappings = yield* a.push(
          account,
          "7:1:INBOX",
          { kind: "archive" },
          undefined,
          queued,
        );
        assert.deepStrictEqual(mappings, [{ from: "7:1:INBOX", to: "7:4:Archive" }]);
        assert.strictEqual(vi.spyOn(c, "messageCopy").mock.calls.length, 0);
        assert.strictEqual(
          vi.spyOn(c, "messageFlagsAdd").mock.calls.length,
          sourceState === "deleted" ? 1 : 0,
        );
      }),
    ),
  );
}
it.effect("Node unresolved copied UID stays queued after source gone", () =>
  fixture((a, c) =>
    Effect.gen(function* () {
      vi.spyOn(c, "search").mockResolvedValue([]);
      const queued = queuedContext(
        new Map([["7:1:INBOX", "<source@example.com>"]]),
        new Set([
          copyKey("7:1:INBOX", "Archive"),
          copyKey("7:1:INBOX", "A"),
          copyKey("7:1:INBOX", "B"),
        ]),
      );
      const error = yield* Effect.flip(
        a.push(account, "7:1:INBOX", { kind: "archive" }, undefined, queued),
      );
      assert.strictEqual(error._tag, "ProviderError");
      assert.strictEqual(vi.spyOn(c, "messageCopy").mock.calls.length, 0);
    }),
  ),
);
it.effect("Node queued Message-ID confirms copy after source gone", () =>
  fixture((a, c) =>
    Effect.gen(function* () {
      vi.spyOn(c, "search").mockImplementation(async (query) => (query.header ? [4] : []));
      const queued = queuedContext(
        new Map([["7:1:INBOX", "<source@example.com>"]]),
        new Set([
          copyKey("7:1:INBOX", "Archive"),
          copyKey("7:1:INBOX", "A"),
          copyKey("7:1:INBOX", "B"),
        ]),
      );
      yield* a.push(
        account,
        "7:1:INBOX",
        { kind: "copy", labelIds: ["A", "B"] },
        undefined,
        queued,
      );
      assert.strictEqual(vi.spyOn(c, "messageCopy").mock.calls.length, 0);
      assert.strictEqual(vi.spyOn(c, "messageFlagsAdd").mock.calls.length, 0);
    }),
  ),
);

it.effect("Node pre-DATA SMTP 535 preserves authentication failure", () =>
  fixture((a, c, t) =>
    Effect.gen(function* () {
      vi.spyOn(t, "sendMail").mockRejectedValue(
        Object.assign(new Error("Invalid credentials"), {
          code: "EAUTH",
          command: "AUTH PLAIN",
          responseCode: 535,
        }),
      );
      const error = yield* Effect.flip(a.send(account, message, Option.none()));
      assert.strictEqual(error._tag, "AuthError");
      assert.strictEqual(vi.spyOn(c, "search").mock.calls.length, 0);
    }),
  ),
);
it.effect("Node after-DATA SMTP 554 remains permanent", () =>
  fixture((a, c, t) =>
    Effect.gen(function* () {
      vi.spyOn(t, "sendMail").mockRejectedValue(
        Object.assign(new Error("Message refused"), {
          code: "EMESSAGE",
          command: "DATA",
          responseCode: 554,
        }),
      );
      const error = yield* Effect.flip(a.send(account, message, Option.none()));
      assert.strictEqual(error._tag, "PermanentError");
      assert.strictEqual(vi.spyOn(c, "search").mock.calls.length, 0);
    }),
  ),
);

for (const op of [{ kind: "copy", labelIds: ["A"] }, { kind: "archive" }] as const) {
  it.effect(`Node mismatched queued Message-ID prevents ${op.kind}`, () =>
    fixture((a, c) =>
      Effect.gen(function* () {
        vi.spyOn(c, "fetchAll").mockResolvedValue([
          { seq: 1, uid: 1, envelope: { messageId: "<replacement@example.com>" } },
        ]);
        const queued = queuedContext(
          new Map([["7:1:INBOX", "<source@example.com>"]]),
          new Set([
            copyKey("7:1:INBOX", "Archive"),
            copyKey("7:1:INBOX", "A"),
            copyKey("7:1:INBOX", "B"),
          ]),
        );
        const error = yield* Effect.flip(a.push(account, "7:1:INBOX", op, undefined, queued));
        assert.strictEqual(error._tag, "PermanentError");
        assert.strictEqual(vi.spyOn(c, "messageCopy").mock.calls.length, 0);
        assert.strictEqual(vi.spyOn(c, "messageFlagsAdd").mock.calls.length, 0);
      }),
    ),
  );
}
it.effect("Node mismatched Deleted source is never deleted again", () =>
  fixture((a, c) =>
    Effect.gen(function* () {
      c.capabilities.set("UIDPLUS", true);
      const removed = vi.spyOn(c, "messageDelete").mockResolvedValue(true);
      vi.spyOn(c, "search").mockImplementation(async (query) =>
        query.header ? [4] : query.deleted === false ? [] : [1],
      );
      vi.spyOn(c, "fetchAll").mockResolvedValue([
        { seq: 1, uid: 1, envelope: { messageId: "<replacement@example.com>" } },
      ]);
      const queued = queuedContext(
        new Map([["7:1:INBOX", "<source@example.com>"]]),
        new Set([
          copyKey("7:1:INBOX", "Archive"),
          copyKey("7:1:INBOX", "A"),
          copyKey("7:1:INBOX", "B"),
        ]),
      );
      const error = yield* Effect.flip(
        a.push(account, "7:1:INBOX", { kind: "archive" }, undefined, queued),
      );
      assert.strictEqual(error._tag, "PermanentError");
      assert.strictEqual(removed.mock.calls.length, 0);
      assert.strictEqual(vi.spyOn(c, "messageCopy").mock.calls.length, 0);
      assert.strictEqual(vi.spyOn(c, "messageFlagsAdd").mock.calls.length, 0);
    }),
  ),
);

it.effect("followup Node externally removed source without copy progress fails permanently", () =>
  fixture((a, c) =>
    Effect.gen(function* () {
      vi.spyOn(c, "search").mockResolvedValue([]);
      const queued = queuedContext(new Map([["7:1:INBOX", "<source@example.com>"]]));
      const error = yield* Effect.flip(
        a.push(account, "7:1:INBOX", { kind: "archive" }, undefined, queued),
      );
      assert.strictEqual(error._tag, "PermanentError");
      assert.strictEqual(vi.spyOn(c, "messageCopy").mock.calls.length, 0);
    }),
  ),
);
it.effect("followup Node pre-existing destination copy still receives fresh COPY", () =>
  fixture((a, c) =>
    Effect.gen(function* () {
      vi.spyOn(c, "search").mockImplementation(async (query) => (query.header ? [4] : [1]));
      const queued = queuedContext();
      yield* a.push(account, "7:1:INBOX", { kind: "archive" }, undefined, queued);
      assert.strictEqual(vi.spyOn(c, "messageCopy").mock.calls.length, 1);
      assert.strictEqual(
        vi.spyOn(c, "search").mock.calls.filter(([query]) => query.header).length,
        0,
      );
      assert.ok(queued.progress.has(copyKey("7:1:INBOX", "Archive")));
    }),
  ),
);
it.effect("followup Node no Message-ID or COPYUID completes move and reconciles", () =>
  fixture((a, c) =>
    Effect.gen(function* () {
      vi.spyOn(c, "fetchAll").mockResolvedValue([{ seq: 1, uid: 1 }]);
      vi.spyOn(c, "messageCopy").mockResolvedValue({ path: "INBOX", destination: "Archive" });
      const expunge = vi.spyOn(c, "messageDelete");
      const result = yield* a.push(
        account,
        "7:1:INBOX",
        { kind: "archive" },
        undefined,
        queuedContext(),
      );
      assert.deepStrictEqual(result, { reconcile: true });
      assert.strictEqual(vi.spyOn(c, "messageCopy").mock.calls.length, 1);
      assert.strictEqual(vi.spyOn(c, "messageFlagsAdd").mock.calls.length, 1);
      assert.strictEqual(expunge.mock.calls.length, 0);
    }),
  ),
);
it.effect("followup Node normalizes queued and envelope Message-ID", () =>
  fixture((a, c) =>
    Effect.gen(function* () {
      vi.spyOn(c, "fetchAll").mockResolvedValue([
        { seq: 1, uid: 1, envelope: { messageId: "  <source@example.com>\r\n " } },
      ]);
      const queued = queuedContext(new Map([["7:1:INBOX", "source@example.com"]]));
      yield* a.push(account, "7:1:INBOX", { kind: "archive" }, undefined, queued);
      assert.strictEqual(vi.spyOn(c, "messageCopy").mock.calls.length, 1);
    }),
  ),
);
it.effect("followup Node SMTP ECONNREFUSED is definite failure", () =>
  fixture((a, c, t) =>
    Effect.gen(function* () {
      vi.spyOn(t, "sendMail").mockRejectedValue(
        Object.assign(new Error("Connection refused"), {
          code: "ESOCKET",
          command: "CONN",
          errno: "ECONNREFUSED",
        }),
      );
      const fiber = yield* a
        .send(account, message, Option.none())
        .pipe(Effect.flip, Effect.forkChild);
      for (let step = 0; step < 10; step++) yield* TestClock.adjust("10 seconds");
      const error = yield* Fiber.join(fiber);
      assert.strictEqual(error._tag, "ProviderError");
      assert.strictEqual(vi.spyOn(c, "search").mock.calls.length, 0);
    }),
  ),
);
it.effect("followup Node draft APPEND retry finds issued copy instead of appending again", () =>
  fixture((a, c) =>
    Effect.gen(function* () {
      const queued = queuedContext();
      let appended = false;
      let source = Buffer.from("");
      vi.spyOn(c, "append").mockImplementation(async (_path, content) => {
        assert.ok(typeof content === "string" || Buffer.isBuffer(content));
        source = Buffer.from(content);
        appended = true;
        throw new Error("APPEND response lost");
      });
      vi.spyOn(c, "fetchOne").mockImplementation(async (_uid, query) => ({
        seq: 9,
        uid: 9,
        flags: new Set<string>(),
        ...(query.source ? { source } : {}),
      }));
      vi.spyOn(c, "search").mockImplementation(async (query) =>
        query.header && appended ? [9] : [],
      );
      const draft = {
        creation: draftCreation(),
        message,
        original: Option.none(),
        remote: previous,
        replaceAttachments: true,
      };
      yield* Effect.flip(a.saveDraft(account, draft, queued));
      const remote = yield* a.saveDraft(account, draft, queued);
      assert.strictEqual(remote.messageId, "7:9:Drafts");
      assert.strictEqual(vi.spyOn(c, "append").mock.calls.length, 1);
      assert.ok(queued.appendedDraftMessageId);
    }),
  ),
);
it.effect("followup Node no Message-ID retry after COPY success only retries deletion", () =>
  fixture((a, c) =>
    Effect.gen(function* () {
      vi.spyOn(c, "fetchAll").mockResolvedValue([{ seq: 1, uid: 1 }]);
      vi.spyOn(c, "messageCopy").mockResolvedValue({ path: "INBOX", destination: "Archive" });
      vi.spyOn(c, "messageFlagsAdd").mockResolvedValueOnce(false).mockResolvedValue(true);
      const queued = queuedContext();
      yield* Effect.flip(a.push(account, "7:1:INBOX", { kind: "archive" }, undefined, queued));
      const result = yield* a.push(account, "7:1:INBOX", { kind: "archive" }, undefined, queued);
      assert.deepStrictEqual(result, { reconcile: true });
      assert.strictEqual(vi.spyOn(c, "messageCopy").mock.calls.length, 1);
      assert.strictEqual(vi.spyOn(c, "messageFlagsAdd").mock.calls.length, 2);
    }),
  ),
);
it.effect("followup Node mixed bulk COPY probes only previously issued source", () =>
  fixture((a, c) =>
    Effect.gen(function* () {
      assert.ok(a.pushBatch);
      vi.spyOn(c, "fetchAll").mockResolvedValue(
        [1, 2].map((uid) => ({ seq: uid, uid, envelope: { messageId: `<m${uid}@example.com>` } })),
      );
      vi.spyOn(c, "search").mockImplementation(async (query) => (query.header ? [4] : [1, 2]));
      vi.spyOn(c, "messageCopy").mockResolvedValue({
        path: "INBOX",
        destination: "Archive",
        uidValidity: 7n,
        uidMap: new Map([[2, 5]]),
      });
      const queued = queuedContext(new Map(), new Set([copyKey("7:1:INBOX", "Archive")]));
      yield* a.pushBatch(
        account,
        ["7:1:INBOX", "7:2:INBOX"],
        { kind: "archive" },
        undefined,
        queued,
      );
      assert.deepStrictEqual(
        vi.spyOn(c, "messageCopy").mock.calls.map(([range]) => range),
        ["2"],
      );
      assert.strictEqual(
        vi.spyOn(c, "search").mock.calls.filter(([query]) => query.header).length,
        1,
      );
      assert.ok(queued.progress.has(copyKey("7:2:INBOX", "Archive")));
    }),
  ),
);

for (const disconnectAfterData of [false, true]) {
  it.effect(
    `followup real Node SMTP disconnect ${disconnectAfterData ? "after terminator" : "before greeting"} uses DATA phase`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const sockets = new Set<Socket>();
          let submissions = 0;
          const server = yield* Effect.acquireRelease(
            Effect.promise(async () => {
              const listener = createServer((socket) => {
                sockets.add(socket);
                socket.on("close", () => sockets.delete(socket));
                socket.on("error", () => {
                  /* Teardown can race the server's deliberate disconnect. */
                });
                if (!disconnectAfterData) {
                  socket.end();
                  return;
                }
                socket.write("220 test SMTP\r\n");
                let incoming = "",
                  body = false;
                socket.on("data", (chunk) => {
                  incoming += chunk.toString("utf8");
                  let end: number;
                  while ((end = incoming.indexOf("\r\n")) >= 0) {
                    const line = incoming.slice(0, end);
                    incoming = incoming.slice(end + 2);
                    if (body) {
                      if (line === ".") {
                        submissions++;
                        socket.end();
                      }
                    } else if (line.startsWith("EHLO")) socket.write("250 localhost\r\n");
                    else if (line === "DATA") {
                      body = true;
                      socket.write("354 Send message\r\n");
                    } else socket.write("250 OK\r\n");
                  }
                });
              });
              await new Promise<void>((resolve) => {
                listener.listen(0, "127.0.0.1", resolve);
              });
              return listener;
            }),
            (listener) =>
              Effect.promise(async () => {
                for (const socket of sockets) socket.destroy();
                await new Promise<void>((resolve) => {
                  listener.close(() => resolve());
                });
              }),
          );
          const address = server.address();
          assert.ok(address && typeof address !== "string");
          const port = address.port;
          yield* fixture(
            (a, c) =>
              Effect.gen(function* () {
                vi.spyOn(c, "search").mockResolvedValue([4]);
                if (disconnectAfterData) yield* a.send(account, message, Option.none());
                else {
                  const error = yield* Effect.flip(a.send(account, message, Option.none()));
                  assert.strictEqual(error._tag, "ProviderError");
                  assert.strictEqual(vi.spyOn(c, "search").mock.calls.length, 0);
                }
                assert.strictEqual(submissions, disconnectAfterData ? 1 : 0);
              }),
            (accountId, smtpSettings, pass, onDataSent) =>
              Effect.gen(function* () {
                const original = yield* smtpTransport(accountId, smtpSettings, pass, onDataSent);
                return yield* Effect.acquireRelease(
                  Effect.sync(() =>
                    createTransport({
                      ...original.options,
                      host: "127.0.0.1",
                      port,
                      secure: false,
                      requireTLS: false,
                      ignoreTLS: true,
                      auth: undefined,
                    }),
                  ),
                  (transport) => Effect.sync(() => transport.close()),
                );
              }),
          );
        }),
      ),
  );
}

it.effect(
  "followup Node accepted identity-free copy resumes after lost Deleted acknowledgment",
  () =>
    fixture((a, c) =>
      Effect.gen(function* () {
        let deleted = false;
        vi.spyOn(c, "fetchAll").mockResolvedValue([{ seq: 1, uid: 1 }]);
        vi.spyOn(c, "messageCopy").mockResolvedValue({ path: "INBOX", destination: "Archive" });
        vi.spyOn(c, "messageFlagsAdd").mockImplementation(async () => {
          if (!deleted) {
            deleted = true;
            throw new Error("Deleted acknowledgment lost");
          }
          return true;
        });
        vi.spyOn(c, "search").mockImplementation(async (query) =>
          query.header || (query.deleted === false && deleted) ? [] : [1],
        );
        const queued = queuedContext();
        yield* Effect.flip(a.push(account, "7:1:INBOX", { kind: "archive" }, undefined, queued));
        const result = yield* a.push(account, "7:1:INBOX", { kind: "archive" }, undefined, queued);
        assert.deepStrictEqual(result, { reconcile: true });
        assert.strictEqual(vi.spyOn(c, "messageCopy").mock.calls.length, 1);
        assert.strictEqual(vi.spyOn(c, "messageFlagsAdd").mock.calls.length, 2);
      }),
    ),
);
it.effect("followup Node explicit COPY NO clears issued progress", () =>
  fixture((a, c) =>
    Effect.gen(function* () {
      vi.spyOn(c, "messageCopy").mockRejectedValue(
        Object.assign(new Error("Permission denied"), { responseStatus: "NO" }),
      );
      const queued = queuedContext();
      yield* Effect.flip(a.push(account, "7:1:INBOX", { kind: "archive" }, undefined, queued));
      assert.isFalse(queued.progress.has(copyKey("7:1:INBOX", "Archive")));
    }),
  ),
);
it.effect("followup Node ambiguous COPY false preserves issued progress", () =>
  fixture((a, c) =>
    Effect.gen(function* () {
      vi.spyOn(c, "messageCopy").mockResolvedValue(false);
      const queued = queuedContext();
      yield* Effect.flip(a.push(account, "7:1:INBOX", { kind: "archive" }, undefined, queued));
      assert.ok(queued.progress.has(copyKey("7:1:INBOX", "Archive")));
    }),
  ),
);
it.effect("followup Node observed COPY NO clears progress even if socket then closes", () =>
  fixture((a, c) =>
    Effect.gen(function* () {
      vi.spyOn(c, "messageCopy").mockImplementation(async () => {
        c.emit("response", { response: "NO" });
        c.usable = false;
        return false;
      });
      const queued = queuedContext();
      yield* Effect.flip(a.push(account, "7:1:INBOX", { kind: "archive" }, undefined, queued));
      assert.isFalse(queued.progress.has(copyKey("7:1:INBOX", "Archive")));
    }),
  ),
);
it.effect(
  "followup Node COPY authentication refusal preserves AuthError while clearing progress",
  () =>
    fixture((a, c) =>
      Effect.gen(function* () {
        vi.spyOn(c, "messageCopy").mockRejectedValue(
          Object.assign(new Error("Authentication expired"), {
            responseStatus: "NO",
            authenticationFailed: true,
          }),
        );
        const queued = queuedContext();
        const error = yield* Effect.flip(
          a.push(account, "7:1:INBOX", { kind: "archive" }, undefined, queued),
        );
        assert.strictEqual(error._tag, "AuthError");
        assert.isFalse(queued.progress.has(copyKey("7:1:INBOX", "Archive")));
      }),
    ),
);

for (const previousId of ["7:9:Drafts", "7:009:Drafts", "007:009:Drafts"]) {
  it.effect(`coordinator recovered draft ${previousId} keeps its own copy`, () =>
    fixture((a, c) =>
      Effect.gen(function* () {
        const raw = yield* buildMime(
          { name: "", address: account.email },
          message,
          {},
          { draft: true, messageId: "<draft@example.com>" },
        );
        vi.spyOn(c, "search").mockResolvedValue([9]);
        vi.spyOn(c, "fetchOne").mockResolvedValue({
          seq: 9,
          uid: 9,
          source: raw,
          flags: new Set(["\\Draft", "\\Seen"]),
        });
        const queued = queuedContext();
        yield* queued.beforeAppendDraft("<draft@example.com>");
        const remote = yield* a.saveDraft(
          account,
          {
            creation: draftCreation(),
            message,
            original: Option.none(),
            remote: { draftId: previousId, messageId: previousId },
            replaceAttachments: true,
          },
          queued,
        );
        assert.strictEqual(remote.messageId, "7:9:Drafts");
        assert.strictEqual(vi.spyOn(c, "messageFlagsAdd").mock.calls.length, 0);
        assert.strictEqual(vi.spyOn(c, "append").mock.calls.length, 0);
      }),
    ),
  );
}
it.effect("coordinator RFC cleanup deletes matching Drafts copies without creating folders", () =>
  fixture((a, c) =>
    Effect.gen(function* () {
      vi.spyOn(c, "search").mockResolvedValue([9, 10]);
      const create = vi.spyOn(c, "mailboxCreate");
      yield* a.deleteDraft(account, {
        draftId: null,
        messageId: null,
        rfcMessageId: "<draft@example.com>",
      });
      assert.deepStrictEqual(
        vi.spyOn(c, "messageFlagsAdd").mock.calls.map(([uid]) => uid),
        ["9", "10"],
      );
      assert.strictEqual(create.mock.calls.length, 0);
    }),
  ),
);
it.effect("coordinator RFC cleanup missing Drafts does not create it", () =>
  fixture((a, c) =>
    Effect.gen(function* () {
      vi.spyOn(c, "list").mockResolvedValue([]);
      const create = vi.spyOn(c, "mailboxCreate");
      yield* a.deleteDraft(account, {
        draftId: null,
        messageId: null,
        rfcMessageId: "<draft@example.com>",
      });
      assert.strictEqual(vi.spyOn(c, "search").mock.calls.length, 0);
      assert.strictEqual(create.mock.calls.length, 0);
    }),
  ),
);
it.effect(
  "coordinator real Mailbox updates edited content after lost APPEND with one cloud draft",
  () =>
    fixture((a, c) => {
      const cloud = new Map<number, Buffer>();
      let nextUid = 9,
        lost = false;
      c.capabilities.set("UIDPLUS", true);
      vi.spyOn(c, "append").mockImplementation(async (_folder, content) => {
        assert.ok(typeof content === "string" || Buffer.isBuffer(content));
        const uid = nextUid++;
        cloud.set(uid, Buffer.from(content));
        if (!lost) {
          lost = true;
          throw new Error("APPEND acknowledgment lost");
        }
        return { destination: "Drafts", uidValidity: 7n, uid };
      });
      vi.spyOn(c, "search").mockImplementation(async (query) => {
        const wanted = query.header?.["message-id"];
        return [...cloud]
          .filter(([_uid, raw]) => !wanted || parseHeaders(raw).get("message-id") === wanted)
          .map(([uid]) => uid);
      });
      vi.spyOn(c, "fetchOne").mockImplementation(async (range, query) => {
        const uid = Number(range);
        const source = cloud.get(uid);
        return source
          ? {
              seq: uid,
              uid,
              flags: new Set(["\\Draft", "\\Seen"]),
              ...(query.source ? { source } : {}),
            }
          : false;
      });
      vi.spyOn(c, "messageDelete").mockImplementation(async (range) => {
        assert.ok(typeof range === "string");
        for (const uid of parseUidSet(range)) cloud.delete(uid);
        return true;
      });
      const provider = { ...a, pull: () => Stream.empty };
      return Effect.gen(function* () {
        const store = yield* Store;
        const mailbox = yield* Mailbox;
        const savedAccount = yield* store.upsertAccount("imap", account.email);
        yield* store.setImapSettings(savedAccount.id, settings);
        yield* mailbox.compose.saveDraft({ id: "lost-draft", accountId: savedAccount.id, message });
        const pending = yield* store.listPendingOps;
        assert.ok(pending[0]?.appendedMessageId);
        yield* mailbox.compose.saveDraft({
          id: "lost-draft",
          accountId: savedAccount.id,
          message: { ...message, text: "latest edited body" },
        });
        yield* TestClock.adjust("2 minutes");
        yield* mailbox.sync.sync();
        assert.strictEqual(cloud.size, 1);
        const content = [...cloud.values()][0];
        assert.ok(content);
        assert.strictEqual(
          (yield* Effect.promise(() => nodeMailCodec.parse(content))).text?.trim(),
          "latest edited body",
        );
        assert.strictEqual((yield* store.listPendingOps).length, 0);
      }).pipe(
        Effect.provide(
          MailboxLive({ backgroundFlush: false }).pipe(
            Layer.provideMerge(
              Layer.mergeAll(StoreLive, Layer.succeed(Providers, { get: () => provider })).pipe(
                Layer.provideMerge(MemoryPlatform()),
              ),
            ),
          ),
        ),
      );
    }),
);
it.effect("coordinator canonical UIDVALIDITY still cleans a different previous UID", () =>
  fixture((a, c) =>
    Effect.gen(function* () {
      const raw = yield* buildMime(
        { name: "", address: account.email },
        message,
        {},
        { draft: true, messageId: "<draft@example.com>" },
      );
      vi.spyOn(c, "search").mockResolvedValue([9]);
      vi.spyOn(c, "fetchOne").mockResolvedValue({
        seq: 9,
        uid: 9,
        source: raw,
        flags: new Set(["\\Draft", "\\Seen"]),
      });
      const queued = queuedContext();
      yield* queued.beforeAppendDraft("<draft@example.com>");
      yield* a.saveDraft(
        account,
        {
          creation: draftCreation(),
          message,
          original: Option.none(),
          remote: { draftId: "007:008:Drafts", messageId: "007:008:Drafts" },
          replaceAttachments: true,
        },
        queued,
      );
      assert.deepStrictEqual(
        vi.spyOn(c, "messageFlagsAdd").mock.calls.map(([uid]) => uid),
        ["8"],
      );
    }),
  ),
);
it.effect("coordinator matching UID numbers in case-distinct folders stay distinct", () =>
  fixture((a, c) =>
    Effect.gen(function* () {
      const raw = yield* buildMime(
        { name: "", address: account.email },
        message,
        {},
        { draft: true, messageId: "<draft@example.com>" },
      );
      vi.spyOn(c, "search").mockResolvedValue([9]);
      vi.spyOn(c, "fetchOne").mockResolvedValue({
        seq: 9,
        uid: 9,
        source: raw,
        flags: new Set(["\\Draft", "\\Seen"]),
      });
      const queued = queuedContext();
      yield* queued.beforeAppendDraft("<draft@example.com>");
      yield* a.saveDraft(
        account,
        {
          creation: draftCreation(),
          message,
          original: Option.none(),
          remote: { draftId: "7:9:drafts", messageId: "7:9:drafts" },
          replaceAttachments: true,
        },
        queued,
      );
      assert.strictEqual(vi.spyOn(c, "messageFlagsAdd").mock.calls.length, 1);
      assert.ok(vi.spyOn(c, "mailboxOpen").mock.calls.some(([path]) => path === "drafts"));
    }),
  ),
);

for (const operation of ["move", "copy"] as const) {
  for (const offline of [false, true]) {
    it.effect(
      `MailboxLive Node identity changed before ${operation}, reconciliation ${offline ? "offline" : "online"}`,
      () =>
        fixture((adapter, client) => {
          const remote = incoming("7:1:INBOX", {
            rfcMessageId: "<source@example.com>",
            bodyText: "replacement body",
          });
          const server = fakeServer(account.email, [remote]);
          const fake = makeFakeProvider(server);
          let reconciliationOffline = offline;
          const provider: ProviderAdapter = {
            ...fake,
            push: (...args) => adapter.push(...args),
            pull: () => Stream.empty,
            fetchMessage: (owner, id) =>
              reconciliationOffline
                ? Effect.fail(new ProviderError({ message: "offline" }))
                : fake.fetchMessage(owner, id),
          };
          return Effect.gen(function* () {
            const store = yield* Store;
            const mailbox = yield* Mailbox;
            const saved = yield* store.upsertAccount("imap", account.email);
            yield* store.setImapSettings(saved.id, settings);
            const old = incoming("7:1:INBOX", {
              rfcMessageId: "<original@example.com>",
              bodyText: "cached original body",
            });
            yield* store.upsertMessage(saved.id, old);
            yield* store.upsertMessage(
              saved.id,
              incoming("7:2:INBOX", { bodyText: "unrelated body" }),
            );
            yield* store.putDraft({ id: "local-draft", accountId: saved.id, message });
            yield* mailbox.organize.perform(
              {
                kind: "modify",
                threads: [`${saved.id}/7:1:INBOX`],
                op:
                  operation === "move"
                    ? { kind: "move", labelId: "A", removeLabelId: "INBOX" }
                    : { kind: "copy", labelIds: ["A"] },
              },
              { kind: "user", surface: "app" },
            );
            const failures = yield* mailbox.proposals.listFailedOps;
            assert.strictEqual(failures.length, 1);
            assert.strictEqual(
              failures[0]?.reason,
              "Message identity changed; sync before changing this message.",
            );
            assert.strictEqual(failures[0]?.kind, operation);
            const cached = yield* store.getMessage(`${saved.id}/7:1:INBOX`);
            assert.strictEqual(cached.bodyText, offline ? old.bodyText : remote.bodyText);
            if (!offline) assert.deepStrictEqual(cached.labels, remote.labels);
            assert.strictEqual(
              (yield* store.getMessage(`${saved.id}/7:2:INBOX`)).bodyText,
              "unrelated body",
            );
            assert.isTrue(Option.isSome(yield* store.getDraft("local-draft")));
            assert.deepStrictEqual(server.messages.get(remote.providerId), remote);
            assert.strictEqual(vi.spyOn(client, "messageCopy").mock.calls.length, 0);
            assert.strictEqual(vi.spyOn(client, "messageFlagsAdd").mock.calls.length, 0);
            const pending = yield* store.listPendingOps;
            assert.deepStrictEqual(
              pending.map((item) => item.op.kind),
              offline ? ["reconcile"] : [],
            );
            if (offline) {
              reconciliationOffline = false;
              yield* TestClock.adjust("2 minutes");
              yield* mailbox.sync.sync(saved.id);
              assert.deepStrictEqual(yield* store.listPendingOps, []);
              assert.strictEqual(
                (yield* store.getMessage(`${saved.id}/7:1:INBOX`)).bodyText,
                remote.bodyText,
              );
              assert.strictEqual(vi.spyOn(client, "messageCopy").mock.calls.length, 0);
            }
            yield* mailbox.proposals.acknowledgeFailedOps(failures.map((item) => item.id));
            assert.deepStrictEqual(yield* mailbox.proposals.listFailedOps, []);
          }).pipe(
            Effect.provide(
              MailboxLive({ backgroundFlush: false, imapIdle: false }).pipe(
                Layer.provideMerge(
                  Layer.mergeAll(StoreLive, Layer.succeed(Providers, { get: () => provider })).pipe(
                    Layer.provideMerge(MemoryPlatform()),
                  ),
                ),
              ),
            ),
          );
        }),
    );
  }
}
