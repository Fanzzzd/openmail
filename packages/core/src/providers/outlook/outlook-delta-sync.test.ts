import { graphPageLink } from "./graph-pagination.js";
import { assert, it } from "@effect/vitest";
import { fakeHttp } from "../../platform/node/fake-http.js";
import { Clock, Effect, Layer, Logger, Option, Schema, Stream } from "effect";
import { HttpClientRequest } from "effect/http";
import { MailboxLive } from "../../mailbox/mailbox-live.js";
import { Mailbox } from "../../mailbox/mailbox.js";
import { makeOutlook } from "./outlook.js";
import { parseGraphMessage } from "./parse.js";
import { MemoryPlatform } from "../../platform/node/platform-memory.js";
import { Providers, type Change } from "../adapter.js";
import { Store } from "../../store/service.js";
import { StoreLive } from "../../store/store.js";
import {
  GRAPH,
  account,
  platformOptions,
  run,
  raw,
  WELL_KNOWN,
  mailbox,
  tags,
} from "../../../test-support/outlook-fixtures.js";
it.effect("fetching a message explicitly selects and retains the provider webLink", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      ...mailbox({}),
      [`GET /me/messages/${raw.id}`]: {
        json: { ...raw, parentFolderId: "id-inbox", hasAttachments: false },
      },
    });
    const message = yield* run(http, (adapter) => adapter.fetchMessage(account, raw.id));
    assert.strictEqual(message.webLink, raw.webLink);
    const request = http.calls.find((call) => call.url.pathname.endsWith(`/messages/${raw.id}`));
    assert.ok(request?.url.searchParams.get("$select")?.split(",").includes("webLink"));
  }),
);

it.effect("a cursor without the immutable-id marker resets, then syncs every folder", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      ...mailbox({
        inbox: (url) =>
          url.searchParams.has("$skiptoken")
            ? {
                json: {
                  value: [{ id: "gone", "@removed": { reason: "deleted" } }],
                  "@odata.deltaLink": `${GRAPH}/me/mailFolders/inbox/messages/delta?$deltatoken=in1`,
                },
              }
            : {
                json: {
                  value: [raw],
                  "@odata.nextLink": `${GRAPH}/me/mailFolders/inbox/messages/delta?$skiptoken=2`,
                },
              },
      }),
      "GET /me/messages/AAMk123/attachments": {
        json: {
          value: [
            { name: "quote.pdf", contentType: "application/pdf", size: 100, isInline: false },
            { name: "logo.png", contentType: "image/png", size: 5, isInline: true },
          ],
        },
      },
    });
    const changes = yield* run(http, (a) =>
      Stream.runCollect(a.pull(account, Option.some(JSON.stringify({ inbox: "old-link" })))),
    );
    assert.deepStrictEqual(tags(changes), ["Labels", "Upsert", "Progress", "Reset", "Cursor"]);
    assert.deepStrictEqual(changes[0], {
      _tag: "Labels",
      labels: [
        { id: "id-c1", name: "Clients", color: null },
        { id: "id-c2", name: "Clients/Acme", color: null },
        { id: "id-empty", name: "Empty", color: null },
      ],
    });
    const upsert = changes[1];
    assert.ok(upsert?._tag === "Upsert");
    assert.deepStrictEqual(upsert.message.labels.toSorted(), ["INBOX", "STARRED", "UNREAD"]);
    assert.deepStrictEqual(upsert.message.attachments, [
      { filename: "quote.pdf", mimeType: "application/pdf", size: 100 },
    ]);
    assert.deepStrictEqual(changes[3], {
      _tag: "Reset",
      keep: ["AAMk123"],
      since: (yield* Clock.currentTimeMillis) - 90 * 86400000,
      partial: true,
    });

    const cursor = changes[4];
    assert.ok(cursor?._tag === "Cursor");
    const next = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
    )(cursor.cursor);
    assert.strictEqual(next["__idType"], "immutable");
    assert.strictEqual(
      next["inbox"],
      `${GRAPH}/me/mailFolders/inbox/messages/delta?$deltatoken=in1`,
    );
    // No Archive folder in this mailbox, so no delta link for it.
    assert.strictEqual(next["archive"], undefined);
    assert.deepStrictEqual(
      Object.keys(next).toSorted(),
      ["__idType", "__windowDays", ...WELL_KNOWN, "id-c1", "id-c2"].toSorted(),
    );
    // The stale link was not followed after the reset.
    assert.ok(!http.calls.some((c) => c.url.href.includes("old-link")));
    assert.ok(
      http.calls.every(
        (c) =>
          c.prefer ===
          (c.url.pathname.endsWith("/messages/delta")
            ? 'IdType="ImmutableId", odata.maxpagesize=50'
            : 'IdType="ImmutableId"'),
      ),
    );
    for (const call of http.calls.filter((c) => c.url.pathname.endsWith("/messages/delta")))
      assert.ok(!(call.url.searchParams.get("$select") ?? "").includes("internetMessageHeaders"));
  }),
);

