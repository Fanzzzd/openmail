import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import type { IncomingMessage } from "../src/domain/domain.js";
import { type ModelRuntime, unavailableVision } from "../src/ai/media.js";
import { MemoryPlatform } from "../src/platform/node/platform-memory.js";
import { makeSemanticIndexer } from "../src/ai/semantic-indexer.js";
import { Store } from "../src/store/service.js";
import { StoreLive } from "../src/store/store.js";

export const withStore = <A, E>(body: Effect.Effect<A, E, Store | SqlClient.SqlClient>) =>
  body.pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform()))));
export const vector = (dim: number, index = 0) =>
  Array.from({ length: dim }, (_, i) => (i === index ? 1 : 0));
export const message = (overrides: Partial<IncomingMessage> = {}): IncomingMessage => ({
  providerId: "m",
  threadId: "t",
  subject: "Mail",
  from: { name: "Alice", address: "alice@example.com" },
  to: [],
  cc: [],
  date: 1000,
  snippet: "",
  bodyText: "Airport passport boarding pass.",
  bodyHtml: "",
  attachments: [],
  labels: ["INBOX"],
  isUnread: true,
  isStarred: false,
  ...overrides,
});
export const fakeModels = (calls: string[], version = "test-v1"): ModelRuntime => ({
  version,
  status: Effect.succeed({ kind: "ready", total: 1, version }),
  ensure: (download) =>
    Effect.sync(() => {
      calls.push(`ensure:${download}`);
    }),
  stop: () => Effect.void,
  embedder: {
    version,
    text: (text, mode) =>
      Effect.sync(() => {
        calls.push(`${mode}:${text}`);
        return vector(384);
      }),
  },
  images: {
    version,
    query: () => Effect.succeed(vector(512)),
    image: () =>
      Effect.succeed([
        {
          vector: vector(512),
          region: {
            imageWidth: 800,
            imageHeight: 5200,
            box: { x: 0, y: 0, width: 800, height: 5200 },
            tile: { x: 0, y: 0, width: 800, height: 5200 },
          },
        },
        {
          vector: vector(512),
          region: {
            imageWidth: 800,
            imageHeight: 5200,
            box: { x: 0, y: 896, width: 800, height: 1024 },
            tile: { x: 0, y: 896, width: 800, height: 1024 },
          },
        },
      ]),
  },
});
export const indexer = (
  store: Store["Service"],
  models: ModelRuntime,
  battery = false,
  busy = false,
) =>
  makeSemanticIndexer(
    {
      store: store.media,
      markReauth: (id, error) => store.markReauth(id, error),
      vision: unavailableVision,
      onBattery: () => battery,
      busy: Effect.succeed(busy),
      changed: Effect.void,
      message: (id) => store.getMessage(id).pipe(Effect.orDie),
      attachment: () => Effect.succeed(new Uint8Array([1])),
      inline: () => Effect.succeed([]),
    },
    store,
    models,
  );
export const setup = Effect.gen(function* () {
  const store = yield* Store;
  const account = yield* store.upsertAccount("gmail", "test@example.com");
  yield* store.upsertMessage(account.id, message());
  return { store, account, id: `${account.id}/m` };
});
