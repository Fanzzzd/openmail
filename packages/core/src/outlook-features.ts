import { Effect, Schema } from "effect";
import type { Account, Address } from "./domain.js";
import type { CalendarInvite, InviteResponse } from "./calendar.js";
import { InvalidInput } from "./errors.js";
import { mergeContacts } from "./contacts.js";
import { featureRequest } from "./provider-features.js";

const Email = Schema.Struct({
  address: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
});
const Contact = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  displayName: Schema.optionalKey(Schema.NullOr(Schema.String)),
  emailAddresses: Schema.optionalKey(Schema.Array(Email)),
  companyName: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const Person = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  displayName: Schema.optionalKey(Schema.NullOr(Schema.String)),
  scoredEmailAddresses: Schema.optionalKey(Schema.Array(Email)),
});
const Contacts = Schema.Struct({
  value: Schema.Array(Contact),
  "@odata.nextLink": Schema.optionalKey(Schema.String),
});
const People = Schema.Struct({
  value: Schema.Array(Person),
  "@odata.nextLink": Schema.optionalKey(Schema.String),
});
const Event = Schema.Struct({
  id: Schema.String,
  iCalUId: Schema.optionalKey(Schema.String),
  isCancelled: Schema.optionalKey(Schema.Boolean),
  isOrganizer: Schema.optionalKey(Schema.Boolean),
  organizer: Schema.optionalKey(Schema.Struct({ emailAddress: Email })),
});
const Related = Schema.Struct({ event: Schema.optionalKey(Schema.NullOr(Event)) });
const Events = Schema.Struct({ value: Schema.Array(Event) });

/** Only Microsoft's own /me pagination links may receive the bearer token. */
function nextPath(url: string, source: string): string {
  const parsed = new URL(url, "https://graph.microsoft.com/v1.0/");
  if (parsed.origin !== "https://graph.microsoft.com" || parsed.pathname !== `/v1.0/me/${source}`)
    throw new InvalidInput({ message: "Invalid contact pagination link" });
  return `${parsed.pathname.slice("/v1.0".length)}${parsed.search}`;
}

export function makeOutlookFeatures<
  E extends {
    readonly _tag: string;
    readonly status?: number | undefined;
    readonly body?: string | undefined;
    readonly message?: string | undefined;
  },
>(
  get: <A>(id: string, schema: Schema.Decoder<A>, path: string) => Effect.Effect<A, E>,
  write: (
    id: string,
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ) => Effect.Effect<unknown, E>,
) {
  return {
    contacts: (account: Account) =>
      featureRequest(
        account,
        "contacts",
        Effect.gen(function* () {
          const contacts: Address[] = [];
          for (const source of ["contacts", "people"] as const) {
            const select =
              source === "contacts"
                ? "id,displayName,emailAddresses,companyName"
                : "id,displayName,scoredEmailAddresses";
            let path = `/me/${source}?$select=${select}&$top=250`;
            const seen = new Set<string>();
            while (path) {
              if (seen.has(path))
                return yield* new InvalidInput({ message: "Contact pagination repeated a page" });
              seen.add(path);
              const page =
                source === "contacts"
                  ? yield* get(account.id, Contacts, path)
                  : yield* get(account.id, People, path);
              for (const person of page.value) {
                const emails =
                  "emailAddresses" in person
                    ? person.emailAddresses
                    : "scoredEmailAddresses" in person
                      ? person.scoredEmailAddresses
                      : [];
                for (const email of emails ?? [])
                  if (email.address)
                    contacts.push({
                      address: email.address,
                      name: person.displayName ?? email.name ?? "",
                      ...("companyName" in person && person.companyName
                        ? { company: person.companyName }
                        : {}),
                      ...(person.id ? { contactKey: `${source}:${person.id}` } : {}),
                    });
              }
              path = page["@odata.nextLink"]
                ? yield* Effect.try({
                    try: () => nextPath(page["@odata.nextLink"] ?? "", source),
                    catch: () => new InvalidInput({ message: "Invalid contact pagination link" }),
                  })
                : "";
            }
          }
          return mergeContacts(contacts);
        }),
      ),
    respondInvite: (
      account: Account,
      providerId: string,
      invite: CalendarInvite,
      response: InviteResponse,
    ) =>
      featureRequest(
        account,
        "calendar",
        Effect.gen(function* () {
          // Outlook's eventMessage relationship identifies the exact recurring occurrence.
          const related = yield* get(
            account.id,
            Related,
            `/me/messages/${encodeURIComponent(providerId)}?$expand=microsoft.graph.eventMessage/event`,
          ).pipe(
            Effect.catchIf(
              (e) => e.status === 404,
              () => Effect.succeed({ event: null }),
            ),
          );
          let event = related.event;
          // A message may also contain unrelated .ics files. Never apply its linked
          // single event's response to a different attachment chosen by the user.
          if (!invite.recurrenceId && event?.iCalUId && event.iCalUId !== invite.uid) event = null;
          if (!event) {
            // A plain .ics attachment is not an eventMessage. Resolve its calendar UID.
            if (invite.recurrenceId)
              return yield* new InvalidInput({
                message: "Open this invitation in your calendar to add it before responding",
              });
            const filter = encodeURIComponent(`iCalUId eq '${invite.uid.replaceAll("'", "''")}'`);
            const page = yield* get(
              account.id,
              Events,
              `/me/events?$filter=${filter}&$select=id,isCancelled,isOrganizer,organizer&$top=2`,
            );
            if (page.value.length === 1) event = page.value[0];
          }
          if (!event)
            return yield* new InvalidInput({
              message: "Open this invitation in your calendar to add it before responding",
            });
          if (event.isCancelled)
            return yield* new InvalidInput({ message: "This meeting has been cancelled" });
          if (
            event.isOrganizer ||
            event.organizer?.emailAddress.address?.toLowerCase() !==
              invite.organizer?.address.toLowerCase()
          )
            return yield* new InvalidInput({
              message: "The calendar organizer does not match this invitation",
            });
          const action = {
            accepted: "accept",
            tentative: "tentativelyAccept",
            declined: "decline",
          }[response];
          yield* write(account.id, "POST", `/me/events/${encodeURIComponent(event.id)}/${action}`, {
            sendResponse: true,
          });
          return yield* Effect.void;
        }),
      ),
  };
}