it.effect("a delta entry without the selected fields is fetched whole", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      ...mailbox({
        inbox: {
          json: {
            value: [
              { id: "AAMk123", isRead: true },
              { id: "vanished", isRead: true },
            ],
            "@odata.deltaLink": `${GRAPH}/me/mailFolders/inbox/messages/delta?$deltatoken=in2`,
          },
        },
      }),
      "GET /me/messages/AAMk123": { json: { ...raw, isRead: true, hasAttachments: false } },
      "GET /me/messages/vanished": { status: 404, json: { error: { code: "ErrorItemNotFound" } } },
    });
    const cursor = JSON.stringify({
      __idType: "immutable",
      inbox: `${GRAPH}/me/mailFolders/inbox/messages/delta?$deltatoken=in1`,
    });
    const changes = yield* run(http, (a) =>
      Stream.runCollect(a.pull(account, Option.some(cursor))),
    );
    const upserts = changes.filter((c) => c._tag === "Upsert");
    assert.strictEqual(upserts.length, 1);
    assert.ok(upserts[0]?._tag === "Upsert");
    assert.strictEqual(upserts[0].message.threadId, raw.conversationId);
    assert.ok(!upserts[0].message.labels.includes("UNREAD"));
  }),
);

it.effect("a failed first delta page or restart never clears cached mail", () =>
  Effect.gen(function* () {
    for (const restart of [false, true]) {
      const http = fakeHttp(
        mailbox({
          inbox: (url) => ({
            status: restart && url.searchParams.has("$deltatoken") ? 410 : 400,
            json: { error: { code: "BadRequest" } },
          }),
        }),
      );
      const changes: Change[] = [];
      const cursor = restart
        ? Option.some(
            JSON.stringify({
              __idType: "immutable",
              inbox: `${GRAPH}/me/mailFolders/inbox/messages/delta?$deltatoken=expired`,
            }),
          )
        : Option.none<string>();
      const result = yield* run(http, (adapter) =>
        adapter.pull(account, cursor, "inbox").pipe(
          Stream.runForEach((change) =>
            Effect.sync(() => {
              changes.push(change);
            }),
          ),
          Effect.result,
        ),
      );
      assert.strictEqual(result._tag, "Failure");
      assert.deepStrictEqual(changes, []);
    }
  }),
);

