import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { AI_ERRORS } from "./ai.js";
import { Model, ModelAnthropic } from "./model.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import { MODEL_KEY } from "../platform/node/secrets.js";
import { Mailbox } from "../mailbox/mailbox.js";
import { fakeServer, TestMailbox } from "../platform/node/testing.js";

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

it.effect("model failures map to one actionable sentence each, without the provider body", () => {
  let mode: "401" | "429" | "404" | "529" | "offline" = "401";
  const fetch: typeof globalThis.fetch = async () => {
    if (mode === "offline") throw new TypeError("fetch failed");
    const status = Number(mode);
    return Response.json(
      {
        type: "error",
        error: {
          type: status === 404 ? "not_found_error" : "api_error",
          message: "test-secret-key echoed by server",
        },
      },
      { status },
    );
  };
  const http = FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  );
  const request = { model: "claude-sonnet-5-5", prompt: "Summarize", check: Effect.void } as const;
  const message = Effect.fnUntraced(function* () {
    const model = yield* Model;
    const exit = yield* Stream.runDrain(model.stream(request)).pipe(Effect.flip);
    assert.ok(!JSON.stringify(exit).includes("test-secret-key"));
    return exit.message;
  });
  return Effect.gen(function* () {
    const withKey = ModelAnthropic.pipe(
      Layer.provide(
        Layer.mergeAll(MemoryPlatform({ secrets: { [MODEL_KEY]: "test-secret-key" } }), http),
      ),
    );
    const expected = {
      "401": AI_ERRORS.invalidKey,
      "429": AI_ERRORS.rateLimited,
      "404": AI_ERRORS.unavailable,
      "529": AI_ERRORS.unavailable,
      offline: AI_ERRORS.offline,
    } as const;
    for (const next of ["401", "429", "404", "529", "offline"] as const) {
      mode = next;
      assert.strictEqual(yield* message().pipe(Effect.provide(withKey)), expected[next], next);
    }
    const noKey = ModelAnthropic.pipe(Layer.provide(Layer.mergeAll(MemoryPlatform({}), http)));
    assert.strictEqual(yield* message().pipe(Effect.provide(noKey)), AI_ERRORS.noKey);
  });
});

/** A Live Model whose fetch answers with `responses` in turn and keeps each request body. */
function scripted(responses: readonly (() => Response)[]) {
  const bodies: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    bodies.push(await new Request(input, init).text());
    const next = responses[bodies.length - 1] ?? responses.at(-1);
    if (!next) throw new Error("no scripted response");
    return next();
  };
  const live = ModelAnthropic.pipe(
    Layer.provide(
      FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
    ),
  );
  return { bodies, live };
}
const toolCall = (id: string, name: string, input: unknown) => () =>
  sse(
    { type: "tool_use", id, name, input: {} },
    { type: "input_json_delta", partial_json: JSON.stringify(input) },
    "tool_use",
  );
const answer = () => sse({ type: "text", text: "" }, { type: "text_delta", text: "Answer" });
/** `count` messages of about `chars` characters each in thread `thread`. */
const longThread = (thread: string, count: number, chars: number, from = 0) =>
  Array.from({ length: count }, (_, i) => ({
    providerId: `${thread}-${i}`,
    threadId: thread,
    subject: `Thread ${thread}`,
    from: { name: "A", address: "a@example.com" },
    to: [],
    cc: [],
    date: 1000 + from + i,
    snippet: "",
    bodyText: Array.from(
      { length: Math.ceil(chars / 60) },
      (_, line) => `Line ${line} of message ${i}, about the "contract" terms.`,
    ).join("\n"),
    bodyHtml: "",
    labels: ["INBOX"],
    attachments: [],
    isUnread: false,
    isStarred: false,
  }));

