import { Buffer } from "./platform/bytes.js";
import { Cause, Context, Effect, Layer, Option, Redacted, Stream } from "effect";
import { Chat, type Toolkit } from "effect/ai";
import { HttpClient } from "effect/http";
import {
  AI_INPUT_BUDGET,
  AI_MAX_TURNS,
  AI_OUTPUT_TOKENS,
  AI_SYSTEM,
  AI_COMPOSE_SYSTEM,
  AI_TRIAGE_SYSTEM,
  type AiModelName,
} from "./ai.js";
import { InvalidInput, ProviderError } from "./errors.js";
import { MODEL_KEY } from "./secrets.js";
import { Secrets } from "./services.js";
import type { AssistantToolkit } from "./tools.js";

export interface ModelRequest {
  readonly model: AiModelName;
  readonly prompt: string;
  readonly purpose?: "compose" | "triage";
  readonly toolkit?: Toolkit.WithHandler<typeof AssistantToolkit.tools>;
  /** Recheck consent immediately before every provider turn. */
  readonly check: Effect.Effect<void, InvalidInput>;
}
export type ModelOutput =
  | { readonly _tag: "Delta"; readonly text: string }
  | { readonly _tag: "Finished"; readonly reason: "stop" | "length" };

export class Model extends Context.Service<
  Model,
  {
    stream(request: ModelRequest): Stream.Stream<ModelOutput, InvalidInput | ProviderError>;
  }
>()("openmail/Model") {}

/** Never serialize provider errors: the cause is kept off the schema, for local diagnostics only. */
const requestFailed = (cause: unknown) => {
  const error = new ProviderError({ message: "AI request failed. Check your key and try again." });
  Object.defineProperty(error, "cause", { value: cause, configurable: true });
  return error;
};

/** Keychain lookup happens inside the request, after consent, never at Layer construction. */
export const ModelAnthropic = Layer.effect(
  Model,
  Effect.gen(function* () {
    const secrets = yield* Secrets;
    const http = yield* HttpClient.HttpClient;
    return Model.of({
      stream: (request) =>
        Stream.unwrap(
          Effect.gen(function* () {
            yield* request.check;
            const key = yield* secrets.get(MODEL_KEY);
            if (Option.isNone(key))
              return yield* new InvalidInput({
                message: "Save an Anthropic API key in AI settings.",
              });
            const { AnthropicClient, AnthropicLanguageModel } = yield* Effect.tryPromise({
              try: () => import("@effect/ai-anthropic"),
              catch: requestFailed,
            });
            const client = AnthropicClient.layer({ apiKey: Redacted.make(key.value) }).pipe(
              Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
            );
            const chat = yield* Chat.empty;
            const system =
              request.purpose === "compose"
                ? AI_COMPOSE_SYSTEM
                : request.purpose === "triage"
                  ? AI_TRIAGE_SYSTEM
                  : AI_SYSTEM;
            let remaining = AI_OUTPUT_TOKENS;
            const turn = (
              index: number,
            ): Stream.Stream<ModelOutput, InvalidInput | ProviderError> =>
              Stream.unwrap(
                Effect.gen(function* () {
                  yield* request.check;
                  const history = yield* chat.exportJson.pipe(
                    Effect.mapError(
                      () => new InvalidInput({ message: "AI input could not be encoded." }),
                    ),
                  );
                  if (
                    Buffer.byteLength(history) +
                      Buffer.byteLength(request.prompt) +
                      Buffer.byteLength(system) +
                      (request.toolkit ? 10_000 : 0) >
                    AI_INPUT_BUDGET
                  )
                    return yield* new InvalidInput({
                      message: "AI input budget exceeded. Ask about fewer messages.",
                    });
                  let tools = false;
                  let finished = false;
                  let truncated = false;
                  const options = { prompt: index === 0 ? request.prompt : [] };
                  const parts = request.toolkit
                    ? chat.streamText({ ...options, toolkit: request.toolkit, concurrency: 1 })
                    : chat.streamText(options);
                  const text = parts.pipe(
                    Stream.tap((part) =>
                      Effect.gen(function* () {
                        yield* request.check;
                        if (part.type === "finish") {
                          tools = part.reason === "tool-calls";
                          finished = true;
                          truncated = part.reason === "length";
                          remaining -= part.usage.outputTokens.total ?? remaining;
                        }
                      }),
                    ),
                    Stream.filter((part) => part.type === "text-delta"),
                    Stream.map((part): ModelOutput => ({ _tag: "Delta", text: part.delta })),
                    Stream.provide(
                      AnthropicLanguageModel.layer({
                        model: request.model,
                        config: {
                          max_tokens: Math.max(1, remaining),
                          system,
                        },
                      }).pipe(Layer.provide(client)),
                    ),
                    // Never serialize provider errors: they can contain headers or request bodies.
                    Stream.mapError(
                      () =>
                        new ProviderError({
                          message: "AI request failed. Check your key and try again.",
                        }),
                    ),
                  );
                  return Stream.concat(
                    text,
                    Stream.unwrap(
                      Effect.gen(function* () {
                        if (!finished)
                          return yield* new ProviderError({
                            message: "AI stream ended before completion.",
                          });
                        if (tools && index + 1 < AI_MAX_TURNS && remaining > 0)
                          return turn(index + 1);
                        return Stream.make({
                          _tag: "Finished",
                          reason: truncated || tools ? "length" : "stop",
                        } satisfies ModelOutput);
                      }),
                    ),
                  );
                }),
              );
            return turn(0);
          }),
        ).pipe(
          Stream.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Stream.failCause(cause)
              : Stream.fail(requestFailed(Cause.squash(cause))),
          ),
        ),
    });
  }),
);

export const FakeModelLayer = (stream: Model["Service"]["stream"]) =>
  Layer.succeed(Model, { stream });
export const ModelUnavailable: Model["Service"] = {
  stream: () => Stream.fail(new InvalidInput({ message: "AI model is unavailable." })),
};
