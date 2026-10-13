import { GMAIL_MIME_LIMIT } from "../../mime/attachment-policy.js";
import { account as buildAccount } from "../../platform/node/testing.js";
import { fakeHttp } from "../../platform/node/fake-http.js";
import { draftCreation } from "../../platform/node/draft-create-fixture.js";
import { MailCodec } from "../../platform/mail-codec.js";
import { nodeMailCodec } from "../../platform/node/mail-codec.js";
import { assert, it } from "@effect/vitest";
import { parseCalendar } from "../../calendar/invites.js";
import { Cause, Clock, Deferred, Effect, Fiber, Layer, Option, Schema, Stream } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { type Account, type OutgoingMessage } from "../../domain/domain.js";
import { makeGmail, parseGmailMessage } from "./gmail.js";
import { makeGmailSettings } from "./gmail-settings.js";
import { ProviderError } from "../../domain/errors.js";
import { type GmailRuleDefinition, EMPTY_FILTER } from "../../domain/organization.js";
import { MemoryPlatform } from "../../platform/node/platform-memory.js";
import { type Change, type ProviderAdapter } from "../../services.js";
import { isDefiniteSendFailure } from "../provider-send.js";
/**
 * An HttpClient that answers from `routes`, keyed by "METHOD /path" under the
 * Gmail API base. Unknown routes answer 404, like a missing resource.
 */

const account: Account = buildAccount("gmail");

const platform = MemoryPlatform({
  secrets: { [account.id]: "refresh-token" },
  config: { google: { clientId: "client", clientSecret: "secret" } },
});

function run<A, E>(
  http: Pick<ReturnType<typeof fakeHttp>, "layer" | "calls">,
  f: (adapter: ProviderAdapter) => Effect.Effect<A, E>,
) {
  return makeGmail.pipe(Effect.flatMap(f), Effect.provide(Layer.mergeAll(http.layer, platform)));
}

const b64 = (s: string) => Buffer.from(s).toString("base64url");

for (const exists of [false, true]) {
  it.effect(
    `Gmail uncertain-draft cleanup finds the journal Message-ID (${exists ? "found" : "missing"})`,
    () => {
      const http = fakeHttp({
        "GET /messages": (url) => {
          assert.strictEqual(
            url.searchParams.get("q"),
            "in:drafts rfc822msgid:<orphan@example.test>",
          );
          return { json: { messages: exists ? [{ id: "orphan-message" }] : [] } };
        },
        "GET /drafts": {
          json: { drafts: [{ id: "orphan-draft", message: { id: "orphan-message" } }] },
        },
        "DELETE /drafts/orphan-draft": { status: 204 },
      });
      return run(http, (adapter) =>
        adapter.deleteDraft(account, {
          draftId: null,
          messageId: null,
          rfcMessageId: "<orphan@example.test>",
        }),
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            assert.isTrue(
              http.calls.some(
                (call) => call.method === "GET" && call.url.pathname.endsWith("/messages"),
              ),
            );
            assert.strictEqual(
              http.calls.filter((call) => call.method === "DELETE").length,
              exists ? 1 : 0,
            );
          }),
        ),
      );
    },
  );
}

it.effect("a Gmail threading 503 is definite before any send submission", () => {
  const http = fakeHttp({
    "GET /messages/source": { status: 503, headers: { "Retry-After": "120" } },
  });
  return run(http, (adapter) =>
    Effect.gen(function* () {
      const result = yield* adapter
        .send(
          account,
          { ...outgoing, mode: "reply" },
          Option.some({ providerId: "source", threadId: "conversation" }),
        )
        .pipe(Effect.result);
      assert.isTrue(result._tag === "Failure" && isDefiniteSendFailure(result.failure));
      assert.isFalse(http.calls.some((call) => call.method === "POST"));
    }),
  );
});

it.live("Gmail can retry draft creation after a DNS failure without a lookup", () =>
  Effect.gen(function* () {
    let attempted = false;
    let posts = 0;
    let lookups = 0;
    const client = HttpClient.make((request) =>
      Effect.suspend(() => {
        if (request.method === "POST") {
          posts++;
          if (posts === 1)
            return Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request,
                  cause: new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } }),
                }),
              }),
            );
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify({ id: "draft", message: { id: "message" } })),
            ),
          );
        }
        lookups++;
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}")));
      }),
    );
    yield* run({ layer: Layer.succeed(HttpClient.HttpClient, client), calls: [] }, (adapter) =>
      Effect.gen(function* () {
        const push = {
          remote: null,
          message: outgoing,
          original: Option.none(),
          replaceAttachments: false,
          creation: {
            missing: () => Effect.succeed(false),
            begin: () => Effect.succeed({ messageId: "<dns@example.test>", attempted }),
            attempted: (_id: string, value = true) =>
              Effect.sync(() => {
                attempted = value;
              }),
            remember: () => Effect.void,
          },
        };
        const first = yield* adapter.saveDraft(account, push).pipe(Effect.result);
        assert.strictEqual(
          first._tag === "Failure" &&
            first.failure._tag === "ProviderError" &&
            first.failure.reason,
          "connection",
        );
        assert.isFalse(attempted);
        assert.strictEqual((yield* adapter.saveDraft(account, push)).draftId, "draft");
      }),
    );
    assert.strictEqual(posts, 2);
    assert.strictEqual(lookups, 0);
  }),
);

it.live("Gmail recreates a draft after the creation journal expires", () =>
  Effect.gen(function* () {
    let misses = 0;
    const http = fakeHttp({
      "GET /messages": { json: { messages: [] } },
      "POST /drafts": { json: { id: "retry-draft", message: { id: "rewritten-message-id" } } },
    });
    yield* run(http, (adapter) =>
      Effect.gen(function* () {
        const push = {
          remote: null,
          message: outgoing,
          original: Option.none(),
          replaceAttachments: false,
          creation: {
            begin: () => Effect.succeed({ messageId: "<rewritten@example.test>", attempted: true }),
            attempted: () => Effect.void,
            missing: () => Effect.sync(() => ++misses >= 3),
            remember: () => Effect.void,
          },
        };
        for (let i = 0; i < 2; i++) {
          const result = yield* adapter.saveDraft(account, push).pipe(Effect.result);
          assert.strictEqual(result._tag === "Failure" && result.failure._tag, "ProviderError");
          assert.strictEqual(http.calls.filter((call) => call.method === "POST").length, 0);
        }
        assert.strictEqual((yield* adapter.saveDraft(account, push)).draftId, "retry-draft");
      }),
    );
    assert.strictEqual(misses, 3);
    assert.strictEqual(http.calls.filter((call) => call.method === "POST").length, 1);
  }),
);

it.live("Gmail uncertain draft creation is reconciled by the client Message-ID", () =>
  Effect.gen(function* () {
    let attempted = false;
    const http = fakeHttp({
      "POST /drafts": () => {
        assert.isTrue(attempted);
        return { status: 503 };
      },
      "GET /messages": (url) => {
        assert.include(url.searchParams.get("q") ?? "", "rfc822msgid:<draft@example.com>");
        return { json: { messages: [{ id: "remote-message" }] } };
      },
      "GET /drafts": {
        json: { drafts: [{ id: "remote-draft", message: { id: "remote-message" } }] },
      },
    });
    const remote = yield* run(http, (a) =>
      a.saveDraft(account, {
        message: outgoing,
        remote: null,
        original: Option.none(),
        replaceAttachments: false,
        creation: {
          missing: () => Effect.succeed(false),
          begin: () => Effect.succeed({ messageId: "<draft@example.com>", attempted: false }),
          attempted: () =>
            Effect.sync(() => {
              attempted = true;
            }),
          remember: () => Effect.void,
        },
      }),
    );
    assert.strictEqual(remote.draftId, "remote-draft");
    assert.strictEqual(http.calls.filter((c) => c.method === "POST").length, 1);
    const body = Schema.decodeUnknownSync(
      Schema.Struct({ message: Schema.Struct({ raw: Schema.String }) }),
    )(http.calls.find((c) => c.method === "POST")?.body);
    assert.include(
      Buffer.from(body.message.raw, "base64url").toString(),
      "Message-ID: <draft@example.com>",
    );
  }),
);

for (const status of [200, 400]) {
  it.live(
    `recovered Gmail creation applies current edits and retains its ID on update ${status}`,
    () =>
      Effect.gen(function* () {
        const http = fakeHttp({
          "GET /messages": { json: { messages: [{ id: "found-message" }] } },
          "GET /drafts": {
            json: { drafts: [{ id: "found-draft", message: { id: "found-message" } }] },
          },
          "PUT /drafts/found-draft": {
            status,
            json: { id: "found-draft", message: { id: "updated-message" } },
          },
        });
        const remote = yield* run(http, (adapter) =>
          adapter.saveDraft(account, {
            remote: null,
            message: { ...outgoing, text: "Latest edit" },
            original: Option.none(),
            replaceAttachments: false,
            creation: {
              missing: () => Effect.succeed(false),
              begin: () => Effect.succeed({ messageId: "<attempt@example.com>", attempted: true }),
              attempted: () => Effect.void,
              remember: () => Effect.void,
            },
          }),
        );
        const writes = http.calls.filter((call) => call.method !== "GET");
        assert.strictEqual(writes.length, 1);
        assert.strictEqual(writes[0]?.method, "PUT");
        const body = Schema.decodeUnknownSync(
          Schema.Struct({ message: Schema.Struct({ raw: Schema.String }) }),
        )(writes[0]?.body);
        assert.include(Buffer.from(body.message.raw, "base64url").toString(), "Latest edit");
        assert.strictEqual(remote.draftId, "found-draft");
        assert.strictEqual(remote.messageId, status === 200 ? "updated-message" : "found-message");
        assert.strictEqual(remote.saveError?._tag, status === 200 ? undefined : "PermanentError");
      }),
  );
}

it.live("an uncertain Gmail filter update matches the new rule before restoring", () =>
  Effect.gen(function* () {
    const original = {
      id: "old",
      criteria: { from: "alice" },
      action: { removeLabelIds: ["UNREAD"] },
    };
    const found = { id: "new", criteria: { from: "bob" }, action: { removeLabelIds: ["UNREAD"] } };
    let posts = 0;
    const settings = makeGmailSettings(
      (_id, schema, path) =>
        Schema.decodeUnknownEffect(schema)(
          path.endsWith("/old") ? original : { filter: [found] },
        ).pipe(Effect.orDie),
      (_id, method) =>
        method === "DELETE"
          ? Effect.void
          : Effect.suspend(() => {
              posts++;
              return posts === 1
                ? Effect.fail(new ProviderError({ message: "Lost response", status: 0 }))
                : Effect.succeed({ ...original, id: "restored" });
            }),
    );
    const result = yield* settings.updateFilter(account, "old", {
      ...EMPTY_FILTER,
      criteria: { ...EMPTY_FILTER.criteria, from: "bob" },
      action: { ...EMPTY_FILTER.action, markRead: true },
    });
    assert.strictEqual(result.id, "new");
    assert.strictEqual(posts, 1);
  }),
);

it.live("uncertain Gmail calendar response re-reads the self attendee", () =>
  Effect.gen(function* () {
    const [parsed] = parseCalendar(
      "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:uid@example.com\r\nDTSTART:20261001T090000Z\r\nORGANIZER:mailto:alice@example.com\r\nATTENDEE:mailto:me@gmail.com\r\nEND:VEVENT\r\nEND:VCALENDAR",
    );
    assert.ok(parsed);
    const event = {
      id: "e",
      organizer: { email: "alice@example.com" },
      attendees: [{ email: "me@gmail.com", self: true }],
    };
    let patches = 0;
    const http = fakeHttp({
      "GET /calendar/v3/calendars/primary/events": { json: { items: [event] } },
      "PATCH /calendar/v3/calendars/primary/events/e": () => ({
        status: patches++ === 0 ? 503 : 200,
        json: {},
      }),
      "GET /calendar/v3/calendars/primary/events/e": {
        json: {
          ...event,
          attendees: [{ email: "me@gmail.com", self: true, responseStatus: "accepted" }],
        },
      },
    });
    yield* run(http, (a) => a.respondInvite(account, "m", parsed.invite, "accepted"));
    assert.strictEqual(http.calls.filter((c) => c.method === "PATCH").length, 1);
  }),
);

it.live("invalid move destination never untrashes a Gmail message", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /labels": { json: { labels: [] } },
      "GET /messages/m": { json: { labelIds: ["TRASH"] } },
      "POST /messages/m/untrash": { json: {} },
      "POST /messages/m/modify": { status: 400 },
    });
    yield* run(http, (a) =>
      a
        .push(account, "m", { kind: "move", labelId: "missing", removeLabelId: null })
        .pipe(Effect.result),
    );
    assert.isFalse(http.calls.some((c) => c.url.pathname.endsWith("/untrash")));
  }),
);

it.live("failed Gmail move restores Trash after untrash", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /labels": {
        json: { labels: [{ id: "Label_dest", name: "Destination", type: "user" }] },
      },
      "GET /messages/m": { json: { labelIds: ["TRASH"] } },
      "POST /messages/m/untrash": { json: {} },
      "POST /messages/m/modify": { status: 400 },
      "POST /messages/m/trash": { json: {} },
    });
    yield* run(http, (a) =>
      a
        .push(account, "m", { kind: "move", labelId: "Label_dest", removeLabelId: null })
        .pipe(Effect.result),
    );
    assert.isTrue(http.calls.some((c) => c.url.pathname.endsWith("/trash")));
  }),
);

