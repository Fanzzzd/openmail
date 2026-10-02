/**
 * Live updates from the main process. `liveUpdatesAtom` holds the one
 * subscription to the `Events` stream; mount it once at the app root.
 */
import { Effect, Match, Stream } from "effect";
import { Atom, Reactivity } from "effect/reactivity";

import type { MailboxEvent, SyncProgress, SyncState } from "../../../shared/api";
import { MailClient } from "../rpc";
import { appleContactsStatusAtom } from "./apple-contacts";
import { Keys, MAIL_KEYS } from "./keys";

export const syncStateAtom = Atom.make<SyncState>({
  running: false,
  lastFinishedAt: null,
  errors: [],
}).pipe(Atom.keepAlive);

/** Messages fetched so far in the running sync; null between syncs. */
export const syncProgressAtom = Atom.make<SyncProgress | null>(null).pipe(Atom.keepAlive);

/**
 * Reads the current sync state, then follows the event stream: sync state and
 * progress go into their atoms, and a finished sync or a `Changed` notice
 * invalidates every mail query.
 */
export const liveUpdatesAtom = MailClient.runtime.atom((get) => {
  get.mount(appleContactsStatusAtom);
  return Effect.gen(function* () {
    const call = yield* MailClient;
    const reactivity = yield* Reactivity.Reactivity;
    get.set(syncStateAtom, yield* call("SyncState", undefined));
    yield* call("Events", undefined).pipe(
      Stream.runForEach(
        Match.typeTags<MailboxEvent, Effect.Effect<void>>()({
          SyncState: ({ state }) =>
            Effect.suspend(() => {
              get.set(syncStateAtom, state);
              if (state.running) return Effect.void;
              get.set(syncProgressAtom, null);
              return reactivity.invalidate(MAIL_KEYS);
            }),
          SyncProgress: ({ progress }) => Effect.sync(() => get.set(syncProgressAtom, progress)),
          UpdateSettingsChanged: () => reactivity.invalidate([Keys.cache]),
          BackfillProgress: () => reactivity.invalidate([Keys.cache, Keys.counts]),
          Changed: () => reactivity.invalidate(MAIL_KEYS),
          NewMail: () => Effect.void,
        }),
      ),
    );
  });
});