it.effect("re-reading the thread a question is about is a tool error, not a failed answer", () => {
  const { bodies, live } = scripted([
    toolCall("tool_1", "read_thread", { message_id: "gmail:me@gmail.com/t1-0" }),
    answer,
  ]);
  const server = fakeServer("me@gmail.com", longThread("t1", 3, 3000));
  return Effect.gen(function* () {
    const m = yield* Mailbox;
    const account = yield* m.connect({ provider: "gmail" });
    yield* m.sync();
    yield* m.setAiKey("k");
    yield* m.setAiAccount({ accountId: account.id, allowed: true, autoSummaries: false });
    const events = yield* Stream.runCollect(
      m.askAi({
        question: "Did they agree elsewhere?",
        accountIds: [account.id],
        threadId: `${account.id}/t1-2`,
      }),
    );
    assert.ok(events.some((e) => e._tag === "Delta" && e.text === "Answer"));
    assert.strictEqual(bodies.length, 2);
    assert.include(bodies[1] ?? "", "already in the question above");
  }).pipe(Effect.provide(TestMailbox({ gmail: server }, { backgroundFlush: false }, {}, live)));
});

it.effect("a read that overruns the input budget comes back to the model as a tool error", () => {
  const { bodies, live } = scripted([
    toolCall("tool_1", "read_thread", { message_id: "gmail:me@gmail.com/a-0", max_chars: 24_000 }),
    toolCall("tool_2", "read_thread", { message_id: "gmail:me@gmail.com/b-0", max_chars: 24_000 }),
    toolCall("tool_3", "read_thread", { message_id: "gmail:me@gmail.com/c-0", max_chars: 24_000 }),
    answer,
  ]);
  const server = fakeServer("me@gmail.com", [
    ...longThread("a", 8, 6000),
    ...longThread("b", 8, 6000, 100),
    ...longThread("c", 8, 6000, 200),
  ]);
  return Effect.gen(function* () {
    const m = yield* Mailbox;
    const account = yield* m.connect({ provider: "gmail" });
    yield* m.sync();
    yield* m.setAiKey("k");
    yield* m.setAiAccount({ accountId: account.id, allowed: true, autoSummaries: false });
    const events = yield* Stream.runCollect(
      m.askAi({ question: "What did they agree?", accountIds: [account.id] }),
    );
    // The answer still arrives, and every request stayed under the budget.
    assert.ok(events.some((e) => e._tag === "Delta" && e.text === "Answer"));
    assert.strictEqual(bodies.length, 4);
    for (const body of bodies) assert.isBelow(Buffer.byteLength(body), 120_000);
    assert.notInclude(bodies[2] ?? "", "does not fit in the input budget");
    assert.include(bodies[3] ?? "", "does not fit in the input budget");
  }).pipe(Effect.provide(TestMailbox({ gmail: server }, { backgroundFlush: false }, {}, live)));
});

it.effect("a summary of a thread too long to read whole says how many messages it covers", () => {
  const { bodies, live } = scripted([answer]);
  // 40 messages of 4,000 characters: about 160 KB, twice the summary budget.
  const server = fakeServer("me@gmail.com", longThread("t", 40, 4000));
  return Effect.gen(function* () {
    const m = yield* Mailbox;
    const account = yield* m.connect({ provider: "gmail" });
    yield* m.sync();
    yield* m.setAiKey("k");
    yield* m.setAiAccount({ accountId: account.id, allowed: true, autoSummaries: false });
    const id = `${account.id}/t-39`;
    const events = yield* Stream.runCollect(m.summarize(id));
    const done = [...events].find((e) => e._tag === "Done");
    assert.ok(done?._tag === "Done" && done.coverage);
    assert.strictEqual(done.coverage.total, 40);
    assert.isAbove(done.coverage.kept, 10);
    assert.isBelow(done.coverage.kept, 40);
    // The newest message is the one the summary must read.
    assert.include(bodies[0] ?? "", "gmail:me@gmail.com/t-39");
    assert.deepStrictEqual((yield* m.aiSummary(id))?.coverage, done.coverage);
    // A short thread reads whole and carries no coverage.
    yield* Stream.runDrain(m.summarize(`${account.id}/t-0`)).pipe(Effect.ignore);
  }).pipe(Effect.provide(TestMailbox({ gmail: server }, { backgroundFlush: false }, {}, live)));
});
