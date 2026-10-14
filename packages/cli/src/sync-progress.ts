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
    const progress = yield* mailbox.app.events.pipe(
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

/** Printed on stderr when search runs before the word index is complete. */
export const SEARCH_INDEX_NOTE =
  "note: the search index is still being rebuilt after an upgrade, so these results are approximate (AROUND matches like AND, and words also match inside longer words). Search again in a minute.";

/**
 * Finishes the word index an upgrade rebuilds, so search matches whole words and AROUND
 * distances. The app builds it in the background, but a one-shot command exits first. A build
 * that takes over a second says so on stderr. Returns whether the index is complete.
 */
export const finishSearchIndex = Effect.gen(function* () {
  const mailbox = yield* Mailbox;
  if (yield* mailbox.reading.searchIndexReady) return true;
  const shown = { announced: false };
  const announce = yield* Effect.sleep("1 second").pipe(
    Effect.andThen(
      Effect.suspend(() => {
        shown.announced = true;
        return writeStderr("Rebuilding the search index after an upgrade…");
      }),
    ),
    Effect.forkChild,
  );
  const ready = yield* mailbox.reading.finishSearchIndex;
  yield* Fiber.interrupt(announce);
  if (shown.announced) yield* writeStderr(ready ? " done.\n" : "\n");
  return ready;
});
