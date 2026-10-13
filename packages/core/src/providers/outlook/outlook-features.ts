import { graphPageLink } from "./graph-pagination.js";
import { reconcileProviderWrite } from "../provider-write.js";
import { Effect, Schema } from "effect";
import type { Account, Address } from "../../domain/domain.js";
import type { CalendarInvite, InviteResponse } from "../../calendar/calendar.js";
import { InvalidInput } from "../../domain/errors.js";
import { mergeContacts } from "../../contacts/contacts.js";
import { featureRequest } from "../provider-features.js";

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
  responseStatus: Schema.optionalKey(Schema.Struct({ response: Schema.String })),
});
const Related = Schema.Struct({ event: Schema.optionalKey(Schema.NullOr(Event)) });
const Events = Schema.Struct({ value: Schema.Array(Event) });

const ContactFolders = Schema.Struct({
  value: Schema.Array(Schema.Struct({ id: Schema.String })),
  "@odata.nextLink": Schema.optionalKey(Schema.String),
});

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
          const contactIds = new Set<string>();
          const readPages = <A>(
            schema: Schema.Decoder<{
              readonly value: readonly A[];
              readonly "@odata.nextLink"?: string;
            }>,
            base: string,
            query: string,
          ) =>
            Effect.gen(function* () {
              const values: A[] = [];
              let path = `${base}?${query}`;
              const seen = new Set<string>();
              while (path) {
                if (seen.has(path))
                  return yield* new InvalidInput({ message: "Contact pagination repeated a page" });
                seen.add(path);
                const page = yield* get(account.id, schema, path);
                values.push(...page.value);
                const next = page["@odata.nextLink"];
                path = next
                  ? yield* Effect.try({
                      try: () => graphPageLink(next, base),
                      catch: () => new InvalidInput({ message: "Invalid contact pagination link" }),
                    })
                  : "";
              }
              return values;
            });
          const readContacts = (base: string) =>
            Effect.gen(function* () {
              const page = yield* readPages(
                Contacts,
                base,
                "$select=id,displayName,emailAddresses,companyName&$top=250",
              );
              for (const person of page) {
                if (person.id && contactIds.has(person.id)) continue;
                if (person.id) contactIds.add(person.id);
                for (const email of person.emailAddresses ?? [])
                  if (email.address)
                    contacts.push({
                      address: email.address,
                      name: person.displayName ?? email.name ?? "",
                      ...(person.companyName ? { company: person.companyName } : {}),
                      ...(person.id ? { contactKey: `contacts:${person.id}` } : {}),
                    });
              }
            });
          yield* readContacts("/me/contacts");
          const pending = yield* readPages(
            ContactFolders,
            "/me/contactFolders",
            "$select=id&$top=100",
          );
          const folders = new Set<string>();
          for (let index = 0; index < pending.length; index++) {
            const folder = pending[index];
            if (!folder || folders.has(folder.id)) continue;
            folders.add(folder.id);
            const base = `/me/contactFolders/${encodeURIComponent(folder.id)}`;
            yield* readContacts(`${base}/contacts`);
            pending.push(
              ...(yield* readPages(ContactFolders, `${base}/childFolders`, "$select=id&$top=100")),
            );
          }
          // People is a relevance-ranked suggestion feed, limited to the first 250, not a contact inventory.
          const people = yield* get(
            account.id,
            People,
            "/me/people?$select=id,displayName,scoredEmailAddresses&$top=250",
          );
          for (const person of people.value.slice(0, 250))
            for (const email of person.scoredEmailAddresses ?? [])
              if (email.address)
                contacts.push({
                  address: email.address,
                  name: person.displayName ?? email.name ?? "",
                  ...(person.id ? { contactKey: `people:${person.id}` } : {}),
                });
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
              `/me/events?$filter=${filter}&$select=id,isCancelled,isOrganizer,organizer,responseStatus&$top=2`,
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
          const desired = response === "tentative" ? "tentativelyAccepted" : response;
          if (event.responseStatus?.response === desired) return yield* Effect.void;
          const path = `/me/events/${encodeURIComponent(event.id)}`;
          yield* reconcileProviderWrite(
            write(account.id, "POST", `${path}/${action}`, { sendResponse: true }),
            get(account.id, Event, `${path}?$select=id,responseStatus`).pipe(
              Effect.map((current) =>
                current.responseStatus?.response === desired ? current : undefined,
              ),
            ),
          );
          return yield* Effect.void;
        }),
      ),
  };
}