for (const status of [400, 409]) {
  it.live(`Gmail label create ${status} resolves the existing name`, () =>
    Effect.gen(function* () {
      let lists = 0;
      const http = fakeHttp({
        "GET /labels": () => ({
          json: { labels: lists++ ? [{ id: "Label_found", name: "Work", type: "user" }] : [] },
        }),
        "POST /labels": { status },
      });
      const labels = yield* run(http, (a) =>
        a.changeLabel(account, { kind: "create", name: "Work" }),
      );
      assert.strictEqual(labels[0]?.id, "Label_found");
    }),
  );
}

it.effect("Gmail checks the built MIME byte length before posting", () =>
  Effect.gen(function* () {
    const http = fakeHttp({ "POST /messages/send": { json: { id: "sent" } } });
    const codec = {
      ...nodeMailCodec,
      build: () => Effect.succeed(new Uint8Array(GMAIL_MIME_LIMIT + 1)),
    };
    const error = yield* makeGmail.pipe(
      Effect.provideService(MailCodec, codec),
      Effect.flatMap((adapter) =>
        Effect.flip(
          adapter.send(
            account,
            {
              to: [{ name: "Bob", address: "bob@example.com" }],
              cc: [],
              bcc: [],
              subject: "Body limit",
              text: "Body bytes are supplied by the MIME encoder",
              attachments: [],
            },
            Option.none(),
          ),
        ),
      ),
      Effect.provide(Layer.mergeAll(http.layer, platform)),
    );
    assert.strictEqual(error._tag, "PermanentError");
    assert.include(error.message, "25 MB");
    assert.strictEqual(http.calls.length, 0);
  }),
);

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
    assert.deepStrictEqual(tags(changes), ["Labels", "Upsert", "Progress", "Reset", "Cursor"]);
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

it.effect("Gmail batch label changes use one batchModify request", () =>
  Effect.gen(function* () {
    const http = fakeHttp({ "POST /messages/batchModify": { json: {} } });
    yield* run(http, (adapter) =>
      Effect.gen(function* () {
        const batch = adapter.pushBatch;
        assert.ok(batch);
        yield* batch(account, ["p", "q"], { kind: "read", value: true });
      }),
    );
    assert.strictEqual(http.calls.length, 1);
    assert.deepStrictEqual(http.calls[0]?.body, {
      ids: ["p", "q"],
      addLabelIds: [],
      removeLabelIds: ["UNREAD"],
    });
  }),
);

it.effect("write scope failures do not require mail reauthentication", () =>
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
    assert.strictEqual(scope._tag, "ProviderError");
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

it("reads text Gmail already converted to UTF-8 even when the header names another charset", () => {
  // Outlook re-encodes Chinese mail as gb2312; Gmail's API returns it as UTF-8.
  const utf8 = Buffer.from("粗体 和 代码", "utf8").toString("base64url");
  const m = parseGmailMessage({
    id: "m",
    threadId: "t",
    internalDate: "1",
    payload: {
      mimeType: "text/html",
      headers: [{ name: "Content-Type", value: 'text/html; charset="gb2312"' }],
      body: { size: 18, data: utf8 },
    },
  });
  assert.strictEqual(m.bodyHtml, "粗体 和 代码");
});

const DraftBody = Schema.Struct({
  message: Schema.Struct({ raw: Schema.String, threadId: Schema.optionalKey(Schema.String) }),
});

it.effect("drafts are created, updated in place, recreated when gone and deleted", () =>
  Effect.gen(function* () {
    const draft = (id: string, messageId: string) => ({ json: { id, message: { id: messageId } } });
    const http = fakeHttp({
      "GET /messages/orig": {
        json: { payload: { headers: [{ name: "Message-ID", value: "<orig@x.com>" }] } },
      },
      "POST /drafts": draft("r1", "m-a"),
      "PUT /drafts/r1": draft("r1", "m-b"),
      "PUT /drafts/gone": { status: 404, json: { error: { code: 404 } } },
      "GET /drafts": { json: { drafts: [{ id: "r9", message: { id: "m-9" } }] } },
      "PUT /drafts/r9": draft("r9", "m-10"),
      "DELETE /drafts/r1": { status: 204 },
      "DELETE /drafts/r9": { status: 404, json: { error: { code: 404 } } },
    });
    const reply = { ...outgoing, mode: "reply" as const };
    const push = (remote: { draftId: string | null; messageId: string | null } | null) => ({
      creation: draftCreation(),
      remote,
      message: reply,
      original: Option.some({ providerId: "orig", threadId: "t-orig" }),
      replaceAttachments: false,
    });
    const results = yield* run(http, (a) =>
      Effect.gen(function* () {
        return [
          yield* a.saveDraft(account, push(null)),
          yield* a.saveDraft(account, push({ draftId: "r1", messageId: "m-a" })),
          // Deleted in Gmail meanwhile: created again.
          yield* a.saveDraft(account, push({ draftId: "gone", messageId: "x" })),
          // Known only by message id (it came in through a pull).
          yield* a.saveDraft(account, push({ draftId: null, messageId: "m-9" })),
          yield* a.deleteDraft(account, { draftId: "r1", messageId: "m-b" }),
          yield* a.deleteDraft(account, { draftId: null, messageId: "m-9" }),
          yield* a.deleteDraft(account, { draftId: null, messageId: "unknown" }),
        ];
      }),
    );
    assert.deepStrictEqual(results.slice(0, 4), [
      { draftId: "r1", messageId: "m-a" },
      { draftId: "r1", messageId: "m-b" },
      { draftId: "r1", messageId: "m-a" },
      { draftId: "r9", messageId: "m-10" },
    ]);
    const writes = http.calls.filter((c) => c.method !== "GET");
    assert.deepStrictEqual(
      writes.map((c) => `${c.method} ${c.url.pathname.replace("/gmail/v1/users/me", "")}`),
      [
        "POST /drafts",
        "PUT /drafts/r1",
        "PUT /drafts/gone",
        "POST /drafts",
        "PUT /drafts/r9",
        "DELETE /drafts/r1",
        "DELETE /drafts/r9",
      ],
    );
    const body = Schema.decodeUnknownSync(DraftBody)(writes[0]?.body);
    assert.strictEqual(body.message.threadId, "t-orig");
    const mime = Buffer.from(body.message.raw, "base64url").toString();
    assert.match(mime, /^In-Reply-To: <orig@x\.com>/m);
    assert.match(mime, /^Bcc: hidden@x\.com/m);
  }),
);

it.effect("raw messages come back as bytes", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /messages/m1": (url) => {
        assert.strictEqual(url.searchParams.get("format"), "raw");
        return { json: { raw: b64("Subject: hi\r\n\r\nbody") } };
      },
    });
    const raw = yield* run(http, (a) => a.fetchRaw(account, "m1"));
    assert.strictEqual(Buffer.from(raw).toString(), "Subject: hi\r\n\r\nbody");
  }),
);

it.effect(
  "attachments come inline or through the attachments endpoint, by name and occurrence",
  () =>
    Effect.gen(function* () {
      const part = (filename: string, body: Record<string, unknown>) => ({
        mimeType: "application/pdf",
        filename,
        body,
      });
      const http = fakeHttp({
        "GET /messages/m1": (url) => {
          assert.strictEqual(url.searchParams.get("format"), "full");
          return {
            json: {
              ...message("m1", ["INBOX"]),
              payload: {
                mimeType: "multipart/mixed",
                body: { size: 0 },
                parts: [
                  { mimeType: "text/plain", body: { size: 2, data: b64("hi") } },
                  part("a.pdf", { size: 3, data: b64("one") }),
                  part("a.pdf", { size: 9, attachmentId: "ATT2" }),
                ],
              },
            },
          };
        },
        "GET /messages/m1/attachments/ATT2": { json: { size: 3, data: b64("two") } },
      });
      const [first, second] = yield* run(http, (a) =>
        Effect.all([
          a.fetchAttachment(account, "m1", { index: 0, filename: "a.pdf", occurrence: 0 }),
          a.fetchAttachment(account, "m1", { index: 1, filename: "a.pdf", occurrence: 1 }),
        ]),
      );
      assert.strictEqual(Buffer.from(first).toString(), "one");
      assert.strictEqual(Buffer.from(second).toString(), "two");
    }),
);

it.effect("a dropped connection is retried, not reported", () =>
  Effect.gen(function* () {
    let calls = 0;
    // Fails once at the transport level, then answers.
    const client = HttpClient.make((request) =>
      Effect.suspend(() =>
        ++calls <= 1
          ? Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request, description: "offline" }),
              }),
            )
          : Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response(JSON.stringify({ raw: b64("hi") }))),
            ),
      ),
    );
    const http = { layer: Layer.succeed(HttpClient.HttpClient)(client), calls: [] };
    yield* run(http, (adapter) =>
      Effect.gen(function* () {
        const fiber = yield* adapter.fetchRaw(account, "m1").pipe(Effect.forkChild);
        yield* TestClock.adjust("2 seconds");
        assert.strictEqual(Buffer.from(yield* Fiber.join(fiber)).toString(), "hi");
      }),
    );
    assert.strictEqual(calls, 2);
  }),
);

it.effect("server search sends q and folder scope, fetches uncached messages across pages", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /labels": { json: labels },
      "GET /messages": (url) => {
        assert.strictEqual(url.searchParams.get("q"), 'from:ann filename:pdf label:"Clients"');
        return {
          json: url.searchParams.get("pageToken")
            ? { messages: [{ id: "m2" }] }
            : { messages: [{ id: "m1" }], nextPageToken: "next" },
        };
      },
      "GET /messages/m1": { json: message("m1", ["Label_1"]) },
      "GET /messages/m2": { json: message("m2", ["Label_1"]) },
    });
    const page = yield* run(http, (a) =>
      a.search(account, {
        search: "from:ann filename:pdf",
        searchScope: "folder",
        label: "Label_1",
      }),
    );
    assert.strictEqual(page.messages.length, 2);
    assert.strictEqual(page.truncated, false);
  }),
);

it.effect("Gmail manages label names and palette colors with the labels API", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /labels": { json: labels },
      "POST /labels": { json: {} },
      "PATCH /labels/Label_1": { json: {} },
      "DELETE /labels/Label_1": { status: 204 },
    });
    yield* run(http, (a) =>
      Effect.gen(function* () {
        yield* a.changeLabel(account, { kind: "create", parentId: "Label_1", name: "New" });
        yield* a.changeLabel(account, { kind: "rename", id: "Label_1", name: "Renamed" });
        yield* a.changeLabel(account, { kind: "color", id: "Label_1", color: "#4986e7" });
        yield* a.changeLabel(account, { kind: "delete", id: "Label_1" });
      }),
    );
    assert.deepStrictEqual(http.calls.filter((c) => c.method === "POST")[0]?.body, {
      name: "Clients/New",
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    });
    assert.deepStrictEqual(
      http.calls.filter((c) => c.method === "PATCH").map((c) => c.body),
      [{ name: "Renamed" }, { color: { backgroundColor: "#4986e7", textColor: "#000000" } }],
    );
  }),
);

it.effect("Gmail filter actions map to labels; list/create/delete use settings filters", () =>
  Effect.gen(function* () {
    const criteria = {
      from: "ann@example.com",
      to: "",
      subject: "Report",
      query: "has:attachment",
      hasAttachment: true,
    };
    const filter = {
      id: "f1",
      criteria,
      action: { addLabelIds: ["STARRED", "Label_1"], removeLabelIds: ["UNREAD"] },
    };
    const http = fakeHttp({
      "GET /settings/filters": { json: { filter: [filter] } },
      "POST /settings/filters": { json: filter },
      "DELETE /settings/filters/f1": { status: 204 },
    });
    yield* run(http, (a) =>
      Effect.gen(function* () {
        const [existing] = yield* a.filters(account);
        assert.ok(existing);
        assert.strictEqual(existing.action.label, "Label_1");
        yield* a.createFilter(account, {
          name: "Reports",
          criteria,
          action: { archive: false, markRead: true, star: true, trash: false, label: "Label_1" },
        });
        yield* a.deleteFilter(account, "f1");
      }),
    );
    assert.deepStrictEqual(http.calls.find((c) => c.method === "POST")?.body, {
      criteria,
      action: filter.action,
    });
  }),
);

it.effect(
  "Gmail vacation roundtrips and send-as skips unverified aliases and decodes signatures",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "GET /settings/vacation": {
          json: {
            enableAutoReply: true,
            startTime: "1000",
            endTime: "2000",
            responseSubject: "Away",
            responseBodyPlainText: "Back tomorrow",
            restrictToContacts: true,
          },
        },
        "PUT /settings/vacation": { json: {} },
        "GET /settings/sendAs": {
          json: {
            sendAs: [
              {
                sendAsEmail: "alias@example.com",
                displayName: "Me",
                isDefault: true,
                signature: "<p>Hello &amp; bye</p>",
                verificationStatus: "accepted",
              },
              { sendAsEmail: "pending@example.com", verificationStatus: "pending" },
            ],
          },
        },
      });
      yield* run(http, (a) =>
        Effect.gen(function* () {
          const v = yield* a.vacation(account);
          assert.strictEqual(v.contactsOnly, true);
          yield* a.setVacation(account, v);
          const aliases = yield* a.sendAs(account);
          assert.strictEqual(aliases.length, 1);
          assert.strictEqual(aliases[0]?.signature, "Hello & bye");
        }),
      );
      assert.deepStrictEqual(http.calls.find((c) => c.method === "PUT")?.body, {
        enableAutoReply: true,
        startTime: "1000",
        endTime: "2000",
        responseSubject: "Away",
        responseBodyPlainText: "Back tomorrow",
        restrictToContacts: true,
      });
    }),
);

