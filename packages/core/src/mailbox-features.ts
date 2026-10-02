import { Clock, Effect, Semaphore } from "effect";
import type { Account, Actor, Command } from "./domain.js";
import { matchingInviteAttendee, type InviteResponse } from "./calendar.js";
import { InvalidInput } from "./errors.js";
import { inviteCanRespond, inviteReply, invitesFromRaw } from "./invites.js";
import type { Mailbox } from "./mailbox.js";
import type { Providers, Store } from "./services.js";

/** User-only responses; no toolkit exposes these operations to agents. */
export function makeFeatureMailbox(
  store: Store["Service"],
  providers: Providers["Service"],
  changed: Effect.Effect<unknown>,
  perform: Mailbox["Service"]["perform"],
) {
  const contactsLock = Semaphore.makeUnsafe(1);
  const responseLock = Semaphore.makeUnsafe(1);
  const refreshContacts = (accountId: string, force = true) =>
    contactsLock.withPermit(
      Effect.gen(function* () {
        const account = yield* store.getAccount(accountId);
        if (account.enabled === false || account.provider === "imap") return yield* Effect.void;
        const now = yield* Clock.currentTimeMillis;
        const previous = (yield* store.contactSync).find((s) => s.accountId === accountId);
        const interval = previous?.error ? 3600000 : 6 * 3600000;
        if (!force && previous && now - previous.attemptedAt < interval) return yield* Effect.void;
        const result = yield* providers.get(account.provider).contacts(account).pipe(Effect.result);
        if (result._tag === "Failure") {
          yield* store.setContactSyncError(
            accountId,
            now,
            result.failure.message,
            result.failure._tag === "FeatureScopeMissing",
          );
          yield* changed;
          return yield* result.failure;
        }
        yield* store.replaceServerContacts(accountId, result.success, now);
        yield* changed;
        return yield* Effect.void;
      }),
    );
  const responseAddresses = Effect.fnUntraced(function* (account: Account) {
    const aliases = yield* store.sendAs;
    const accounts = yield* store.listAccounts;
    return [
      account.email,
      ...(account.imap ? [account.imap.username] : []),
      ...accounts.map((a) => a.email),
      ...aliases.filter((a) => a.accountId === account.id).map((a) => a.address),
    ];
  });
  const parsedInvites = Effect.fnUntraced(function* (messageId: string) {
    const ref = yield* store.messageRef(messageId);
    const account = yield* store.getAccount(ref.accountId);
    const parsed = yield* providers
      .get(account.provider)
      .fetchRaw(account, ref.providerId)
      .pipe(Effect.flatMap(invitesFromRaw));
    return { account, ref, parsed };
  });
  return {
    contactSync: store.contactSync,
    refreshContacts,
    invitations: (messageId: string) =>
      Effect.gen(function* () {
        const { parsed, account } = yield* parsedInvites(messageId);
        const addresses =
          account.provider === "imap" ? yield* responseAddresses(account) : [account.email];
        return parsed.map((p) => {
          const attendee = matchingInviteAttendee(p.invite, addresses);
          return { ...p.invite, ...(attendee ? { responseAddress: attendee } : {}) };
        });
      }),
    respondInvite: (messageId: string, key: string, response: InviteResponse, actor: Actor) =>
      responseLock.withPermit(
        Effect.gen(function* () {
          if (actor.kind !== "user")
            return yield* new InvalidInput({ message: "Calendar responses require a user action" });
          // Re-read the MIME at click time; never trust an invitation supplied by a caller.
          const { account, ref, parsed } = yield* parsedInvites(messageId);
          const invitation = parsed.find(
            (p) => p.invite.key === key && p.invite.method === "REQUEST",
          );
          const addresses = account.provider === "imap" ? yield* responseAddresses(account) : [];
          if (
            !invitation ||
            !inviteCanRespond(invitation.invite, account.email, account.provider, addresses)
          )
            return yield* new InvalidInput({
              message: "This invitation cannot be answered by this account",
            });
          if (
            parsed.some(
              (p) =>
                p.invite.uid === invitation.invite.uid &&
                p.invite.cancelled &&
                p.invite.sequence >= invitation.invite.sequence &&
                (!p.invite.recurrenceId ||
                  p.invite.recurrenceId.value === invitation.invite.recurrenceId?.value),
            )
          )
            return yield* new InvalidInput({ message: "This meeting has been cancelled" });
          const thread = yield* store.getThread(messageId);
          for (const sibling of thread) {
            if (
              sibling.id === messageId ||
              !(
                sibling.hasCalendar ||
                sibling.attachments.some(
                  (a) => a.mimeType === "text/calendar" || /\.ics$/i.test(a.filename),
                )
              )
            )
              continue;
            const updates = (yield* parsedInvites(sibling.id)).parsed;
            for (const update of updates) {
              const latest = update.invite;
              if (
                latest.uid !== invitation.invite.uid ||
                latest.sequence < invitation.invite.sequence ||
                (latest.recurrenceId &&
                  latest.recurrenceId.value !== invitation.invite.recurrenceId?.value)
              )
                continue;
              if (latest.cancelled)
                return yield* new InvalidInput({ message: "This meeting has been cancelled" });
              if (latest.method === "REQUEST" && latest.sequence > invitation.invite.sequence)
                return yield* new InvalidInput({ message: "This invitation has a newer update" });
            }
          }
          if (account.provider === "imap") {
            const attendee = matchingInviteAttendee(invitation.invite, addresses);
            if (!attendee)
              return yield* new InvalidInput({
                message: "This invitation cannot be answered by this account",
              });
            const message = yield* Effect.try({
              try: () => inviteReply(invitation, attendee, response, messageId),
              catch: () => new InvalidInput({ message: "Cannot build calendar response" }),
            });
            const command: Command = { kind: "send", accountId: account.id, message };
            const outcome = yield* perform(command, actor);
            if (outcome.status !== "applied")
              return yield* new InvalidInput({ message: "Calendar response was not sent" });
          } else
            yield* providers
              .get(account.provider)
              .respondInvite(account, ref.providerId, invitation.invite, response);
          yield* store.audit({
            actor,
            accountId: account.id,
            action: "calendar_response",
            detail: { messageId, uid: invitation.invite.uid, response },
          });
          yield* changed;
          return yield* Effect.void;
        }),
      ),
  } satisfies Pick<
    Mailbox["Service"],
    "contactSync" | "refreshContacts" | "invitations" | "respondInvite"
  >;
}