it.effect(
  "a later delta-page failure preserves cached mail during resets and folder restarts",
  () =>
    Effect.gen(function* () {
      for (const restart of [false, true]) {
        const http = fakeHttp(
          mailbox({
            inbox: (url) => {
              if (restart && url.searchParams.has("$deltatoken")) return { status: 410 };
              if (url.searchParams.has("$skiptoken")) return { status: 400 };
              return {
                json: {
                  value: Array.from({ length: 120 }, (_, i) => ({
                    ...raw,
                    id: `fresh-${i}`,
                    hasAttachments: false,
                  })),
                  "@odata.nextLink": `${GRAPH}/me/mailFolders/inbox/messages/delta?$skiptoken=next`,
                },
              };
            },
          }),
        );
        const adapters = Layer.effect(
          Providers,
          Effect.map(makeOutlook, (adapter) => Providers.of({ get: () => adapter })),
        );
        const layer = MailboxLive({ backgroundFlush: false }).pipe(
          Layer.provideMerge(Layer.mergeAll(StoreLive, adapters)),
          Layer.provide(Layer.mergeAll(MemoryPlatform(platformOptions), http.layer)),
        );
        yield* Effect.gen(function* () {
          const store = yield* Store;
          const mailbox = yield* Mailbox;
          yield* store.upsertAccount("outlook", account.email);
          yield* store.upsertMessage(
            account.id,
            parseGraphMessage({ ...raw, id: "cached", hasAttachments: false }, "INBOX", []),
          );
          if (restart)
            yield* store.saveSyncCursor(
              account.id,
              JSON.stringify({
                __idType: "immutable",
                inbox: `${GRAPH}/me/mailFolders/inbox/messages/delta?$deltatoken=expired`,
              }),
            );
          const result = yield* mailbox.sync.sync(account.id);
          assert.ok(result[0]?.error);
          assert.strictEqual(yield* store.hasMessage(`${account.id}/cached`), true);
        }).pipe(Effect.provide(layer), Effect.scoped);
      }
    }),
);

it.effect("delta sync delivers a page before fetching the whole history and checkpoints last", () =>
  Effect.gen(function* () {
    let delivered = 0;
    let nextPageAt = -1;
    const http = fakeHttp(
      mailbox({
        inbox: (url) => {
          const page = Number(url.searchParams.get("page") ?? 0);
          if (page === 1) nextPageAt = delivered;
          return {
            json: {
              value: Array.from({ length: 40 }, (_, i) => ({
                ...raw,
                id: `page-${page}-${i}`,
                hasAttachments: false,
              })),
              ...(page < 4
                ? {
                    "@odata.nextLink": `${GRAPH}/me/mailFolders/inbox/messages/delta?page=${page + 1}`,
                  }
                : {
                    "@odata.deltaLink": `${GRAPH}/me/mailFolders/inbox/messages/delta?$deltatoken=final`,
                  }),
            },
          };
        },
      }),
    );
    const changes: Change[] = [];
    yield* run(http, (adapter) =>
      adapter.pull(account, Option.none(), "inbox").pipe(
        Stream.runForEach((change) =>
          Effect.sync(() => {
            changes.push(change);
            if (change._tag === "Upsert") delivered++;
          }),
        ),
      ),
    );
    assert.strictEqual(delivered, 200);
    assert.isAtLeast(nextPageAt, 24);
    assert.isBelow(nextPageAt, 41);
    assert.strictEqual(changes.at(-1)?._tag, "Cursor");
  }),
);

it.effect("a move between folders is kept, and a vanished folder drops its label", () =>
  Effect.gen(function* () {
    const link = (key: string) =>
      `${GRAPH}/me/mailFolders/${key}/messages/delta?$deltatoken=${key}`;
    const stored = {
      __idType: "immutable",
      ...Object.fromEntries([...WELL_KNOWN, "id-c1", "id-c2"].map((k) => [k, link(k)])),
      "id-old": link("id-old"),
    };
    const http = fakeHttp(
      mailbox({
        inbox: {
          json: {
            value: [{ id: "moved", "@removed": { reason: "changed" } }],
            "@odata.deltaLink": link("inbox"),
          },
        },
        "id-c1": {
          json: {
            value: [{ ...raw, id: "moved", hasAttachments: false }],
            "@odata.deltaLink": link("id-c1"),
          },
        },
      }),
    );
    const changes = yield* run(http, (a) =>
      Stream.runCollect(a.pull(account, Option.some(JSON.stringify(stored)))),
    );
    assert.deepStrictEqual(tags(changes), [
      "Labels",
      "Upsert",
      "Progress",
      "DeleteLabel",
      "Cursor",
    ]);
    const upsert = changes[1];
    assert.ok(upsert?._tag === "Upsert");
    assert.strictEqual(upsert.message.providerId, "moved");
    assert.ok(upsert.message.labels.includes("id-c1"));
    assert.deepStrictEqual(changes[3], { _tag: "DeleteLabel", label: "id-old", partial: true });
    // Stored delta links are followed as they are.
    assert.ok(http.calls.some((c) => c.url.searchParams.get("$deltatoken") === "id-c1"));
  }),
);