it.effect("missing Gmail settings scope is separate from mail authentication", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /settings/filters": {
        status: 403,
        json: { error: "insufficient authentication scopes" },
      },
      "GET /messages/m1": { json: { raw: b64("mail still works") } },
    });
    yield* run(http, (a) =>
      Effect.gen(function* () {
        const error = yield* a.filters(account).pipe(Effect.flip);
        assert.strictEqual(error._tag, "SettingsScopeMissing");
        assert.strictEqual(
          Buffer.from(yield* a.fetchRaw(account, "m1")).toString(),
          "mail still works",
        );
      }),
    );
  }),
);

it.effect("Gmail alias selection becomes the MIME From header", () =>
  Effect.gen(function* () {
    const http = fakeHttp({ "POST /messages/send": { json: {} } });
    yield* run(http, (a) =>
      a.send(
        account,
        {
          from: { name: "Alias", address: "alias@example.com" },
          to: [{ name: "", address: "to@example.com" }],
          cc: [],
          bcc: [],
          subject: "Hi",
          text: "Hello",
          attachments: [],
        },
        Option.none(),
      ),
    );
    const body = Schema.decodeUnknownSync(Schema.Struct({ raw: Schema.String }))(
      http.calls[0]?.body,
    );
    assert.match(Buffer.from(body.raw, "base64url").toString(), /From: Alias <alias@example.com>/);
  }),
);

it.effect("Gmail sign-in requests base mail scopes only", () => {
  const http = fakeHttp({
    "GET /profile": { json: { emailAddress: account.email, historyId: "1" } },
  });
  return makeGmail.pipe(
    Effect.flatMap((a) => a.connect({ provider: "gmail" })),
    Effect.provide(
      Layer.mergeAll(
        http.layer,
        MemoryPlatform({
          config: { google: { clientId: "client", clientSecret: "secret" } },
          oauth: {
            authorize: (req) =>
              Effect.sync(() => {
                assert.isFalse(
                  req.scopes.includes("https://www.googleapis.com/auth/gmail.settings.basic"),
                );
                assert.strictEqual(req.scopes[0], "https://www.googleapis.com/auth/gmail.modify");
                assert.isFalse(req.scopes.includes("https://mail.google.com/"));
                assert.deepStrictEqual(req.scopes, [
                  "https://www.googleapis.com/auth/gmail.modify",
                  "https://www.googleapis.com/auth/gmail.send",
                ]);
                for (const scope of [
                  "calendar.events",
                  "contacts.readonly",
                  "contacts.other.readonly",
                ])
                  assert.isFalse(req.scopes.includes(`https://www.googleapis.com/auth/${scope}`));
                return {
                  accessToken: "access-token",
                  refreshToken: Option.some("refresh-token"),
                  expiresIn: 3600,
                };
              }),
          },
        }),
      ),
    ),
  );
});

it.effect(
  "Gmail permanent deletion consent adds only full-mail scope with incremental authorization on the user's client",
  () => {
    const scopes = [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.send",
      "https://mail.google.com/",
    ];
    const http = fakeHttp({
      "GET /profile": { json: { emailAddress: account.email, historyId: "1" } },
    });
    return makeGmail.pipe(
      Effect.flatMap((adapter) =>
        adapter.connect({
          provider: "gmail",
          loginHint: account.email,
          feature: "permanentDelete",
        }),
      ),
      Effect.tap((connected) =>
        Effect.sync(() => assert.deepStrictEqual(connected.scopes, scopes)),
      ),
      Effect.provide(
        Layer.mergeAll(
          http.layer,
          MemoryPlatform({
            config: { google: { clientId: "own-client", clientSecret: "own-secret" } },
            oauth: {
              authorize: (request) =>
                Effect.sync(() => {
                  assert.deepStrictEqual(request.scopes, scopes);
                  assert.strictEqual(
                    request.authUrl,
                    "https://accounts.google.com/o/oauth2/v2/auth",
                  );
                  assert.strictEqual(request.clientId, "own-client");
                  assert.strictEqual(request.clientSecret, "own-secret");
                  assert.strictEqual(request.extraParams?.include_granted_scopes, "true");
                  assert.strictEqual(request.extraParams?.login_hint, account.email);
                  return {
                    accessToken: "access-token",
                    refreshToken: Option.some("refresh-token"),
                    expiresIn: 3600,
                    scopes,
                  };
                }),
            },
          }),
        ),
      ),
    );
  },
);

it.effect("Gmail explicit spam search includes messages normally excluded from all mail", () => {
  const http = fakeHttp({
    "GET /labels": { json: labels },
    "GET /messages": (url) => {
      assert.strictEqual(url.searchParams.get("q"), "in:spam from:ann");
      assert.strictEqual(url.searchParams.get("includeSpamTrash"), "true");
      return { json: { messages: [{ id: "spam" }] } };
    },
    "GET /messages/spam": { json: message("spam", ["SPAM"]) },
  });
  return run(http, (a) => a.search(account, { search: "in:spam from:ann" })).pipe(
    Effect.tap((page) =>
      Effect.sync(() => assert.strictEqual(page.messages[0]?.labels[0], "SPAM")),
    ),
  );
});

it.effect(
  "Gmail vacation updates preserve the original rich HTML when body text is unchanged",
  () =>
    Effect.gen(function* () {
      const html = '<p style="color:blue">Rich <b>reply</b></p>';
      const http = fakeHttp({
        "GET /settings/vacation": {
          json: {
            enableAutoReply: true,
            responseBodyPlainText: "Alternative plain text",
            responseBodyHtml: html,
          },
        },
        "PUT /settings/vacation": { json: {} },
      });
      yield* run(http, (a) =>
        Effect.gen(function* () {
          const v = yield* a.vacation(account);
          yield* a.setVacation(account, { ...v, enabled: false });
        }),
      );
      const body = Schema.decodeUnknownSync(
        Schema.Struct({ responseBodyHtml: Schema.String, responseBodyPlainText: Schema.String }),
      )(http.calls.at(-1)?.body);
      assert.strictEqual(body.responseBodyHtml, html);
      assert.strictEqual(body.responseBodyPlainText, "Alternative plain text");
    }),
);

it.effect(
  "send-as scope failure is cached without refreshing mail tokens, until that account reauthenticates",
  () => {
    let authorized = false;
    let refreshes = 0;
    const http = fakeHttp({
      "GET /settings/sendAs": () =>
        authorized
          ? { json: { sendAs: [] } }
          : { status: 403, json: { error: "insufficient authentication scopes" } },
      "GET /messages/m1": { json: { raw: b64("still reads") } },
      "GET /profile": { json: { emailAddress: account.email, historyId: "1" } },
    });
    const platform = MemoryPlatform({
      secrets: { [account.id]: "refresh-token" },
      config: { google: { clientId: "client", clientSecret: "secret" } },
      oauth: {
        refresh: () =>
          Effect.sync(() => {
            refreshes++;
            return {
              accessToken: "access-token",
              refreshToken: Option.some("refresh-token"),
              expiresIn: 3600,
            };
          }),
      },
    });
    return makeGmail.pipe(
      Effect.flatMap((a) =>
        Effect.gen(function* () {
          assert.strictEqual(
            (yield* a.sendAs(account).pipe(Effect.flip))._tag,
            "SettingsScopeMissing",
          );
          yield* a.fetchRaw(account, "m1");
          assert.strictEqual(
            (yield* a.sendAs(account).pipe(Effect.flip))._tag,
            "SettingsScopeMissing",
          );
          assert.strictEqual(
            http.calls.filter((c) => c.url.pathname.endsWith("/settings/sendAs")).length,
            1,
          );
          assert.strictEqual(refreshes, 1);
          authorized = true;
          yield* a.connect({ provider: "gmail" });
          assert.deepStrictEqual(yield* a.sendAs(account), []);
          assert.strictEqual(
            http.calls.filter((c) => c.url.pathname.endsWith("/settings/sendAs")).length,
            2,
          );
        }),
      ),
      Effect.provide(Layer.mergeAll(http.layer, platform)),
    );
  },
);

it.effect(
  "Gmail legacy vacation callers preserve existing HTML without sending a preservation field",
  () => {
    const html = "<p>Rich <b>reply</b></p>";
    const http = fakeHttp({
      "GET /settings/vacation": {
        json: { responseBodyPlainText: "Plain", responseBodyHtml: html },
      },
      "PUT /settings/vacation": { json: {} },
    });
    return run(http, (a) =>
      a.setVacation(account, {
        enabled: false,
        start: null,
        end: null,
        subject: "",
        body: "Plain",
        contactsOnly: false,
      }),
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          assert.strictEqual(
            Schema.decodeUnknownSync(Schema.Struct({ responseBodyHtml: Schema.String }))(
              http.calls.at(-1)?.body,
            ).responseBodyHtml,
            html,
          );
        }),
      ),
    );
  },
);

it.effect("media raw size is checked before downloading Gmail MIME", () =>
  Effect.gen(function* () {
    let rawCalls = 0;
    const http = fakeHttp({
      "GET /messages/m1": (url) => {
        if (url.searchParams.get("format") === "minimal")
          return { json: { sizeEstimate: 20_000_000 } };
        rawCalls++;
        return { json: { raw: b64("body") } };
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
  "People API reads all connections and otherContacts pages and merges email duplicates",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "GET /v1/people/me/connections": (url) => {
          assert.strictEqual(url.hostname, "people.googleapis.com");
          assert.strictEqual(
            url.searchParams.get("personFields"),
            "names,emailAddresses,organizations",
          );
          return url.searchParams.get("pageToken")
            ? { json: { connections: [{ emailAddresses: [{ value: "second@example.com" }] }] } }
            : {
                json: {
                  connections: [
                    {
                      names: [{ displayName: "Saved name" }],
                      emailAddresses: [{ value: "Person@Example.com" }, { value: "invalid" }],
                    },
                  ],
                  nextPageToken: "page2",
                },
              };
        },
        "GET /v1/otherContacts": (url) => {
          assert.strictEqual(url.searchParams.get("readMask"), "names,emailAddresses");
          return url.searchParams.get("pageToken")
            ? { json: { otherContacts: [{ emailAddresses: [{ value: "last@example.com" }] }] } }
            : {
                json: {
                  otherContacts: [
                    {
                      names: [{ displayName: "Other name" }],
                      emailAddresses: [{ value: "person@example.com" }],
                    },
                  ],
                  nextPageToken: "other2",
                },
              };
        },
      });
      const contacts = yield* run(http, (a) => a.contacts(account));
      assert.deepStrictEqual(contacts, [
        { name: "Saved name", address: "person@example.com" },
        { name: "", address: "second@example.com" },
        { name: "", address: "last@example.com" },
      ]);
      assert.strictEqual(http.calls.length, 4);
    }),
);

it.effect("Calendar responds only for the matched UID and self attendee using sendUpdates", () =>
  Effect.gen(function* () {
    const [parsed] = parseCalendar(
      "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:uid@example.com\r\nDTSTART:20261001T090000Z\r\nORGANIZER:mailto:alice@example.com\r\nATTENDEE:mailto:me@gmail.com\r\nEND:VEVENT\r\nEND:VCALENDAR",
    );
    assert.ok(parsed);
    const http = fakeHttp({
      "GET /calendar/v3/calendars/primary/events": (url) => {
        assert.strictEqual(url.searchParams.get("iCalUID"), "uid@example.com");
        return {
          json: {
            items: [
              {
                id: "e1",
                organizer: { email: "alice@example.com" },
                attendees: [
                  { email: "me@gmail.com", self: true },
                  { email: "other@example.com", responseStatus: "declined" },
                ],
              },
            ],
          },
        };
      },
      "PATCH /calendar/v3/calendars/primary/events/e1": { json: {} },
    });
    for (const response of ["accepted", "tentative", "declined"] as const)
      yield* run(http, (a) => a.respondInvite(account, "m1", parsed.invite, response));
    const writes = http.calls.filter((c) => c.method === "PATCH");
    assert.strictEqual(writes.length, 3);
    for (const [i, response] of ["accepted", "tentative", "declined"].entries()) {
      assert.strictEqual(writes[i]?.url.searchParams.get("sendUpdates"), "all");
      assert.deepStrictEqual(writes[i]?.body, {
        attendeesOmitted: true,
        attendees: [{ email: "me@gmail.com", responseStatus: response }],
      });
    }
  }),
);

it.effect("optional Gmail scopes produce feature-specific errors without mail AuthError", () =>
  Effect.gen(function* () {
    const [parsed] = parseCalendar(
      "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:uid\r\nDTSTART:20261001T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR",
    );
    assert.ok(parsed);
    const http = fakeHttp({
      "GET /v1/people/me/connections": {
        status: 403,
        json: { error: "insufficient authentication scopes" },
      },
      "GET /calendar/v3/calendars/primary/events": {
        status: 403,
        json: { error: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" },
      },
    });
    const contacts = yield* run(http, (a) => a.contacts(account)).pipe(Effect.result);
    assert.strictEqual(contacts._tag, "Failure");
    if (contacts._tag === "Failure") {
      assert.strictEqual(contacts.failure._tag, "FeatureScopeMissing");
      if (contacts.failure._tag === "FeatureScopeMissing")
        assert.strictEqual(contacts.failure.feature, "contacts");
    }
    const response = yield* run(http, (a) =>
      a.respondInvite(account, "m", parsed.invite, "accepted"),
    ).pipe(Effect.result);
    assert.strictEqual(response._tag, "Failure");
    if (response._tag === "Failure") {
      assert.strictEqual(response.failure._tag, "FeatureScopeMissing");
      if (response.failure._tag === "FeatureScopeMissing")
        assert.strictEqual(response.failure.feature, "calendar");
    }
  }),
);

it.effect(
  "Calendar targets a moved recurring instance by originalStartTime and leaves other occurrences alone",
  () =>
    Effect.gen(function* () {
      const [parsed] = parseCalendar(
        "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:series\r\nDTSTART:20261002T120000Z\r\nRECURRENCE-ID:20261001T090000Z\r\nORGANIZER:mailto:alice@example.com\r\nATTENDEE:mailto:me@gmail.com\r\nEND:VEVENT\r\nEND:VCALENDAR",
      );
      assert.ok(parsed);
      const http = fakeHttp({
        "GET /calendar/v3/calendars/primary/events": (url) => {
          assert.strictEqual(url.searchParams.get("singleEvents"), "true");
          assert.ok(url.searchParams.has("timeMin"));
          return url.searchParams.has("pageToken")
            ? {
                json: {
                  items: [
                    {
                      id: "target",
                      originalStartTime: { dateTime: "2026-10-01T09:00:00Z" },
                      organizer: { email: "alice@example.com" },
                      attendees: [{ email: "me@gmail.com", self: true }],
                    },
                  ],
                },
              }
            : {
                json: {
                  items: [{ id: "other", originalStartTime: { dateTime: "2026-09-30T09:00:00Z" } }],
                  nextPageToken: "next",
                },
              };
        },
        "PATCH /calendar/v3/calendars/primary/events/target": { json: {} },
      });
      yield* run(http, (a) => a.respondInvite(account, "m1", parsed.invite, "tentative"));
      assert.deepStrictEqual(
        http.calls.filter((c) => c.method === "PATCH").map((c) => c.url.pathname),
        ["/calendar/v3/calendars/primary/events/target"],
      );
    }),
);

it.effect("Calendar absent, cancelled, ambiguous or mismatched events never get patched", () =>
  Effect.gen(function* () {
    const [parsed] = parseCalendar(
      "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:uid\r\nDTSTART:20261001T090000Z\r\nORGANIZER:mailto:alice@example.com\r\nATTENDEE:mailto:me@gmail.com\r\nEND:VEVENT\r\nEND:VCALENDAR",
    );
    assert.ok(parsed);
    const event = {
      id: "e1",
      organizer: { email: "alice@example.com" },
      attendees: [{ email: "me@gmail.com", self: true }],
    };
    for (const items of [
      [],
      [event, { ...event, id: "e2" }],
      [{ ...event, status: "cancelled" }],
      [{ ...event, organizer: { email: "stranger@example.com" } }],
      [{ ...event, attendees: [] }],
    ]) {
      const http = fakeHttp({ "GET /calendar/v3/calendars/primary/events": { json: { items } } });
      assert.strictEqual(
        (yield* run(http, (a) => a.respondInvite(account, "m1", parsed.invite, "accepted")).pipe(
          Effect.result,
        ))._tag,
        "Failure",
      );
      assert.ok(!http.calls.some((c) => c.method === "PATCH"));
    }
  }),
);

it("Gmail detects calendar alternatives without a filename", () => {
  const raw = message("invite", ["INBOX"]);
  const parsed = parseGmailMessage({
    ...raw,
    payload: {
      ...raw.payload,
      parts: [{ mimeType: "text/calendar", body: { size: 10, data: b64("BEGIN:VCALENDAR") } }],
    },
  });
  assert.strictEqual(parsed.hasCalendar, true);
});

it.effect(
  "disabled People API is a provider setup error, not a request for more OAuth grants",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "GET /v1/people/me/connections": {
          status: 403,
          json: {
            error: { status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] },
          },
        },
      });
      const result = yield* run(http, (a) => a.contacts(account)).pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "ProviderError");
    }),
);

