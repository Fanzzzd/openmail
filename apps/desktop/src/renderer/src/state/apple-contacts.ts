import { Duration, Effect, Option, Schedule, Stream } from "effect";
import { AsyncResult, Atom, Reactivity } from "effect/reactivity";
import type { AppleContactsState } from "@openmail/core/schema";
import type { AppError } from "../errors";
import { MailClient } from "../rpc";
import { Keys } from "./keys";

const every10s = Atom.make(Stream.fromSchedule(Schedule.spaced("10 seconds")));
/** Poll independently of contact queries, so invalidation never refreshes this atom recursively. */
export const appleContactsStatusAtom = MailClient.runtime
  .atom((get) => {
    const previous = get
      .self<AsyncResult.AsyncResult<AppleContactsState, AppError>>()
      .pipe(Option.flatMap(AsyncResult.value), Option.getOrUndefined);
    return Effect.gen(function* () {
      const call = yield* MailClient;
      const state = yield* call("AppleContactsStatus", undefined);
      if (!previous || previous.status !== state.status || previous.revision !== state.revision)
        yield* Reactivity.invalidate([Keys.contacts]);
      return state;
    });
  })
  .pipe(
    Atom.withReactivity([Keys.prefs]),
    Atom.setIdleTTL(Duration.minutes(5)),
    Atom.makeRefreshOnSignal(every10s),
  );
