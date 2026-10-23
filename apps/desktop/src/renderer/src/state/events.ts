/**
 * Live updates from the main process. `liveUpdatesAtom` holds the one
 * subscription to the `Events` stream; mount it once at the app root.
 */
import { Effect, Match, Schedule, Stream } from "effect";
import { Atom, Reactivity } from "effect/reactivity";

import type { MailboxEvent, SyncProgress, SyncState } from "../../../shared/api";
import { MailClient } from "./rpc";
import { appleContactsStatusAtom } from "./apple-contacts";
import { Keys, MAIL_KEYS } from "./keys";

export const syncStateAtom = Atom.make<SyncState>({
  running: false,
  lastFinishedAt: null,
  errors: [],
}).pipe(Atom.keepAlive);

/** Messages fetched so far in the running sync; null between syncs. */
export const syncProgressAtom = Atom.make<SyncProgress | null>(null).pipe(Atom.keepAlive);

/** Waits before following Events again, by failures since its last event. */
export const RESUBSCRIBE_MS = [1000, 2000, 5000, 15_000, 30_000];

/**
 * Reads the current sync state, then follows the event stream: sync state and
 * progress go into their atoms, and a finished sync or a `Changed` notice
 * invalidates every mail query.
 *
 * The subscription starts again when it ends with any failure: in the web
 * build the socket to the Mac can drop, and a defect in the main process
 * fails the stream. Every query then reads again, since events sent in
 * between were missed. While it keeps failing before its first event, the
 * waits grow from 1 to 30 seconds.
 */
export const liveUpdatesAtom = MailClient.runtime.atom((get) => {
  get.mount(appleContactsStatusAtom);
  let resubscribing = false;
  let failures = 0;
  return Effect.gen(function* () {
    const call = yield* MailClient;
    const reactivity = yield* Reactivity.Reactivity;
    get.set(syncStateAtom, yield* call("SyncState", undefined));
    if (resubscribing) yield* reactivity.invalidate(Object.values(Keys));
    resubscribing = true;
    yield* call("Events", undefined).pipe(
      Stream.tap(() =>
        Effect.sync(() => {
          failures = 0;
        }),
      ),
      // Each batch is every event waiting since the last one ran. A burst, such as the change
      // for a local write and the one for its push, invalidates each key once, so every view
      // refetches once rather than once per event.
      Stream.runForEachArray((events) => {
        const keys = new Set<string>();
        for (const event of events)
          for (const key of Match.typeTags<MailboxEvent, readonly string[]>()({
            SyncState: ({ state }) => {
              get.set(syncStateAtom, state);
              if (state.running) return [];
              get.set(syncProgressAtom, null);
              return MAIL_KEYS;
            },
            SyncProgress: ({ progress }) => {
              get.set(syncProgressAtom, progress);
              return [];
            },
            UpdateSettingsChanged: () => [Keys.cache],
            BackfillProgress: () => [Keys.cache, Keys.counts],
            Changed: () => MAIL_KEYS,
            // The main process posts notifications. The Changed or finished sync that follows refetches views.
            NewMail: () => [],
            SnoozeDue: () => [],
          })(event))
            keys.add(key);
        return keys.size === 0 ? Effect.void : reactivity.invalidate([...keys]);
      }),
    );
  }).pipe(
    // Typed failures and defects alike. Interrupting the atom still stops it.
    Effect.sandbox,
    Effect.retry({
      schedule: Schedule.spaced(0).pipe(
        Schedule.modifyDelay(() =>
          Effect.sync(
            () => RESUBSCRIBE_MS[Math.min(failures++, RESUBSCRIBE_MS.length - 1)] ?? 1000,
          ),
        ),
      ),
    }),
  );
});