it.effect("missing otherContacts scope still returns all saved-contact pages", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /v1/people/me/connections": (url) =>
        url.searchParams.has("pageToken")
          ? { json: { connections: [{ emailAddresses: [{ value: "second@example.com" }] }] } }
          : {
              json: {
                connections: [
                  {
                    names: [{ displayName: "Saved" }],
                    emailAddresses: [{ value: "saved@example.com" }],
                  },
                ],
                nextPageToken: "next",
              },
            },
      "GET /v1/otherContacts": { status: 403, json: { error: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" } },
    });
    assert.deepStrictEqual(yield* run(http, (a) => a.contacts(account)), [
      { name: "Saved", address: "saved@example.com" },
      { name: "", address: "second@example.com" },
    ]);
    assert.strictEqual(http.calls.length, 3);
  }),
);

it.effect(
  "floating recurrence ids match offset wall times; malformed zoned instances do not crash lookup",
  () =>
    Effect.gen(function* () {
      const source =
        "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:series\r\nDTSTART:20261001T090000\r\nRECURRENCE-ID:20261001T090000\r\nORGANIZER:mailto:alice@example.com\r\nATTENDEE:mailto:alias@googlemail.com\r\nEND:VEVENT\r\nEND:VCALENDAR";
      const [floating] = parseCalendar(source);
      const [zoned] = parseCalendar(source.replaceAll(":20261001T090000", ":20261001T090000Z"));
      assert.ok(floating);
      assert.ok(zoned);
      for (const [invite, dateTime] of [
        [floating.invite, "2026-10-01T09:00:00.000-04:00"],
        [zoned.invite, "2026-10-01T09:00:00Z"],
      ] as const) {
        const http = fakeHttp({
          "GET /calendar/v3/calendars/primary/events": {
            json: {
              items: [
                {
                  id: "bad-date",
                  originalStartTime: { dateTime: "broken", timeZone: "Unknown/Zone" },
                },
                {
                  id: "bad-zone",
                  originalStartTime: { dateTime: "2026-10-01T09:00:00", timeZone: "Unknown/Zone" },
                },
                {
                  id: "target",
                  originalStartTime: { dateTime },
                  organizer: { email: "alice@example.com" },
                  attendees: [{ email: "alias@googlemail.com", self: true }],
                },
              ],
            },
          },
          "PATCH /calendar/v3/calendars/primary/events/target": { json: {} },
        });
        // A floating id with two equal wall times remains ambiguous and must not
        // update either event. A zoned id ignores the malformed competitor.
        const result = yield* run(http, (a) =>
          a.respondInvite(account, "m1", invite, "accepted"),
        ).pipe(Effect.result);
        if (invite.recurrenceId?.kind === "floating") assert.strictEqual(result._tag, "Failure");
        else {
          assert.strictEqual(result._tag, "Success");
          assert.deepStrictEqual(http.calls.at(-1)?.body, {
            attendeesOmitted: true,
            attendees: [{ email: "alias@googlemail.com", responseStatus: "accepted" }],
          });
        }
      }
      const http = fakeHttp({
        "GET /calendar/v3/calendars/primary/events": {
          json: {
            items: [
              {
                id: "target",
                originalStartTime: { dateTime: "2026-10-01T09:00:00.000-04:00" },
                organizer: { email: "alice@example.com" },
                attendees: [{ email: "alias@googlemail.com", self: true }],
              },
            ],
          },
        },
        "PATCH /calendar/v3/calendars/primary/events/target": { json: {} },
      });
      yield* run(http, (a) => a.respondInvite(account, "m1", floating.invite, "tentative"));
      assert.deepStrictEqual(http.calls.at(-1)?.body, {
        attendeesOmitted: true,
        attendees: [{ email: "alias@googlemail.com", responseStatus: "tentative" }],
      });
    }),
);

it.effect(
  "Gmail settings accepts empty filter lists and keeps permission failures typed before decoding",
  () =>
    Effect.gen(function* () {
      for (const reply of [{ json: {} }, { json: { filter: [] } }, { json: null }, {}]) {
        const http = fakeHttp({ "GET /settings/filters": reply });
        assert.deepStrictEqual(yield* run(http, (a) => a.filters(account)), []);
      }
      for (const reply of [
        {
          status: 403,
          json: {
            error: {
              code: 403,
              message: "Request had insufficient authentication scopes.",
              status: "PERMISSION_DENIED",
            },
          },
        },
        { status: 403 },
        { status: 403, json: { error: { code: 403, message: "Forbidden" } } },
      ]) {
        const http = fakeHttp({
          "GET /settings/filters": reply,
          "GET /messages/m1": { json: { raw: b64("mail remains readable") } },
        });
        yield* run(http, (a) =>
          Effect.gen(function* () {
            const error = yield* a.filters(account).pipe(Effect.flip);
            assert.strictEqual(error._tag, "SettingsScopeMissing");
            assert.strictEqual(
              Buffer.from(yield* a.fetchRaw(account, "m1")).toString(),
              "mail remains readable",
            );
          }),
        );
      }
    }),
);

it.effect(
  "Gmail settings does not misclassify API disablement or quota errors as missing scopes",
  () =>
    Effect.gen(function* () {
      for (const body of [
        "SERVICE_DISABLED: PERMISSION_DENIED",
        "dailyLimitExceeded: forbidden",
        "rateLimitExceeded: Forbidden",
      ]) {
        const http = fakeHttp({ "GET /settings/filters": { status: 403, json: { error: body } } });
        yield* run(http, (adapter) =>
          Effect.gen(function* () {
            const request = yield* adapter.filters(account).pipe(Effect.flip, Effect.forkChild);
            yield* TestClock.adjust("1 minute");
            assert.strictEqual((yield* Fiber.join(request))._tag, "ProviderError");
          }),
        );
      }
    }),
);

it.effect("inbox polling reads only inbox history and does not replace cached labels", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /history": (url) => {
        assert.strictEqual(url.searchParams.get("labelId"), "INBOX");
        assert.strictEqual(url.searchParams.get("startHistoryId"), "100");
        return {
          json: { historyId: "101", history: [{ messagesAdded: [{ message: { id: "new" } }] }] },
        };
      },
      "GET /messages/new": { json: message("new", ["INBOX", "UNREAD"]) },
    });
    const changes = yield* run(http, (adapter) =>
      Stream.runCollect(adapter.pull(account, Option.some("100"), "inbox")),
    );
    assert.deepStrictEqual(tags(changes), ["Upsert", "Progress", "Cursor"]);
    assert.isFalse(http.calls.some((call) => call.url.pathname.endsWith("/labels")));
    assert.deepStrictEqual(changes.at(-1), { _tag: "Cursor", cursor: "101" });
  }),
);

it.effect("historical pages resume with a fixed snapshot without touching history", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /messages": (url) => ({
        json: url.searchParams.has("pageToken")
          ? { messages: [{ id: "older" }] }
          : { messages: [{ id: "old" }], nextPageToken: "next" },
      }),
      "GET /messages/old": { json: message("old", ["INBOX"]) },
      "GET /messages/older": { json: message("older", ["SPAM"]) },
    });
    yield* run(http, (adapter) =>
      Effect.gen(function* () {
        const first = yield* adapter.backfill(account, { cursor: null, before: 1_700_000_000_000 });
        assert.strictEqual(first.cursor, "next");
        assert.strictEqual(first.messages[0]?.providerId, "old");
        const second = yield* adapter.backfill(account, {
          cursor: first.cursor,
          before: 1_700_000_000_000,
        });
        assert.strictEqual(second.cursor, null);
        assert.strictEqual(second.messages[0]?.providerId, "older");
      }),
    );
    const lists = http.calls.filter((c) => c.url.pathname.endsWith("/messages"));
    assert.deepStrictEqual(
      lists.map((c) => c.url.searchParams.get("q")),
      ["before:1700000000", "before:1700000000"],
    );
    assert.strictEqual(lists[1]?.url.searchParams.get("pageToken"), "next");
    assert.strictEqual(
      http.calls.some((c) => c.url.pathname.endsWith("/history")),
      false,
    );
  }),
);

it.effect("backfill filters listed Gmail ids before any body download", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /messages": {
        json: {
          messages: [{ id: "cached" }, { id: "pending" }, { id: "missing" }],
          nextPageToken: "later",
        },
      },
      "GET /messages/missing": { json: message("missing", ["INBOX"]) },
    });
    const page = yield* run(http, (a) =>
      a.backfill(account, { cursor: null, before: 1_700_000_000_000 }, (ids) => {
        assert.deepStrictEqual(ids, ["cached", "pending", "missing"]);
        return Effect.succeed(["missing"]);
      }),
    );
    assert.strictEqual(page.scanned, 3);
    assert.strictEqual(page.cursor, "later");
    assert.deepStrictEqual(
      page.messages.map((m) => m.providerId),
      ["missing"],
    );
    assert.deepStrictEqual(
      http.calls.filter((c) => c.url.pathname.includes("/messages/")).map((c) => c.url.pathname),
      ["/gmail/v1/users/me/messages/missing"],
    );
  }),
);

it.effect("Gmail fetch parses a folded, encoded, multi-address Reply-To header", () =>
  Effect.gen(function* () {
    const raw = message("reply", ["INBOX"]);
    raw.payload.headers.push({
      name: "rEpLy-To",
      value: '=?UTF-8?B?UmVwbHksIFRlYW0=?= <reply@example.com>,\r\n "Doe, Jane" <jane@example.com>',
    });
    const http = fakeHttp({ "GET /messages/reply": { json: raw } });
    const parsed = yield* run(http, (adapter) => adapter.fetchMessage(account, "reply"));
    assert.deepStrictEqual(parsed.replyTo, [
      { name: "Reply, Team", address: "reply@example.com" },
      { name: "Doe, Jane", address: "jane@example.com" },
    ]);
    assert.deepStrictEqual(parseGmailMessage(message("no-reply-to", [])).replyTo, []);
    assert.deepStrictEqual(
      parseGmailMessage({
        ...raw,
        payload: { ...raw.payload, headers: [{ name: "Reply-To", value: "" }] },
      }).replyTo,
      [],
    );
  }),
);

