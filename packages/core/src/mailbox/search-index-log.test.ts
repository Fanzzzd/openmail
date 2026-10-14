import { assert, it } from "@effect/vitest";
import { Effect, Layer, Logger, References } from "effect";
import { TestClock } from "effect/testing";
import { logCodeOf, throttledWarning } from "../domain/diagnostic-log.js";
import { Mailbox } from "./mailbox.js";
import { MailboxLive } from "./mailbox-live.js";
import { fakeServer } from "../platform/node/testing.js";
import { makeFakeProvider } from "../platform/node/fake-provider.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import { Providers } from "../providers/adapter.js";
import { Store } from "../store/service.js";
import { StoreLive } from "../store/store.js";

const codes = (seen: unknown[]) =>
  Logger.layer([
    Logger.make((options) => {
      seen.push(logCodeOf(options.fiber.getRef(References.CurrentLogAnnotations)));
    }),
  ]);

it.effect("a throttled warning writes at most once per interval", () => {
  const seen: unknown[] = [];
  const warn = throttledWarning("search-index-failed", 60_000);
  return Effect.gen(function* () {
    yield* warn("failed");
    yield* TestClock.adjust("30 seconds");
    yield* warn("failed");
    yield* TestClock.adjust("31 seconds");
    yield* warn("failed");
    assert.deepStrictEqual(seen, ["search-index-failed", "search-index-failed"]);
  }).pipe(Effect.provide(codes(seen)));
});

it.effect("a failing search index backfill logs search-index-failed once while it retries", () => {
  const seen: unknown[] = [];
  const platform = MemoryPlatform();
  const storeLayer = StoreLive.pipe(Layer.provideMerge(platform));
  // The word index backfill fails every time; the loop retries it every 5 seconds.
  const failingStore = Layer.effect(
    Store,
    Effect.map(Store, (store) => ({
      ...store,
      backfillWordIndex: () => Effect.die(new Error("database is locked")),
    })),
  ).pipe(Layer.provide(storeLayer));
  const server = fakeServer("me@gmail.com", []);
  const providers = Layer.succeed(Providers, { get: () => makeFakeProvider(server) });
  const mailboxLayer = MailboxLive({ backgroundFlush: false }).pipe(
    Layer.provide(Layer.mergeAll(failingStore, platform, providers, codes(seen))),
  );
  return Effect.gen(function* () {
    yield* Mailbox;
    for (let i = 0; i < 12; i++) yield* TestClock.adjust("5 seconds");
    assert.deepStrictEqual(
      seen.filter((code) => code === "search-index-failed"),
      ["search-index-failed"],
    );
    yield* TestClock.adjust("10 minutes");
    assert.deepStrictEqual(
      seen.filter((code) => code === "search-index-failed"),
      ["search-index-failed", "search-index-failed"],
    );
  }).pipe(Effect.provide(mailboxLayer));
});

const mailboxWith = (
  backfillWordIndex: (size?: number) => Effect.Effect<{ processed: number; ready: boolean }>,
) => {
  const platform = MemoryPlatform();
  const store = Layer.effect(
    Store,
    Effect.map(Store, (live) => ({ ...live, backfillWordIndex })),
  ).pipe(Layer.provide(StoreLive.pipe(Layer.provideMerge(platform))));
  const providers = Layer.succeed(Providers, {
    get: () => makeFakeProvider(fakeServer("me@gmail.com", [])),
  });
  // No background rebuild: only finishSearchIndex fills the index here.
  return MailboxLive({ backgroundFlush: false, backgroundReady: Effect.never }).pipe(
    Layer.provide(Layer.mergeAll(store, platform, providers)),
  );
};

it.effect("finishSearchIndex builds the word index to the end in committed batches", () => {
  const sizes: (number | undefined)[] = [];
  return Effect.gen(function* () {
    assert.isTrue(yield* (yield* Mailbox).reading.finishSearchIndex);
    assert.deepStrictEqual(sizes, [500, 500, 500]);
  }).pipe(
    Effect.provide(
      mailboxWith((size) =>
        Effect.sync(() => {
          sizes.push(size);
          return { processed: 500, ready: sizes.length === 3 };
        }),
      ),
    ),
  );
});

it.effect("finishSearchIndex reports not ready when the database stays locked", () =>
  Effect.gen(function* () {
    assert.isFalse(yield* (yield* Mailbox).reading.finishSearchIndex);
  }).pipe(Effect.provide(mailboxWith(() => Effect.die(new Error("database is locked"))))),
);
