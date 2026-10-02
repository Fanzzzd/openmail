import { assert, it } from "@effect/vitest";
import { parseCalendar } from "./invites.js";

import { Effect, Fiber, Layer, Option, Schema, Stream } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { simpleParser } from "mailparser";

import type { Account, OutgoingMessage } from "./domain.js";
import { makeOutlook, parseGraphMessage, MARKDOWN_DRAFT_PROPERTY } from "./outlook.js";
import {
  importedMessage,
  parseRawDraft,
  withDraftMarkdownSource,
} from "./platform/node/portable-helpers.js";
import { markdownDraftSource } from "./markdown-draft.js";
import { renderMarkdown } from "./markdown.js";
import { replyRecipients } from "./recipients.js";
import { MemoryPlatform, type MemoryPlatformOptions } from "./platform/node/platform-memory.js";
import { type Change, type ProviderAdapter, Providers, Secrets, Store } from "./services.js";
import { MailboxLive } from "./mailbox-live.js";
import { Mailbox } from "./mailbox.js";
import { StoreLive } from "./store.js";

const GRAPH = "https://graph.microsoft.com/v1.0";

interface Call {
  method: string;
  url: URL;
  body: unknown;
  contentType: string;
  prefer: string | undefined;
}

const parseJson = (text: string): unknown => JSON.parse(text);

type Reply = { status?: number; json?: unknown; text?: string };

/**
 * An HttpClient that answers from `routes`, keyed by "METHOD /path" under
 * GRAPH. Function routes see the full URL (delta pages share a path).
 * Unknown routes answer 404, like a folder the mailbox does not have.
 */
function fakeHttp(routes: Record<string, Reply | ((url: URL) => Reply)>) {
  const calls: Call[] = [];
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const text =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      const contentType = request.body._tag === "Uint8Array" ? request.body.contentType : "";
      const body = contentType.startsWith("application/json") ? parseJson(text) : text || undefined;
      calls.push({
        method: request.method,
        url,
        body,
        contentType,
        prefer: request.headers["prefer"],
      });
      const path = url.pathname.replace("/v1.0", "");
      const route = routes[`${request.method} ${path}`];
      const reply = typeof route === "function" ? route(url) : (route ?? { status: 404 });
      return HttpClientResponse.fromWeb(
        request,
        new Response(reply.text ?? (reply.json === undefined ? null : JSON.stringify(reply.json)), {
          status: reply.status ?? 200,
        }),
      );
    }),
  );
  return { layer: Layer.succeed(HttpClient.HttpClient)(client), calls };
}

const account: Account = {
  id: "outlook:me@outlook.com",
  provider: "outlook",
  email: "me@outlook.com",
  createdAt: 0,
  lastSyncedAt: null,
  lastSyncError: null,
  profileId: null,
  needsReauth: false,
};

const platformOptions: MemoryPlatformOptions = {
  secrets: { [account.id]: "refresh-token" },
  config: { microsoft: { clientId: "client" } },
};

function run<A, E>(
  http: ReturnType<typeof fakeHttp>,
  f: (adapter: ProviderAdapter) => Effect.Effect<A, E, Secrets>,
  options: MemoryPlatformOptions = platformOptions,
) {
  return makeOutlook.pipe(
    Effect.flatMap(f),
    Effect.provide(Layer.mergeAll(http.layer, MemoryPlatform(options))),
  );
}

const raw = {
  id: "AAMk123",
  conversationId: "conv-1",
  webLink: "https://outlook.live.com/mail/0/id/AAMk123",
  subject: "报价确认",
  bodyPreview: "已确认报价",
  body: { contentType: "html", content: "<p>已确认<b>报价</b></p>" },
  from: { emailAddress: { name: "王工", address: "wang@contoso.com" } },
  toRecipients: [{ emailAddress: { name: "Me", address: "me@outlook.com" } }],
  ccRecipients: [],
  receivedDateTime: "2026-09-20T02:30:00Z",
  isRead: false,
  isDraft: false,
  hasAttachments: true,
  flag: { flagStatus: "flagged" },
};

const WELL_KNOWN = ["inbox", "sentitems", "drafts", "junkemail", "deleteditems"];

/** A mailbox with the well-known folders (no Archive), one custom folder with a child, and Sync Issues. */
function mailbox(deltas: Record<string, Reply | ((url: URL) => Reply)>) {
  const routes: Record<string, Reply | ((url: URL) => Reply)> = {
    "GET /me/mailFolders": {
      json: {
        value: [
          { id: "id-inbox", displayName: "Inbox", childFolderCount: 0, totalItemCount: 9 },
          { id: "id-c1", displayName: "Clients", childFolderCount: 1, totalItemCount: 3 },
          { id: "id-empty", displayName: "Empty", childFolderCount: 0, totalItemCount: 0 },
          {
            id: "id-syncissues",
            displayName: "Sync Issues",
            childFolderCount: 1,
            totalItemCount: 2,
          },
        ],
      },
    },
    "GET /me/mailFolders/id-c1/childFolders": {
      json: {
        value: [{ id: "id-c2", displayName: "Acme", childFolderCount: 0, totalItemCount: 1 }],
      },
    },
    "GET /me/mailFolders/syncissues": { json: { id: "id-syncissues" } },
  };
  for (const name of WELL_KNOWN)
    routes[`GET /me/mailFolders/${name}`] = { json: { id: `id-${name}` } };
  for (const key of [...WELL_KNOWN, "id-c1", "id-c2"]) {
    routes[`GET /me/mailFolders/${key}/messages/delta`] = deltas[key] ?? {
      json: {
        value: [],
        "@odata.deltaLink": `${GRAPH}/me/mailFolders/${key}/messages/delta?$deltatoken=${key}`,
      },
    };
  }
  return routes;
}

const tags = (changes: readonly Change[]) => changes.map((c) => c._tag);

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
    assert.deepStrictEqual(tags(changes), [
      "Labels",
      "Upsert",
      "Progress",
      "Reset",
      "Delete",
      "Cursor",
    ]);
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
    assert.deepStrictEqual(changes[4], { _tag: "Delete", providerId: "gone" });

    const cursor = changes[5];
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
      ["__idType", ...WELL_KNOWN, "id-c1", "id-c2"].toSorted(),
    );
    // The stale link was not followed after the reset.
    assert.ok(!http.calls.some((c) => c.url.href.includes("old-link")));
    assert.ok(http.calls.every((c) => c.prefer === 'IdType="ImmutableId"'));
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
          const result = yield* mailbox.sync(account.id);
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
    assert.deepStrictEqual(changes[3], { _tag: "DeleteLabel", label: "id-old" });
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
    assert.deepStrictEqual(tags(changes), [
      "Labels",
      "Upsert",
      "Progress",
      "DeleteLabel",
      "Cursor",
    ]);
    assert.deepStrictEqual(changes[3], { _tag: "DeleteLabel", label: "INBOX", keep: ["AAMk123"] });
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

it.effect("ops map onto PATCH and move destinations", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "PATCH /me/messages/p": { json: {} },
      "POST /me/messages/p/move": { json: { id: "p" } },
    });
    yield* run(http, (a) =>
      Effect.gen(function* () {
        yield* a.push(account, "p", { kind: "read", value: true });
        yield* a.push(account, "p", { kind: "star", value: false });
        yield* a.push(account, "p", { kind: "archive" });
        yield* a.push(account, "p", { kind: "inbox" });
        yield* a.push(account, "p", { kind: "trash" });
        yield* a.push(account, "p", { kind: "spam" });
        yield* a.push(account, "p", { kind: "label", labelId: "id-c1", value: true });
        yield* a.push(account, "p", { kind: "label", labelId: "id-c1", value: false });
        // Outlook has no "important" flag; nothing is sent.
        yield* a.push(account, "p", { kind: "important", value: true });
      }),
    );
    assert.deepStrictEqual(
      http.calls.map((c) => [c.method, c.body]),
      [
        ["PATCH", { isRead: true }],
        ["PATCH", { flag: { flagStatus: "notFlagged" } }],
        ["POST", { destinationId: "archive" }],
        ["POST", { destinationId: "inbox" }],
        ["POST", { destinationId: "deleteditems" }],
        ["POST", { destinationId: "junkemail" }],
        ["POST", { destinationId: "id-c1" }],
        ["POST", { destinationId: "inbox" }],
        ["PATCH", { importance: "high" }],
      ],
    );
  }),
);

it.effect("403 is an AuthError on reads and writes; 404 on a write is permanent", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "PATCH /me/messages/denied": { status: 403, json: { error: { code: "ErrorAccessDenied" } } },
      "PATCH /me/messages/gone": { status: 404, json: { error: { code: "ErrorItemNotFound" } } },
      "GET /me/mailFolders/inbox": { status: 403, json: { error: { code: "ErrorAccessDenied" } } },
    });
    const [write, gone, read] = yield* run(http, (a) =>
      Effect.all([
        Effect.flip(a.push(account, "denied", { kind: "read", value: true })),
        Effect.flip(a.push(account, "gone", { kind: "read", value: true })),
        Effect.flip(Stream.runDrain(a.pull(account, Option.none()))),
      ]),
    );
    assert.strictEqual(write._tag, "AuthError");
    assert.strictEqual(gone._tag, "PermanentError");
    assert.strictEqual(read._tag, "AuthError");
  }),
);

it.effect("a rejected access token is refreshed and the request retried once", () =>
  Effect.gen(function* () {
    let patches = 0;
    const http = fakeHttp({
      "PATCH /me/messages/p": () => (++patches === 1 ? { status: 401, json: {} } : { json: {} }),
      "PATCH /me/messages/never": { status: 401, json: {} },
    });
    const refused = yield* run(http, (a) =>
      a
        .push(account, "p", { kind: "read", value: true })
        .pipe(Effect.andThen(Effect.flip(a.push(account, "never", { kind: "read", value: true })))),
    );
    assert.strictEqual(patches, 2);
    // A token that is still refused after a fresh one means signing in again.
    assert.strictEqual(refused._tag, "AuthError");
    assert.strictEqual(http.calls.filter((c) => c.url.pathname.endsWith("/never")).length, 2);
  }),
);

it.effect("a rotated refresh token is saved to the keychain", () =>
  Effect.gen(function* () {
    const http = fakeHttp({ "PATCH /me/messages/p": { json: {} } });
    const saved = yield* run(
      http,
      (a) =>
        Effect.gen(function* () {
          yield* a.push(account, "p", { kind: "read", value: true });
          return yield* (yield* Secrets).get(account.id);
        }),
      {
        ...platformOptions,
        tokens: { accessToken: "at", refreshToken: Option.some("rotated"), expiresIn: 3600 },
      },
    );
    assert.deepStrictEqual(saved, Option.some("rotated"));
  }),
);