it.effect(
  "Gmail attachment type tokens constrain the server page before fetching older mail",
  () => {
    const older = message("older-pdf", ["INBOX"]);
    const http = fakeHttp({
      "GET /labels": { json: labels },
      "GET /messages": (url) => {
        assert.strictEqual(url.searchParams.get("q"), "has:attachment {filename:pdf}");
        assert.strictEqual(url.searchParams.get("maxResults"), "200");
        return { json: { messages: [{ id: "older-pdf" }] } };
      },
      "GET /messages/older-pdf": {
        json: {
          ...older,
          payload: {
            ...older.payload,
            mimeType: "multipart/mixed",
            parts: [
              older.payload,
              {
                mimeType: "application/pdf",
                filename: "older.pdf",
                body: { size: 12, attachmentId: "pdf" },
              },
            ],
          },
        },
      },
    });
    return run(http, (adapter) => adapter.search(account, { search: "has:pdf" })).pipe(
      Effect.map((page) =>
        assert.deepStrictEqual(
          page.messages.map((item) => item.providerId),
          ["older-pdf"],
        ),
      ),
    );
  },
);

it.effect(
  "folder actions enumerate ids with page tokens and use bounded permanent batch deletion",
  () => {
    const http = fakeHttp({
      "POST /token": { json: { access_token: "token", expires_in: 3600 } },
      "GET /messages": (url) => {
        assert.strictEqual(url.searchParams.get("labelIds"), "TRASH");
        assert.strictEqual(url.searchParams.get("includeSpamTrash"), "true");
        assert.strictEqual(url.searchParams.get("maxResults"), "100");
        return {
          json: url.searchParams.has("pageToken")
            ? { messages: [{ id: "b" }] }
            : { messages: [{ id: "a" }], nextPageToken: "next" },
        };
      },
      "POST /messages/batchDelete": { status: 204 },
      "GET /messages/a": { json: { labelIds: ["TRASH"] } },
      "GET /messages/b": { json: { labelIds: ["TRASH"] } },
    });
    return run(http, (adapter) =>
      Effect.gen(function* () {
        const folder = { mailbox: "trash" } as const;
        const first = yield* adapter.listFolderMessages(account, folder, null);
        assert.deepStrictEqual(first, { ids: ["a"], next: "next" });
        assert.deepStrictEqual(yield* adapter.listFolderMessages(account, folder, first.next), {
          ids: ["b"],
          next: null,
        });
        yield* adapter.permanentlyDelete(account, ["a", "b"], "trash");
        assert.deepStrictEqual(
          http.calls.find((c) => c.url.pathname.endsWith("batchDelete"))?.body,
          { ids: ["a", "b"] },
        );
        assert.isTrue(
          (yield* adapter
            .permanentlyDelete(
              account,
              Array.from({ length: 101 }, () => "a"),
              "trash",
            )
            .pipe(Effect.result))._tag === "Failure",
        );
        assert.strictEqual(
          http.calls.filter((c) => c.url.pathname.endsWith("batchDelete")).length,
          1,
        );
      }),
    );
  },
);

it.effect(
  "folder enumeration intersects Inbox categories and excludes Trash and Spam from All Mail labels",
  () => {
    const http = fakeHttp({
      "POST /token": { json: { access_token: "token", expires_in: 3600 } },
      "GET /messages": (url) => {
        const labels = url.searchParams.getAll("labelIds");
        if (labels.includes("CATEGORY_SOCIAL")) {
          assert.deepStrictEqual(labels, ["INBOX", "CATEGORY_SOCIAL"]);
        } else {
          assert.deepStrictEqual(labels, ["custom"]);
          assert.strictEqual(url.searchParams.get("q"), "-in:trash -in:spam");
        }
        return { json: {} };
      },
    });
    return run(http, (adapter) =>
      Effect.gen(function* () {
        yield* adapter.listFolderMessages(
          account,
          { mailbox: "inbox", label: "CATEGORY_SOCIAL" },
          null,
        );
        yield* adapter.listFolderMessages(account, { mailbox: "all", label: "custom" }, null);
      }),
    );
  },
);

it.effect(
  "permanent deletion reports missing full-mail scope without pausing mail authentication",
  () => {
    const http = fakeHttp({
      "POST /token": { json: { access_token: "token", expires_in: 3600 } },
      "POST /messages/batchDelete": {
        status: 403,
        json: { error: { message: "insufficient authentication scopes" } },
      },
      "GET /messages/a": { json: { labelIds: ["TRASH"] } },
    });
    return run(http, (adapter) =>
      Effect.gen(function* () {
        const result = yield* adapter
          .permanentlyDelete(account, ["a"], "trash")
          .pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure")
          assert.strictEqual(result.failure._tag, "FeatureScopeMissing");
      }),
    );
  },
);

it.effect("Gmail folder reads query UNREAD before enumerating and mark an entire ID batch", () => {
  const http = fakeHttp({
    "POST /token": { json: { access_token: "token", expires_in: 3600 } },
    "GET /messages": (url) => {
      assert.deepStrictEqual(url.searchParams.getAll("labelIds"), ["UNREAD"]);
      assert.strictEqual(url.searchParams.get("q"), "-in:trash -in:spam");
      return { json: { messages: [{ id: "unread" }] } };
    },
    "POST /messages/batchModify": { status: 204 },
  });
  return run(http, (adapter) =>
    Effect.gen(function* () {
      const page = yield* adapter.listFolderMessages(account, { mailbox: "all" }, null, {
        unreadOnly: true,
      });
      yield* adapter.markReadBatch(account, page.ids);
      assert.deepStrictEqual(
        http.calls.find((call) => call.url.pathname.endsWith("batchModify"))?.body,
        { ids: ["unread"], addLabelIds: [], removeLabelIds: ["UNREAD"] },
      );
    }),
  );
});

it.effect(
  "Gmail checks current minimal labels for every id and returns only confirmed Trash or Spam deletions",
  () => {
    const metadata = (labels: string[]) => (url: URL) => {
      assert.strictEqual(url.searchParams.get("format"), "minimal");
      assert.strictEqual(url.searchParams.get("fields"), "labelIds");
      return { json: { labelIds: labels } };
    };
    const http = fakeHttp({
      "POST /token": { json: { access_token: "token", expires_in: 3600 } },
      "GET /messages/trash": metadata(["TRASH"]),
      "GET /messages/restored": metadata(["INBOX"]),
      "GET /messages/spam": metadata(["SPAM"]),
      "GET /messages/gone": { status: 404 },
      "POST /messages/batchDelete": { status: 204 },
    });
    return run(http, (adapter) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(
          yield* adapter.permanentlyDelete(account, ["trash", "restored", "gone"], "trash"),
          { kind: "complete", ids: ["trash"] },
        );
        assert.deepStrictEqual(
          yield* adapter.permanentlyDelete(account, ["spam", "restored"], "spam"),
          { kind: "complete", ids: ["spam"] },
        );
        assert.deepStrictEqual(
          http.calls
            .filter((call) => call.url.pathname.endsWith("batchDelete"))
            .map((call) => call.body),
          [{ ids: ["trash"] }, { ids: ["spam"] }],
        );
      }),
    );
  },
);

it.effect(
  "Gmail Move To adds the destination and removes the current label in one modify request",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "GET /messages/m1": { json: { labelIds: ["INBOX"] } },
        "POST /messages/m1/modify": { json: {} },
      });
      yield* run(http, (a) =>
        a.push(account, "m1", { kind: "move", labelId: "Label_2", removeLabelId: "INBOX" }),
      );
      assert.strictEqual(http.calls.filter((call) => call.method === "POST").length, 1);
      assert.deepStrictEqual(http.calls.at(-1)?.body, {
        addLabelIds: ["Label_2"],
        removeLabelIds: ["INBOX", "SPAM"],
      });
    }),
);
it.effect("Gmail label visibility is read and PATCHed; reparenting renames descendants", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /labels": {
        json: {
          labels: [
            {
              id: "a",
              name: "A",
              type: "user",
              labelListVisibility: "labelHide",
              messageListVisibility: "hide",
            },
            { id: "child", name: "A/Child", type: "user" },
            { id: "b", name: "B", type: "user" },
          ],
        },
      },
      "PATCH /labels/a": { json: {} },
      "PATCH /labels/child": { json: {} },
    });
    yield* run(http, (a) =>
      Effect.gen(function* () {
        const labels = yield* a.changeLabel(account, {
          kind: "visibility",
          id: "a",
          labelListVisibility: "labelShowIfUnread",
          messageListVisibility: "show",
        });
        assert.strictEqual(labels[0]?.labelListVisibility, "labelHide");
        assert.strictEqual(labels[0]?.messageListVisibility, "hide");
        yield* a.changeLabel(account, { kind: "parent", id: "a", parentId: "b" });
      }),
    );
    assert.deepStrictEqual(
      http.calls.filter((c) => c.method === "PATCH").map((c) => c.body),
      [
        { labelListVisibility: "labelShowIfUnread", messageListVisibility: "show" },
        { name: "B/A" },
        { name: "B/A/Child" },
      ],
    );
  }),
);
it.effect(
  "Gmail edits filters by delete and create; a failed create restores the original rule",
  () =>
    Effect.gen(function* () {
      const original = {
        id: "old",
        criteria: { from: "alice" },
        action: { removeLabelIds: ["UNREAD"] },
      };
      const replacement = {
        name: "Edited",
        criteria: { from: "bob", to: "", subject: "", query: "", hasAttachment: false },
        action: { archive: true, markRead: false, star: false, trash: false, label: null },
      };
      const success = fakeHttp({
        "GET /settings/filters/old": { json: original },
        "DELETE /settings/filters/old": { status: 204 },
        "POST /settings/filters": { json: { ...original, id: "new" } },
      });
      const edited = yield* run(success, (a) => a.updateFilter(account, "old", replacement));
      assert.strictEqual(edited.id, "new");
      assert.deepStrictEqual(
        success.calls.map((c) => c.method),
        ["GET", "DELETE", "POST"],
      );
      let posts = 0;
      const failure = fakeHttp({
        "GET /settings/filters": { json: { filter: [] } },
        "GET /settings/filters/old": { json: original },
        "DELETE /settings/filters/old": { status: 204 },
        "POST /settings/filters": () =>
          ++posts === 1
            ? { status: 400, json: { error: "invalid replacement" } }
            : { json: { ...original, id: "restored" } },
      });
      const error = yield* run(failure, (a) =>
        a.updateFilter(account, "old", replacement).pipe(Effect.flip),
      );
      assert.match(error.message, /previous rule was restored/);
      assert.deepStrictEqual(failure.calls.at(-1)?.body, {
        criteria: original.criteria,
        action: original.action,
      });
    }),
);
it.effect("Gmail rejects edits of rules with unrepresented actions before deleting them", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /settings/filters/old": {
        json: {
          id: "old",
          criteria: { from: "alice", negatedQuery: "urgent" },
          action: { forward: "someone@example.com", removeLabelIds: ["UNREAD"] },
        },
      },
    });
    const result = yield* run(http, (a) =>
      a
        .updateFilter(account, "old", {
          name: "",
          criteria: { from: "bob", to: "", subject: "", query: "", hasAttachment: false },
          action: { archive: false, markRead: true, star: false, trash: false, label: null },
        })
        .pipe(Effect.result),
    );
    assert.strictEqual(result._tag, "Failure");
    assert.strictEqual(http.calls.length, 1);
  }),
);

for (const source of ["TRASH", "SPAM"] as const) {
  it.effect(`Gmail Move To from ${source} clears the system label in single and batch paths`, () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "GET /labels": { json: { labels: [{ id: "Label_target", name: "Target", type: "user" }] } },
        "GET /messages/m1": { json: { labelIds: [source] } },
        "POST /messages/m1/untrash": { json: {} },
        "POST /messages/m1/modify": { json: {} },
      });
      yield* run(http, (adapter) =>
        Effect.gen(function* () {
          const op = { kind: "move", labelId: "Label_target", removeLabelId: null } as const;
          yield* adapter.push(account, "m1", op);
          assert.ok(adapter.pushBatch);
          yield* adapter.pushBatch(account, ["m1"], op);
        }),
      );
      const posts = http.calls.filter((call) => call.method === "POST");
      assert.strictEqual(
        posts.filter((call) => call.url.pathname.endsWith("/untrash")).length,
        source === "TRASH" ? 2 : 0,
      );
      const modifications = posts.filter((call) => call.url.pathname.endsWith("/modify"));
      assert.strictEqual(modifications.length, 2);
      for (const call of modifications)
        assert.deepStrictEqual(call.body, {
          addLabelIds: ["Label_target"],
          removeLabelIds: ["SPAM"],
        });
    }),
  );
}

it.effect(
  "Gmail documented category and importance actions are editable while undocumented additions stay protected",
  () =>
    Effect.gen(function* () {
      const rules = ["CATEGORY_UPDATES", "SENT", "INBOX", "IMPORTANT"].map((label, index) => ({
        id: String(index),
        criteria: { from: "alice" },
        action: { addLabelIds: [label] },
      }));
      const http = fakeHttp({
        "GET /settings/filters": { json: { filter: rules } },
        ...Object.fromEntries(
          rules.map((rule) => [`DELETE /settings/filters/${rule.id}`, { status: 204 }]),
        ),
      });
      yield* run(http, (adapter) =>
        Effect.gen(function* () {
          const filters = yield* adapter.filters(account);
          assert.notStrictEqual(filters[0]?.editable, false);
          assert.strictEqual(filters[1]?.editable, false);
          assert.strictEqual(filters[2]?.editable, false);
          assert.notStrictEqual(filters[3]?.editable, false);
          for (const filter of filters) yield* adapter.deleteFilter(account, filter.id);
        }),
      );
      assert.strictEqual(
        http.calls.filter((call) => call.method === "DELETE").length,
        rules.length,
      );
    }),
);