it.effect("an expired delta link restarts that folder and drops its local copies first", () =>
  Effect.gen(function* () {
    const link = (key: string) =>
      `${GRAPH}/me/mailFolders/${key}/messages/delta?$deltatoken=${key}`;
    const fresh = `${GRAPH}/me/mailFolders/inbox/messages/delta?$deltatoken=fresh`;
    const stored = {
      __idType: "immutable",
      ...Object.fromEntries([...WELL_KNOWN, "id-c1", "id-c2"].map((k) => [k, link(k)])),
    };
    const http = fakeHttp(
      mailbox({
        inbox: (url) =>
          url.searchParams.get("$deltatoken") === "inbox"
            ? { status: 410, json: { error: { code: "SyncStateNotFound" } } }
            : {
                json: {
                  value: [{ ...raw, hasAttachments: false }],
                  "@odata.deltaLink": fresh,
                },
              },
      }),
    );
    const changes = yield* run(http, (a) =>
      Stream.runCollect(a.pull(account, Option.some(JSON.stringify(stored)))),
    );
    // The restarted Inbox is checkpointed before the other folders, after its DeleteLabel.
    assert.deepStrictEqual(tags(changes), [
      "Labels",
      "Upsert",
      "Progress",
      "DeleteLabel",
      "Cursor",
      "Cursor",
    ]);
    assert.deepStrictEqual(changes[3], {
      _tag: "DeleteLabel",
      label: "INBOX",
      keep: ["AAMk123"],
      since: (yield* Clock.currentTimeMillis) - 90 * 86400000,
      partial: true,
    });
    const upsert = changes[1];
    assert.ok(upsert?._tag === "Upsert");
    assert.strictEqual(upsert.message.providerId, "AAMk123");
    // The restart used the initial delta URL, not the expired link again.
    const inboxCalls = http.calls.filter((c) =>
      c.url.pathname.endsWith("/mailFolders/inbox/messages/delta"),
    );
    assert.deepStrictEqual(
      inboxCalls.map((c) => c.url.searchParams.get("$deltatoken")),
      ["inbox", null],
    );

    const cursor = changes.at(-1);
    assert.ok(cursor?._tag === "Cursor");
    const next = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
    )(cursor.cursor);
    assert.strictEqual(next["inbox"], fresh);
    assert.strictEqual(next["id-c1"], link("id-c1"));
  }),
);

it.effect("custom folder IDs stay in one encoded segment in the initial delta URL", () =>
  Effect.gen(function* () {
    const id = "folder/A+B==";
    const http = fakeHttp({
      "GET /me/mailFolders": {
        json: { value: [{ id, displayName: "Custom", childFolderCount: 0, totalItemCount: 0 }] },
      },
      "GET /me/mailFolders/folder%2FA%2BB%3D%3D/messages/delta": { json: { value: [] } },
    });
    yield* run(http, (adapter) => Stream.runCollect(adapter.pull(account, Option.none())));
    const call = http.calls.find(
      (request) =>
        request.url.pathname.endsWith("/messages/delta") && request.url.pathname.includes("folder"),
    );
    assert.strictEqual(
      call?.url.pathname,
      "/v1.0/me/mailFolders/folder%2FA%2BB%3D%3D/messages/delta",
    );
  }),
);

