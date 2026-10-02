import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { Model, ModelAnthropic } from "./model.js";
import { MemoryPlatform } from "./platform/node/platform-memory.js";
import { MODEL_KEY } from "./platform/node/secrets.js";
import { Mailbox } from "./mailbox.js";
import { fakeServer, TestMailbox } from "./platform/node/testing.js";

function sse(block: unknown, delta: unknown, reason = "end_turn") {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 30,
          output_tokens: 0,
          cache_creation: null,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          service_tier: null,
        },
      },
    },
    { type: "content_block_start", index: 0, content_block: block },
    { type: "content_block_delta", index: 0, delta },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: reason, stop_sequence: null },
      usage: {
        output_tokens: 12,
        input_tokens: null,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
    },
    { type: "message_stop" },
  ];
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}
const Payload = Schema.Struct({
  model: Schema.String,
  stream: Schema.Boolean,
  max_tokens: Schema.Number,
  messages: Schema.Array(Schema.Unknown),
  system: Schema.Unknown,
  tools: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String }))),
});

it.effect("length-limited summaries remain visible as truncated and are never cached", () => {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => {
    calls++;
    return sse(
      { type: "text", text: "" },
      { type: "text_delta", text: "Incomplete summary" },
      "max_tokens",
    );
  };
  const live = ModelAnthropic.pipe(
    Layer.provide(
      FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
    ),
  );
  const server = fakeServer("me@gmail.com", [
    {
      providerId: "m1",
      threadId: "t1",
      subject: "Summary target",
      from: { name: "A", address: "a@example.com" },
      to: [],
      cc: [],
      date: 1000,
      snippet: "",
      bodyText: "A long decision",
      bodyHtml: "",
      labels: ["INBOX"],
      attachments: [],
      isUnread: false,
      isStarred: false,
    },
  ]);
  return Effect.gen(function* () {
    const m = yield* Mailbox;
    const account = yield* m.connect({ provider: "gmail" });
    yield* m.sync();
    yield* m.setAiKey("test-secret-key");
    yield* m.setAiAccount({ accountId: account.id, allowed: true, autoSummaries: false });
    const id = `${account.id}/m1`;
    const events = yield* Stream.runCollect(m.summarize(id));
    assert.ok(events.some((e) => e._tag === "Delta" && e.text === "Incomplete summary"));
    assert.ok(events.some((e) => e._tag === "Done" && e.truncated));
    assert.strictEqual(yield* m.aiSummary(id), null);
    yield* Stream.runDrain(m.summarize(id));
    assert.strictEqual(calls, 2, "truncated output must not become a cache hit");
  }).pipe(Effect.provide(TestMailbox({ gmail: server }, { backgroundFlush: false }, {}, live)));
});

it.effect(
  "Anthropic uses HTTPS Messages API, masked keychain key, bounded streaming and sanitized errors",
  () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async (url, init) => {
      calls++;
      assert.strictEqual(
        url instanceof Request ? url.url : typeof url === "string" ? url : url.href,
        "https://api.anthropic.com/v1/messages",
      );
      const headers = new Headers(init?.headers);
      assert.strictEqual(headers.get("x-api-key"), "test-secret-key");
      assert.strictEqual(headers.get("anthropic-version"), "2023-06-01");
      const request = new Request(url, init);
      const payload = Schema.decodeUnknownSync(Payload)(JSON.parse(await request.text()));
      assert.strictEqual(payload.stream, true);
      assert.strictEqual(payload.model, "claude-sonnet-5-5");
      assert.ok(payload.max_tokens <= 1024);
      assert.ok(JSON.stringify(payload.system).includes("untrusted DATA"));
      if (calls === 1)
        return sse({ type: "text", text: "" }, { type: "text_delta", text: "Summary" });
      return Response.json(
        {
          type: "error",
          error: { type: "authentication_error", message: "test-secret-key echoed by server" },
        },
        { status: 401 },
      );
    };
    const live = ModelAnthropic.pipe(
      Layer.provide(
        Layer.mergeAll(
          MemoryPlatform({ secrets: { [MODEL_KEY]: "test-secret-key" } }),
          FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
        ),
      ),
    );
    return Effect.gen(function* () {
      const model = yield* Model;
      const request = {
        model: "claude-sonnet-5-5",
        prompt: "Summarize",
        check: Effect.void,
      } as const;
      assert.deepStrictEqual(yield* Stream.runCollect(model.stream(request)), [
        { _tag: "Delta", text: "Summary" },
        { _tag: "Finished", reason: "stop" },
      ]);
      const error = yield* Stream.runDrain(model.stream(request)).pipe(Effect.exit);
      assert.strictEqual(error._tag, "Failure");
      assert.ok(!JSON.stringify(error).includes("test-secret-key"));
    }).pipe(Effect.provide(live));
  },
);

it.effect(
  "Anthropic assistant continues after shared read tools and only exposes seven allowed tools",
  () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async (url, init) => {
      calls++;
      const payload = Schema.decodeUnknownSync(Payload)(
        JSON.parse(await new Request(url, init).text()),
      );
      assert.deepStrictEqual(
        payload.tools?.map((tool) => tool.name),
        [
          "list_accounts",
          "list_labels",
          "search",
          "semantic_search",
          "read_thread",
          "modify_threads",
          "draft_message",
        ],
      );
      if (calls === 1)
        return sse(
          { type: "tool_use", id: "tool_1", name: "search", input: {} },
          { type: "input_json_delta", partial_json: '{"query":"Friday","limit":5}' },
          "tool_use",
        );
      assert.ok(JSON.stringify(payload.messages).includes("tool_result"));
      assert.ok(payload.max_tokens <= 1012, "output allowance is shared across turns");
      return sse({ type: "text", text: "" }, { type: "text_delta", text: "No mail found" });
    };
    const live = ModelAnthropic.pipe(
      Layer.provide(
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
      ),
    );
    return Effect.gen(function* () {
      const m = yield* Mailbox;
      const account = yield* m.connect({ provider: "gmail" });
      yield* m.setAiKey("test-secret-key");
      yield* m.setAiAccount({ accountId: account.id, allowed: true, autoSummaries: false });
      const events = yield* Stream.runCollect(
        m.askAi({ question: "Find Friday", accountIds: [account.id] }),
      );
      assert.ok(events.some((event) => event._tag === "Delta" && event.text === "No mail found"));
      assert.strictEqual(calls, 2);
    }).pipe(Effect.provide(TestMailbox({}, { backgroundFlush: false }, {}, live)));
  },
);
