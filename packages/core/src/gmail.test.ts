import { assert, it } from "@effect/vitest";
import { parseCalendar } from "./invites.js";

import { Effect, Fiber, Layer, Option, Schema, Stream } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

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
              HttpClientResponse.fromWeb(request, new Response(JSON.stringify({ raw: b64("hi") }))),
            ),
      ),
    );
    const http = { layer: Layer.succeed(HttpClient.HttpClient)(client), calls: [] };
    const fiber = yield* Effect.forkChild(run(http, (a) => a.fetchRaw(account, "m1")));
    yield* TestClock.adjust("2 seconds");
    assert.strictEqual(Buffer.from(yield* Fiber.join(fiber)).toString(), "hi");
    assert.strictEqual(calls, 3);
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

it.effect("Gmail consent requests settings.basic alongside existing mail scopes", () => {
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
                assert.ok(
                  req.scopes.includes("https://www.googleapis.com/auth/gmail.settings.basic"),
                );
                assert.ok(req.scopes.includes("https://www.googleapis.com/auth/gmail.modify"));
                for (const scope of [
                  "calendar.events",
                  "contacts.readonly",
                  "contacts.other.readonly",
                ])
                  assert.ok(req.scopes.includes(`https://www.googleapis.com/auth/${scope}`));
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
          assert.strictEqual(url.searchParams.get("personFields"), "names,emailAddresses");
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
