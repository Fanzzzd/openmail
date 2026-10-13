import { gmailPages } from "../provider-pages.js";
import { Effect, Result, Schema } from "effect";
import { reconcileProviderWrite } from "../provider-write.js";
import type { Account, Address } from "../../domain/domain.js";
import type { CalendarInvite, CalendarTime, InviteResponse } from "../../calendar/calendar.js";
import { InvalidInput } from "../../domain/errors.js";
import {
  type ContactGroup,
  type ContactPhoto,
  type ContactSnapshot,
  mergeContacts,
} from "../../contacts/contacts.js";
import { graphTimestamp } from "../../calendar/graph-time.js";
import { featureRequest } from "../provider-features.js";

const Person = Schema.Struct({
  resourceName: Schema.optionalKey(Schema.String),
  photos: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        url: Schema.String,
        default: Schema.optionalKey(Schema.Boolean),
        metadata: Schema.optionalKey(
          Schema.Struct({ primary: Schema.optionalKey(Schema.Boolean) }),
        ),
      }),
    ),
  ),
  memberships: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        contactGroupMembership: Schema.optionalKey(
          Schema.Struct({ contactGroupResourceName: Schema.String }),
        ),
      }),
    ),
  ),
  names: Schema.optionalKey(
    Schema.Array(Schema.Struct({ displayName: Schema.optionalKey(Schema.String) })),
  ),
  organizations: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: Schema.optionalKey(Schema.String) })),
  ),
  emailAddresses: Schema.optionalKey(
    Schema.Array(Schema.Struct({ value: Schema.optionalKey(Schema.String) })),
  ),
});
const Connections = Schema.Struct({
  connections: Schema.optionalKey(Schema.Array(Person)),
  nextPageToken: Schema.optionalKey(Schema.String),
});
const Others = Schema.Struct({
  otherContacts: Schema.optionalKey(Schema.Array(Person)),
  nextPageToken: Schema.optionalKey(Schema.String),
});
const Groups = Schema.Struct({
  contactGroups: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        resourceName: Schema.String,
        name: Schema.String,
        groupType: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  nextPageToken: Schema.optionalKey(Schema.String),
});
const EventTime = Schema.Struct({
  date: Schema.optionalKey(Schema.String),
  dateTime: Schema.optionalKey(Schema.String),
  timeZone: Schema.optionalKey(Schema.String),
});
const Attendee = Schema.Struct({
  email: Schema.String,
  self: Schema.optionalKey(Schema.Boolean),
  responseStatus: Schema.optionalKey(Schema.String),
});
const Event = Schema.Struct({
  id: Schema.String,
  status: Schema.optionalKey(Schema.String),
  organizer: Schema.optionalKey(
    Schema.Struct({
      email: Schema.optionalKey(Schema.String),
      self: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  attendees: Schema.optionalKey(Schema.Array(Attendee)),
  originalStartTime: Schema.optionalKey(EventTime),
});
const Events = Schema.Struct({
  items: Schema.optionalKey(Schema.Array(Event)),
  nextPageToken: Schema.optionalKey(Schema.String),
});
const PEOPLE = "https://people.googleapis.com/v1";
const EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

function matchesInstance(
  original: typeof EventTime.Type | undefined,
  instance: CalendarTime,
): boolean {
  if (!original) return false;
  if (instance.kind === "date") return original.date === instance.value;
  if (!original.dateTime) return false;
  if (instance.kind === "floating") {
    // Floating recurrence ids describe a wall time, not a UTC instant. Google's
    // occurrence can carry a Z or offset suffix (and fractional seconds).
    return (
      original.dateTime.replace(/(?:Z|[+-]\d{2}:\d{2})$/, "").replace(/\.\d+$/, "") ===
      instance.value
    );
  }
  if (instance.timestamp === null) return false;
  return Result.getOrElse(
    Result.try(
      () =>
        graphTimestamp({
          dateTime: original.dateTime ?? "",
          timeZone: original.timeZone ?? instance.zone,
        }) === instance.timestamp,
    ),
    () => false,
  );
}

export function makeGmailFeatures<
  E extends {
    readonly _tag: string;
    readonly status?: number | undefined;
    readonly body?: string | undefined;
    readonly message?: string | undefined;
  },
>(
  get: <A>(id: string, schema: Schema.Decoder<A>, url: string) => Effect.Effect<A, E>,
  patch: (id: string, url: string, body: unknown) => Effect.Effect<unknown, E>,
) {
  const loadContacts = (account: Account, details: boolean) =>
    featureRequest(
      account,
      "contacts",
      Effect.gen(function* () {
        const contacts: Address[] = [];
        const photos: ContactPhoto[] = [];
        const members = new Map<string, Address[]>();
        for (const source of ["connections", "otherContacts"] as const) {
          const seen = new Set<string>();
          for (const loadPage of gmailPages((token) =>
            Effect.gen(function* () {
              const query = new URLSearchParams({
                pageSize: "1000",
                ...(source === "connections"
                  ? {
                      personFields: details
                        ? "names,emailAddresses,organizations,photos,memberships"
                        : "names,emailAddresses,organizations",
                      sources: "READ_SOURCE_TYPE_CONTACT",
                    }
                  : { readMask: "names,emailAddresses" }),
                ...(token ? { pageToken: token } : {}),
              });
              const url = `${PEOPLE}/${source === "connections" ? "people/me/connections" : "otherContacts"}?${query.toString()}`;
              return source === "connections"
                ? yield* get(account.id, Connections, url)
                : yield* featureRequest(account, "contacts", get(account.id, Others, url)).pipe(
                    Effect.catchTag("FeatureScopeMissing", () =>
                      Effect.succeed<typeof Others.Type>({ otherContacts: [] }),
                    ),
                  );
            }),
          )) {
            const page = yield* loadPage;

            const people =
              "connections" in page
                ? page.connections
                : "otherContacts" in page
                  ? page.otherContacts
                  : [];
            for (const person of people ?? []) {
              const addresses = mergeContacts(
                (person.emailAddresses ?? []).flatMap((email) =>
                  email.value
                    ? [
                        {
                          address: email.value,
                          name: person.names?.[0]?.displayName ?? "",
                          ...(person.organizations?.length
                            ? {
                                company: person.organizations
                                  .map((o) => o.name ?? "")
                                  .filter(Boolean)
                                  .join(" "),
                              }
                            : {}),
                          ...(person.resourceName ? { contactKey: person.resourceName } : {}),
                        },
                      ]
                    : [],
                ),
              );
              contacts.push(...addresses);
              if (details && source === "connections") {
                const photo =
                  person.photos?.find((p) => p.default !== true && p.metadata?.primary === true) ??
                  person.photos?.find((p) => p.default !== true);
                if (photo)
                  photos.push(...addresses.map((a) => ({ address: a.address, url: photo.url })));
                for (const membership of person.memberships ?? []) {
                  const id = membership.contactGroupMembership?.contactGroupResourceName;
                  if (id) members.set(id, [...(members.get(id) ?? []), ...addresses]);
                }
              }
            }
            const token = page.nextPageToken ?? "";
            if (token && seen.has(token))
              return yield* new InvalidInput({ message: "Contact pagination repeated a page" });
            seen.add(token);
          }
        }
        const groups: ContactGroup[] = [];
        if (details) {
          const seen = new Set<string>();
          for (const loadPage of gmailPages((token) =>
            Effect.gen(function* () {
              const query = new URLSearchParams({
                pageSize: "1000",
                groupFields: "name,groupType",
                ...(token ? { pageToken: token } : {}),
              });
              return yield* get(account.id, Groups, `${PEOPLE}/contactGroups?${query.toString()}`);
            }),
          )) {
            const page = yield* loadPage;

            for (const group of page.contactGroups ?? []) {
              const addresses = mergeContacts(members.get(group.resourceName) ?? []);
              if (group.groupType === "USER_CONTACT_GROUP" && addresses.length)
                groups.push({
                  accountId: account.id,
                  id: group.resourceName,
                  name: group.name,
                  members: addresses,
                });
            }
            const token = page.nextPageToken ?? "";
            if (token && seen.has(token))
              return yield* new InvalidInput({
                message: "Contact group pagination repeated a page",
              });
            seen.add(token);
          }
        }
        return { contacts: mergeContacts(contacts), groups, photos } satisfies ContactSnapshot;
      }),
    );
  return {
    contacts: (account: Account) =>
      loadContacts(account, false).pipe(Effect.map((snapshot) => snapshot.contacts)),
    contactSnapshot: (account: Account) => loadContacts(account, true),
    respondInvite: (
      account: Account,
      _providerId: string,
      invite: CalendarInvite,
      response: InviteResponse,
    ) =>
      featureRequest(
        account,
        "calendar",
        Effect.gen(function* () {
          const events: (typeof Event.Type)[] = [];
          const seen = new Set<string>();
          for (const loadPage of gmailPages((token) =>
            Effect.gen(function* () {
              const query = new URLSearchParams({
                iCalUID: invite.uid,
                showDeleted: "true",
                ...(invite.recurrenceId ? { singleEvents: "true" } : {}),
                ...(token ? { pageToken: token } : {}),
              });
              if (invite.recurrenceId?.kind === "zoned" && invite.recurrenceId.timestamp !== null) {
                query.set(
                  "timeMin",
                  new Date(invite.recurrenceId.timestamp - 86400000).toISOString(),
                );
                query.set(
                  "timeMax",
                  new Date(invite.recurrenceId.timestamp + 86400000).toISOString(),
                );
              } else if (invite.recurrenceId) {
                const date = invite.recurrenceId.value.slice(0, 10);
                query.set("timeMin", `${date}T00:00:00Z`);
                query.set(
                  "timeMax",
                  new Date(Date.parse(`${date}T00:00:00Z`) + 2 * 86400000).toISOString(),
                );
              }
              return yield* get(account.id, Events, `${EVENTS}?${query.toString()}`);
            }),
          )) {
            const page = yield* loadPage;

            events.push(...(page.items ?? []));
            const token = page.nextPageToken ?? "";
            if (token && seen.has(token))
              return yield* new InvalidInput({ message: "Calendar pagination repeated a page" });
            seen.add(token);
          }
          const matches = events.filter((e) =>
            invite.recurrenceId
              ? matchesInstance(e.originalStartTime, invite.recurrenceId)
              : e.originalStartTime === undefined,
          );
          const event = matches.length === 1 ? matches[0] : undefined;
          if (!event)
            return yield* new InvalidInput({
              message: "Open this invitation in your calendar to add it before responding",
            });
          if (event.status === "cancelled")
            return yield* new InvalidInput({ message: "This meeting has been cancelled" });
          if (
            event.organizer?.self ||
            event.organizer?.email?.toLowerCase() !== invite.organizer?.address.toLowerCase()
          )
            return yield* new InvalidInput({
              message: "The calendar organizer does not match this invitation",
            });
          const me = event.attendees?.find(
            (a) => a.self || a.email.toLowerCase() === account.email.toLowerCase(),
          );
          if (!me)
            return yield* new InvalidInput({
              message: "This invitation cannot be answered by this account",
            });
          if (me.responseStatus === response) return yield* Effect.void;
          // attendeesOmitted permits a self-only response without replacing other guests.
          yield* reconcileProviderWrite(
            patch(account.id, `${EVENTS}/${encodeURIComponent(event.id)}?sendUpdates=all`, {
              attendeesOmitted: true,
              attendees: [{ email: me.email, responseStatus: response }],
            }),
            get(account.id, Event, `${EVENTS}/${encodeURIComponent(event.id)}`).pipe(
              Effect.map((current) =>
                current.attendees?.some(
                  (a) =>
                    a.email.toLowerCase() === me.email.toLowerCase() &&
                    a.responseStatus === response,
                )
                  ? current
                  : undefined,
              ),
            ),
          );
          return yield* Effect.void;
        }),
      ),
  };
}
