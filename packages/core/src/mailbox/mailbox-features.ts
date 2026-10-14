import { PlatformCrypto } from "../platform/crypto.js";
import { MailCodec, type MailCodecPort } from "../platform/mail-codec.js";
import { bestComposeSender } from "../compose/compose-sender.js";
import {
  imageAttachment as unboundImageAttachment,
  COMPOSE_IMAGE_LIMIT,
} from "../compose/compose-images.js";
import type { ImageDownloader } from "../platform/runtime.js";
import type { Host } from "../platform/host.js";
import { Effect, Schema, Semaphore } from "effect";
import type { Account } from "../domain/account.js";
import type { Actor, Command } from "../domain/command.js";
import {
  calendarTimestamp,
  detectMailEvents,
  editCalendarEvent,
  CalendarEventEdits,
  inviteHistory,
  matchingInviteAttendee,
  shouldLoadInvitation,
  type CalendarEvent,
  type CalendarInvite,
  type InviteResponse,
} from "../calendar/calendar.js";
import { InvalidInput } from "../domain/errors.js";
import {
  inviteCanRespond,
  inviteReply,
  invitesFromRaw as unboundInvitesFromRaw,
} from "../calendar/invites.js";
import type { MailboxCalendar, MailboxCompose, MailboxOrganize } from "./mailbox.js";
import type { Providers } from "../providers/adapter.js";
import type { Store } from "../store/service.js";
import { providerCapabilities } from "../providers/capabilities.js";

/** `timeZone` places a floating start when the invite has no end: the PlatformHost zone. */
export function eventFromInvite(invite: CalendarInvite, timeZone: string): CalendarEvent | null {
  if (!invite.start || invite.cancelled) return null;
  const start = invite.start;
  let end = invite.end;
  if (!end) {
    if (start.kind === "date") {
      const day = new Date(`${start.value}T00:00:00Z`);
      day.setUTCDate(day.getUTCDate() + 1);
      end = { kind: "date", value: day.toISOString().slice(0, 10) };
    } else {
      const timestamp = calendarTimestamp(start, timeZone) + 3600000;
      if (!Number.isFinite(timestamp)) return null;
      end = { kind: "zoned", value: new Date(timestamp).toISOString(), zone: "UTC", timestamp };
    }
  }
  return {
    key: invite.key,
    uid: invite.uid,
    title: invite.title,
    start,
    end,
    location: invite.location,
    description: invite.description ?? "",
    recurrence: invite.recurrence,
  };
}

