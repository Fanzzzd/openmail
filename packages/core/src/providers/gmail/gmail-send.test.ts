import { GMAIL_MIME_LIMIT } from "../../mime/attachment-policy.js";
import { fakeHttp } from "../../platform/node/fake-http.js";
import { draftCreation } from "../../platform/node/draft-create-fixture.js";
import { MailCodec } from "../../platform/mail-codec.js";
import { nodeMailCodec } from "../../platform/node/mail-codec.js";
import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { makeGmail } from "./gmail.js";
import { isDefiniteSendFailure } from "../provider-send.js";
import {
  account,
  platform,
  run,
  outgoing,
  DraftBody,
} from "../../../test-support/gmail-fixtures.js";
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

it.effect("Gmail exposes no draft organization write unsupported by its API", () =>
  Effect.gen(function* () {
    const http = fakeHttp({});
    yield* run(http, (adapter) =>
      Effect.sync(() => assert.strictEqual("setDraftOrganization" in adapter, false)),
    );
    assert.strictEqual(http.calls.length, 0);
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
