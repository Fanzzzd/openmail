import { assert, it } from "@effect/vitest";

import { Effect, Fiber, Layer, Option, Schema, Stream } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { simpleParser } from "mailparser";

import type { Account } from "./domain.js";
import { makeOutlook, parseGraphMessage } from "./outlook.js";
import { MemoryPlatform, type MemoryPlatformOptions } from "./platform-memory.js";
import { type Change, type ProviderAdapter, Secrets } from "./services.js";

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
      "Reset",
      "Labels",
      "Upsert",
      "Progress",
      "Delete",
      "Cursor",
    ]);
    assert.deepStrictEqual(changes[1], {
      _tag: "Labels",
      labels: [
        { id: "id-c1", name: "Clients", color: null },
        { id: "id-c2", name: "Clients/Acme", color: null },
      ],
    });
    const upsert = changes[2];
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
      "DeleteLabel",
      "Upsert",
      "Progress",
      "Cursor",
    ]);
    assert.deepStrictEqual(changes[1], { _tag: "DeleteLabel", label: "INBOX" });
    const upsert = changes[2];
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
    const fiber = yield* Effect.forkChild(
      run(http, (a) => a.push(account, "m1", { kind: "read", value: true })),
    );
    yield* TestClock.adjust("2 seconds");
    yield* Fiber.join(fiber);
    assert.strictEqual(calls, 3);
  }),
);
