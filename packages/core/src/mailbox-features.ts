import { PlatformCrypto } from "./platform/crypto.js";
import { MailCodec, type MailCodecPort } from "./platform/mail-codec.js";
import { bestComposeSender } from "./compose-sender.js";
import {
  imageAttachment as unboundImageAttachment,
  CONTACT_PHOTO_LIMIT,
  COMPOSE_IMAGE_LIMIT,
  type ImageDownloader,
} from "./compose-images.js";
import { Clock, Effect, Semaphore } from "effect";
import type { Account, Actor, Command } from "./domain.js";
import {
  calendarTimestamp,
  detectMailEvents,
  inviteHistory,
  matchingInviteAttendee,
  shouldLoadInvitation,
  type CalendarEvent,
  type CalendarInvite,
  type InviteResponse,
} from "./calendar.js";
import { InvalidInput } from "./errors.js";
import {
  inviteCanRespond,
  inviteReply,
  invitesFromRaw as unboundInvitesFromRaw,
} from "./invites.js";
import type { Mailbox } from "./mailbox.js";
import type { Providers, Store } from "./services.js";

function eventFromInvite(invite: CalendarInvite): CalendarEvent | null {
  if (!invite.start || invite.cancelled) return null;
  const start = invite.start;
  let end = invite.end;
  if (!end) {
    if (start.kind === "date") {
      const day = new Date(`${start.value}T00:00:00Z`);
      day.setUTCDate(day.getUTCDate() + 1);
      end = { kind: "date", value: day.toISOString().slice(0, 10) };
    } else {
      const timestamp = calendarTimestamp(start) + 3600000;
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
  perform: Mailbox["Service"]["perform"],
  downloadImage: ImageDownloader,
  codec: MailCodecPort,
  crypto: PlatformCrypto,
) {
  const imageAttachment = (...args: Parameters<typeof unboundImageAttachment>) =>
    unboundImageAttachment(...args).pipe(Effect.provideService(PlatformCrypto, crypto));
  const invitesFromRaw = (...args: Parameters<typeof unboundInvitesFromRaw>) =>
    unboundInvitesFromRaw(...args).pipe(Effect.provideService(MailCodec, codec));
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
        const provider = providers.get(account.provider);
        const result = yield* (
          provider.contactSnapshot
            ? provider.contactSnapshot(account)
            : provider
                .contacts(account)
                .pipe(Effect.map((contacts) => ({ contacts, groups: [], photos: [] })))
        ).pipe(Effect.result);
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
        yield* store.replaceServerContacts(accountId, result.success.contacts, now);
        yield* store.replaceContactExtras(accountId, result.success);
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
  const photoLock = Semaphore.makeUnsafe(1);
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
        const event = eventFromInvite(p.invite);
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
    return detectMailEvents(message).map((event) => ({ ...event, key: JSON.stringify(event) }));
  });
  return {
    imageFromFile: imageAttachment,
    imageFromUrl: (url: string) =>
      downloadImage(url, COMPOSE_IMAGE_LIMIT).pipe(
        Effect.flatMap((image) =>
          imageAttachment({ ...image, filename: `image.${image.mimeType.split("/")[1] ?? "png"}` }),
        ),
      ),
    contactGroups: (query, accountIds) => store.contactGroups(query, accountIds),
    contactPhoto: (accountId: string, address: string) =>
      photoLock.withPermit(
        Effect.gen(function* () {
          if (!(yield* store.prefs).contactPhotos) return null;
          const source = yield* store.contactPhotoSource(accountId, address);
          if (!source || !googleContactPhotoUrl(source.url)) return null;
          if (source.dataUrl) return (yield* store.prefs).contactPhotos ? source.dataUrl : null;
          const image = yield* downloadImage(source.url, CONTACT_PHOTO_LIMIT);
          const dataUrl = `data:${image.mimeType};base64,${image.content}`;
          if (!(yield* store.prefs).contactPhotos) return null;
          yield* store.cacheContactPhoto(accountId, address, source.url, dataUrl);
          return dataUrl;
        }).pipe(Effect.catch(() => Effect.succeed(null))),
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
                a.provider === "gmail" &&
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
        const event = invite && eventFromInvite(invite);
        const adapter = providers.get(account.provider);
        if (!event || account.provider === "imap" || !adapter.calendarEvents)
          return yield* new InvalidInput({
            message: "Calendar access is unavailable for this account",
          });
        return yield* adapter.calendarEvents(account, { ...event, key: invite.uid });
      }),
    createCalendarEvent: (messageId: string, key: string, actor: Actor) =>
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
          if (account.provider === "imap" || !adapter.createCalendarEvent)
            return yield* new InvalidInput({
              message: "Calendar access is unavailable for this account",
            });
          yield* adapter.createCalendarEvent(account, event);
          yield* store.audit({
            actor,
            accountId: account.id,
            action: "calendar_create",
            detail: { messageId, title: event.title },
          });
          yield* changed;
          return yield* Effect.void;
        }),
      ),
    contactSync: store.contactSync,
    refreshContacts,
    invitations: (messageId: string) =>
      Effect.gen(function* () {
        const { parsed, account } = yield* parsedInvites(messageId);
        const addresses =
          account.provider === "imap" ? yield* responseAddresses(account) : [account.email];
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
    | "contactSync"
    | "refreshContacts"
    | "invitations"
    | "respondInvite"
    | "contactGroups"
    | "contactPhoto"
    | "imageFromUrl"
    | "imageFromFile"
    | "suggestSender"
    | "calendarEvents"
    | "detectedEvents"
    | "createCalendarEvent"
  >;
}

function googleContactPhotoUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      (url.hostname === "googleusercontent.com" || url.hostname.endsWith(".googleusercontent.com"))
    );
  } catch {
    return false;
  }
}