it.effect("replies go through a draft; new messages through sendMail", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "POST /me/messages/orig/createReply": { json: { id: "draft" } },
      "PATCH /me/messages/draft": { json: {} },
      "POST /me/messages/draft/attachments": { json: {} },
      "POST /me/messages/draft/send": { status: 202 },
      "POST /me/sendMail": { status: 202 },
    });
    const message = {
      to: [{ name: "王工", address: "wang@contoso.com" }],
      cc: [],
      bcc: [],
      subject: "Re: 报价确认",
      text: "收到",
      attachments: [{ filename: "a.txt", mimeType: "text/plain", content: "aGk=" }],
    };
    yield* run(http, (a) =>
      Effect.gen(function* () {
        yield* a.send(
          account,
          { ...message, mode: "reply" },
          Option.some({ providerId: "orig", threadId: "conv-1" }),
        );
        yield* a.send(account, message, Option.none());
      }),
    );
    assert.deepStrictEqual(
      http.calls.map((c) => `${c.method} ${c.url.pathname.replace("/v1.0", "")}`),
      [
        "POST /me/messages/orig/createReply",
        "PATCH /me/messages/draft",
        "POST /me/messages/draft/attachments",
        "POST /me/messages/draft/send",
        "POST /me/sendMail",
      ],
    );
    assert.deepStrictEqual(
      Schema.decodeUnknownSync(Schema.Struct({ saveToSentItems: Schema.Boolean }))(
        http.calls.at(-1)?.body,
      ),
      { saveToSentItems: true },
    );
  }),
);

for (const includeOriginalAttachments of [true, false, undefined]) {
  it.effect(
    `Graph forward attachment choice ${includeOriginalAttachments} replaces inherited parts only when explicit`,
    () =>
      Effect.gen(function* () {
        const http = fakeHttp({
          "POST /me/messages/orig/createForward": { json: { id: "draft" } },
          "PATCH /me/messages/draft": { json: {} },
          "GET /me/messages/draft/attachments": {
            json: {
              value: [{ id: "copied" }, { id: "inline", isInline: true, contentId: "logo" }],
            },
          },
          "DELETE /me/messages/draft/attachments/copied": { status: 204 },
          "DELETE /me/messages/draft/attachments/inline": { status: 204 },
          "POST /me/messages/draft/attachments": { json: {} },
          "POST /me/messages/draft/send": { status: 202 },
        });
        const parts = includeOriginalAttachments
          ? [
              { filename: "original.txt", mimeType: "text/plain", content: "aGk=" },
              { filename: "logo.png", mimeType: "image/png", content: "aGk=", contentId: "logo" },
            ]
          : [];
        yield* run(http, (adapter) =>
          adapter.send(
            account,
            {
              to: [{ name: "Bob", address: "bob@example.com" }],
              cc: [],
              bcc: [],
              subject: "Forward",
              text: "Body",
              attachments: parts,
              mode: "forward",
              ...(includeOriginalAttachments === undefined ? {} : { includeOriginalAttachments }),
            },
            Option.some({ providerId: "orig", threadId: "thread" }),
          ),
        );
        const calls = http.calls.map(
          (call) => `${call.method} ${call.url.pathname.replace("/v1.0", "")}`,
        );
        assert.strictEqual(
          calls.filter((call) => call.startsWith("DELETE")).length,
          includeOriginalAttachments === undefined ? 0 : 2,
        );
        assert.strictEqual(
          calls.filter((call) => call === "POST /me/messages/draft/attachments").length,
          parts.length,
        );
        assert.strictEqual(calls.at(-1), "POST /me/messages/draft/send");
      }),
  );
}

it.effect("attachments over 3 MB are refused before any request", () =>
  Effect.gen(function* () {
    const http = fakeHttp({});
    const error = yield* run(http, (a) =>
      Effect.flip(
        a.send(
          account,
          {
            to: [],
            cc: [],
            bcc: [],
            subject: "big",
            text: "",
            attachments: [
              {
                filename: "big.bin",
                mimeType: "application/octet-stream",
                content: "A".repeat(5_000_000),
              },
            ],
          },
          Option.none(),
        ),
      ),
    );
    assert.strictEqual(error._tag, "PermanentError");
    assert.strictEqual(http.calls.length, 0);
  }),
);

it("maps a Graph message onto the store shape", () => {
  const m = parseGraphMessage(raw, "INBOX", [
    { filename: "quote.pdf", mimeType: "application/pdf", size: 100 },
  ]);
  assert.strictEqual(m.providerId, "AAMk123");
  assert.strictEqual(m.threadId, "conv-1");
  assert.strictEqual(m.webLink, raw.webLink);
  assert.strictEqual(m.from.address, "wang@contoso.com");
  assert.deepStrictEqual(m.labels.toSorted(), ["INBOX", "STARRED", "UNREAD"]);
  assert.strictEqual(m.isUnread, true);
  assert.strictEqual(m.isStarred, true);
  assert.strictEqual(m.bodyText, "已确认报价");
  assert.strictEqual(m.bodyHtml, "<p>已确认<b>报价</b></p>");
  assert.strictEqual(m.date, Date.parse("2026-09-20T02:30:00Z"));
  assert.strictEqual(m.attachments.length, 1);
});

it("a read plain-text message in Sent has only the folder label", () => {
  const m = parseGraphMessage(
    {
      ...raw,
      isRead: true,
      flag: { flagStatus: "notFlagged" },
      body: { contentType: "text", content: "纯文本正文" },
    },
    "SENT",
    [],
  );
  assert.deepStrictEqual(m.labels, ["SENT"]);
  assert.strictEqual(m.bodyText, "纯文本正文");
  assert.strictEqual(m.bodyHtml, "");
});

const draftMessage = {
  to: [{ name: "王工", address: "wang@contoso.com" }],
  cc: [],
  bcc: [],
  subject: "报价",
  text: "草稿",
  attachments: [{ filename: "a.txt", mimeType: "text/plain", content: "aGk=" }],
};

const paths = (calls: readonly Call[]) =>
  calls.map((c) => `${c.method} ${c.url.pathname.replace("/v1.0", "")}`);

it.effect(
  "default forward autosave uses createForward and never uploads inherited large attachments",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "POST /me/messages/orig/createForward": { json: { id: "d1" } },
        "PATCH /me/messages/d1": { json: {} },
      });
      yield* run(http, (adapter) =>
        adapter.saveDraft(account, {
          remote: null,
          original: Option.some({ providerId: "orig", threadId: "thread" }),
          message: { ...draftMessage, mode: "forward", attachments: [] },
          replaceAttachments: true,
        }),
      );
      assert.deepStrictEqual(paths(http.calls), [
        "POST /me/messages/orig/createForward",
        "PATCH /me/messages/d1",
      ]);
    }),
);

it.effect(
  "changing uploaded parts of an inherited forward recreates its server copy and preserves originals",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "POST /me/messages/orig/createForward": { json: { id: "fresh" } },
        "PATCH /me/messages/fresh": { json: {} },
        "GET /me/messages/old": {
          json: { categories: ["External"], flag: { flagStatus: "flagged" } },
        },
        "DELETE /me/messages/old": { status: 204 },
        "POST /me/messages/fresh/attachments": { json: {} },
        "POST /me/messages/fresh/send": { status: 202 },
      });
      const message = { ...draftMessage, mode: "forward" } satisfies OutgoingMessage;
      yield* run(http, (adapter) =>
        Effect.gen(function* () {
          yield* adapter.saveDraft(account, {
            remote: { draftId: "old", messageId: "old" },
            original: Option.some({ providerId: "orig", threadId: "thread" }),
            message,
            replaceAttachments: true,
          });
          yield* adapter.send(
            account,
            message,
            Option.some({ providerId: "orig", threadId: "thread" }),
          );
        }),
      );
      const fields = Schema.decodeUnknownSync(
        Schema.Struct({
          categories: Schema.Array(Schema.String),
          flag: Schema.Struct({ flagStatus: Schema.String }),
        }),
      )(http.calls.find((call) => call.method === "PATCH")?.body);
      assert.deepStrictEqual(fields.categories, ["External"]);
      assert.strictEqual(fields.flag.flagStatus, "flagged");
      assert.deepStrictEqual(paths(http.calls), [
        "GET /me/messages/old",
        "POST /me/messages/orig/createForward",
        "PATCH /me/messages/fresh",
        "POST /me/messages/fresh/attachments",
        "DELETE /me/messages/old",
        "POST /me/messages/orig/createForward",
        "PATCH /me/messages/fresh",
        "POST /me/messages/fresh/attachments",
        "POST /me/messages/fresh/send",
      ]);
    }),
);

it.effect(
  "drafts are messages in Drafts: created, patched, attachments replaced only when changed",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "POST /me/messages": { status: 201, json: { id: "d1" } },
        "PATCH /me/messages/d1": { json: {} },
        "GET /me/messages/d1/attachments": {
          json: { value: [{ id: "a1" }, { id: "logo", isInline: true }] },
        },
        "DELETE /me/messages/d1/attachments/a1": { status: 204 },
        "POST /me/messages/d1/attachments": { status: 201, json: {} },
        "PATCH /me/messages/gone": { status: 404, json: { error: { code: "ErrorItemNotFound" } } },
      });
      const push = (remote: { draftId: string; messageId: string } | null, replace: boolean) => ({
        remote,
        message: draftMessage,
        original: Option.none(),
        replaceAttachments: replace,
      });
      const ids = yield* run(http, (a) =>
        Effect.all([
          a.saveDraft(account, push(null, true)),
          a.saveDraft(account, push({ draftId: "d1", messageId: "d1" }, false)),
          a.saveDraft(account, push({ draftId: "d1", messageId: "d1" }, true)),
          // Deleted in Outlook meanwhile: created again.
          a.saveDraft(account, push({ draftId: "gone", messageId: "gone" }, false)),
        ]),
      );
      assert.deepStrictEqual(
        ids.map((r) => r.messageId),
        ["d1", "d1", "d1", "d1"],
      );
      assert.deepStrictEqual(paths(http.calls), [
        "POST /me/messages",
        "PATCH /me/messages/d1",
        "PATCH /me/messages/d1",
        "GET /me/messages/d1/attachments",
        "DELETE /me/messages/d1/attachments/a1",
        "POST /me/messages/d1/attachments",
        "PATCH /me/messages/gone",
        "POST /me/messages",
      ]);
      const created = Schema.decodeUnknownSync(
        Schema.Struct({
          subject: Schema.String,
          bccRecipients: Schema.Array(Schema.Unknown),
          attachments: Schema.Array(Schema.Unknown),
        }),
      )(http.calls[0]?.body);
      assert.strictEqual(created.subject, "报价");
      assert.deepStrictEqual(created.attachments, [
        {
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: "a.txt",
          contentType: "text/plain",
          contentBytes: "aGk=",
        },
      ]);
    }),
);