/** User-only responses; no toolkit exposes these operations to agents. */
export function makeFeatureMailbox(
  store: Store["Service"],
  providers: Providers["Service"],
  changed: Effect.Effect<unknown>,
  perform: MailboxOrganize["perform"],
  downloadImage: ImageDownloader,
  codec: MailCodecPort,
  crypto: PlatformCrypto,
  host: Host,
) {
  const imageAttachment = (...args: Parameters<typeof unboundImageAttachment>) =>
    unboundImageAttachment(...args).pipe(Effect.provideService(PlatformCrypto, crypto));
  const invitesFromRaw = (...args: Parameters<typeof unboundInvitesFromRaw>) =>
    unboundInvitesFromRaw(...args).pipe(Effect.provideService(MailCodec, codec));
  const responseLock = Semaphore.makeUnsafe(1);
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
    if (account.enabled === false)
      return yield* new InvalidInput({ message: "Enable this account to use its calendar" });
    const parsed = yield* providers
      .get(account.provider)
      .fetchRaw(account, ref.providerId)
      .pipe(Effect.flatMap(invitesFromRaw));
    yield* store.cacheInvites(
      messageId,
      parsed.map((p) => p.invite),
    );
    return { account, ref, parsed };
  });
  const detectedEvents = Effect.fnUntraced(function* (messageId: string) {
    const message = yield* store.getMessage(messageId);
    const owner = yield* store.getAccount(message.accountId);
    if (owner.enabled === false)
      return yield* new InvalidInput({ message: "Enable this account to use its calendar" });
    if (shouldLoadInvitation(message)) {
      const ref = yield* store.messageRef(messageId);
      const account = yield* store.getAccount(ref.accountId);
      const raw = yield* providers.get(account.provider).fetchRaw(account, ref.providerId);
      const parsed = yield* invitesFromRaw(raw, true);
      yield* store.cacheInvites(
        messageId,
        parsed.map((p) => p.invite),
      );
      // Never reinterpret an iTIP request/response/cancellation as a new personal event.
      if (parsed.some((p) => p.invite.method !== "PUBLISH")) return [];
      return parsed.flatMap((p) => {
        const event = eventFromInvite(p.invite, host.timeZone());
        return event
          ? [
              {
                ...event,
                ...(event.recurrence.length &&
                parsed.some(
                  (other) =>
                    other.calendar === p.calendar &&
                    other.invite.uid === p.invite.uid &&
                    other.invite.recurrenceId,
                )
                  ? { hasRecurrenceOverrides: true }
                  : {}),
                title: event.title || message.subject,
              },
            ].map((value) => ({ ...value, key: JSON.stringify(value) }))
          : [];
      });
    }
    return detectMailEvents(message, {
      reference: message.date,
      timeZone: host.timeZone(),
    }).map((event) => ({ ...event, key: JSON.stringify(event) }));
  });
  return {
    imageFromFile: imageAttachment,
    imageFromUrl: (url: string) =>
      downloadImage(url, COMPOSE_IMAGE_LIMIT).pipe(
        Effect.flatMap((image) =>
          imageAttachment({ ...image, filename: `image.${image.mimeType.split("/")[1] ?? "png"}` }),
        ),
      ),
    suggestSender: (current, recipients, accountIds) =>
      Effect.gen(function* () {
        if (!recipients.some((address) => address.trim())) return null;
        const accounts = (yield* store.listAccounts).filter(
          (a) => a.enabled !== false && accountIds.includes(a.id),
        );
        const aliases = yield* store.sendAs;
        const senders = accounts.flatMap((a) => [
          { accountId: a.id, address: a.email, name: "" },
          ...aliases
            .filter(
              (s) =>
                providerCapabilities(a.provider).sendAs &&
                s.accountId === a.id &&
                s.address.toLowerCase() !== a.email.toLowerCase(),
            )
            .map((s) => ({ accountId: s.accountId, address: s.address, name: s.name })),
        ]);
        return bestComposeSender(
          senders,
          current,
          recipients,
          yield* store.senderHistory(recipients),
        );
      }),
    detectedEvents,
    calendarEvents: (messageId: string, key: string) =>
      Effect.gen(function* () {
        const { parsed, account } = yield* parsedInvites(messageId);
        const invite = parsed.find((p) => p.invite.key === key)?.invite;
        const event = invite && eventFromInvite(invite, host.timeZone());
        const adapter = providers.get(account.provider);
        if (!event || !providerCapabilities(account.provider).calendar || !adapter.calendarEvents)
          return yield* new InvalidInput({
            message: "Calendar access is unavailable for this account",
          });
        return yield* adapter.calendarEvents(account, { ...event, key: invite.uid });
      }),
    createCalendarEvent: (
      messageId: string,
      key: string,
      actor: Actor,
      edits?: CalendarEventEdits,
    ) =>
      responseLock.withPermit(
        Effect.gen(function* () {
          if (actor.kind !== "user" || actor.surface !== "app")
            return yield* new InvalidInput({
              message: "Calendar creation requires an in-app confirmation",
            });
          const event = (yield* detectedEvents(messageId)).find((e) => e.key === key);
          if (!event)
            return yield* new InvalidInput({ message: "This event is no longer available" });
          const ref = yield* store.messageRef(messageId);
          const account = yield* store.getAccount(ref.accountId);
          const adapter = providers.get(account.provider);
          if (!providerCapabilities(account.provider).calendar || !adapter.createCalendarEvent)
            return yield* new InvalidInput({
              message: "Calendar access is unavailable for this account",
            });
          const message = yield* store.getMessage(messageId);
          const updated = yield* Effect.try({
            try: () =>
              editCalendarEvent(
                event,
                Schema.decodeUnknownSync(CalendarEventEdits)(edits ?? {}),
                message.date,
                host.timeZone(),
              ),
            catch: (error) =>
              error instanceof InvalidInput
                ? error
                : new InvalidInput({ message: "Invalid calendar event time" }),
          });
          yield* adapter.createCalendarEvent(account, updated);
          yield* store.appendAudit({
            actor,
            accountId: account.id,
            action: "calendar_create",
            detail: { messageId, title: event.title },
          });
          yield* changed;
          return yield* Effect.void;
        }),
      ),
    invitations: (messageId: string) =>
      Effect.gen(function* () {
        const { parsed, account } = yield* parsedInvites(messageId);
        const addresses = !providerCapabilities(account.provider).calendar
          ? yield* responseAddresses(account)
          : [account.email];
        return yield* Effect.forEach(parsed, (p) =>
          Effect.gen(function* () {
            const attendee = matchingInviteAttendee(p.invite, addresses);
            const history = yield* store.cachedInvites(account.id, p.invite.uid);
            const annotated = inviteHistory(p.invite, history);
            const response = yield* store.inviteResponse({
              accountId: account.id,
              uid: p.invite.uid,
              organizer: p.invite.organizer?.address ?? "",
              recurrenceId: p.invite.recurrenceId?.value ?? "",
            });
            const status = annotated.threadStatus;
            const threadStatus =
              response && status && !status.cancelled && response.sequence === status.sequence
                ? {
                    ...status,
                    statuses: [
                      ...status.statuses.filter(
                        (a) => a.address.toLowerCase() !== response.address.address.toLowerCase(),
                      ),
                      { ...response.address, status: response.response.toUpperCase() },
                    ],
                  }
                : status;
            return {
              ...annotated,
              ...(threadStatus ? { threadStatus } : {}),
              ...(attendee ? { responseAddress: attendee } : {}),
            };
          }),
        );
      }),
    respondInvite: (
      messageId: string,
      key: string,
      response: InviteResponse,
      actor: Actor,
      label?: string,
    ) =>
      responseLock.withPermit(
        Effect.gen(function* () {
          if (actor.kind !== "user")
            return yield* new InvalidInput({ message: "Calendar responses require a user action" });
          // Re-read the MIME at click time; never trust an invitation supplied by a caller.
          const { account, ref, parsed } = yield* parsedInvites(messageId);
          const invitation = parsed.find(
            (p) => p.invite.key === key && p.invite.method === "REQUEST",
          );
          const addresses = !providerCapabilities(account.provider).calendar
            ? yield* responseAddresses(account)
            : [];
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
                p.invite.organizer?.address.toLowerCase() ===
                  invitation.invite.organizer?.address.toLowerCase() &&
                p.invite.cancelled &&
                p.invite.sequence >= invitation.invite.sequence &&
                (!p.invite.recurrenceId ||
                  p.invite.recurrenceId.value === invitation.invite.recurrenceId?.value),
            )
          )
            return yield* new InvalidInput({ message: "This meeting has been cancelled" });
          for (const siblingId of yield* store.inviteSiblingIds(
            account.id,
            invitation.invite.uid,
            messageId,
          )) {
            const updates = yield* parsedInvites(siblingId).pipe(Effect.result);
            if (updates._tag === "Failure") continue;
            for (const update of updates.success.parsed) {
              const latest = update.invite;
              if (
                latest.uid !== invitation.invite.uid ||
                latest.organizer?.address.toLowerCase() !==
                  invitation.invite.organizer?.address.toLowerCase() ||
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
          if (!providerCapabilities(account.provider).calendar) {
            const attendee = matchingInviteAttendee(invitation.invite, addresses);
            if (!attendee)
              return yield* new InvalidInput({
                message: "This invitation cannot be answered by this account",
              });
            const message = yield* Effect.try({
              try: () => inviteReply(invitation, attendee, response, messageId, label),
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
          yield* store.recordInviteResponse({
            accountId: account.id,
            uid: invitation.invite.uid,
            organizer: invitation.invite.organizer?.address ?? "",
            recurrenceId: invitation.invite.recurrenceId?.value ?? "",
            sequence: invitation.invite.sequence,
            address: matchingInviteAttendee(invitation.invite, [account.email, ...addresses]) ?? {
              name: "",
              address: account.email,
            },
            response,
          });
          yield* store.appendAudit({
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
    MailboxCalendar,
    "invitations" | "respondInvite" | "calendarEvents" | "detectedEvents" | "createCalendarEvent"
  > &
    Pick<MailboxCompose, "imageFromUrl" | "imageFromFile" | "suggestSender">;
}
