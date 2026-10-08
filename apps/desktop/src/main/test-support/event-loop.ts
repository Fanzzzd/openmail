import { Effect } from "effect";

/** Resolves after one event-loop turn. Relies on Effect scheduling fibers with setImmediate. */
export const nextTurn = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

/** Lets fake-backed background fibers finish without waiting on wall-clock time. */
export const settle = (turns = 10) =>
  Effect.forEach(Array.from({ length: turns }), () => Effect.promise(nextTurn), {
    discard: true,
  });