it.effect("reply drafts start from createReply so Outlook threads them", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "POST /me/messages/orig/createReplyAll": { status: 201, json: { id: "d2" } },
      "PATCH /me/messages/d2": { json: {} },
      "POST /me/messages/d2/attachments": { status: 201, json: {} },
    });
    const remote = yield* run(http, (a) =>
      a.saveDraft(account, {
        remote: null,
        message: { ...draftMessage, mode: "replyAll" },
        original: Option.some({ providerId: "orig", threadId: "conv-1" }),
        replaceAttachments: true,
      }),
    );
    assert.deepStrictEqual(remote, { draftId: "d2", messageId: "d2" });
    assert.deepStrictEqual(paths(http.calls), [
      "POST /me/messages/orig/createReplyAll",
      "PATCH /me/messages/d2",
      "POST /me/messages/d2/attachments",
    ]);
  }),
);

it.effect(
  "Graph reuses Content-ID inline images without duplicating managed parts on replacement",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "PATCH /me/messages/d1": { json: {} },
        "GET /me/messages/d1/attachments": {
          json: {
            value: [
              { id: "copied-logo", isInline: true, contentId: "logo@example.com" },
              { id: "server-only", isInline: true, contentId: "unknown@example.com" },
            ],
          },
        },
        "DELETE /me/messages/d1/attachments/copied-logo": { status: 204 },
        "POST /me/messages/d1/attachments": { status: 201, json: {} },
      });
      yield* run(http, (adapter) =>
        adapter.saveDraft(account, {
          remote: { draftId: "d1", messageId: "d1" },
          message: {
            ...draftMessage,
            html: '<img src="cid:logo@example.com">',
            attachments: [
              {
                filename: "logo.png",
                mimeType: "image/png",
                content: "aGk=",
                contentId: "logo@example.com",
              },
            ],
          },
          original: Option.none(),
          replaceAttachments: true,
        }),
      );
      assert.deepStrictEqual(paths(http.calls), [
        "PATCH /me/messages/d1",
        "GET /me/messages/d1/attachments",
        "DELETE /me/messages/d1/attachments/copied-logo",
        "POST /me/messages/d1/attachments",
      ]);
      const uploaded = Schema.decodeUnknownSync(
        Schema.Struct({
          contentId: Schema.String,
          isInline: Schema.Boolean,
          contentBytes: Schema.String,
        }),
      )(http.calls.at(-1)?.body);
      assert.deepStrictEqual(uploaded, {
        contentId: "logo@example.com",
        isInline: true,
        contentBytes: "aGk=",
      });
    }),
);

it.effect("Graph draft source properties survive create, update, import and removal", () =>
  Effect.gen(function* () {
    const source = "**bold**\n\n- first\n- second\n";
    const propertySchema = Schema.Struct({
      singleValueExtendedProperties: Schema.Array(
        Schema.Struct({ id: Schema.String, value: Schema.String }),
      ),
    });
    let externalBody: string | undefined;
    const writtenBody = () => {
      const write = http.calls
        .filter((call) => call.method === "POST" || call.method === "PATCH")
        .at(-1);
      return Schema.decodeUnknownSync(
        Schema.Struct({ body: Schema.Struct({ content: Schema.String }) }),
      )(write?.body).body.content;
    };
    const http = fakeHttp({
      "POST /me/messages": { status: 201, json: { id: "markdown-draft" } },
      "PATCH /me/messages/markdown-draft": { json: {} },
      "GET /me/messages/markdown-draft": (url) => {
        assert.include(url.searchParams.get("$expand") ?? "", MARKDOWN_DRAFT_PROPERTY);
        const lastWrite = http.calls
          .filter((call) => call.method === "POST" || call.method === "PATCH")
          .at(-1);
        const fields = Schema.decodeUnknownSync(propertySchema)(lastWrite?.body);
        assert.strictEqual(fields.singleValueExtendedProperties[0]?.id, MARKDOWN_DRAFT_PROPERTY);
        return { json: fields };
      },
      "GET /me/messages/markdown-draft/$value": () => ({
        text: `To: bob@example.com\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${externalBody ?? writtenBody()}`,
      }),
    });
    yield* run(http, (adapter) =>
      Effect.gen(function* () {
        if (!adapter.draftMarkdownSource) throw new Error("Graph draft source API is missing");
        const remote = yield* adapter.saveDraft(account, {
          remote: null,
          message: {
            ...draftMessage,
            attachments: [],
            text: source,
            html: renderMarkdown(source),
            markdown: true,
          },
          original: Option.none(),
          replaceAttachments: false,
        });
        assert.deepStrictEqual(
          yield* adapter.draftMarkdownSource(account, "markdown-draft"),
          markdownDraftSource(source),
        );
        const raw = yield* adapter.fetchRaw(account, "markdown-draft");
        const parsed = withDraftMarkdownSource(
          yield* parseRawDraft(raw),
          yield* adapter.draftMarkdownSource(account, "markdown-draft"),
        );
        const imported = importedMessage(parsed, []);
        assert.strictEqual(imported.markdown, true);
        assert.strictEqual(imported.text, source);
        assert.strictEqual(imported.html, undefined);
        assert.strictEqual(imported.originalHtml, undefined);
        externalBody = '<p style="color:red">Edited in another client</p>';
        const external = withDraftMarkdownSource(
          yield* parseRawDraft(yield* adapter.fetchRaw(account, "markdown-draft")),
          yield* adapter.draftMarkdownSource(account, "markdown-draft"),
        );
        assert.strictEqual(external.markdown, undefined);
        assert.strictEqual(external.text, "Edited in another client");
        assert.strictEqual(external.originalHtml, externalBody);
        externalBody = undefined;
        const edited = "_edited_\n";
        yield* adapter.saveDraft(account, {
          remote,
          message: { ...imported, text: edited, html: renderMarkdown(edited) },
          original: Option.none(),
          replaceAttachments: false,
        });
        assert.deepStrictEqual(
          yield* adapter.draftMarkdownSource(account, "markdown-draft"),
          markdownDraftSource(edited),
        );
        yield* adapter.saveDraft(account, {
          remote,
          message: { ...imported, text: "", html: renderMarkdown(""), markdown: true },
          original: Option.none(),
          replaceAttachments: false,
        });
        assert.deepStrictEqual(
          yield* adapter.draftMarkdownSource(account, "markdown-draft"),
          markdownDraftSource(""),
        );
        yield* adapter.saveDraft(account, {
          remote,
          message: { ...imported, text: "plain", markdown: false },
          original: Option.none(),
          replaceAttachments: false,
        });
        assert.strictEqual(
          yield* adapter.draftMarkdownSource(account, "markdown-draft"),
          undefined,
        );
      }),
    );
    // internetMessageHeaders cannot be patched; only the updateable property is sent.
    assert.ok(
      http.calls
        .filter((call) => call.method === "PATCH")
        .every(
          (call) =>
            !Object.hasOwn(
              Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(call.body),
              "internetMessageHeaders",
            ),
        ),
    );
  }),
);

it.effect("deleting a draft that is already gone succeeds; raw MIME comes from $value", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "DELETE /me/messages/d1": { status: 204 },
      "DELETE /me/messages/gone": { status: 404, json: { error: { code: "ErrorItemNotFound" } } },
      "GET /me/messages/m1/$value": { text: "Subject: hi\r\n\r\nbody" },
    });
    const raw = yield* run(http, (a) =>
      Effect.gen(function* () {
        yield* a.deleteDraft(account, { draftId: "d1", messageId: "d1" });
        yield* a.deleteDraft(account, { draftId: null, messageId: "gone" });
        return yield* a.fetchRaw(account, "m1");
      }),
    );
    assert.strictEqual(Buffer.from(raw).toString(), "Subject: hi\r\n\r\nbody");
  }),
);

it.effect("attachments download from $value, skipping inline parts", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /me/messages/m1/attachments": {
        json: {
          value: [
            { id: "logo", name: "logo.png", isInline: true },
            { id: "A1", name: "报价.xlsx", isInline: false },
          ],
        },
      },
      "GET /me/messages/m1/attachments/A1/$value": { text: "xlsx-bytes" },
    });
    const bytes = yield* run(http, (a) =>
      a.fetchAttachment(account, "m1", { index: 0, filename: "报价.xlsx", occurrence: 0 }),
    );
    assert.strictEqual(Buffer.from(bytes).toString(), "xlsx-bytes");
  }),
);

const chineseOriginal = Buffer.from(
  "From: li@x.com\r\nSubject: =?UTF-8?B?5Y6f6YKu5Lu2?=\r\nContent-Type: text/plain; charset=utf-8\r\n" +
    "Content-Transfer-Encoding: 8bit\r\n\r\n你好，这是原来的邮件。\r\n",
);

it.effect("a forwarded original goes out as raw MIME with a message/rfc822 part", () =>
  Effect.gen(function* () {
    const http = fakeHttp({ "POST /me/sendMail": { status: 202 } });
    const eml = {
      filename: "报价.eml",
      mimeType: "message/rfc822",
      content: chineseOriginal.toString("base64"),
    };
    yield* run(http, (a) =>
      a.send(
        account,
        { ...draftMessage, bcc: [{ name: "", address: "hidden@x.com" }], attachments: [eml] },
        Option.none(),
      ),
    );
    const [call] = http.calls;
    assert.strictEqual(call?.contentType, "text/plain");
    assert.strictEqual(typeof call?.body, "string");
    const parsed = yield* Effect.promise(() =>
      simpleParser(Buffer.from(String(call?.body), "base64")),
    );
    assert.strictEqual(parsed.subject, "报价");
    assert.strictEqual(parsed.text?.trim(), "草稿");
    // Graph reads Bcc from the MIME headers and strips it.
    assert.match(Buffer.from(String(call?.body), "base64").toString(), /^Bcc: hidden@x\.com/m);
    const forwarded = parsed.attachments.find((a) => a.contentType === "message/rfc822");
    assert.strictEqual(forwarded?.filename, "报价.eml");
    assert.isTrue(forwarded?.content.equals(chineseOriginal));
    const inner = yield* Effect.promise(() => simpleParser(forwarded.content));
    assert.strictEqual(inner.subject, "原邮件");
    assert.strictEqual(inner.text?.trim(), "你好，这是原来的邮件。");
  }),
);

