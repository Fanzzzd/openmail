import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { makeNodeModels } from "./platform/node/embeddings-node.js";
import { type InferenceProcessLauncher } from "./platform/node/inference-process.js";
import { resettableLoader } from "./platform/node/resettable-loader.mjs";

it.effect("ensure(false) immediately rejects while download holds its own lock", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const models = yield* makeNodeModels("/unused", undefined, {
      prepare: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
    });
    const task = yield* Effect.forkChild(models.ensure(true));
    yield* Deferred.await(started);
    const read = yield* models.ensure(false).pipe(Effect.result);
    assert.strictEqual(read._tag, "Failure");
    yield* Fiber.interrupt(task);
  }).pipe(Effect.scoped),
);

it("a rejected model promise is cleared and can be initialized again", async () => {
  let calls = 0;
  const load = resettableLoader(async () => {
    if (++calls === 1) throw new Error("temporary load failure");
    return 42;
  });
  const first = await load().then(
    () => false,
    () => true,
  );
  assert.strictEqual(first, true);
  assert.strictEqual(await load(), 42);
  assert.strictEqual(await load(), 42);
  assert.strictEqual(calls, 2);
});

it.effect("process exit is a runtime failure; a later request starts a fresh child", () =>
  Effect.gen(function* () {
    let spawns = 0;
    let kills = 0;
    const launch: InferenceProcessLauncher = () => {
      spawns++;
      let reply: (value: unknown) => void = () => null;
      let failure: () => void = () => null;
      return {
        onMessage: (cb) => {
          reply = cb;
          return () => null;
        },
        onFailure: (cb) => {
          failure = cb;
          return () => null;
        },
        kill: () => {
          kills++;
          return Promise.resolve();
        },
        send: () =>
          queueMicrotask(() => {
            if (spawns === 1) failure();
            else
              reply({ ok: true, vector: Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)) });
          }),
      };
    };
    const models = yield* makeNodeModels("/unused", undefined, {
      launch,
      prepare: () => Effect.succeed(0),
    });
    yield* models.ensure(true);
    const failed = yield* models.embedder.text("fixture", "passage").pipe(Effect.result);
    assert.strictEqual(failed._tag, "Failure");
    if (failed._tag === "Failure") assert.strictEqual(failed.failure._tag, "InferenceRuntimeError");
    assert.strictEqual((yield* models.embedder.text("fixture", "passage")).length, 384);
    assert.strictEqual(spawns, 2);
    assert.strictEqual(kills, 1);
  }).pipe(Effect.scoped),
);

it("a verified runtime frees its idle process while retaining fast search readiness", async () => {
  let kills = 0;
  let spawns = 0;
  const launch: InferenceProcessLauncher = () => {
    spawns++;
    let reply: (value: unknown) => void = () => null;
    return {
      onMessage: (cb) => {
        reply = cb;
        return () => null;
      },
      onFailure: () => () => null,
      kill: () => {
        kills++;
        return Promise.resolve();
      },
      send: () =>
        queueMicrotask(() =>
          reply({ ok: true, vector: Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)) }),
        ),
    };
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const models = yield* makeNodeModels("/unused", undefined, {
        launch,
        idleMs: 15,
        prepare: () => Effect.succeed(0),
      });
      yield* models.ensure(true);
      yield* models.embedder.text("fixture", "query");
      yield* Effect.promise(
        () =>
          new Promise((resolve) => {
            setTimeout(resolve, 60);
          }),
      );
      assert.strictEqual(kills, 1);
      assert.strictEqual((yield* models.status).kind, "ready");
      yield* models.ensure(false);
      yield* models.embedder.text("fixture", "query");
      assert.strictEqual(spawns, 2);
    }).pipe(Effect.scoped),
  );
});
