import { assert, it } from "@effect/vitest";
import { Effect, Option, Stream } from "effect";
import { vi } from "vitest";
import { ImapFlow } from "imapflow";
import { createTransport } from "nodemailer";
import { MailCodec } from "../mail-codec.js";
import { nodeMailCodec } from "./mail-codec.js";
import { makeImapWith } from "./imap/adapter.js";
import { incoming as makeIncoming, TestMailbox } from "./testing.js";
import { smtpTransport } from "./imap/session.js";
import { Mailbox } from "../../mailbox/mailbox.js";
import { type ProviderAdapter, type Change } from "../../providers/adapter.js";
import { Secrets } from "../auth.js";
import { Store } from "../../store/service.js";
import type { Account } from "../../domain/account.js";
import { ProviderError } from "../../domain/errors.js";
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

// Server rebuilt INBOX: UIDVALIDITY 7 -> 8; the message formerly 7:1 is now 8:5.
const rebuilt = (c: ImapFlow) =>
  vi.spyOn(c, "mailboxOpen").mockImplementation(async (input) => ({
    path: typeof input === "string" ? input : input.join("/"),
    delimiter: "/",
    flags: new Set<string>(),
    permanentFlags: new Set(["\\Seen", "\\Flagged", "\\Deleted"]),
    uidValidity: 8n,
    uidNext: 10,
    exists: 1,
  }));
const msg = (providerId: string) =>
  makeIncoming(providerId, {
    rfcMessageId: "<m@x>",
    threadId: "<m@x>",
    subject: "s",
    to: [],
    date: 100,
    bodyText: "b",
    labels: ["INBOX"],
  });
const secrets = {
  get: () => Effect.succeed(Option.some("password")),
  set: () => Effect.void,
  remove: () => Effect.void,
};
const withSettings = (acc: Account) => ({ ...account, ...acc, imap: settings }) as Account;
const isAccount = (value: unknown): value is Account =>
  typeof value === "object" && value !== null && "provider" in value && "email" in value;
/** The real IMAP adapter with the test settings and password, and a scripted pull. */
const scripted = (real: ProviderAdapter, changes: readonly Change[]): ProviderAdapter =>
  new Proxy(real, {
    get(target, key, receiver) {
      if (key === "pull") return () => Stream.fromIterable(changes);
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const out: unknown = Reflect.apply(
          value,
          target,
          args.map((arg) => (isAccount(arg) ? withSettings(arg) : arg)),
        );
        return Effect.isEffect(out) ? out.pipe(Effect.provideService(Secrets, secrets)) : out;
      };
    },
  });
const star = { kind: "star", value: true } as const;
const user = { kind: "user", surface: "app" } as const;
const testLayer = (adapter: ProviderAdapter) =>
  TestMailbox.withAdapter(adapter, { options: { backgroundFlush: false }, platformOptions: {} });

it.effect("UIDVALIDITY change: the real adapter defers a stale id instead of failing it", () =>
  fixture((real, c) =>
    Effect.gen(function* () {
      rebuilt(c);
      const push = yield* Effect.flip(
        real.push(account, "7:1:INBOX", star).pipe(Effect.provideService(Secrets, secrets)),
      );
      const fetch = yield* Effect.flip(
        real.fetchMessage(account, "7:1:INBOX").pipe(Effect.provideService(Secrets, secrets)),
      );
      assert.strictEqual(push._tag, "ProviderError");
      assert.strictEqual(fetch._tag, "ProviderError");
    }),
  ),
);

for (const order of ["user acts before the next pull", "pull runs first"] as const)
  it.effect(`UIDVALIDITY change: star survives when ${order}`, () =>
    fixture((real, c) =>
      Effect.gen(function* () {
        rebuilt(c);
        const pushed: string[] = [];
        const base = scripted(real, [
          {
            _tag: "Remap",
            previous: { path: "INBOX", uidValidity: "7" },
            message: msg("8:5:INBOX"),
          },
          {
            _tag: "RebuildFolder",
            previous: { path: "INBOX", uidValidity: "7" },
            keep: ["8:5:INBOX"],
            partial: true,
          },
          { _tag: "Cursor", cursor: JSON.stringify({ folders: {} }) },
        ]);
        const adapter: ProviderAdapter = {
          ...base,
          push: (acc, id, op, cursor, ctx) =>
            id === "7:1:INBOX"
              ? base.push(acc, id, op, cursor, ctx)
              : Effect.sync(() => {
                  pushed.push(`${id} ${op.kind}`);
                }),
          fetchMessage: (acc, id) =>
            id === "7:1:INBOX" ? base.fetchMessage(acc, id) : Effect.succeed(msg(id)),
        };
        return yield* Effect.gen(function* () {
          const store = yield* Store;
          const mailbox = yield* Mailbox;
          const acc = yield* store.upsertAccount("imap", "me@example.com");
          yield* store.upsertMessage(acc.id, msg("7:1:INBOX"));
          const local = `${acc.id}/7:1:INBOX`;
          if (order === "pull runs first") yield* mailbox.sync.sync();
          yield* mailbox.organize.perform({ kind: "modify", threads: [local], op: star }, user);
          if (order === "user acts before the next pull") yield* mailbox.sync.sync();
          const id = yield* store.messageIdForProvider(acc.id, "8:5:INBOX");
          assert.ok(id, "the message is remapped to its new UID");
          assert.strictEqual((yield* store.getMessage(id)).isStarred, true);
          assert.deepStrictEqual(pushed, ["8:5:INBOX star"]);
          assert.deepStrictEqual(yield* mailbox.proposals.listFailedOps, []);
        }).pipe(Effect.provide(testLayer(adapter)));
      }),
    ),
  );

