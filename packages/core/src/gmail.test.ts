import { assert, it } from "@effect/vitest";

import { Effect, Layer, Option, Schema, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import type { Account, OutgoingMessage } from "./domain.js";
import { makeGmail, parseGmailMessage } from "./gmail.js";
import { MemoryPlatform } from "./platform-memory.js";
import type { Change, ProviderAdapter } from "./services.js";

interface Call {
  method: string;
  url: URL;
  body: unknown;
}

const parseJson = (text: string): unknown => JSON.parse(text);

type Reply = { status?: number; json?: unknown };

/**
 * An HttpClient that answers from `routes`, keyed by "METHOD /path" under the
 * Gmail API base. Unknown routes answer 404, like a missing resource.
 */
function fakeHttp(routes: Record<string, Reply | ((url: URL) => Reply)>) {
  const calls: Call[] = [];
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const body =
        request.body._tag === "Uint8Array"
          ? parseJson(new TextDecoder().decode(request.body.body))
          : undefined;
      calls.push({ method: request.method, url, body });
      const path = url.pathname.replace("/gmail/v1/users/me", "");
      const route = routes[`${request.method} ${path}`];
      const reply = typeof route === "function" ? route(url) : (route ?? { status: 404 });
      return HttpClientResponse.fromWeb(
        request,
        new Response(reply.json === undefined ? null : JSON.stringify(reply.json), {
          status: reply.status ?? 200,
        }),
      );
    }),
  );
  return { layer: Layer.succeed(HttpClient.HttpClient)(client), calls };
}

const account: Account = {
  id: "gmail:me@gmail.com",
  provider: "gmail",
  email: "me@gmail.com",
  createdAt: 0,
  lastSyncedAt: null,
  lastSyncError: null,
  profileId: null,
  needsReauth: false,
};

const platform = MemoryPlatform({
  secrets: { [account.id]: "refresh-token" },
  config: { google: { clientId: "client", clientSecret: "secret" } },
});

function run<A, E>(
  http: ReturnType<typeof fakeHttp>,
  f: (adapter: ProviderAdapter) => Effect.Effect<A, E>,
) {
  return makeGmail.pipe(Effect.flatMap(f), Effect.provide(Layer.mergeAll(http.layer, platform)));
}

const b64 = (s: string) => Buffer.from(s).toString("base64url");

const message = (id: string, labelIds: string[]) => ({
  id,
  threadId: `t-${id}`,
  labelIds,
  snippet: "Tom &amp; Jerry",
  internalDate: "1700000000000",
  payload: {
    mimeType: "text/plain",
    headers: [
      { name: "Subject", value: `Subject ${id}` },
      { name: "From", value: "Ann <ann@x.com>" },
    ],
    body: { size: 5, data: b64("hello") },
  },
});

const labels = {
  labels: [
    { id: "INBOX", name: "INBOX", type: "system" },
    { id: "Label_1", name: "Clients", type: "user", color: { backgroundColor: "#fb4c2f" } },
    { id: "Label_2", name: "Clients/Acme", type: "user" },
  ],
};

const tags = (changes: readonly Change[]) => changes.map((c) => c._tag);

it.effect("history turns into labels, upserts, deletes and a cursor", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /labels": { json: labels },
      "GET /history": (url) => {
        assert.strictEqual(url.searchParams.get("startHistoryId"), "100");
        return {
          json: {
            historyId: "150",
            history: [
              { messagesAdded: [{ message: { id: "m1" } }] },
              { labelsAdded: [{ message: { id: "m2" } }] },
              { messagesDeleted: [{ message: { id: "m3" } }] },
            ],
          },
        };
      },
      "GET /messages/m1": { json: message("m1", ["INBOX", "UNREAD"]) },
      // m2 is gone by the time it is fetched.
    });
    const changes = yield* run(http, (a) => Stream.runCollect(a.pull(account, Option.some("100"))));
    assert.deepStrictEqual(tags(changes), [
      "Labels",
      "Upsert",
      "Progress",
      "Delete",
      "Progress",
      "Delete",
      "Cursor",
    ]);
    assert.deepStrictEqual(changes[0], {
      _tag: "Labels",
      labels: [
        { id: "Label_1", name: "Clients", color: "#fb4c2f" },
        { id: "Label_2", name: "Clients/Acme", color: null },
      ],
    });
    const upsert = changes[1];
    assert.ok(upsert?._tag === "Upsert");
    assert.strictEqual(upsert.message.providerId, "m1");
    assert.strictEqual(upsert.message.isUnread, true);
    assert.strictEqual(upsert.message.snippet, "Tom & Jerry");
    assert.deepStrictEqual(changes[2], { _tag: "Progress", fetched: 1, total: 2 });
    assert.deepStrictEqual(changes[3], { _tag: "Delete", providerId: "m2" });
    assert.deepStrictEqual(changes[5], { _tag: "Delete", providerId: "m3" });
    assert.deepStrictEqual(changes[6], { _tag: "Cursor", cursor: "150" });
  }),
);