it.effect("an HTML body goes to Graph as a document that declares UTF-8", () =>
  Effect.gen(function* () {
    const http = fakeHttp({ "POST /me/sendMail": { status: 202 } });
    yield* run(http, (a) =>
      a.send(
        account,
        {
          ...draftMessage,
          subject: "粗体 和 code",
          text: "**粗体** 和 `code`",
          html: "<p><strong>粗体</strong> 和 <code>code</code></p>",
        },
        Option.none(),
      ),
    );
    const [call] = http.calls;
    assert.strictEqual(call?.contentType, "application/json");
    const { message } = Schema.decodeUnknownSync(
      Schema.Struct({
        message: Schema.Struct({
          subject: Schema.String,
          body: Schema.Struct({ contentType: Schema.String, content: Schema.String }),
        }),
      }),
    )(call?.body);
    assert.strictEqual(message.subject, "粗体 和 code");
    assert.strictEqual(message.body.contentType, "html");
    assert.match(
      message.body.content,
      /^<!DOCTYPE html><html><head><meta http-equiv="Content-Type" content="text\/html; charset=utf-8"><\/head><body><p><strong>粗体<\/strong> 和/,
    );
  }),
);

it.effect("a dropped connection is retried, not reported", () =>
  Effect.gen(function* () {
    let calls = 0;
    // Fails twice at the transport level, then answers.
    const client = HttpClient.make((request) =>
      Effect.suspend(() =>
        ++calls <= 2
          ? Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request, description: "offline" }),
              }),
            )
          : Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })),
            ),
      ),
    );
    const http = { layer: Layer.succeed(HttpClient.HttpClient)(client), calls: [] };
    yield* run(http, (adapter) =>
      Effect.gen(function* () {
        const fiber = yield* adapter
          .push(account, "m1", { kind: "read", value: true })
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("2 seconds");
        yield* Fiber.join(fiber);
      }),
    );
    assert.strictEqual(calls, 3);
  }),
);

it.effect("Graph search uses $search, immutable IDs and the selected folder", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /me/mailFolders": { json: { value: [] } },
      "GET /me/mailFolders/inbox": { json: { id: "inbox-id" } },
      "GET /me/mailFolders/inbox/messages": (url) => {
        assert.ok(url.searchParams.get("$search")?.includes("from:"));
        assert.strictEqual(url.searchParams.has("$filter"), false);
        return { json: { value: [{ ...raw, parentFolderId: "inbox-id", hasAttachments: false }] } };
      },
    });
    const page = yield* run(http, (a) =>
      a.search(account, { search: "from:wang is:unread", searchScope: "folder", mailbox: "inbox" }),
    );
    assert.strictEqual(page.messages.length, 1);
    assert.ok(page.messages[0]?.labels.includes("INBOX"));
    assert.strictEqual(http.calls.at(-1)?.prefer, 'IdType="ImmutableId"');
  }),
);

it.effect("Graph creates child folders, renames and deletes without losing empty folders", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /me/mailFolders": {
        json: {
          value: [{ id: "child", displayName: "Child", childFolderCount: 0, totalItemCount: 0 }],
        },
      },
      "POST /me/mailFolders/parent/childFolders": { json: { id: "child" } },
      "PATCH /me/mailFolders/child": { json: { id: "child" } },
      "DELETE /me/mailFolders/child": { status: 204 },
    });
    yield* run(http, (a) =>
      Effect.gen(function* () {
        const labels = yield* a.changeLabel(account, {
          kind: "create",
          name: "Child",
          parentId: "parent",
        });
        assert.strictEqual(labels[0]?.name, "Child");
        yield* a.changeLabel(account, { kind: "rename", id: "child", name: "Renamed" });
        yield* a.changeLabel(account, { kind: "delete", id: "child" });
      }),
    );
    assert.deepStrictEqual(http.calls.find((c) => c.method === "POST")?.body, {
      displayName: "Child",
    });
    assert.deepStrictEqual(http.calls.find((c) => c.method === "PATCH")?.body, {
      displayName: "Renamed",
    });
  }),
);

it.effect("Graph inbox rules map conditions and actions, allocate sequence, and delete", () =>
  Effect.gen(function* () {
    const rule = {
      id: "r1",
      displayName: "Reports",
      sequence: 5,
      conditions: { senderContains: ["alice"], subjectContains: ["Report"], hasAttachments: true },
      actions: { markAsRead: true, moveToFolder: "archive-id" },
    };
    const http = fakeHttp({
      "GET /me/mailFolders/inbox/messageRules": { json: { value: [rule] } },
      "POST /me/mailFolders/inbox/messageRules": { json: rule },
      "GET /me/mailFolders/archive": { json: { id: "archive-id" } },
      "DELETE /me/mailFolders/inbox/messageRules/r1": { status: 204 },
    });
    yield* run(http, (a) =>
      Effect.gen(function* () {
        assert.strictEqual((yield* a.filters(account))[0]?.name, "Reports");
        yield* a.createFilter(account, {
          name: "Reports",
          criteria: { from: "alice", to: "", subject: "Report", query: "", hasAttachment: true },
          action: { archive: true, markRead: true, star: false, trash: false, label: null },
        });
        yield* a.deleteFilter(account, "r1");
      }),
    );
    assert.deepStrictEqual(http.calls.find((c) => c.method === "POST")?.body, {
      displayName: "Reports",
      sequence: 6,
      isEnabled: true,
      conditions: rule.conditions,
      actions: rule.actions,
    });
  }),
);

it.effect("Graph scheduled automatic replies use UTC dates and contacts-only", () =>
  Effect.gen(function* () {
    const settings = {
      status: "scheduled",
      scheduledStartDateTime: { dateTime: "2026-09-30T09:00:00.000", timeZone: "UTC" },
      scheduledEndDateTime: { dateTime: "2026-10-01T09:00:00.000", timeZone: "UTC" },
      externalAudience: "contactsOnly",
      internalReplyMessage: "<p>Back tomorrow</p>",
      externalReplyMessage: "<p>Back tomorrow</p>",
    };
    const http = fakeHttp({
      "GET /me/mailboxSettings/automaticRepliesSetting": { json: settings },
      "PATCH /me/mailboxSettings": { status: 204 },
    });
    yield* run(http, (a) =>
      Effect.gen(function* () {
        const v = yield* a.vacation(account);
        assert.strictEqual(v.start, Date.parse("2026-09-30T09:00:00Z"));
        assert.strictEqual(v.body, "Back tomorrow");
        yield* a.setVacation(account, v);
      }),
    );
    const body = Schema.decodeUnknownSync(
      Schema.Struct({
        automaticRepliesSetting: Schema.Struct({
          externalAudience: Schema.String,
          status: Schema.String,
          scheduledStartDateTime: Schema.Struct({
            dateTime: Schema.String,
            timeZone: Schema.String,
          }),
        }),
      }),
    )(http.calls.at(-1)?.body);
    assert.strictEqual(body.automaticRepliesSetting.externalAudience, "contactsOnly");
    assert.strictEqual(body.automaticRepliesSetting.status, "scheduled");
    assert.deepStrictEqual(
      body.automaticRepliesSetting.scheduledStartDateTime,
      settings.scheduledStartDateTime,
    );
  }),
);

it.effect("missing Graph settings scope does not block reading mail", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /me/mailFolders/inbox/messageRules": { status: 403, json: { error: "AccessDenied" } },
      "GET /me/messages/m1/$value": { text: "mail still works" },
    });
    yield* run(http, (a) =>
      Effect.gen(function* () {
        assert.strictEqual(
          (yield* a.filters(account).pipe(Effect.flip))._tag,
          "SettingsScopeMissing",
        );
        assert.strictEqual(
          Buffer.from(yield* a.fetchRaw(account, "m1")).toString(),
          "mail still works",
        );
      }),
    );
  }),
);

it.effect("personal Outlook consent adds MailboxSettings.ReadWrite and stays on consumers", () => {
  const http = fakeHttp({
    "GET /me": { json: { mail: account.email, userPrincipalName: account.email } },
  });
  return run(http, (a) => a.connect({ provider: "outlook" }), {
    config: { microsoft: { clientId: "client" } },
    oauth: {
      authorize: (req) =>
        Effect.sync(() => {
          assert.ok(req.scopes.includes("MailboxSettings.ReadWrite"));
          assert.ok(req.scopes.includes("Mail.ReadWrite"));
          for (const scope of ["Calendars.ReadWrite", "Contacts.Read", "People.Read"])
            assert.ok(req.scopes.includes(scope));
          assert.ok(req.authUrl.includes("/consumers/"));
          return {
            accessToken: "access-token",
            refreshToken: Option.some("refresh-token"),
            expiresIn: 3600,
          };
        }),
    },
  });
});

it.effect(
  "Outlook vacation saves preserve all three audiences and the distinct internal HTML",
  () =>
    Effect.gen(function* () {
      for (const audience of ["none", "contactsOnly", "all"]) {
        const internal = "<p>Internal <b>reply</b></p>";
        const external = "<p>External reply</p>";
        const http = fakeHttp({
          "GET /me/mailboxSettings/automaticRepliesSetting": {
            json: {
              status: "alwaysEnabled",
              externalAudience: audience,
              internalReplyMessage: internal,
              externalReplyMessage: external,
            },
          },
          "PATCH /me/mailboxSettings": { status: 204 },
        });
        yield* run(http, (a) =>
          Effect.gen(function* () {
            const value = yield* a.vacation(account);
            yield* a.setVacation(account, { ...value, enabled: false });
          }),
        );
        const body = Schema.decodeUnknownSync(
          Schema.Struct({
            automaticRepliesSetting: Schema.Struct({
              externalAudience: Schema.String,
              internalReplyMessage: Schema.String,
              externalReplyMessage: Schema.String,
            }),
          }),
        )(http.calls.at(-1)?.body);
        assert.strictEqual(body.automaticRepliesSetting.externalAudience, audience);
        assert.strictEqual(body.automaticRepliesSetting.internalReplyMessage, internal);
        assert.strictEqual(body.automaticRepliesSetting.externalReplyMessage, external);
      }
    }),
);