it.effect(
  "background Outlook pull refuses missing or expired delta without restarting a folder",
  () =>
    Effect.gen(function* () {
      const expired = `${GRAPH}/me/mailFolders/inbox/messages/delta?$deltatoken=expired`;
      const http = fakeHttp({ "GET /me/mailFolders/inbox/messages/delta": { status: 410 } });
      for (const cursor of [
        Option.none<string>(),
        Option.some(JSON.stringify({ __idType: "immutable", inbox: expired })),
      ]) {
        const result = yield* run(http, (adapter) =>
          Stream.runCollect(adapter.pull(account, cursor, "inbox", true)).pipe(Effect.result),
        );
        assert.strictEqual(result._tag, "Failure");
      }
      assert.isTrue(
        http.calls.every((call) => call.url.searchParams.get("$deltatoken") === "expired"),
      );
    }),
);

for (const restart of [false, true]) {
  it.effect(
    `delta page-size preference enumerates all messages after ${restart ? "410 restart" : "initial sync"}`,
    () =>
      Effect.gen(function* () {
        const delta = `${GRAPH}/me/mailFolders/inbox/messages/delta`;
        const complete = `${delta}?$deltatoken=complete`;
        const all = Array.from({ length: 123 }, (_value, index) => ({
          ...raw,
          id: `paged-${index}`,
          hasAttachments: false,
        }));
        const http = fakeHttp({
          ...mailbox({}),
          "GET /me/mailFolders/inbox/messages/delta": (url, call) => {
            if (url.searchParams.get("$deltatoken") === "expired") return { status: 410 };
            if (url.searchParams.get("$deltatoken") === "complete")
              return { json: { value: [], "@odata.deltaLink": complete } };
            const top = url.searchParams.get("$top");
            if (top !== null)
              return { json: { value: all.slice(0, Number(top)), "@odata.deltaLink": complete } };
            const offset = Number(url.searchParams.get("$skiptoken") ?? 0);
            const size = Number(
              /odata.maxpagesize=(\d+)/.exec(call.prefer ?? "")?.[1] ?? all.length,
            );
            const next = offset + size;
            return {
              json: {
                value: all.slice(offset, next),
                ...(next < all.length
                  ? { "@odata.nextLink": `${delta}?$skiptoken=${next}` }
                  : { "@odata.deltaLink": complete }),
              },
            };
          },
        });
        // Replay the old request shape: a deltaLink arrives after 50 despite 73 more messages.
        const capped = yield* http.client.execute(
          HttpClientRequest.get(`${delta}?$top=50`).pipe(
            HttpClientRequest.setHeader("prefer", 'IdType="ImmutableId"'),
          ),
        );
        const legacy = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            value: Schema.Array(Schema.Struct({ id: Schema.String })),
            "@odata.deltaLink": Schema.String,
            "@odata.nextLink": Schema.optionalKey(Schema.String),
          }),
        )(yield* capped.json);
        assert.strictEqual(legacy.value.length, 50);
        assert.strictEqual(legacy["@odata.nextLink"], undefined);
        assert.strictEqual(legacy["@odata.deltaLink"], complete);
        const before = http.calls.length;
        yield* run(http, (adapter) =>
          Effect.gen(function* () {
            const cursor = restart
              ? Option.some(
                  JSON.stringify({
                    __idType: "immutable",
                    inbox: `${delta}?$deltatoken=expired&$top=50`,
                  }),
                )
              : Option.none<string>();
            const changes = yield* Stream.runCollect(adapter.pull(account, cursor));
            const delivered = changes.flatMap((change) =>
              change._tag === "Upsert" ? [change.message.providerId] : [],
            );
            assert.deepStrictEqual(
              delivered,
              all.map((message) => message.id),
            );
            const reset = changes.find(
              (change) => change._tag === (restart ? "DeleteLabel" : "Reset"),
            );
            assert.ok(reset?._tag === "DeleteLabel" || reset?._tag === "Reset");
            assert.deepStrictEqual(reset.keep, delivered);
            const checkpoint = changes.at(-1);
            assert.ok(checkpoint?._tag === "Cursor");
            yield* Stream.runDrain(adapter.pull(account, Option.some(checkpoint.cursor), "inbox"));
          }),
        );
        const calls = http.calls.slice(before);
        const deltaCalls = calls.filter((call) => call.url.pathname.endsWith("/messages/delta"));
        for (const call of deltaCalls) {
          assert.isFalse(call.url.searchParams.has("$top"));
          assert.strictEqual(call.prefer, 'IdType="ImmutableId", odata.maxpagesize=50');
        }
        const inbox = deltaCalls.filter((call) => call.url.pathname.includes("/inbox/"));
        assert.strictEqual(inbox.length, restart ? 5 : 4);
        assert.isTrue(inbox.some((call) => call.url.searchParams.has("$skiptoken")));
        assert.isTrue(
          inbox.some((call) => call.url.searchParams.get("$deltatoken") === "complete"),
        );
        const folders = calls.find((call) => call.url.pathname === "/v1.0/me/mailFolders");
        assert.ok(folders);
        assert.strictEqual(folders.url.searchParams.get("$top"), "100");
        assert.strictEqual(folders.prefer, 'IdType="ImmutableId"');
      }),
  );
}

