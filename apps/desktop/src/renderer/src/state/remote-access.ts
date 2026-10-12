import { Effect, Stream } from "effect";
import { Atom } from "effect/reactivity";

import type { RemoteAccessView } from "../../../shared/remote-access";
import { MailClient } from "./rpc";

/** Remote access as main reports it; mount `remoteAccessFeedAtom` to follow changes. */
export const remoteAccessAtom = Atom.make<RemoteAccessView | null>(null);

export const remoteAccessFeedAtom = MailClient.runtime.atom((get) =>
  Effect.gen(function* () {
    const call = yield* MailClient;
    yield* call("RemoteAccess", undefined).pipe(
      Stream.runForEach((view) => Effect.sync(() => get.set(remoteAccessAtom, view))),
    );
  }),
);

export const refreshRemoteAccessAtom = MailClient.mutation("RefreshRemoteAccess");
export const setRemoteAccessAtom = MailClient.mutation("SetRemoteAccess");
export const setRemoteAllowlistAtom = MailClient.mutation("SetRemoteAllowlist");
export const setRemoteServiceAtom = MailClient.mutation("SetRemoteService");
export const disconnectRemoteSessionAtom = MailClient.mutation("DisconnectRemoteSession");