it.effect(
  "Outlook server search ignores skipped or unmapped folders before fetching attachments",
  () => {
    const http = fakeHttp({
      "GET /me/mailFolders": { json: { value: [] } },
      "GET /me/mailFolders/inbox": { json: { id: "inbox-id" } },
      "GET /me/messages": {
        json: {
          value: [
            { ...raw, id: "outbox-copy", parentFolderId: "outbox-id" },
            { ...raw, id: "inbox-copy", parentFolderId: "inbox-id", hasAttachments: false },
          ],
        },
      },
    });
    return run(http, (a) => a.search(account, { search: "from:wang" })).pipe(
      Effect.tap((page) =>
        Effect.sync(() => {
          assert.deepStrictEqual(
            page.messages.map((m) => m.providerId),
            ["inbox-copy"],
          );
          assert.ok(!http.calls.some((c) => c.url.pathname.includes("/attachments")));
        }),
      ),
    );
  },
);

it.effect(
  "Outlook legacy vacation callers cannot widen external audience or replace internal replies",
  () => {
    const internal = "<p>Internal only</p>";
    const http = fakeHttp({
      "GET /me/mailboxSettings/automaticRepliesSetting": {
        json: {
          status: "alwaysEnabled",
          externalAudience: "none",
          internalReplyMessage: internal,
          externalReplyMessage: "<p>External</p>",
        },
      },
      "PATCH /me/mailboxSettings": { status: 204 },
    });
    return run(http, (a) =>
      a.setVacation(account, {
        enabled: false,
        start: null,
        end: null,
        subject: "",
        body: "External",
        contactsOnly: false,
      }),
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const body = Schema.decodeUnknownSync(
            Schema.Struct({
              automaticRepliesSetting: Schema.Struct({
                externalAudience: Schema.String,
                internalReplyMessage: Schema.String,
              }),
            }),
          )(http.calls.at(-1)?.body);
          assert.strictEqual(body.automaticRepliesSetting.externalAudience, "none");
          assert.strictEqual(body.automaticRepliesSetting.internalReplyMessage, internal);
        }),
      ),
    );
  },
);

it.effect(
  "media raw size uses body and inline attachment metadata before Graph MIME download",
  () =>
    Effect.gen(function* () {
      let rawCalls = 0;
      const http = fakeHttp({
        "GET /me/messages/m1": { json: { body: { content: '<img src="cid:large">' } } },
        "GET /me/messages/m1/attachments": { json: { value: [{ size: 10_000_000 }] } },
        "GET /me/messages/m1/$value": () => {
          rawCalls++;
          return { text: "body" };
        },
      });
      const result = yield* run(http, (adapter) =>
        adapter.fetchRaw(account, "m1", 8 * 1024 * 1024),
      ).pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(rawCalls, 0);
    }),
);

it.effect(
  "Graph contacts and people pagination merge saved names and reject external next links",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "GET /me/contacts": (url) =>
          url.searchParams.has("$skiptoken")
            ? {
                json: {
                  value: [
                    { displayName: "Second", emailAddresses: [{ address: "second@example.com" }] },
                  ],
                },
              }
            : {
                json: {
                  value: [
                    { displayName: "Saved", emailAddresses: [{ address: "ONE@example.com" }] },
                  ],
                  "@odata.nextLink": `${GRAPH}/me/contacts?$skiptoken=second`,
                },
              },
        "GET /me/people": (url) =>
          url.searchParams.has("$skiptoken")
            ? { json: { value: [{ scoredEmailAddresses: [{ address: "last@example.com" }] }] } }
            : {
                json: {
                  value: [
                    {
                      displayName: "Recent",
                      scoredEmailAddresses: [{ address: "one@example.com" }],
                    },
                  ],
                  "@odata.nextLink": `${GRAPH}/me/people?$skiptoken=last`,
                },
              },
      });
      assert.deepStrictEqual(yield* run(http, (a) => a.contacts(account)), [
        { name: "Saved", address: "one@example.com" },
        { name: "Second", address: "second@example.com" },
        { name: "", address: "last@example.com" },
      ]);
      assert.strictEqual(http.calls.length, 4);
      const bad = fakeHttp({
        "GET /me/contacts": { json: { value: [], "@odata.nextLink": "https://example.com/steal" } },
      });
      const result = yield* run(bad, (a) => a.contacts(account)).pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(bad.calls.length, 1);
    }),
);

it.effect("Graph responds through accept/tentativelyAccept/decline on the related occurrence", () =>
  Effect.gen(function* () {
    const [parsed] = parseCalendar(
      "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:uid\r\nDTSTART:20261001T090000Z\r\nRECURRENCE-ID:20261001T090000Z\r\nORGANIZER:mailto:alice@example.com\r\nATTENDEE:mailto:me@outlook.com\r\nEND:VEVENT\r\nEND:VCALENDAR",
    );
    assert.ok(parsed);
    const http = fakeHttp({
      "GET /me/messages/m1": (url) => {
        assert.strictEqual(url.searchParams.get("$expand"), "microsoft.graph.eventMessage/event");
        return {
          json: {
            event: {
              id: "occurrence",
              organizer: { emailAddress: { address: "alice@example.com" } },
            },
          },
        };
      },
      "POST /me/events/occurrence/accept": { status: 202 },
      "POST /me/events/occurrence/tentativelyAccept": { status: 202 },
      "POST /me/events/occurrence/decline": { status: 202 },
    });
    for (const response of ["accepted", "tentative", "declined"] as const)
      yield* run(http, (a) => a.respondInvite(account, "m1", parsed.invite, response));
    const writes = http.calls.filter((c) => c.method === "POST");
    assert.deepStrictEqual(
      writes.map((c) => c.url.pathname),
      [
        "/v1.0/me/events/occurrence/accept",
        "/v1.0/me/events/occurrence/tentativelyAccept",
        "/v1.0/me/events/occurrence/decline",
      ],
    );
    for (const c of writes) assert.deepStrictEqual(c.body, { sendResponse: true });
  }),
);

it.effect("Graph missing contacts/calendar grants are typed independently from mail auth", () =>
  Effect.gen(function* () {
    const [parsed] = parseCalendar(
      "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:uid\r\nDTSTART:20261001T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR",
    );
    assert.ok(parsed);
    const forbidden = {
      status: 403,
      json: { error: { code: "ErrorAccessDenied", message: "Access is denied" } },
    };
    const http = fakeHttp({ "GET /me/contacts": forbidden, "GET /me/messages/m1": forbidden });
    for (const feature of ["contacts", "calendar"] as const) {
      const result = yield* run(http, (a) =>
        feature === "contacts"
          ? a.contacts(account).pipe(Effect.asVoid)
          : a.respondInvite(account, "m1", parsed.invite, "accepted"),
      ).pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.strictEqual(result.failure._tag, "FeatureScopeMissing");
        if (result.failure._tag === "FeatureScopeMissing")
          assert.strictEqual(result.failure.feature, feature);
      }
    }
    assert.ok(!http.calls.some((c) => c.method === "POST"));
  }),
);

it.effect(
  "Graph resolves a plain .ics by escaped UID, and does not respond to a cancelled linked event",
  () =>
    Effect.gen(function* () {
      const [parsed] = parseCalendar(
        "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:uid'quoted\r\nDTSTART:20261001T090000Z\r\nORGANIZER:mailto:alice@example.com\r\nATTENDEE:mailto:me@outlook.com\r\nEND:VEVENT\r\nEND:VCALENDAR",
      );
      assert.ok(parsed);
      const event = { id: "e1", organizer: { emailAddress: { address: "alice@example.com" } } };
      const http = fakeHttp({
        "GET /me/messages/m1": {
          json: { event: { ...event, id: "unrelated", iCalUId: "different-uid" } },
        },
        "GET /me/events": (url) => {
          assert.strictEqual(url.searchParams.get("$filter"), "iCalUId eq 'uid''quoted'");
          return { json: { value: [event] } };
        },
        "POST /me/events/e1/decline": { status: 202 },
      });
      yield* run(http, (a) => a.respondInvite(account, "m1", parsed.invite, "declined"));
      assert.ok(http.calls.some((c) => c.url.pathname === "/v1.0/me/events/e1/decline"));
      const cancelled = fakeHttp({
        "GET /me/messages/m1": { json: { event: { ...event, isCancelled: true } } },
      });
      assert.strictEqual(
        (yield* run(cancelled, (a) =>
          a.respondInvite(account, "m1", parsed.invite, "accepted"),
        ).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.ok(!cancelled.calls.some((c) => c.method === "POST"));
    }),
);

it.effect(
  "Graph mutations return authoritative folder IDs and names while list endpoints still lag",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "GET /me/mailFolders": {
          json: {
            value: [
              { id: "parent", displayName: "Projects", childFolderCount: 0, totalItemCount: 0 },
            ],
          },
        },
        "POST /me/mailFolders/parent/childFolders": {
          status: 201,
          json: { id: "new-folder", displayName: "Test" },
        },
        "PATCH /me/mailFolders/new-folder": { json: { id: "new-folder", displayName: "Renamed" } },
        "DELETE /me/mailFolders/new-folder": { status: 204 },
      });
      yield* run(http, (a) =>
        Effect.gen(function* () {
          const created = yield* a.changeLabel(account, {
            kind: "create",
            parentId: "parent",
            name: "Test",
          });
          assert.deepStrictEqual(
            created.find((l) => l.id === "new-folder"),
            { id: "new-folder", name: "Projects/Test", color: null },
          );
          const renamed = yield* a.changeLabel(account, {
            kind: "rename",
            id: "new-folder",
            name: "Renamed",
          });
          assert.strictEqual(renamed.find((l) => l.id === "new-folder")?.name, "Projects/Renamed");
          const removed = yield* a.changeLabel(account, { kind: "delete", id: "new-folder" });
          assert.ok(!removed.some((l) => l.id === "new-folder"));
        }),
      );
    }),
);

it.effect("Graph folder creation does not depend on a follow-up listing to retain the new ID", () =>
  Effect.gen(function* () {
    let created = false;
    const http = fakeHttp({
      "GET /me/mailFolders": () =>
        created ? { status: 403, json: { error: "listing unavailable" } } : { json: { value: [] } },
      "POST /me/mailFolders": () => {
        created = true;
        return { status: 201, json: { id: "new-id", displayName: "New" } };
      },
    });
    const labels = yield* run(http, (a) => a.changeLabel(account, { kind: "create", name: "New" }));
    assert.deepStrictEqual(labels, [{ id: "new-id", name: "New", color: null }]);
    assert.strictEqual(http.calls.at(-1)?.method, "POST");
  }),
);

