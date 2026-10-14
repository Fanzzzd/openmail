import { assert, it } from "@effect/vitest";
import { fakeHttp } from "../../platform/node/fake-http.js";
import { Deferred, Effect, Fiber, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { account, run, draftMessage } from "../../../test-support/outlook-fixtures.js";
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

it.effect("attachments over the Outlook.com message limit are refused before any request", () =>
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
                content: "A".repeat(36_000_000),
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

it.effect("a dropped connection never replays a write", () =>
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
        const error = yield* adapter
          .push(account, "m1", { kind: "read", value: true })
          .pipe(Effect.flip);
        assert.strictEqual(error._tag, "ProviderError");
        if (error._tag === "ProviderError") assert.strictEqual(error.status, 0);
      }),
    );
    assert.strictEqual(calls, 1);
  }),
);

for (const reply of [false, true])
  it.effect(
    `Graph ambiguous ${reply ? "reply" : "new"} send checks Sent without duplicate POST`,
    () =>
      Effect.gen(function* () {
        const http = fakeHttp({
          "POST /me/sendMail": { status: 503, json: { error: "ambiguous" } },
          "POST /me/messages/orig/createReply": { json: { id: "prepared" } },
          "PATCH /me/messages/prepared": { json: {} },
          "POST /me/messages/prepared/send": { status: 503, json: { error: "ambiguous" } },
          "GET /me/mailFolders/sentitems/messages": (url) => {
            assert.match(
              url.searchParams.get("$filter") ?? "",
              /^internetMessageId eq '<.+@outlook.com>'$/,
            );
            return { json: { value: [{ id: "sent" }] } };
          },
        });
        const result = yield* run(http, (a) =>
          Effect.gen(function* () {
            const fiber = yield* a
              .send(
                account,
                { ...draftMessage, attachments: [], mode: reply ? "reply" : "new" },
                reply ? Option.some({ providerId: "orig", threadId: "thread" }) : Option.none(),
              )
              .pipe(Effect.result, Effect.forkChild);
            yield* TestClock.adjust("35 seconds");
            return yield* Fiber.join(fiber);
          }),
        );
        assert.strictEqual(result._tag, "Success");
        assert.strictEqual(
          http.calls.filter((c) => c.method === "POST" && /\/(send|sendMail)$/.test(c.url.pathname))
            .length,
          1,
        );
        assert.isFalse(http.calls.some((c) => c.method === "DELETE"));
        const fields = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            internetMessageId: Schema.optionalKey(Schema.String),
            message: Schema.optionalKey(Schema.Struct({ internetMessageId: Schema.String })),
          }),
        )(http.calls.find((c) => c.method === (reply ? "PATCH" : "POST"))?.body);
        assert.match(
          fields.internetMessageId ?? fields.message?.internetMessageId ?? "",
          /^<.+@outlook.com>$/,
        );
      }),
  );

it.effect("reply preparation failure deletes its orphan draft without sending", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "POST /me/messages/orig/createReply": { json: { id: "prepared" } },
      "PATCH /me/messages/prepared": { status: 400 },
      "DELETE /me/messages/prepared": { status: 204 },
    });
    yield* run(http, (a) =>
      Effect.flip(
        a.send(
          account,
          { ...draftMessage, attachments: [], mode: "reply" },
          Option.some({ providerId: "orig", threadId: "t" }),
        ),
      ),
    );
    assert.strictEqual(http.calls.filter((c) => c.method === "DELETE").length, 1);
    assert.isFalse(http.calls.some((c) => c.url.pathname.endsWith("/send")));
  }),
);