it.effect("empty delta restart persists once and healthy increments emit no reset listing", () =>
  Effect.gen(function* () {
    const diagnostics: unknown[] = [];
    const logger = Logger.make((options) => {
      diagnostics.push(...(Array.isArray(options.message) ? options.message : [options.message]));
    });
    const http = fakeHttp(mailbox({}));
    yield* run(http, (adapter) =>
      Effect.gen(function* () {
        const initial = yield* Stream.runCollect(adapter.pull(account, Option.none()));
        // The last cursor is the one a completed pull leaves; earlier ones are folder checkpoints.
        const saved = initial.findLast((change) => change._tag === "Cursor");
        assert.ok(saved?._tag === "Cursor");
        diagnostics.length = 0;
        for (let pass = 0; pass < 3; pass++) {
          const changes = yield* Stream.runCollect(
            adapter.pull(account, Option.some(saved.cursor)),
          );
          assert.isFalse(
            changes.some((change) => change._tag === "Reset" || change._tag === "DeleteLabel"),
          );
        }
        assert.strictEqual(
          diagnostics.filter(
            (value) =>
              typeof value === "object" &&
              value !== null &&
              "_tag" in value &&
              value._tag === "SyncResetDiagnostic",
          ).length,
          0,
        );
      }).pipe(Effect.provide(Logger.layer([logger]))),
    );
    const pulls = http.calls.filter((call) => call.url.pathname.endsWith("/messages/delta"));
    for (const folder of [...WELL_KNOWN, "id-c1", "id-c2"])
      assert.strictEqual(
        pulls.filter(
          (call) =>
            call.url.pathname.includes(`/mailFolders/${folder}/`) &&
            !call.url.searchParams.has("$deltatoken"),
        ).length,
        1,
      );
  }),
);

{
  it("Graph page validation confines all resources and rejects repeated delta pages", () => {
    const seen = new Set<string>();
    const base = "/me/mailFolders/inbox/messages/delta";
    const link =
      "https://graph.microsoft.com/v1.0/me/mailFolders('actual-id')/messages/delta?$skiptoken=opaque";
    assert.strictEqual(graphPageLink(link, base, seen), link);
    assert.throws(() => graphPageLink(link, base, seen), /repeated/);
    for (const bad of [
      "https://evil.test/v1.0/me/messages",
      "https://graph.microsoft.com/v1.0/users/other/messages",
      "https://graph.microsoft.com/v1.0/me/contacts",
      "https://graph.microsoft.com/v1.0/me/messages#fragment",
    ])
      assert.throws(() => graphPageLink(bad, base));
  });
}