for (const collision of ["B/A", "B/A/Child"]) {
  it.effect(`Gmail reparent checks ${collision} for collisions before any PATCH`, () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "GET /labels": {
          json: {
            labels: [
              { id: "a", name: "A", type: "user" },
              { id: "child", name: "A/Child", type: "user" },
              { id: "b", name: "B", type: "user" },
              { id: "collision", name: collision, type: "user" },
            ],
          },
        },
      });
      const exit = yield* run(http, (adapter) =>
        adapter.changeLabel(account, { kind: "parent", id: "a", parentId: "b" }),
      ).pipe(Effect.result);
      assert.strictEqual(exit._tag, "Failure");
      assert.strictEqual(
        http.calls.some((call) => call.method === "PATCH"),
        false,
      );
    }),
  );
}

it.effect("Gmail reparent rolls back already-renamed labels on a descendant failure", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /labels": {
        json: {
          labels: [
            { id: "a", name: "A", type: "user" },
            { id: "child", name: "A/Child", type: "user" },
            { id: "b", name: "B", type: "user" },
          ],
        },
      },
      "PATCH /labels/a": { json: {} },
      "PATCH /labels/child": { status: 400, json: { error: "rename refused" } },
    });
    const exit = yield* run(http, (adapter) =>
      adapter.changeLabel(account, { kind: "parent", id: "a", parentId: "b" }),
    ).pipe(Effect.result);
    assert.strictEqual(exit._tag, "Failure");
    assert.deepStrictEqual(
      http.calls.filter((call) => call.method === "PATCH").map((call) => call.body),
      [{ name: "B/A" }, { name: "B/A/Child" }, { name: "A" }],
    );
  }),
);

for (const recoverySucceeds of [true, false]) {
  it.effect(
    `Gmail uncertain restoration preserves a backup without replay even when ${recoverySucceeds ? "a later POST would succeed" : "all later POSTs would fail"}`,
    () =>
      Effect.gen(function* () {
        const original = {
          id: "old",
          criteria: { from: "alice" },
          action: { removeLabelIds: ["UNREAD"] },
        };
        let posts = 0;
        const attempted: unknown[] = [];
        const saved: GmailRuleDefinition[] = [];
        const settings = makeGmailSettings(
          (_id, schema, path) =>
            Schema.decodeUnknownEffect(schema)(
              path.endsWith("/old") ? original : { filter: [] },
            ).pipe(Effect.orDie),
          (_id, method, _path, body) =>
            Effect.suspend(() => {
              if (method === "DELETE") return Effect.void;
              posts++;
              attempted.push(body);
              return recoverySucceeds && posts === 3
                ? Effect.succeed({ ...original, id: "restored" })
                : Effect.fail(
                    new ProviderError({ message: "offline", status: posts === 1 ? 400 : 503 }),
                  );
            }),
        );
        const request = yield* Effect.forkChild(
          settings
            .updateFilter(
              account,
              "old",
              {
                ...EMPTY_FILTER,
                criteria: { ...EMPTY_FILTER.criteria, from: "bob" },
                action: { ...EMPTY_FILTER.action, markRead: true },
              },
              (definition) =>
                Effect.sync(() => {
                  saved.push(definition);
                }),
            )
            .pipe(Effect.result),
        );
        yield* TestClock.adjust("2 seconds");
        const result = yield* Fiber.join(request);
        assert.strictEqual(result._tag, "Failure");
        const definition = { criteria: original.criteria, action: original.action };
        assert.deepStrictEqual(attempted.slice(1), [definition]);
        assert.deepStrictEqual(saved, [definition]);
      }),
  );
}

it.effect(
  "Gmail exposes archive plus one label for editing but rejects other destination combinations",
  () =>
    Effect.gen(function* () {
      const rules = [
        {
          id: "label-and-archive",
          action: { addLabelIds: ["Label_1"], removeLabelIds: ["INBOX"] },
        },
        {
          id: "trash-and-label",
          action: { addLabelIds: ["TRASH", "Label_1"], removeLabelIds: [] },
        },
        { id: "trash-and-archive", action: { addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] } },
        {
          id: "multiple-labels",
          action: { addLabelIds: ["Label_1", "Label_2"], removeLabelIds: ["INBOX"] },
        },
      ].map((rule) => ({ ...rule, criteria: { from: "alice" } }));
      const http = fakeHttp({ "GET /settings/filters": { json: { filter: rules } } });
      const filters = yield* run(http, (adapter) => adapter.filters(account));
      assert.notStrictEqual(filters[0]?.editable, false);
      assert.ok(filters.slice(1, 3).every((filter) => filter.editable === false));
      assert.notStrictEqual(filters[3]?.editable, false);
      assert.deepStrictEqual(filters[3]?.action.labels, ["Label_2"]);
    }),
);

it.effect("Gmail exposes no draft organization write unsupported by its API", () =>
  Effect.gen(function* () {
    const http = fakeHttp({});
    yield* run(http, (adapter) =>
      Effect.sync(() => assert.strictEqual("setDraftOrganization" in adapter, false)),
    );
    assert.strictEqual(http.calls.length, 0);
  }),
);

it.effect(
  "Google saved contacts join paginated group memberships and saved photos without extra scopes",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "GET /v1/people/me/connections": (url) => {
          assert.strictEqual(
            url.searchParams.get("personFields"),
            "names,emailAddresses,organizations,photos,memberships",
          );
          assert.strictEqual(url.searchParams.get("sources"), "READ_SOURCE_TYPE_CONTACT");
          return url.searchParams.get("pageToken")
            ? {
                json: {
                  connections: [
                    {
                      names: [{ displayName: "Bob" }],
                      emailAddresses: [{ value: "bob@example.com" }],
                      photos: [{ url: "https://photos.example.com/default", default: true }],
                      memberships: [
                        {
                          contactGroupMembership: {
                            contactGroupResourceName: "contactGroups/team",
                          },
                        },
                      ],
                    },
                  ],
                },
              }
            : {
                json: {
                  connections: [
                    {
                      names: [{ displayName: "Alice" }],
                      emailAddresses: [
                        { value: "Alice@example.com" },
                        { value: "second@example.com" },
                      ],
                      photos: [
                        { url: "https://photos.example.com/alice", metadata: { primary: true } },
                      ],
                      memberships: [
                        {
                          contactGroupMembership: {
                            contactGroupResourceName: "contactGroups/team",
                          },
                        },
                      ],
                    },
                  ],
                  nextPageToken: "next",
                },
              };
        },
        "GET /v1/otherContacts": {
          json: { otherContacts: [{ emailAddresses: [{ value: "other@example.com" }] }] },
        },
        "GET /v1/contactGroups": (url) => {
          assert.strictEqual(url.searchParams.get("groupFields"), "name,groupType");
          return url.searchParams.get("pageToken")
            ? {
                json: {
                  contactGroups: [
                    {
                      resourceName: "contactGroups/empty",
                      name: "Empty",
                      groupType: "USER_CONTACT_GROUP",
                    },
                  ],
                },
              }
            : {
                json: {
                  contactGroups: [
                    {
                      resourceName: "contactGroups/team",
                      name: "Team",
                      groupType: "USER_CONTACT_GROUP",
                    },
                    {
                      resourceName: "contactGroups/myContacts",
                      name: "My contacts",
                      groupType: "SYSTEM_CONTACT_GROUP",
                    },
                  ],
                  nextPageToken: "next",
                },
              };
        },
      });
      const snapshot = yield* run(http, (adapter) => {
        assert.ok("contactSnapshot" in adapter);
        if (!adapter.contactSnapshot) throw new Error("Missing contact snapshots");
        return adapter.contactSnapshot(account);
      });
      assert.deepStrictEqual(snapshot.groups, [
        {
          accountId: account.id,
          id: "contactGroups/team",
          name: "Team",
          members: [
            { name: "Alice", address: "alice@example.com" },
            { name: "Alice", address: "second@example.com" },
            { name: "Bob", address: "bob@example.com" },
          ],
        },
      ]);
      assert.deepStrictEqual(snapshot.photos, [
        { address: "alice@example.com", url: "https://photos.example.com/alice" },
        { address: "second@example.com", url: "https://photos.example.com/alice" },
      ]);
      assert.strictEqual(snapshot.contacts.length, 4);
      assert.strictEqual(http.calls.length, 5);
    }),
);

it.effect("repeated group pages fail rather than committing an incomplete snapshot", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /v1/people/me/connections": { json: { connections: [] } },
      "GET /v1/otherContacts": { json: { otherContacts: [] } },
      "GET /v1/contactGroups": { json: { contactGroups: [], nextPageToken: "repeat" } },
    });
    const result = yield* run(http, (adapter) => {
      assert.ok("contactSnapshot" in adapter);
      if (!adapter.contactSnapshot) throw new Error("Missing contact snapshots");
      return adapter.contactSnapshot(account);
    }).pipe(Effect.result);
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "InvalidInput");
  }),
);

it.effect(
  "Gmail extended rules map words, exclusions, size, importance, category and multiple labels without forwarding",
  () =>
    Effect.gen(function* () {
      const rule = {
        id: "extended",
        criteria: {
          from: "",
          to: "",
          subject: "",
          hasAttachment: false,
          query: "(budget)",
          negatedQuery: "private",
          size: 1_000_000,
          sizeComparison: "larger",
        },
        action: {
          addLabelIds: ["Label_1", "Label_2", "CATEGORY_UPDATES"],
          removeLabelIds: ["IMPORTANT"],
        },
      };
      const http = fakeHttp({ "POST /settings/filters": { json: rule } });
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
            size: 1_000_000,
            sizeComparison: "larger",
          },
          action: {
            archive: false,
            markRead: false,
            star: false,
            trash: false,
            label: "Label_1",
            labels: ["Label_2"],
            important: false,
            category: "CATEGORY_UPDATES",
          },
        }),
      );
      assert.deepStrictEqual(http.calls.find((call) => call.method === "POST")?.body, {
        criteria: rule.criteria,
        action: rule.action,
      });
      assert.notStrictEqual(saved.editable, false);
      assert.strictEqual(saved.criteria.notWords, "private");
      assert.strictEqual(saved.criteria.size, 1_000_000);
      assert.deepStrictEqual(saved.action.labels, ["Label_2"]);
      assert.strictEqual(saved.action.category, "CATEGORY_UPDATES");
      assert.strictEqual(saved.action.important, false);
    }),
);

it.effect("label-only history reads minimal and additions read full", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /labels": { json: { labels: [] } },
      "GET /history": {
        json: {
          historyId: "2",
          history: [
            {
              labelsAdded: [{ message: { id: "labels" } }],
              messagesAdded: [{ message: { id: "added" } }],
            },
          ],
        },
      },
      "GET /messages/labels": { json: { id: "labels", labelIds: ["INBOX", "STARRED"] } },
      "GET /messages/added": { json: message("added", ["INBOX"]) },
    });
    const changes = yield* run(http, (a) => Stream.runCollect(a.pull(account, Option.some("1"))));
    assert.ok(changes.some((c) => c._tag === "MessageLabels"));
    assert.strictEqual(
      http.calls
        .find((c) => c.url.pathname.endsWith("/labels") && c.url.searchParams.has("format"))
        ?.url.searchParams.get("format"),
      "minimal",
    );
    assert.strictEqual(
      http.calls.find((c) => c.url.pathname.endsWith("/added"))?.url.searchParams.get("format"),
      "full",
    );
  }),
);

for (const delivered of [true, false])
  it.effect(`Gmail ambiguous send ${delivered} checks Sent once without resending`, () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "POST /messages/send": { status: 503, json: { error: "ambiguous" } },
        "GET /messages": (url) => {
          assert.include(url.searchParams.get("q") ?? "", "in:sent");
          return { json: { messages: delivered ? [{ id: "sent" }] : [] } };
        },
      });
      const result = yield* run(http, (a) =>
        Effect.gen(function* () {
          const fiber = yield* a
            .send(account, outgoing, Option.none())
            .pipe(Effect.result, Effect.forkChild);
          while (
            !http.calls.some(
              (call) => call.method === "GET" && call.url.pathname.endsWith("/messages"),
            )
          )
            yield* Effect.yieldNow;
          yield* TestClock.adjust("35 seconds");
          return yield* Fiber.join(fiber);
        }),
      );
      assert.strictEqual(result._tag, delivered ? "Success" : "Failure");
      assert.strictEqual(http.calls.filter((c) => c.method === "POST").length, 1);
      const sent = yield* Schema.decodeUnknownEffect(Schema.Struct({ raw: Schema.String }))(
        http.calls[0]?.body,
      );
      assert.match(Buffer.from(sent.raw, "base64url").toString(), /Message-ID: <.+@gmail.com>/i);
    }),
  );

it.effect("a changed remote Gmail draft creates a second copy", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /drafts/d1": { json: { id: "d1", message: { id: "other-edit" } } },
      "POST /drafts": { json: { id: "d2", message: { id: "ours" } } },
      "PUT /drafts/d1": { json: { id: "d1", message: { id: "overwritten" } } },
    });
    const saved = yield* run(http, (a) =>
      a.saveDraft(account, {
        creation: draftCreation(),
        remote: { draftId: "d1", messageId: "before" },
        message: outgoing,
        original: Option.none(),
        replaceAttachments: false,
      }),
    );
    assert.strictEqual(saved.messageId, "ours");
    assert.strictEqual(saved.conflict, true);
    assert.isFalse(http.calls.some((c) => c.method === "PUT"));
  }),
);

