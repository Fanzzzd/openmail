/**
 * Changes, as Effects over the `MailClient`. Each one invalidates the
 * reactivity keys of what it changes, so the query atoms that show that data
 * refetch. Components run them with `useRunMail` (fire and forget, own fiber
 * per call) or through the mutation atoms in `mutations.ts` (when the UI
 * shows pending and error state).
 */
import { type Context, Effect, type Scope } from "effect";
import { AtomRegistry, Reactivity } from "effect/reactivity";
import { useContext } from "react";
import { RegistryContext } from "@effect/atom-react";

import type { MailOp, OutgoingMessage } from "../../../shared/api";
import { MailClient } from "../rpc";
import { MAIL_KEYS, threadChangeKeys } from "./keys";

/** What the Effects below need; `MailClient.runtime` provides all of it. */
export type MailEnv = MailClient | Reactivity.Reactivity | AtomRegistry.AtomRegistry | Scope.Scope;

/** The flat RPC client: `call("Tag", payload)`. */
type Call = Context.Service.Shape<typeof MailClient>;

/** Runs `f` with the RPC client. */
export const withMail = <A, E, R>(f: (call: Call) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    return yield* f(yield* MailClient);
  });

/** Applies `op` to whole threads, given any message id in each. */
export const modifyThreads = (threads: readonly string[], op: MailOp) =>
  withMail((call) => call("Modify", { threads, op })).pipe(
    Reactivity.mutation(threadChangeKeys(threads)),
  );

/** Sends as the person at the app. Only after the undo window has passed. */
export const sendMessage = (accountId: string, message: OutgoingMessage) =>
  withMail((call) => call("Send", { accountId, message })).pipe(Reactivity.mutation(MAIL_KEYS));

export const decideProposal = (id: number, approve: boolean) =>
  withMail((call) => call("DecideProposal", { id, approve })).pipe(Reactivity.mutation(MAIL_KEYS));

/** Signs in again with the account's provider. OAuth only; IMAP goes through Connect. */
export const reauthAccount = (accountId: string) =>
  withMail((call) => call("Reauth", { accountId })).pipe(Reactivity.mutation(MAIL_KEYS));

/** Starts a sync of every account. Progress and results arrive as events. */
export const syncNow = withMail((call) => call("Sync", undefined));

/**
 * Runs mail Effects from event handlers. Each call gets its own fiber in the
 * atom runtime, so concurrent calls never cancel each other. Returns the
 * fiber; interrupting it cancels the call.
 */
export function useRunMail() {
  const registry = useContext(RegistryContext);
  return <A, E>(effect: Effect.Effect<A, E, MailEnv>) =>
    Effect.runFork(AtomRegistry.getResult(registry, MailClient.runtime.atom(effect)));
}
