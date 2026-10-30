import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { Store } from "../store/service.js";
import { StoreLive } from "../store/store.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import { fakeServer, makeFakeProvider } from "../platform/node/fake-provider.js";
import { Providers } from "../providers/adapter.js";
import { Mailbox } from "./mailbox.js";
import { MailboxLive } from "./mailbox-live.js";

it.effect("writes during the initial or a later visible-text drain are never lost", () =>
  Effect.gen(function* () {
    const firstStarted = yield* Deferred.make<void>();
    const firstDone = yield* Deferred.make<void>();
    const secondStarted = yield* Deferred.make<void>();
    const secondDone = yield* Deferred.make<void>();
    let calls = 0;
    const platform = MemoryPlatform();
    const store = Layer.effect(
      Store,
      Effect.map(Store, (live) => ({
        ...live,
        fillVisibleText: () =>
          Effect.gen(function* () {
            calls++;
            if (calls === 1) {
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Deferred.await(firstDone);
            } else if (calls === 2) {
              yield* Deferred.succeed(secondStarted, undefined);
              yield* Deferred.await(secondDone);
            }
            return { processed: 0, ready: true };
          }),
      })),
    ).pipe(Layer.provide(StoreLive.pipe(Layer.provideMerge(platform))));
    const providers = Layer.succeed(Providers, {
      get: () => makeFakeProvider(fakeServer("me@gmail.com", [])),
    });
    return yield* Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      yield* Deferred.await(firstStarted);
      // This Changed happens after the initial read but before that drain returns. Subscribing
      // only after the initial drain lost it, leaving pending text until another unrelated event.
      yield* mailbox.app.setPrefs({ undoSendSeconds: 10 });
      yield* Deferred.succeed(firstDone, undefined);
      yield* TestClock.adjust("2 seconds");
      assert.strictEqual(calls, 2, "a change during the initial drain must trigger another pass");
      yield* Deferred.await(secondStarted);
      // The subscription must also retain changes while the sequential handler is busy.
      yield* mailbox.app.setPrefs({ undoSendSeconds: 20 });
      yield* Deferred.succeed(secondDone, undefined);
      yield* TestClock.adjust("2 seconds");
      assert.strictEqual(calls, 3);
      yield* TestClock.adjust("10 seconds");
      assert.strictEqual(calls, 3, "the fill must not publish Changed for each batch");
    }).pipe(
      Effect.provide(
        MailboxLive({ backgroundFlush: false }).pipe(
          Layer.provide(Layer.mergeAll(store, platform, providers)),
        ),
      ),
    );
  }),
);