for (const date of [false, true])
  it.effect(`Retry-After ${date ? "HTTP date" : "seconds"} delays provider retries`, () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      let requests = 0;
      const http = fakeHttp({
        "POST /messages/m/modify": () =>
          ++requests === 1
            ? {
                status: 429,
                headers: { "Retry-After": date ? new Date(now + 5000).toUTCString() : "5" },
              }
            : { json: {} },
      });
      yield* run(http, (a) =>
        Effect.gen(function* () {
          const fiber = yield* a
            .push(account, "m", { kind: "read", value: true })
            .pipe(Effect.forkChild);
          yield* TestClock.adjust("2 seconds");
          assert.strictEqual(requests, 1);
          yield* TestClock.adjust("3 seconds");
          yield* Fiber.join(fiber);
          assert.strictEqual(requests, 2);
        }),
      );
    }),
  );

it.effect("send transport timeout checks Sent and never replays POST", () =>
  Effect.gen(function* () {
    let posts = 0,
      sentChecks = 0;
    const client = HttpClient.make((request, url) =>
      Effect.suspend(() => {
        if (url.pathname.endsWith("/messages/send")) {
          posts++;
          return Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                description: "timeout after submission",
              }),
            }),
          );
        }
        sentChecks++;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ messages: [], value: [] })),
          ),
        );
      }),
    );
    const http = { layer: Layer.succeed(HttpClient.HttpClient, client), calls: [] };
    yield* run(http, (a) =>
      Effect.gen(function* () {
        const fiber = yield* a
          .send(account, outgoing, Option.none())
          .pipe(Effect.result, Effect.forkChild);
        while ((() => sentChecks === 0)()) yield* Effect.yieldNow;
        yield* TestClock.adjust("35 seconds");
        assert.strictEqual((yield* Fiber.join(fiber))._tag, "Failure");
      }),
    );
    assert.strictEqual(posts, 1);
    assert.isAtLeast(sentChecks, 6);
  }),
);

it.effect("Gmail JSON signed containers use raw MIME for the body", () =>
  Effect.gen(function* () {
    const signedRaw =
      "Content-Type: application/pkcs7-mime; smime-type=signed-data; name=smime.p7m\r\nContent-Transfer-Encoding: base64\r\n\r\nMFEGCSqGSIb3DQEHAqBEMEICAQExADA7BgkqhkiG9w0BBwGgLgQsQ29udGVudC1UeXBlOiB0ZXh0L3BsYWluDQoNCnNpZ25lZCBKU09OIGJvZHk=";
    const http = fakeHttp({
      "GET /messages/signed": (url) =>
        url.searchParams.get("format") === "raw"
          ? { json: { raw: b64(signedRaw) } }
          : {
              json: {
                ...message("signed", ["INBOX"]),
                payload: {
                  mimeType: "application/pkcs7-mime",
                  filename: "smime.p7m",
                  body: { size: 100 },
                },
              },
            },
    });
    const m = yield* run(http, (a) => a.fetchMessage(account, "signed"));
    assert.strictEqual(m.bodyText.trim(), "signed JSON body");
    assert.deepStrictEqual(
      m.attachments.map((part) => part.filename),
      ["smime.p7m"],
    );
  }),
);
it.effect("Gmail JSON uuencode attachments are listed and fetched from raw MIME", () =>
  Effect.gen(function* () {
    const text = "hello\r\nbegin 644 file.txt\r\n#0V%T\r\n`\r\nend\r\n";
    const http = fakeHttp({
      "GET /messages/uu": (url) =>
        url.searchParams.get("format") === "raw"
          ? { json: { raw: b64(`Content-Type: text/plain\r\n\r\n${text}`) } }
          : {
              json: {
                ...message("uu", ["INBOX"]),
                payload: { mimeType: "text/plain", body: { size: text.length, data: b64(text) } },
              },
            },
    });
    yield* run(http, (a) =>
      Effect.gen(function* () {
        const m = yield* a.fetchMessage(account, "uu");
        assert.strictEqual(m.attachments[0]?.filename, "file.txt");
        assert.strictEqual(
          Buffer.from(
            yield* a.fetchAttachment(account, "uu", {
              index: 0,
              filename: "file.txt",
              occurrence: 0,
            }),
          ).toString(),
          "Cat",
        );
      }),
    );
  }),
);

it.effect("a late Sent copy is polled without repeating the send", () =>
  Effect.gen(function* () {
    let lookup = 0;
    const http = fakeHttp({
      "POST /messages/send": { status: 503 },
      "GET /messages": (url) => ({
        json: {
          messages:
            (url.searchParams.get("q") ?? "").includes("@gmail.com") && ++lookup >= 6
              ? [{ id: "delayed" }]
              : [],
        },
      }),
    });
    yield* run(http, (a) =>
      Effect.gen(function* () {
        const fiber = yield* a
          .send(account, outgoing, Option.none())
          .pipe(Effect.result, Effect.forkChild);
        while ((() => lookup === 0)()) yield* Effect.yieldNow;
        yield* TestClock.adjust("35 seconds");
        assert.strictEqual((yield* Fiber.join(fiber))._tag, "Success");
      }),
    );
    assert.strictEqual(http.calls.filter((c) => c.method === "POST").length, 1);
    assert.strictEqual(lookup, 6);
  }),
);

it.effect("ambiguous Gmail sends search their random Message-ID token in recent Sent", () =>
  Effect.gen(function* () {
    let token = "";
    const http = fakeHttp({
      "POST /messages/send": () => {
        const sent = Schema.decodeUnknownSync(Schema.Struct({ raw: Schema.String }))(
          http.calls.find((call) => call.method === "POST")?.body,
        );
        const mime = Buffer.from(sent.raw, "base64url").toString();
        assert.notInclude(mime, "X-OpenMail-Id:");
        const id = /^Message-ID: <([a-f0-9-]+)@gmail.com>$/im.exec(mime.replaceAll("\r", ""));
        assert.ok(id);
        token = id[1]!;
        return { status: 503 };
      },
      "GET /messages": (url) => {
        const q = url.searchParams.get("q") ?? "";
        if (q.includes("@gmail.com")) return { json: { messages: [] } };
        assert.include(q, "in:sent");
        assert.notInclude(q, "rfc822msgid:");
        assert.match(q, /after:-?\d+/);
        return { json: { messages: [{ id: "rewritten" }] } };
      },
      "GET /messages/rewritten": () => ({
        json: {
          payload: { headers: [{ name: "Message-ID", value: `<${token}@rewritten.gmail.com>` }] },
        },
      }),
    });
    const result = yield* run(http, (a) =>
      a.send(account, outgoing, Option.none()).pipe(Effect.result),
    );
    assert.strictEqual(result._tag, "Success");
    assert.ok(
      http.calls.some((call) => call.url.searchParams.get("metadataHeaders") === "Message-ID"),
    );
  }),
);

it.effect("a Retry-After over sixty seconds returns to the next sync", () =>
  Effect.gen(function* () {
    let calls = 0;
    const http = fakeHttp({
      "POST /messages/m/modify": () =>
        ++calls === 1 ? { status: 429, headers: { "Retry-After": "61" } } : { json: {} },
    });
    const result = yield* run(http, (a) =>
      Effect.gen(function* () {
        const fiber = yield* a
          .push(account, "m", { kind: "read", value: true })
          .pipe(Effect.result, Effect.forkChild);
        yield* TestClock.adjust("62 seconds");
        return yield* Fiber.join(fiber);
      }),
    );
    assert.strictEqual(result._tag, "Failure");
    assert.strictEqual(calls, 1);
    if (result._tag === "Failure") {
      assert.strictEqual(result.failure._tag, "ProviderError");
      if (result.failure._tag === "ProviderError")
        assert.strictEqual(result.failure.deferred, true);
    }
  }),
);

it.effect("MIME parse failures preserve opaque mail and advance history", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /labels": { json: { labels: [] } },
      "GET /profile": { json: { emailAddress: account.email, historyId: "safe-cursor" } },
      "GET /messages": { json: { messages: [{ id: "opaque" }] } },
      "GET /messages/opaque": (url) =>
        url.searchParams.get("format") === "raw"
          ? { json: { raw: b64("malformed MIME") } }
          : {
              json: {
                ...message("opaque", ["INBOX"]),
                payload: {
                  mimeType: "application/pkcs7-mime",
                  filename: "smime.p7m",
                  body: { size: 100 },
                },
              },
            },
    });
    const broken = {
      ...nodeMailCodec,
      parse: async () => {
        throw new Error("malformed MIME");
      },
    };
    const changes = yield* makeGmail.pipe(
      Effect.provideService(MailCodec, broken),
      Effect.flatMap((a) => Stream.runCollect(a.pull(account, Option.none()))),
      Effect.provide(Layer.mergeAll(http.layer, platform)),
    );
    const upsert = changes.find((change) => change._tag === "Upsert");
    assert.ok(upsert?._tag === "Upsert");
    assert.strictEqual(upsert.message.attachments[0]?.filename, "smime.p7m");
    assert.deepStrictEqual(changes.at(-1), { _tag: "Cursor", cursor: "safe-cursor" });
  }),
);

it.effect("signed attachments do not trigger Gmail body replacement", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /messages/invoice": (url) => {
        assert.strictEqual(url.searchParams.get("format"), "full");
        return {
          json: {
            ...message("invoice", ["INBOX"]),
            payload: {
              mimeType: "multipart/mixed",
              body: { size: 0 },
              parts: [
                { mimeType: "text/plain", body: { size: 16, data: b64("Invoice enclosed") } },
                {
                  mimeType: "application/pkcs7-mime",
                  filename: "invoice.pdf.p7m",
                  body: { size: 100 },
                },
              ],
            },
          },
        };
      },
    });
    const m = yield* run(http, (a) => a.fetchMessage(account, "invoice"));
    assert.strictEqual(m.bodyText, "Invoice enclosed");
    assert.strictEqual(m.attachments[0]?.filename, "invoice.pdf.p7m");
    assert.strictEqual(http.calls.length, 1);
  }),
);

it.effect(
  "background Gmail pull refuses missing and expired history without listing or full sync",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({ "GET /history": { status: 404 } });
      for (const cursor of [Option.none<string>(), Option.some("expired")]) {
        const result = yield* run(http, (adapter) =>
          Stream.runCollect(adapter.pull(account, cursor, "inbox", true)).pipe(Effect.result),
        );
        assert.strictEqual(result._tag, "Failure");
      }
      assert.isFalse(http.calls.some((call) => /messages|profile|labels/.test(call.url.pathname)));
    }),
);

it.effect("a missing OAuth client is configuration failure, never a status-zero AuthError", () => {
  const http = fakeHttp({});
  return makeGmail.pipe(
    Effect.flatMap((adapter) => adapter.fetchRaw(account, "fake").pipe(Effect.flip)),
    Effect.map((error) => {
      assert.strictEqual(error._tag, "ProviderError");
      assert.strictEqual(http.calls.length, 0);
    }),
    Effect.provide(
      Layer.mergeAll(
        http.layer,
        MemoryPlatform({ secrets: { [account.id]: "fake-refresh" }, config: {} }),
      ),
    ),
  );
});

for (const failure of ["offline", "AbortError"]) {
  it.effect(`gmail status-zero ${failure} GET retries once and remains ProviderError`, () =>
    Effect.gen(function* () {
      let calls = 0;
      const client = HttpClient.make((request) =>
        Effect.suspend(() => {
          calls++;
          return Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, description: failure }),
            }),
          );
        }),
      );
      const http = { layer: Layer.succeed(HttpClient.HttpClient, client), calls: [] };
      yield* run(http, (adapter) =>
        Effect.gen(function* () {
          const fiber = yield* adapter
            .fetchRaw(account, "fake")
            .pipe(Effect.flip, Effect.forkChild);
          yield* TestClock.adjust("2 seconds");
          const error = yield* Fiber.join(fiber);
          assert.strictEqual(error._tag, "ProviderError");
          if (error._tag === "ProviderError") assert.strictEqual(error.status, 0);
        }),
      );
      assert.strictEqual(calls, 2);
    }),
  );
}

it.effect("gmail never retries a send on a dropped connection", () =>
  Effect.gen(function* () {
    let sends = 0;
    let lookups = 0;
    const client = HttpClient.make((request) =>
      Effect.suspend(() => {
        if (request.method === "GET") {
          lookups++;
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify({ value: [], id: "folder", payload: { headers: [] } })),
            ),
          );
        }
        sends++;
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, description: "offline" }),
          }),
        );
      }),
    );
    const http = { layer: Layer.succeed(HttpClient.HttpClient, client), calls: [] };
    const error = yield* run(http, (adapter) =>
      Effect.gen(function* () {
        const fiber = yield* adapter
          .send(
            account,
            {
              to: [{ name: "Recipient", address: "recipient@example.com" }],
              cc: [],
              bcc: [],
              subject: "Test",
              text: "Text",
              attachments: [],
            },
            Option.none(),
          )
          .pipe(Effect.flip, Effect.forkChild);
        while ((() => lookups === 0)()) yield* Effect.yieldNow;
        yield* TestClock.adjust("35 seconds");
        return yield* Fiber.join(fiber);
      }),
    );
    assert.strictEqual(error._tag, "SendUncertain");
    assert.strictEqual(sends, 1);
  }),
);

