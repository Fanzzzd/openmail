/**
 * Changes, as Effects over the `MailClient`. Each one invalidates the
 * reactivity keys of what it changes, so the query atoms that show that data
 * refetch. Components run them with `useRunMail` (fire and forget, own fiber
 * per call) or through the mutation atoms in `mutations.ts` (when the UI
 * shows pending and error state).
 */
import { type Context, Effect, type Scope } from "effect";
import { AtomRegistry, Reactivity } from "effect/reactivity";
import { useCallback, useContext } from "react";
import { RegistryContext } from "@effect/atom-react";

import type { DraftInput, MailOp, OutgoingMessage } from "../../../shared/api";
import { MailClient } from "../rpc";
import { Keys, MAIL_KEYS, threadChangeKeys } from "./keys";

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

export const modifyWithUndo = (threads: readonly string[], op: MailOp, flat: boolean) =>
  withMail((call) => call("ModifyWithUndo", { threads, op, flat })).pipe(
    Reactivity.mutation(threadChangeKeys(threads)),
  );

export const undoBatch = (undoId: string, threads: readonly string[]) =>
  withMail((call) => call("UndoBatch", { undoId })).pipe(
    Reactivity.mutation(threadChangeKeys(threads)),
  );

/**
 * Sends as the person at the app. Only after the undo window has passed.
 * `draftId` names the saved draft this sends; `archive` archives the thread
 * replied to (send and archive).
 */
export const sendMessage = (
  accountId: string,
  message: OutgoingMessage,
  options: { draftId?: string; archive?: boolean } = {},
) =>
  withMail((call) => call("Send", { accountId, message, ...options })).pipe(
    Reactivity.mutation(MAIL_KEYS),
  );

/** Saves the draft locally; the main process pushes it to the provider. */
export const saveDraft = (draft: DraftInput) =>
  withMail((call) => call("SaveDraft", { draft })).pipe(Reactivity.mutation([Keys.threads]));

export const discardDraft = (id: string) =>
  withMail((call) => call("DiscardDraft", { id })).pipe(
    Reactivity.mutation([Keys.threads, Keys.thread, Keys.proposals, Keys.audit]),
  );

/** A draft to edit: a local draft id, a draft message id, or "proposal:<id>". */
export const openDraft = (id: string) => withMail((call) => call("OpenDraft", { id }));

export const decideProposal = (id: number, approve: boolean) =>
  withMail((call) => call("DecideProposal", { id, approve })).pipe(Reactivity.mutation(MAIL_KEYS));

/** Signs in again with the account's provider. OAuth only; IMAP goes through Connect. */
export const reauthAccount = (accountId: string, feature?: "permanentDelete") =>
  withMail((call) => call("Reauth", { accountId, ...(feature ? { feature } : {}) })).pipe(
    Reactivity.mutation(MAIL_KEYS),
  );

/** Asks where to save the attachment and writes it. Succeeds with false when cancelled. */
export const saveAttachment = (messageId: string, index: number) =>
  withMail((call) => call("SaveAttachment", { messageId, index }));

/** Opens the attachment with its default app, from a temporary copy. */
export const openAttachment = (messageId: string, index: number) =>
  withMail((call) => call("OpenAttachment", { messageId, index }));

/** Asks for a folder and saves every attachment of the message. Succeeds with the count. */
export const saveAllAttachments = (messageId: string) =>
  withMail((call) => call("SaveAllAttachments", { messageId }));

/** Prints the thread of `id` (or only message `only`), or saves it as PDF with `pdf`. */
export const printThread = (request: {
  id: string;
  only?: string;
  pdf: boolean;
  headings: { from: string; to: string; cc: string; date: string };
  locale: string;
}) => withMail((call) => call("PrintThread", request));

/** Opens the thread in a window of its own. */
export const openThreadWindow = (id: string) =>
  withMail((call) => call("OpenThreadWindow", { id }));

/** Message-scoped actions never expand the ID into its conversation. */
export const modifyMessages = (ids: readonly string[], op: MailOp) => modifyWithUndo(ids, op, true);
export const markUnreadFrom = (id: string) =>
  withMail((call) => call("MarkUnreadFrom", { id })).pipe(
    Reactivity.mutation(threadChangeKeys([id])),
  );
export const openMessageWindow = (id: string) =>
  withMail((call) => call("OpenMessageWindow", { id }));

/** Starts a sync of every account. Progress and results arrive as events. */
export const syncNow = withMail((call) => call("Sync", undefined));

/**
 * Runs mail Effects from event handlers. Each call gets its own fiber in the
 * atom runtime, so concurrent calls never cancel each other. Returns the
 * fiber; interrupting it cancels the call.
 */
export function useRunMail() {
  const registry = useContext(RegistryContext);
  return useCallback(
    <A, E>(effect: Effect.Effect<A, E, MailEnv>) =>
      Effect.runFork(AtomRegistry.getResult(registry, MailClient.runtime.atom(effect))),
    [registry],
  );
}