it.effect("a history cursor Gmail no longer has falls back to a full sync", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /labels": { json: { labels: [] } },
      "GET /history": { status: 404, json: { error: { code: 404 } } },
      "GET /profile": { json: { emailAddress: "me@gmail.com", historyId: "900" } },
      "GET /messages": (url) => {
        assert.strictEqual(url.searchParams.get("q"), "newer_than:90d");
        assert.strictEqual(url.searchParams.get("includeSpamTrash"), "true");
        return { json: { messages: [{ id: "m1" }] } };
      },
      "GET /messages/m1": { json: message("m1", ["SPAM"]) },
    });
    const changes = yield* run(http, (a) => Stream.runCollect(a.pull(account, Option.some("1"))));
    assert.deepStrictEqual(tags(changes), ["Labels", "Upsert", "Progress", "Cursor"]);
    assert.deepStrictEqual(changes.at(-1), { _tag: "Cursor", cursor: "900" });
  }),
);

it.effect("ops map onto trash, untrash and label modifications", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "POST /messages/p/trash": { json: {} },
      "POST /messages/p/untrash": { json: {} },
      "POST /messages/p/modify": { json: {} },
    });
    yield* run(http, (a) =>
      Effect.gen(function* () {
        yield* a.push(account, "p", { kind: "trash" });
        yield* a.push(account, "p", { kind: "inbox" });
        yield* a.push(account, "p", { kind: "read", value: true });
        yield* a.push(account, "p", { kind: "label", labelId: "Label_1", value: false });
      }),
    );
    assert.deepStrictEqual(
      http.calls.map((c) => [c.url.pathname.split("/").at(-1), c.body]),
      [
        ["trash", undefined],
        ["untrash", undefined],
        ["modify", { addLabelIds: ["INBOX"], removeLabelIds: ["SPAM"] }],
        ["modify", { addLabelIds: [], removeLabelIds: ["UNREAD"] }],
        ["modify", { addLabelIds: [], removeLabelIds: ["Label_1"] }],
      ],
    );
  }),
);

it.effect("write failures map to AuthError and PermanentError", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "POST /messages/scope/modify": {
        status: 403,
        json: { error: { message: "Request had insufficient authentication scopes." } },
      },
      "POST /messages/gone/modify": { status: 404, json: { error: { code: 404 } } },
    });
    const [scope, gone] = yield* run(http, (a) =>
      Effect.all([
        Effect.flip(a.push(account, "scope", { kind: "archive" })),
        Effect.flip(a.push(account, "gone", { kind: "archive" })),
      ]),
    );
    assert.strictEqual(scope._tag, "AuthError");
    assert.strictEqual(gone._tag, "PermanentError");
  }),
);

const outgoing: OutgoingMessage = {
  to: [{ name: "Ann", address: "ann@x.com" }],
  cc: [],
  bcc: [{ name: "", address: "hidden@x.com" }],
  subject: "Re: plan",
  text: "sounds good",
  attachments: [],
};

it.effect("replies carry the thread id and threading headers; forwards do not", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /messages/orig": (url) => {
        assert.strictEqual(url.searchParams.get("format"), "metadata");
        assert.deepStrictEqual(url.searchParams.getAll("metadataHeaders"), [
          "Message-ID",
          "References",
        ]);
        return {
          json: {
            payload: {
              headers: [
                { name: "Message-ID", value: "<orig@x.com>" },
                { name: "References", value: "<root@x.com>" },
              ],
            },
          },
        };
      },
      "POST /messages/send": { json: { id: "sent" } },
    });
    const original = Option.some({ providerId: "orig", threadId: "t-orig" });
    yield* run(http, (a) =>
      Effect.gen(function* () {
        yield* a.send(account, { ...outgoing, mode: "reply" }, original);
        yield* a.send(account, { ...outgoing, mode: "forward" }, original);
        yield* a.send(account, outgoing, Option.none());
      }),
    );
    const sends = http.calls.filter((c) => c.method === "POST");
    const [reply, forward, fresh] = sends.map((c) =>
      Schema.decodeUnknownSync(
        Schema.Struct({ raw: Schema.String, threadId: Schema.optionalKey(Schema.String) }),
      )(c.body),
    );
    assert.strictEqual(reply?.threadId, "t-orig");
    assert.strictEqual(forward?.threadId, undefined);
    assert.strictEqual(fresh?.threadId, undefined);
    assert.ok(reply);
    const mime = Buffer.from(reply.raw, "base64url").toString();
    assert.match(mime, /^In-Reply-To: <orig@x\.com>/m);
    assert.match(mime, /^References: <root@x\.com> <orig@x\.com>/m);
    // Gmail reads Bcc from the raw message to deliver it.
    assert.match(mime, /^Bcc: hidden@x\.com/m);
    // New messages need no threading lookup.
    assert.strictEqual(http.calls.filter((c) => c.method === "GET").length, 2);
  }),
);

it("parses nested parts with their declared charset", () => {
  const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]).toString("base64url");
  const m = parseGmailMessage({
    id: "m",
    threadId: "t",
    internalDate: "1",
    payload: {
      mimeType: "multipart/mixed",
      body: { size: 0 },
      parts: [
        {
          mimeType: "text/plain",
          headers: [{ name: "Content-Type", value: 'text/plain; charset="gbk"' }],
          body: { size: 4, data: gbk },
        },
        { mimeType: "application/pdf", filename: "a.pdf", body: { size: 10 } },
      ],
    },
  });
  assert.strictEqual(m.bodyText, "你好");
  assert.deepStrictEqual(m.attachments, [
    { filename: "a.pdf", mimeType: "application/pdf", size: 10 },
  ]);
  assert.deepStrictEqual(m.labels, []);
});