it.effect("inbox polling follows only its delta and skips folder discovery", () =>
  Effect.gen(function* () {
    const inbox = `${GRAPH}/me/mailFolders/inbox/messages/delta?$deltatoken=before`;
    const next = `${GRAPH}/me/mailFolders/inbox/messages/delta?$deltatoken=after`;
    const http = fakeHttp({
      "GET /me/mailFolders/inbox/messages/delta": {
        json: { value: [{ ...raw, hasAttachments: false }], "@odata.deltaLink": next },
      },
    });
    const cursor = JSON.stringify({ __idType: "immutable", inbox, sentitems: "unrelated" });
    const changes = yield* run(http, (adapter) =>
      Stream.runCollect(adapter.pull(account, Option.some(cursor), "inbox")),
    );
    assert.deepStrictEqual(tags(changes), ["Upsert", "Progress", "Cursor"]);
    assert.strictEqual(http.calls.length, 1);
    assert.strictEqual(http.calls[0]?.url.toString(), inbox);
    assert.deepStrictEqual(changes.at(-1), {
      _tag: "Cursor",
      cursor: JSON.stringify({ __idType: "immutable", inbox: next }),
    });
  }),
);

it.effect("Graph backfill follows nextLink, maps folders, and refuses foreign continuations", () =>
  Effect.gen(function* () {
    const next = `${GRAPH}/me/messages?$skiptoken=older`;
    const http = fakeHttp({
      ...mailbox({}),
      "GET /me/messages/AAMk123": {
        json: { ...raw, hasAttachments: false, parentFolderId: "id-inbox" },
      },
      "GET /me/messages": (url) => ({
        json: {
          value: [{ ...raw, hasAttachments: false, parentFolderId: "id-inbox" }],
          ...(url.searchParams.has("$skiptoken") ? {} : { "@odata.nextLink": next }),
        },
      }),
    });
    yield* run(http, (adapter) =>
      Effect.gen(function* () {
        const first = yield* adapter.backfill(account, { cursor: null, before: 1_700_000_000_000 });
        assert.strictEqual(first.cursor, next);
        assert.ok(first.messages[0]?.labels.includes("INBOX"));
        const second = yield* adapter.backfill(account, {
          cursor: first.cursor,
          before: 1_700_000_000_000,
        });
        assert.strictEqual(second.cursor, null);
        const foreign = yield* Effect.result(
          adapter.backfill(account, { cursor: "https://fake.invalid/steal", before: 0 }),
        );
        assert.strictEqual(foreign._tag, "Failure");
      }),
    );
    const lists = http.calls.filter((c) => c.url.pathname.endsWith("/me/messages"));
    assert.strictEqual(lists[0]?.url.searchParams.get("$orderby"), "receivedDateTime desc");
    assert.strictEqual(
      lists[0]?.url.searchParams.get("$filter"),
      "receivedDateTime lt 2023-11-14T22:13:20.000Z",
    );
    assert.strictEqual(lists[1]?.url.searchParams.get("$skiptoken"), "older");
    assert.ok(http.calls.every((c) => c.url.origin === "https://graph.microsoft.com"));
  }),
);

it.effect(
  "Graph backfill lists headers first and never fetches cached/pending bodies or attachments",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        ...mailbox({}),
        "GET /me/messages": (url) => {
          assert.strictEqual(url.searchParams.get("$select"), "id,receivedDateTime");
          return { json: { value: [{ id: "cached" }, { id: "pending" }, { id: "missing" }] } };
        },
        "GET /me/messages/missing": {
          json: { ...raw, id: "missing", parentFolderId: "id-inbox", hasAttachments: false },
        },
      });
      const page = yield* run(http, (a) =>
        a.backfill(account, { cursor: null, before: 1_700_000_000_000 }, (ids) => {
          assert.deepStrictEqual(ids, ["cached", "pending", "missing"]);
          return Effect.succeed(["missing"]);
        }),
      );
      assert.strictEqual(page.scanned, 3);
      assert.deepStrictEqual(
        page.messages.map((m) => m.providerId),
        ["missing"],
      );
      assert.ok(
        !http.calls.some((c) => /messages\/(cached|pending)|\/attachments/.test(c.url.pathname)),
      );
    }),
);

it.effect("Graph fetch selects and decodes the full Reply-To recipient collection", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /me/messages/reply": {
        json: {
          ...raw,
          id: "reply",
          hasAttachments: false,
          parentFolderId: "inbox",
          replyTo: [
            { emailAddress: { name: "Reply, Team", address: "reply@example.com" } },
            { emailAddress: { address: "other@example.com" } },
          ],
        },
      },
    });
    const parsed = yield* run(http, (adapter) => adapter.fetchMessage(account, "reply"));
    assert.deepStrictEqual(parsed.replyTo, [
      { name: "Reply, Team", address: "reply@example.com" },
      { name: "", address: "other@example.com" },
    ]);
    const request = http.calls.find((call) => call.url.pathname.endsWith("/messages/reply"));
    assert.ok(request);
    assert.ok(request.url.searchParams.get("$select")?.split(",").includes("replyTo"));
    assert.deepStrictEqual(parseGraphMessage(raw, "INBOX", []).replyTo, []);
    assert.deepStrictEqual(parseGraphMessage({ ...raw, replyTo: [] }, "INBOX", []).replyTo, []);
  }),
);

it.effect("Graph reply drafts replace server defaults with the selected Reply-To targets", () =>
  Effect.gen(function* () {
    const incoming = parseGraphMessage(
      {
        ...raw,
        replyTo: [
          { emailAddress: { name: "Reply", address: "reply@example.com" } },
          { emailAddress: { address: "ALIAS@outlook.com" } },
        ],
        toRecipients: [
          ...raw.toRecipients,
          { emailAddress: { name: "Other", address: "other@example.com" } },
        ],
        ccRecipients: [{ emailAddress: { name: "Duplicate", address: "OTHER@example.com" } }],
      },
      "INBOX",
      [],
    );
    const graphRecipient = Schema.Struct({
      emailAddress: Schema.Struct({ name: Schema.String, address: Schema.String }),
    });
    const decodeTargets = Schema.decodeUnknownSync(
      Schema.Struct({
        toRecipients: Schema.Array(graphRecipient),
        ccRecipients: Schema.Array(graphRecipient),
        bccRecipients: Schema.Array(graphRecipient),
      }),
    );
    for (const mode of ["reply", "replyAll"] as const) {
      const action = mode === "reply" ? "createReply" : "createReplyAll";
      const http = fakeHttp({
        [`POST /me/messages/orig/${action}`]: { json: { id: "draft" } },
        "PATCH /me/messages/draft": { json: {} },
        "POST /me/messages/draft/send": { status: 202 },
      });
      yield* run(http, (adapter) =>
        adapter.send(
          account,
          {
            ...replyRecipients(incoming, [account.email, "alias@outlook.com"], mode === "replyAll"),
            bcc: [],
            subject: "Re: Question",
            text: "Answer",
            attachments: [],
            mode,
          },
          Option.some({ providerId: "orig", threadId: "conv-1" }),
        ),
      );
      const patch = http.calls.find((call) => call.method === "PATCH");
      assert.ok(patch);
      assert.deepStrictEqual(decodeTargets(patch.body), {
        toRecipients: [{ emailAddress: { name: "Reply", address: "reply@example.com" } }],
        ccRecipients:
          mode === "replyAll"
            ? [{ emailAddress: { name: "Other", address: "other@example.com" } }]
            : [],
        bccRecipients: [],
      });
    }
  }),
);

it.effect(
  "Graph search outer wrapping roundtrips KQL values containing quotes and backslashes",
  () =>
    Effect.gen(function* () {
      const value = 'Alice "private" \\ archive';
      const query = {
        search: `from:${JSON.stringify(value)} subject:${JSON.stringify(value)} after:2026-10-02`,
      };
      const http = fakeHttp({
        "GET /me/mailFolders": { json: { value: [] } },
        "GET /me/messages": (url) => {
          const wrapped = url.searchParams.get("$search");
          assert.ok(wrapped);
          const kql = Schema.decodeUnknownSync(Schema.String)(JSON.parse(wrapped));
          assert.strictEqual(
            kql,
            `from:${JSON.stringify(value)} AND subject:${JSON.stringify(value)} AND received>=${new Date(2026, 9, 2).toISOString()}`,
          );
          return { json: { value: [] } };
        },
      });
      yield* run(http, (adapter) => adapter.search(account, query));
      assert.ok(http.calls.some((call) => call.url.pathname.endsWith("/me/messages")));
    }),
);

it.effect("folder actions follow Graph pages and POST permanentDelete with immutable ids", () => {
  const http = fakeHttp({
    "POST /consumers/oauth2/v2.0/token": { json: { access_token: "token", expires_in: 3600 } },
    "GET /me/mailFolders/deleteditems/messages": (url) => ({
      json: url.searchParams.has("$skip")
        ? { value: [{ id: "b" }] }
        : {
            value: [{ id: "a" }],
            "@odata.nextLink": `${GRAPH}/me/mailFolders/deleteditems/messages?$skip=1`,
          },
    }),
    "POST /me/messages/a/permanentDelete": { status: 204 },
    "POST /me/messages/b/permanentDelete": { status: 404 },
    "GET /me/mailFolders/deleteditems": { json: { id: "trash-root" } },
    "GET /me/mailFolders/trash-root/childFolders": { json: { value: [] } },
    "GET /me/messages/a": { json: { parentFolderId: "trash-root" } },
    "GET /me/messages/b": { json: { parentFolderId: "trash-root" } },
  });
  return run(http, (adapter) =>
    Effect.gen(function* () {
      const folder = { mailbox: "trash" } as const;
      const first = yield* adapter.listFolderMessages(account, folder, null);
      assert.deepStrictEqual(first.ids, ["a"]);
      assert.deepStrictEqual(yield* adapter.listFolderMessages(account, folder, first.next), {
        ids: ["b"],
        next: null,
      });
      yield* adapter.permanentlyDelete(account, ["a", "b"], "trash");
      assert.strictEqual(
        http.calls.filter((c) => c.url.pathname.endsWith("permanentDelete")).length,
        2,
      );
      assert.ok(
        http.calls
          .filter((c) => c.url.pathname.endsWith("permanentDelete"))
          .every((c) => c.method === "POST" && c.prefer === 'IdType="ImmutableId"'),
      );
      for (const cursor of [
        "https://evil.example/v1.0/me/mailFolders/deleteditems/messages",
        `${GRAPH}/me/messages?$skip=2`,
      ])
        assert.isTrue(
          (yield* adapter.listFolderMessages(account, folder, cursor).pipe(Effect.result))._tag ===
            "Failure",
        );
      assert.isFalse(http.calls.some((c) => c.url.hostname === "evil.example"));
      assert.isTrue(
        (yield* adapter
          .permanentlyDelete(
            account,
            Array.from({ length: 101 }, () => "a"),
            "trash",
          )
          .pipe(Effect.result))._tag === "Failure",
      );
    }),
  );
});

