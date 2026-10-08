import { Effect, Schedule } from "effect";

/**
 * Electron's main process has no online event, and the renderer's one is missing while every
 * window is closed. Poll the OS state so a reconnect resumes sync and the op queue at once
 * instead of after the outage backoff.
 */
export const watchOnline = <E>(isOnline: () => boolean, reconnected: Effect.Effect<void, E>) =>
  Effect.gen(function* () {
    let online = isOnline();
    yield* Effect.suspend(() => {
      const now = isOnline();
      const back = now && !online;
      online = now;
      return back ? reconnected : Effect.void;
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("reconnect sync failed", cause)),
      Effect.repeat(Schedule.spaced("5 seconds")),
      Effect.forkScoped,
    );
  });
