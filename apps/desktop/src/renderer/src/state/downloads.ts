/** The app-wide Downloads list; mount `downloadsFeedAtom` to follow the main process. */
import { Effect, Stream } from "effect";
import { Atom } from "effect/reactivity";

import type { DownloadItem } from "../../../shared/downloads";
import { MailClient } from "../rpc";

export const downloadsAtom = Atom.make<readonly DownloadItem[]>([]).pipe(Atom.keepAlive);

/** Set when a save starts in this window, so the panel opens like a browser's download bubble. */
export const downloadsOpenAtom = Atom.make(false).pipe(Atom.keepAlive);

export const downloadsFeedAtom = MailClient.runtime.atom((get) =>
  Effect.gen(function* () {
    const call = yield* MailClient;
    yield* call("Downloads", undefined).pipe(
      Stream.runForEach((items) => Effect.sync(() => get.set(downloadsAtom, items))),
    );
  }),
);