it.effect(
  "Outlook unread enumeration filters server-side and empty Trash includes nested and hidden child folders",
  () => {
    const http = fakeHttp({
      "POST /consumers/oauth2/v2.0/token": { json: { access_token: "token", expires_in: 3600 } },
      "GET /me/mailFolders/inbox/messages": (url) => {
        assert.strictEqual(url.searchParams.get("$filter"), "isRead eq false");
        return { json: { value: [{ id: "unread" }] } };
      },
      "GET /me/mailFolders/deleteditems/messages": { json: { value: [] } },
      "GET /me/mailFolders/deleteditems/childFolders": (url) => {
        if (url.searchParams.has("$skip")) return { json: { value: [] } };
        assert.strictEqual(url.searchParams.get("includeHiddenFolders"), "true");
        return {
          json: {
            value: [{ id: "child" }],
            "@odata.nextLink": `${GRAPH}/me/mailFolders/deleteditems/childFolders?$skip=1`,
          },
        };
      },
      "GET /me/mailFolders/child/messages": { json: { value: [] } },
      "GET /me/mailFolders/child/childFolders": { json: { value: [{ id: "nested" }] } },
      "GET /me/mailFolders/nested/messages": { json: { value: [{ id: "nested-mail" }] } },
    });
    return run(http, (adapter) =>
      Effect.gen(function* () {
        yield* adapter.listFolderMessages(account, { mailbox: "inbox" }, null, {
          unreadOnly: true,
        });
        assert.deepStrictEqual(
          yield* adapter.listFolderMessages(account, { mailbox: "trash" }, null, {
            includeChildren: true,
          }),
          { ids: ["nested-mail"], next: null },
        );
      }),
    );
  },
);

it.effect("Outlook marks read with bounded concurrency and immutable IDs", () => {
  let active = 0;
  let maximum = 0;
  let count = 0;
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      if (request.method === "PATCH") {
        active++;
        maximum = Math.max(maximum, active);
        assert.strictEqual(request.headers.prefer, 'IdType="ImmutableId"');
        yield* Effect.yieldNow;
        active--;
        count++;
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }));
      }
      return HttpClientResponse.fromWeb(
        request,
        Response.json({ access_token: "token", expires_in: 3600 }),
      );
    }),
  );
  return makeOutlook.pipe(
    Effect.flatMap((adapter) =>
      adapter.markReadBatch(
        account,
        Array.from({ length: 20 }, (_, i) => String(i)),
      ),
    ),
    Effect.tap(() =>
      Effect.sync(() => {
        assert.strictEqual(count, 20);
        assert.isTrue(maximum > 1 && maximum <= 5);
      }),
    ),
    Effect.provide(
      Layer.mergeAll(Layer.succeed(HttpClient.HttpClient)(client), MemoryPlatform(platformOptions)),
    ),
  );
});

it.effect(
  "Graph verifies current parent folders, retains restored mail and returns only successful deletions",
  () => {
    const http = fakeHttp({
      "POST /consumers/oauth2/v2.0/token": { json: { access_token: "token", expires_in: 3600 } },
      "GET /me/mailFolders/deleteditems": { json: { id: "trash-root" } },
      "GET /me/mailFolders/trash-root/childFolders": { json: { value: [{ id: "child" }] } },
      "GET /me/mailFolders/child/childFolders": { json: { value: [] } },
      "GET /me/messages/root": { json: { parentFolderId: "trash-root" } },
      "GET /me/messages/child": (url) => {
        assert.strictEqual(url.searchParams.get("$select"), "parentFolderId");
        return { json: { parentFolderId: "child" } };
      },
      "GET /me/messages/restored": { json: { parentFolderId: "inbox" } },
      "GET /me/messages/gone": { status: 404 },
      "POST /me/messages/root/permanentDelete": { status: 204 },
      "POST /me/messages/child/permanentDelete": { status: 204 },
    });
    return run(http, (adapter) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(
          yield* adapter.permanentlyDelete(account, ["root", "child", "restored", "gone"], "trash"),
          { kind: "complete", ids: ["root", "child"] },
        );
        assert.deepStrictEqual(
          http.calls
            .filter(
              (call) => call.method === "POST" && call.url.pathname.endsWith("permanentDelete"),
            )
            .map((call) => call.url.pathname),
          ["/v1.0/me/messages/root/permanentDelete", "/v1.0/me/messages/child/permanentDelete"],
        );
      }),
    );
  },
);

it.effect("Outlook mark-all-read continues after a snapshotted message disappears with 404", () => {
  const http = fakeHttp({
    "POST /consumers/oauth2/v2.0/token": { json: { access_token: "token", expires_in: 3600 } },
    "PATCH /me/messages/gone": { status: 404 },
    "PATCH /me/messages/live": { status: 204 },
  });
  return run(http, (adapter) =>
    Effect.gen(function* () {
      yield* adapter.markReadBatch(account, ["gone", "live"]);
      assert.strictEqual(http.calls.filter((call) => call.method === "PATCH").length, 2);
    }),
  );
});

it.effect(
  "Graph moves a folder under a new parent and retains nested display paths until sync catches up",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "GET /me/mailFolders": {
          json: {
            value: [
              { id: "parent", displayName: "Parent", childFolderCount: 0, totalItemCount: 0 },
              { id: "child", displayName: "Child", childFolderCount: 1, totalItemCount: 0 },
            ],
          },
        },
        "GET /me/mailFolders/child/childFolders": {
          json: {
            value: [
              { id: "nested", displayName: "Nested", childFolderCount: 0, totalItemCount: 0 },
            ],
          },
        },
        "POST /me/mailFolders/child/move": { json: { id: "moved-child" } },
      });
      const labels = yield* run(http, (a) =>
        a.changeLabel(account, { kind: "parent", id: "child", parentId: "parent" }),
      );
      assert.strictEqual(labels.find((l) => l.id === "moved-child")?.name, "Parent/Child");
      assert.strictEqual(
        labels.some((l) => l.id === "child"),
        false,
      );
      assert.strictEqual(labels.find((l) => l.id === "nested")?.name, "Parent/Child/Nested");
      assert.deepStrictEqual(http.calls.find((c) => c.method === "POST")?.body, {
        destinationId: "parent",
      });
    }),
);
it.effect("Graph edits a rule with PATCH without resetting its sequence or enabled state", () =>
  Effect.gen(function* () {
    const original = {
      id: "r1",
      displayName: "Old",
      sequence: 7,
      isEnabled: false,
      conditions: { senderContains: ["alice"] },
      actions: { markAsRead: true },
    };
    const http = fakeHttp({
      "GET /me/mailFolders/inbox/messageRules/r1": { json: original },
      "PATCH /me/mailFolders/inbox/messageRules/r1": { json: { ...original, displayName: "New" } },
    });
    const result = yield* run(http, (a) =>
      a.updateFilter(account, "r1", {
        name: "New",
        criteria: { from: "bob", to: "", subject: "", query: "", hasAttachment: false },
        action: { archive: false, markRead: true, star: false, trash: false, label: null },
      }),
    );
    assert.strictEqual(result.id, "r1");
    assert.deepStrictEqual(
      http.calls.filter((c) => c.method === "PATCH").map((c) => c.body),
      [
        {
          displayName: "New",
          conditions: { senderContains: ["bob"] },
          actions: { markAsRead: true },
        },
      ],
    );
    assert.strictEqual(
      http.calls.some((c) => c.method === "DELETE" || c.method === "POST"),
      false,
    );
  }),
);
it.effect("Graph rejects replacing unsupported compound rule conditions before PATCH", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /me/mailFolders/inbox/messageRules/r1": {
        json: {
          id: "r1",
          displayName: "Compound",
          conditions: { senderContains: ["alice", "bob"], importance: "high" },
          actions: { markAsRead: true },
        },
      },
    });
    const result = yield* run(http, (a) =>
      a
        .updateFilter(account, "r1", {
          name: "Changed",
          criteria: { from: "bob", to: "", subject: "", query: "", hasAttachment: false },
          action: { archive: false, markRead: true, star: false, trash: false, label: null },
        })
        .pipe(Effect.result),
    );
    assert.strictEqual(result._tag, "Failure");
    assert.strictEqual(http.calls.length, 1);
  }),
);

it.effect("Outlook archive-folder rules roundtrip as archive actions and remain deletable", () =>
  Effect.gen(function* () {
    const rule = {
      id: "archive-rule",
      displayName: "Archive",
      conditions: { senderContains: ["alice"] },
      actions: { moveToFolder: "archive-id" },
    };
    const http = fakeHttp({
      "GET /me/mailFolders/archive": { json: { id: "archive-id" } },
      "GET /me/mailFolders/inbox/messageRules": { json: { value: [rule] } },
      "GET /me/mailFolders/inbox/messageRules/archive-rule": { json: rule },
      "PATCH /me/mailFolders/inbox/messageRules/archive-rule": { json: rule },
      "DELETE /me/mailFolders/inbox/messageRules/archive-rule": { status: 204 },
    });
    yield* run(http, (adapter) =>
      Effect.gen(function* () {
        const current = (yield* adapter.filters(account))[0];
        assert.ok(current);
        assert.strictEqual(current.action.archive, true);
        assert.strictEqual(current.action.label, null);
        const edited = yield* adapter.updateFilter(account, current.id, current);
        assert.strictEqual(edited.action.archive, true);
        assert.strictEqual(edited.action.label, null);
        yield* adapter.deleteFilter(account, current.id);
      }),
    );
    assert.deepStrictEqual(http.calls.find((call) => call.method === "PATCH")?.body, {
      displayName: "Archive",
      conditions: { senderContains: ["alice"] },
      actions: { moveToFolder: "archive-id" },
    });
  }),
);