for (const invalid of [
  "https://evil.test/secret?token=private",
  `${GRAPH}/expired-delta`,
  "broken cursor",
]) {
  it.effect(
    `invalid stored Graph cursor is discarded without a bearer request (${invalid.startsWith("https://evil") ? "foreign origin" : invalid.startsWith(GRAPH) ? "invalid resource" : "malformed URL"})`,
    () => {
      const http = fakeHttp(mailbox({}));
      return run(http, (adapter) =>
        Effect.gen(function* () {
          const changes = yield* Stream.runCollect(
            adapter.pull(
              account,
              Option.some(JSON.stringify({ __idType: "immutable", inbox: invalid })),
              "inbox",
            ),
          );
          const cursor = changes.find((change) => change._tag === "Cursor");
          assert.ok(cursor?._tag === "Cursor");
          assert.include(cursor.cursor, "/me/mailFolders/inbox/messages/delta");
          assert.ok(!cursor.cursor.includes(invalid));
          assert.isTrue(
            http.calls.every((call) => call.url.origin === "https://graph.microsoft.com"),
          );
          assert.isTrue(
            http.calls.some((call) => call.url.pathname.endsWith("/inbox/messages/delta")),
          );
          assert.isFalse(http.calls.some((call) => call.url.pathname.endsWith("expired-delta")));
        }),
      );
    },
  );
}

it.effect("a failed folder keeps the delta links of folders that finished before it", () =>
  Effect.gen(function* () {
    let sentFails = true;
    const inboxLink = `${GRAPH}/me/mailFolders/inbox/messages/delta?$deltatoken=inbox-done`;
    const http = fakeHttp(
      mailbox({
        inbox: (url) =>
          url.searchParams.get("$deltatoken") === "inbox-done"
            ? { json: { value: [], "@odata.deltaLink": inboxLink } }
            : {
                json: {
                  value: [{ ...raw, id: "first", hasAttachments: false }],
                  "@odata.deltaLink": inboxLink,
                },
              },
        sentitems: () =>
          sentFails
            ? { status: 400, json: { error: { code: "BadRequest" } } }
            : {
                json: {
                  value: [],
                  "@odata.deltaLink": `${GRAPH}/me/mailFolders/sentitems/messages/delta?$deltatoken=sent`,
                },
              },
      }),
    );
    const adapters = Layer.effect(
      Providers,
      Effect.map(makeOutlook, (adapter) => Providers.of({ get: () => adapter })),
    );
    const layer = MailboxLive({ backgroundFlush: false, imapIdle: false }).pipe(
      Layer.provideMerge(Layer.mergeAll(StoreLive, adapters)),
      Layer.provide(Layer.mergeAll(MemoryPlatform(platformOptions), http.layer)),
    );
    yield* Effect.gen(function* () {
      const store = yield* Store;
      const mailbox = yield* Mailbox;
      yield* store.upsertAccount("outlook", account.email);
      const failed = yield* mailbox.sync.sync(account.id);
      assert.ok(failed[0]?.error);
      const partial = yield* store.getSyncCursor(account.id);
      assert.ok(Option.isSome(partial));
      assert.include(partial.value, "inbox-done");
      // A folder checkpoint is not a completed sync and leaves the inbox cursor alone.
      assert.strictEqual((yield* store.getAccount(account.id)).lastSyncedAt, null);
      assert.isTrue(Option.isNone(yield* store.getInboxCursor(account.id)));
      sentFails = false;
      const inboxCalls = () =>
        http.calls
          .filter((c) => c.url.pathname.endsWith("/mailFolders/inbox/messages/delta"))
          .map((c) => c.url.searchParams.get("$deltatoken"));
      const before = inboxCalls().length;
      const done = yield* mailbox.sync.sync(account.id);
      assert.isUndefined(done[0]?.error);
      // The retry continues Inbox from its saved link instead of listing it again.
      assert.deepStrictEqual(inboxCalls().slice(before), ["inbox-done"]);
      assert.strictEqual(yield* store.hasMessage(`${account.id}/first`), true);
      const final = yield* store.getSyncCursor(account.id);
      assert.ok(Option.isSome(final));
      assert.notInclude(final.value, "__partial");
    }).pipe(Effect.provide(layer), Effect.scoped);
  }),
);