it.effect("gmail interruption aborts the GET and never retries or returns AuthError", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let signal: AbortSignal | undefined;
    let attempts = 0;
    const client = HttpClient.make((_request, _url, abort) =>
      Effect.gen(function* () {
        signal = abort;
        attempts++;
        yield* Deferred.succeed(started, undefined);
        return yield* Effect.never;
      }),
    );
    const http = { layer: Layer.succeed(HttpClient.HttpClient, client), calls: [] };
    yield* run(http, (adapter) =>
      Effect.gen(function* () {
        const fiber = yield* adapter.fetchRaw(account, "fake").pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        const exit = yield* Fiber.await(fiber);
        assert.strictEqual(exit._tag, "Failure");
        if (exit._tag === "Failure") assert.isTrue(Cause.hasInterruptsOnly(exit.cause));
      }),
    );
    assert.isTrue(signal?.aborted);
    assert.strictEqual(attempts, 1);
  }),
);

it.effect("Gmail sync health only GETs label message/unread/thread counts", () => {
  const http = fakeHttp({
    "GET /labels/Label_private": {
      json: { messagesTotal: 12, messagesUnread: 3, threadsTotal: 8 },
    },
  });
  return run(http, (adapter) =>
    Effect.gen(function* () {
      const status = yield* adapter.folderStatus(account, "Label_private");
      assert.deepStrictEqual(status, {
        total: 12,
        unread: 3,
        threads: 8,
        uidNext: null,
        uidValidity: null,
      });
      const calls = http.calls.filter((call) => call.url.hostname === "gmail.googleapis.com");
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0]?.method, "GET");
      assert.strictEqual(calls[0]?.url.pathname, "/gmail/v1/users/me/labels/Label_private");
    }),
  );
});

it.effect("label-only category removal accepts minimal messages with no remaining labels", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /labels": {
        json: { labels: [{ id: "CATEGORY_PERSONAL", name: "Personal", type: "system" }] },
      },
      "GET /history": {
        json: {
          historyId: "2",
          history: [
            { labelsRemoved: [{ message: { id: "m1" }, labelIds: ["CATEGORY_PERSONAL"] }] },
          ],
        },
      },
      "GET /messages/m1": { json: { id: "m1" } },
    });
    const changes = yield* run(http, (adapter) =>
      Stream.runCollect(adapter.pull(account, Option.some("1"))),
    );
    assert.deepStrictEqual(
      changes.filter((c) => c._tag === "MessageLabels"),
      [{ _tag: "MessageLabels", providerId: "m1", labels: [] }],
    );
    assert.strictEqual(
      http.calls
        .find((c) => c.url.pathname.endsWith("/messages/m1"))
        ?.url.searchParams.get("format"),
      "minimal",
    );
  }),
);

it.effect(
  "stale draft discovery reads one bounded drafts.list page without treating later pages as missing",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "GET /drafts": (url) => {
          assert.strictEqual(url.searchParams.get("maxResults"), "500");
          assert.isNull(url.searchParams.get("pageToken"));
          return {
            json: {
              drafts: [{ id: "stable", message: { id: "new-version" } }],
              nextPageToken: "more",
            },
          };
        },
      });
      const ids = yield* run(http, (adapter) => {
        if (!adapter.draftMessageIds) return Effect.die("Gmail draft listing is missing");
        return adapter.draftMessageIds(account);
      });
      assert.deepStrictEqual(ids, ["new-version"]);
      assert.strictEqual(http.calls.length, 1);
    }),
);

it.effect(
  "Gmail header backfill requests metadata only, preserves repeated fields and tolerates 404",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "GET /messages/a": {
          json: {
            payload: {
              headers: [
                { name: "Message-ID", value: "<old@example.test>" },
                { name: "Delivered-To", value: "one@example.test" },
                { name: "Delivered-To", value: "two@example.test" },
              ],
            },
          },
        },
        "GET /messages/no-id": { json: { payload: { headers: [] } } },
      });
      const results = yield* run(http, (adapter) => {
        if (!adapter.fetchCachedHeaders) return Effect.die("Missing header reader");
        return adapter.fetchCachedHeaders(account, ["a", "gone", "no-id"]);
      });
      assert.deepStrictEqual(results, [
        {
          kind: "headers",
          id: "a",
          rfcMessageId: "<old@example.test>",
          headers: [
            { name: "message-id", value: "<old@example.test>" },
            { name: "delivered-to", value: "one@example.test" },
            { name: "delivered-to", value: "two@example.test" },
          ],
        },
        { kind: "unavailable", id: "gone" },
        { kind: "headers", id: "no-id", rfcMessageId: null, headers: [] },
      ]);
      assert.isTrue(
        http.calls.every(
          (call) => call.method === "GET" && call.url.searchParams.get("format") === "metadata",
        ),
      );
      assert.isTrue(
        http.calls.every((call) =>
          ["message-id", "list-id", "delivered-to"].every((header) =>
            call.url.searchParams.getAll("metadataHeaders").includes(header),
          ),
        ),
      );
    }),
);

it.effect("Gmail header backfill stops sequential reads when Retry-After exceeds its budget", () =>
  Effect.gen(function* () {
    const http = fakeHttp({ "GET /messages/a": { status: 429, headers: { "Retry-After": "61" } } });
    const result = yield* run(http, (adapter) => {
      if (!adapter.fetchCachedHeaders) return Effect.die("Missing header reader");
      return adapter.fetchCachedHeaders(account, ["a", "b"]).pipe(Effect.result);
    });
    assert.strictEqual(result._tag, "Failure");
    assert.strictEqual(http.calls.length, 1);
  }),
);

it.effect(
  "offline Gmail refresh failures back off across background readers and reset on wake",
  () => {
    let refreshes = 0;
    const http = fakeHttp({});
    return makeGmail.pipe(
      Effect.flatMap((adapter) =>
        Effect.gen(function* () {
          for (let tick = 0; tick < 8; tick++)
            yield* adapter.folderStatus(account, "INBOX").pipe(Effect.result);
          assert.strictEqual(refreshes, 1);
          yield* TestClock.adjust("5 seconds");
          yield* adapter.folderStatus(account, "INBOX").pipe(Effect.result);
          assert.strictEqual(refreshes, 2);
          yield* TestClock.adjust("5 seconds");
          yield* adapter.fetchCachedHeaders?.(account, ["a"]).pipe(Effect.result) ?? Effect.void;
          assert.strictEqual(refreshes, 2);
          yield* adapter.resetConnectivity?.() ?? Effect.void;
          yield* adapter.folderStatus(account, "INBOX").pipe(Effect.result);
          assert.strictEqual(refreshes, 3);
        }),
      ),
      Effect.provide(
        Layer.mergeAll(
          http.layer,
          MemoryPlatform({
            secrets: { [account.id]: "refresh-token" },
            config: { google: { clientId: "client", clientSecret: "secret" } },
            oauth: {
              refresh: () =>
                Effect.suspend(() => {
                  refreshes++;
                  return Effect.fail(new ProviderError({ message: "Offline", status: 0 }));
                }),
            },
          }),
        ),
      ),
    );
  },
);

it.effect("Gmail category undercounts use paginated IDs including spam/trash", () => {
  const ids = Array.from({ length: 22 }, (_, index) => ({ id: `m${index}` }));
  const http = fakeHttp({
    "GET /labels/CATEGORY_PERSONAL": {
      json: { messagesTotal: 0, messagesUnread: 0, threadsTotal: 0 },
    },
    "GET /messages": (url) => {
      assert.strictEqual(url.searchParams.get("includeSpamTrash"), "true");
      assert.ok(url.searchParams.getAll("labelIds").includes("CATEGORY_PERSONAL"));
      if (url.searchParams.getAll("labelIds").includes("UNREAD")) return { json: { messages: [] } };
      return {
        json: url.searchParams.has("pageToken")
          ? { messages: ids.slice(10) }
          : { messages: ids.slice(0, 10), nextPageToken: "next" },
      };
    },
  });
  return run(http, (adapter) =>
    Effect.gen(function* () {
      const counts = yield* adapter.folderStatus(account, "CATEGORY_PERSONAL", {
        localTotal: 22,
        summary: yield* adapter.folderStatus(account, "CATEGORY_PERSONAL"),
      });
      assert.strictEqual(counts.total, 22);
      assert.strictEqual(counts.unread, 0);
      assert.isFalse(http.calls.some((call) => /messages\//.test(call.url.pathname)));
    }),
  );
});

it.effect("a capped category recheck retains the summary and skips unread listing", () => {
  let pages = 0;
  const http = fakeHttp({
    "GET /labels/CATEGORY_PERSONAL": {
      json: { messagesTotal: 999, messagesUnread: 100, threadsTotal: 20_000 },
    },
    "GET /messages": (url) => {
      assert.isFalse(url.searchParams.getAll("labelIds").includes("UNREAD"));
      return {
        json: {
          messages: Array.from({ length: 500 }, (_, index) => ({ id: `page-${pages}-${index}` })),
          nextPageToken: String(++pages),
        },
      };
    },
  });
  return run(http, (adapter) =>
    Effect.gen(function* () {
      const summary = yield* adapter.folderStatus(account, "CATEGORY_PERSONAL");
      assert.deepStrictEqual(
        yield* adapter.folderStatus(account, "CATEGORY_PERSONAL", { localTotal: 30_000, summary }),
        summary,
      );
      assert.strictEqual(pages, 2);
      assert.strictEqual(
        http.calls.filter((call) => call.url.pathname.includes("/labels/")).length,
        1,
      );
    }),
  );
});

it.effect("category summaries above the listing capacity skip repeated rechecks", () => {
  const http = fakeHttp({
    "GET /labels/CATEGORY_PERSONAL": {
      json: { messagesTotal: 1001, messagesUnread: 100, threadsTotal: 1000 },
    },
  });
  return run(http, (adapter) =>
    Effect.gen(function* () {
      const summary = yield* adapter.folderStatus(account, "CATEGORY_PERSONAL");
      for (let pass = 0; pass < 3; pass++)
        assert.deepStrictEqual(
          yield* adapter.folderStatus(account, "CATEGORY_PERSONAL", { localTotal: 2000, summary }),
          summary,
        );
      assert.strictEqual(http.calls.length, 1);
    }),
  );
});

it.effect("a first sync saves its history id and a retry skips the messages it stored", () =>
  Effect.gen(function* () {
    let profileCalls = 0;
    const http = fakeHttp({
      "GET /labels": { json: { labels: [] } },
      "GET /profile": () => {
        profileCalls++;
        return { json: { emailAddress: "me@gmail.com", historyId: String(900 + profileCalls) } };
      },
      "GET /messages": { json: { messages: [{ id: "m1" }, { id: "m2" }] } },
      "GET /messages/m1": { json: message("m1", ["INBOX"]) },
      "GET /messages/m2": { json: message("m2", ["INBOX"]) },
    });
    const first = yield* run(http, (a) => Stream.runCollect(a.pull(account, Option.none())));
    assert.deepStrictEqual(first[1], { _tag: "Cursor", cursor: "initial:901", checkpoint: true });
    assert.deepStrictEqual(first.at(-1), { _tag: "Cursor", cursor: "901" });

    const before = http.calls.length;
    const resumed = yield* run(http, (a) =>
      Stream.runCollect(
        a.pull(account, Option.some("initial:901"), undefined, false, () =>
          Effect.succeed(new Set(["m1"])),
        ),
      ),
    );
    const paths = http.calls.slice(before).map((c) => c.url.pathname.replace(/^.*\/users\/me/, ""));
    assert.notInclude(paths, "/messages/m1");
    assert.notInclude(paths, "/profile");
    assert.include(paths, "/messages/m2");
    assert.deepStrictEqual(tags(resumed), ["Labels", "Upsert", "Progress", "Cursor"]);
    assert.deepStrictEqual(resumed[2], { _tag: "Progress", fetched: 2, total: 2 });
    // History from the first attempt's id covers changes to the skipped message.
    assert.deepStrictEqual(resumed.at(-1), { _tag: "Cursor", cursor: "901" });
  }),
);

it.effect("Gmail's per-user rate limit 403 is a quota failure, not a refusal", () =>
  Effect.gen(function* () {
    const body = {
      error: {
        code: 403,
        message: "Quota exceeded for quota metric 'Queries'",
        errors: [{ reason: "rateLimitExceeded" }],
        details: [{ metadata: { quota_limit: "totalQueryCostPerMinutePerUser" } }],
      },
    };
    let calls = 0;
    const http = fakeHttp({
      "GET /labels": () => {
        calls++;
        return { status: 403, json: body };
      },
    });
    const fiber = yield* Effect.forkChild(
      run(http, (a) => Stream.runCollect(a.pull(account, Option.some("1")))).pipe(Effect.flip),
    );
    for (let second = 0; second < 90; second++) yield* TestClock.adjust("1 second");
    const error = yield* Fiber.join(fiber);
    assert.strictEqual(error._tag, "ProviderError");
    assert.ok(error._tag === "ProviderError" && error.reason === "quota");
    assert.isAbove(calls, 1);
  }),
);

it.effect("an inbox poll from a first sync's checkpoint skips the messages already stored", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /messages": { json: { messages: [{ id: "m1" }, { id: "m2" }] } },
      "GET /messages/m1": { json: message("m1", ["INBOX"]) },
      "GET /messages/m2": { json: message("m2", ["INBOX"]) },
    });
    const changes = yield* run(http, (a) =>
      Stream.runCollect(
        a.pull(account, Option.some("initial:901"), "inbox", false, () =>
          Effect.succeed(new Set(["m1", "m2"])),
        ),
      ),
    );
    const paths = http.calls.map((c) => c.url.pathname.replace(/^.*\/users\/me/, ""));
    assert.notInclude(paths, "/messages/m1");
    assert.notInclude(paths, "/messages/m2");
    assert.deepStrictEqual(changes.at(-1), { _tag: "Cursor", cursor: "901" });
  }),
);