const now = 200 * 86_400_000;
// The real pull for a rebuilt folder remaps only UIDs in the 90-day window.
const outsideWindow: Change[] = [
  {
    _tag: "RebuildFolder",
    previous: { path: "INBOX", uidValidity: "7" },
    keep: [],
    since: now - 90 * 86_400_000,
    partial: true,
  },
  { _tag: "Cursor", cursor: JSON.stringify({ folders: {} }) },
];

it.effect("UIDVALIDITY change: old mail outside the rebuild window stays cached", () =>
  fixture((real, c) =>
    Effect.gen(function* () {
      rebuilt(c);
      return yield* Effect.gen(function* () {
        const store = yield* Store;
        const mailbox = yield* Mailbox;
        const acc = yield* store.upsertAccount("imap", "me@example.com");
        yield* store.upsertMessage(acc.id, msg("7:1:INBOX")); // date 100: older than the window
        const local = `${acc.id}/7:1:INBOX`;
        yield* mailbox.sync.sync();
        yield* mailbox.organize.perform({ kind: "modify", threads: [local], op: star }, user);
        yield* mailbox.sync.sync();
        assert.isTrue(
          Option.isSome(yield* store.getMessage(local).pipe(Effect.option)),
          "a message still on the server must not vanish from the cache",
        );
        assert.deepStrictEqual(yield* mailbox.proposals.listFailedOps, []);
        assert.deepStrictEqual(
          (yield* store.listPendingOps).map((p) => p.op.kind),
          ["star"],
          "the star waits for the message to be found",
        );
      }).pipe(Effect.provide(testLayer(scripted(real, outsideWindow))));
    }),
  ),
);

it.effect("UIDVALIDITY change: old mail found by Message-ID is remapped and the star lands", () =>
  fixture((real, c) =>
    Effect.gen(function* () {
      rebuilt(c);
      vi.spyOn(c, "search").mockImplementation(async (query) =>
        query.header?.["message-id"] === "<m@x>" || query.uid === "5" ? [5] : [],
      );
      const flagged = vi.spyOn(c, "messageFlagsAdd").mockResolvedValue(true);
      return yield* Effect.gen(function* () {
        const store = yield* Store;
        const mailbox = yield* Mailbox;
        const acc = yield* store.upsertAccount("imap", "me@example.com");
        yield* store.upsertMessage(acc.id, msg("7:1:INBOX"));
        const local = `${acc.id}/7:1:INBOX`;
        yield* mailbox.sync.sync();
        yield* mailbox.organize.perform({ kind: "modify", threads: [local], op: star }, user);
        assert.strictEqual((yield* store.messageRef(local)).providerId, "8:5:INBOX");
        yield* mailbox.sync.sync();
        assert.deepStrictEqual(
          flagged.mock.calls.map(([range, flags]) => [range, flags]),
          [["5", ["\\Flagged"]]],
        );
        assert.deepStrictEqual(yield* store.listPendingOps, []);
        assert.strictEqual((yield* store.getMessage(local)).isStarred, true);
      }).pipe(Effect.provide(testLayer(scripted(real, outsideWindow))));
    }),
  ),
);

it.effect("UIDVALIDITY change: a remapped op stays ahead of later ops on the same message", () =>
  fixture((real) =>
    Effect.gen(function* () {
      const pushed: string[] = [];
      const base = scripted(real, [{ _tag: "Cursor", cursor: JSON.stringify({ folders: {} }) }]);
      const adapter: ProviderAdapter = {
        ...base,
        pushBatch: undefined,
        push: (_acc, id, op) =>
          id === "7:1:INBOX"
            ? Effect.fail(
                new ProviderError({
                  message: "rebuilt",
                  deferred: true,
                  remap: [{ from: "7:1:INBOX", to: "8:5:INBOX" }],
                }),
              )
            : Effect.sync(() => {
                pushed.push(`${id} ${JSON.stringify(op)}`);
              }),
        fetchMessage: (_acc, id) => Effect.succeed(msg(id)),
      };
      return yield* Effect.gen(function* () {
        const store = yield* Store;
        const mailbox = yield* Mailbox;
        const acc = yield* store.upsertAccount("imap", "me@example.com");
        yield* store.upsertMessage(acc.id, msg("7:1:INBOX"));
        yield* store.saveSyncCursor(acc.id, JSON.stringify({ folders: {} }), false);
        yield* store.enqueueOp(acc.id, "7:1:INBOX", star);
        yield* store.enqueueOp(acc.id, "7:1:INBOX", { kind: "star", value: false });
        yield* mailbox.sync.sync();
        yield* mailbox.sync.sync();
        assert.deepStrictEqual(pushed, [
          '8:5:INBOX {"kind":"star","value":true}',
          '8:5:INBOX {"kind":"star","value":false}',
        ]);
      }).pipe(Effect.provide(testLayer(adapter)));
    }),
  ),
);
