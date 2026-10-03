import { Mailbox } from "@openmail/core";
import { Console, Deferred, Effect, Fiber, Stdio, Stream } from "effect";

const writeStderr = (text: string) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    yield* Stream.run(Stream.make(text), stdio.stderr());
  }).pipe(Effect.ignore);

/** Subscribe before starting sync, and report a start even when no page has arrived. */
export const withProgress = <A, E, R>(effect: Effect.Effect<A, E, R>, show: boolean) =>
  Effect.gen(function* () {
    if (!show) return yield* effect;
    yield* Console.error("Syncing mail…");
    const mailbox = yield* Mailbox;
    const ready = yield* Deferred.make<void>();
    const progress = yield* mailbox.events.pipe(
      Stream.onStart(Deferred.succeed(ready, undefined)),
      Stream.runForEach((event) =>
        event._tag === "SyncProgress"
          ? writeStderr(
              `\r${event.progress.accountId} ${event.progress.fetched}/${event.progress.total}`,
            )
          : Effect.void,
      ),
      Effect.forkChild,
    );
    yield* Deferred.await(ready);
    return yield* effect.pipe(
      Effect.ensuring(Fiber.interrupt(progress).pipe(Effect.andThen(writeStderr("\n")))),
    );
  });