it.effect("send transport timeout checks Sent and never replays POST", () =>
  Effect.gen(function* () {
    let posts = 0,
      sentChecks = 0;
    const client = HttpClient.make((request, url) =>
      Effect.suspend(() => {
        if (url.pathname.endsWith("/sendMail")) {
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
          .send(account, { ...draftMessage, attachments: [] }, Option.none())
          .pipe(Effect.result, Effect.forkChild);
        yield* TestClock.adjust("35 seconds");
        assert.strictEqual((yield* Fiber.join(fiber))._tag, "Failure");
      }),
    );
    assert.strictEqual(posts, 1);
    assert.isAtLeast(sentChecks, 6);
  }),
);

it.effect("ambiguous reply creation cleans its orphan without sending", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "POST /me/messages/orig/createReply": { status: 503 },
      "GET /me/mailFolders/drafts/messages": { json: { value: [{ id: "orphan" }] } },
      "DELETE /me/messages/orphan": { status: 204 },
    });
    const result = yield* run(http, (a) =>
      a
        .send(
          account,
          { ...draftMessage, attachments: [], mode: "reply" },
          Option.some({ providerId: "orig", threadId: "thread" }),
        )
        .pipe(Effect.result),
    );
    assert.strictEqual(result._tag, "Failure");
    assert.ok(
      http.calls.some((call) => call.method === "DELETE" && call.url.pathname.endsWith("/orphan")),
    );
    assert.isFalse(http.calls.some((call) => call.url.pathname.endsWith("/send")));
    assert.strictEqual(http.calls.filter((call) => call.method === "POST").length, 1);
  }),
);

it.effect("outlook never retries a send on a dropped connection", () =>
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

for (const reply of [false, true])
  it.effect(
    `${reply ? "reply" : "new"} sending never queues behind four throttled Graph requests`,
    () =>
      Effect.gen(function* () {
        let pulls = 0;
        const release = yield* Deferred.make<void>();
        const http = fakeHttp({
          "PATCH /me/messages/m": { status: 429, headers: { "Retry-After": "30" } },
          "POST /me/sendMail": { status: 202 },
          "POST /me/messages/orig/createReply": { json: { id: "prepared" } },
          "PATCH /me/messages/prepared": { json: {} },
          "POST /me/messages/prepared/send": { status: 202 },
        });
        // Hold all four permits before responding, so the shared throttle gate
        // does not prevent this saturation fixture from reaching the server.
        http.layer = Layer.succeed(HttpClient.HttpClient)(
          HttpClient.make((request) =>
            Effect.gen(function* () {
              if (new URL(request.url).pathname.endsWith("/messages/m")) {
                pulls++;
                yield* Deferred.await(release);
              }
              return yield* http.client.execute(request);
            }),
          ),
        );
        yield* run(http, (a) =>
          Effect.gen(function* () {
            const stalled = yield* Effect.forEach([1, 2, 3, 4], () =>
              a
                .push(account, "m", { kind: "read", value: true })
                .pipe(Effect.result, Effect.forkChild),
            );
            while ((() => pulls < 4)()) yield* Effect.yieldNow;
            yield* Deferred.succeed(release, undefined);
            const send = yield* a
              .send(
                account,
                { ...draftMessage, attachments: [], mode: reply ? "reply" : "new" },
                reply ? Option.some({ providerId: "orig", threadId: "thread" }) : Option.none(),
              )
              .pipe(Effect.forkChild);
            yield* TestClock.adjust("1 second");
            assert.strictEqual(
              http.calls.filter((c) => /\/(send|sendMail)$/.test(c.url.pathname)).length,
              1,
            );
            yield* Fiber.join(send);
            yield* Effect.forEach(stalled, Fiber.interrupt);
          }),
        );
      }),
  );

it.effect("Graph sends use the sender domain and no custom trace header", () =>
  Effect.gen(function* () {
    const http = fakeHttp({ "POST /me/sendMail": { status: 202 } });
    yield* run(http, (a) => a.send(account, { ...draftMessage, attachments: [] }, Option.none()));
    const sent = Schema.decodeUnknownSync(
      Schema.Struct({
        message: Schema.Struct({
          internetMessageId: Schema.String,
          internetMessageHeaders: Schema.optional(
            Schema.Array(Schema.Struct({ name: Schema.String })),
          ),
        }),
      }),
    )(http.calls[0]?.body);
    assert.match(sent.message.internetMessageId, /^<[a-f0-9-]+@outlook\.com>$/);
    assert.isFalse(
      sent.message.internetMessageHeaders?.some((h) => h.name.toLowerCase() === "x-openmail-id") ??
        false,
    );
  }),
);