it.effect("Outlook rules with delete and another destination are not offered for editing", () => {
  const actions = [
    { delete: true, moveToFolder: "archive-id" },
    { delete: true, moveToFolder: "custom-id" },
    { delete: true },
    { moveToFolder: "archive-id" },
  ];
  const http = fakeHttp({
    "GET /me/mailFolders/archive": { json: { id: "archive-id" } },
    "GET /me/mailFolders/inbox/messageRules": {
      json: {
        value: actions.map((action, index) => ({
          id: String(index),
          displayName: "Rule",
          conditions: { senderContains: ["alice"] },
          actions: action,
        })),
      },
    },
  });
  return run(http, (adapter) => adapter.filters(account)).pipe(
    Effect.tap((rules) =>
      Effect.sync(() => {
        assert.deepStrictEqual(
          rules.map((rule) => rule.editable !== false),
          [false, false, true, true],
        );
      }),
    ),
  );
});

it.effect("composer draft labels/star patch categories and flag without moving out of Drafts", () =>
  Effect.gen(function* () {
    const http = fakeHttp({ "PATCH /me/messages/draft": { json: {} } });
    yield* run(http, (adapter) =>
      adapter.saveDraft(account, {
        remote: { draftId: "draft", messageId: "draft" },
        original: Option.none(),
        replaceAttachments: false,
        message: {
          ...draftMessage,
          draftOrganization: { labels: ["Work", "Project"], starred: true },
        },
      }),
    );
    const body = Schema.decodeUnknownSync(
      Schema.Struct({
        categories: Schema.Array(Schema.String),
        flag: Schema.Struct({ flagStatus: Schema.String }),
      }),
    )(http.calls[0]?.body);
    assert.deepStrictEqual(body.categories, ["Work", "Project"]);
    assert.deepStrictEqual(body.flag, { flagStatus: "flagged" });
    assert.deepStrictEqual(paths(http.calls), ["PATCH /me/messages/draft"]);
  }),
);

it.effect("body-only Outlook draft patches omit categories/flag and keep external edits", () =>
  Effect.gen(function* () {
    const http = fakeHttp({ "PATCH /me/messages/draft": { json: {} } });
    yield* run(http, (adapter) =>
      adapter.saveDraft(account, {
        remote: { draftId: "draft", messageId: "draft" },
        original: Option.none(),
        replaceAttachments: false,
        message: draftMessage,
      }),
    );
    const fields = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
      http.calls[0]?.body,
    );
    assert.strictEqual(Object.hasOwn(fields, "categories"), false);
    assert.strictEqual(Object.hasOwn(fields, "flag"), false);
  }),
);

it.effect(
  "calendar view preserves local timezone preference and immutable IDs; personal event POST carries no attendees",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "GET /me/calendarView": {
          json: {
            value: [
              {
                id: "busy",
                isAllDay: true,
                start: { dateTime: "2026-10-10T00:00:00", timeZone: "UTC" },
                end: { dateTime: "2026-10-11T00:00:00", timeZone: "UTC" },
              },
            ],
          },
        },
        "POST /me/events": { json: { id: "created" } },
      });
      const event = {
        key: "candidate",
        title: "Train",
        start: { kind: "date", value: "2026-10-10" },
        end: { kind: "date", value: "2026-10-11" },
        location: "Station",
        description: "Ticket",
        recurrence: [],
      } as const;
      yield* run(http, (adapter) =>
        Effect.gen(function* () {
          assert.ok(typeof adapter.calendarEvents === "function");
          assert.ok(typeof adapter.createCalendarEvent === "function");
          assert.deepStrictEqual(
            (yield* adapter.calendarEvents(account, event))[0]?.start,
            event.start,
          );
          yield* adapter.createCalendarEvent(account, event);
        }),
      );
      const read = http.calls.find((call) => call.url.pathname.endsWith("/calendarView"));
      assert.strictEqual(
        read?.prefer,
        `IdType="ImmutableId", outlook.timezone="${Intl.DateTimeFormat().resolvedOptions().timeZone}"`,
      );
      const write = http.calls.find((call) => call.url.pathname.endsWith("/events"));
      assert.deepStrictEqual(write?.body, {
        subject: "Train",
        transactionId: Schema.decodeUnknownSync(Schema.Struct({ transactionId: Schema.String }))(
          write?.body,
        ).transactionId,
        start: {
          dateTime: "2026-10-10T00:00:00",
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        end: {
          dateTime: "2026-10-11T00:00:00",
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        isAllDay: true,
        location: { displayName: "Station" },
        body: { contentType: "text", content: "Ticket" },
      });
    }),
);

it.effect("opaque message and attachment IDs are encoded as individual Graph path segments", () =>
  Effect.gen(function* () {
    const id = "A/B+C==";
    const http = fakeHttp({
      "GET /me/messages/A%2FB%2BC%3D%3D": {
        json: { ...raw, id, parentFolderId: "inbox", hasAttachments: false },
      },
      "GET /me/mailFolders/inbox": { json: { id: "inbox", displayName: "Inbox" } },
    });
    yield* run(http, (adapter) => adapter.fetchMessage(account, id));
    assert.ok(http.calls.some((call) => call.url.pathname === "/v1.0/me/messages/A%2FB%2BC%3D%3D"));
    assert.ok(http.calls.every((call) => !call.url.pathname.includes("/messages/A/")));
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

it.effect("Graph extended rules preserve native word exclusions, size and importance", () =>
  Effect.gen(function* () {
    const rule = {
      id: "extended",
      displayName: "Budget",
      conditions: { bodyOrSubjectContains: ["budget"], withinSizeRange: { minimumSize: 1024 } },
      exceptions: { bodyOrSubjectContains: ["private"] },
      actions: { markImportance: "high", moveToFolder: "destination" },
    };
    const http = fakeHttp({
      "GET /me/mailFolders/inbox/messageRules": { json: { value: [] } },
      "POST /me/mailFolders/inbox/messageRules": { json: rule },
      "GET /me/mailFolders/archive": { json: { id: "archive-id" } },
    });
    const saved = yield* run(http, (adapter) =>
      adapter.createFilter(account, {
        name: "Budget",
        criteria: {
          from: "",
          to: "",
          subject: "",
          query: "",
          hasAttachment: false,
          hasWords: "budget",
          notWords: "private",
          size: 1_048_576,
          sizeComparison: "larger",
        },
        action: {
          archive: false,
          markRead: false,
          star: false,
          trash: false,
          label: "destination",
          important: true,
        },
      }),
    );
    assert.deepStrictEqual(http.calls.find((call) => call.method === "POST")?.body, {
      displayName: "Budget",
      sequence: 1,
      isEnabled: true,
      conditions: rule.conditions,
      exceptions: rule.exceptions,
      actions: rule.actions,
    });
    assert.notStrictEqual(saved.editable, false);
    assert.strictEqual(saved.criteria.hasWords, "budget");
    assert.strictEqual(saved.criteria.notWords, "private");
    assert.strictEqual(saved.criteria.size, 1_048_576);
    assert.strictEqual(saved.action.important, true);
  }),
);

for (const mailbox of ["all", "starred", "important"] as const) {
  it.effect(`Outlook ${mailbox} history paging avoids Graph InefficientFilter`, () => {
    const http = fakeHttp({
      "GET /me/mailFolders/junkemail": { json: { id: "junk" } },
      "GET /me/mailFolders/deleteditems": { json: { id: "trash" } },
      "GET /me/messages": (url) => {
        if (
          url.searchParams.has("$orderby") &&
          !url.searchParams.get("$filter")?.startsWith("receivedDateTime ge ")
        )
          return {
            status: 400,
            json: {
              error: { code: "InefficientFilter", message: "Order property must start filter" },
            },
          };
        return { json: { value: [{ id: "older" }] } };
      },
    });
    return run(http, (adapter) =>
      adapter
        .listFolderMessages(account, { mailbox }, null, { newestFirst: true })
        .pipe(Effect.tap((page) => Effect.sync(() => assert.deepStrictEqual(page.ids, ["older"])))),
    );
  });
}
it.effect("multi-category writes reread server categories and never move the message", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /me/messages/A": { json: { categories: ["Keep", "Old", "Remote"] } },
      "GET /me/outlook/masterCategories": {
        json: { value: [{ displayName: "Work" }, { displayName: "Personal" }] },
      },
      "PATCH /me/messages/A": { json: {} },
    });
    yield* run(http, (adapter) =>
      adapter.push(account, "A", {
        kind: "categories",
        add: ["Work", "Personal", "Work"],
        remove: ["Old"],
      }),
    );
    assert.deepStrictEqual(
      http.calls.map((call) => [call.method, call.url.pathname]),
      [
        ["GET", "/v1.0/me/messages/A"],
        ["GET", "/v1.0/me/outlook/masterCategories"],
        ["PATCH", "/v1.0/me/messages/A"],
      ],
    );
    assert.deepStrictEqual(http.calls[2]?.body, {
      categories: ["Keep", "Remote", "Work", "Personal"],
    });
    assert.deepStrictEqual(
      parseGraphMessage({ ...raw, categories: ["Work", "Personal"] }, "INBOX", []).labels,
      ["INBOX", "category:Work", "category:Personal", "UNREAD", "STARRED"],
    );
  }),
);

it.effect(
  "category names compare case-insensitively and missing master names are created before assignment",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "GET /me/messages/A": { json: { categories: ["Work", "OLD", "Keep"] } },
        "GET /me/outlook/masterCategories": { json: { value: [{ displayName: "Work" }] } },
        "POST /me/outlook/masterCategories": {
          json: { id: "new", displayName: "Personal" },
          status: 201,
        },
        "PATCH /me/messages/A": { json: {} },
      });
      yield* run(http, (adapter) =>
        adapter.push(account, "A", {
          kind: "categories",
          add: ["work", "Personal", "PERSONAL"],
          remove: ["old"],
        }),
      );
      assert.deepStrictEqual(
        http.calls.filter((call) => call.method === "POST").map((call) => call.body),
        [{ displayName: "Personal", color: "none" }],
      );
      assert.deepStrictEqual(http.calls.at(-1)?.body, { categories: ["Work", "Keep", "Personal"] });
    }),
);
it.effect("category registration failure never patches message categories", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /me/messages/A": { json: { categories: ["Keep"] } },
      "GET /me/outlook/masterCategories": { json: { value: [] } },
      "POST /me/outlook/masterCategories": { status: 403 },
      "PATCH /me/messages/A": { json: {} },
    });
    const result = yield* Effect.result(
      run(http, (adapter) =>
        adapter.push(account, "A", { kind: "categories", add: ["Work"], remove: [] }),
      ),
    );
    assert.strictEqual(result._tag, "Failure");
    assert.ok(!http.calls.some((call) => call.method === "PATCH"));
  }),
);
