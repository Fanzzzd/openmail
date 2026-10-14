import { fakeHttp } from "../../platform/node/fake-http.js";
import { assert, it } from "@effect/vitest";
import { parseCalendar } from "../../calendar/invites.js";
import { Effect } from "effect";
import { parseGmailMessage } from "./parse.js";
import { account, run, b64, message } from "../../../test-support/gmail-fixtures.js";
it.live("uncertain Gmail calendar response re-reads the self attendee", () =>
  Effect.gen(function* () {
    const [parsed] = parseCalendar(
      "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:uid@example.com\r\nDTSTART:20261001T090000Z\r\nORGANIZER:mailto:alice@example.com\r\nATTENDEE:mailto:me@gmail.com\r\nEND:VEVENT\r\nEND:VCALENDAR",
    );
    assert.ok(parsed);
    const event = {
      id: "e",
      organizer: { email: "alice@example.com" },
      attendees: [{ email: "me@gmail.com", self: true }],
    };
    let patches = 0;
    const http = fakeHttp({
      "GET /calendar/v3/calendars/primary/events": { json: { items: [event] } },
      "PATCH /calendar/v3/calendars/primary/events/e": () => ({
        status: patches++ === 0 ? 503 : 200,
        json: {},
      }),
      "GET /calendar/v3/calendars/primary/events/e": {
        json: {
          ...event,
          attendees: [{ email: "me@gmail.com", self: true, responseStatus: "accepted" }],
        },
      },
    });
    yield* run(http, (a) => a.respondInvite(account, "m", parsed.invite, "accepted"));
    assert.strictEqual(http.calls.filter((c) => c.method === "PATCH").length, 1);
  }),
);

it.effect(
  "People API reads all connections and otherContacts pages and merges email duplicates",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "GET /v1/people/me/connections": (url) => {
          assert.strictEqual(url.hostname, "people.googleapis.com");
          assert.strictEqual(
            url.searchParams.get("personFields"),
            "names,emailAddresses,organizations",
          );
          return url.searchParams.get("pageToken")
            ? { json: { connections: [{ emailAddresses: [{ value: "second@example.com" }] }] } }
            : {
                json: {
                  connections: [
                    {
                      names: [{ displayName: "Saved name" }],
                      emailAddresses: [{ value: "Person@Example.com" }, { value: "invalid" }],
                    },
                  ],
                  nextPageToken: "page2",
                },
              };
        },
        "GET /v1/otherContacts": (url) => {
          assert.strictEqual(url.searchParams.get("readMask"), "names,emailAddresses");
          return url.searchParams.get("pageToken")
            ? { json: { otherContacts: [{ emailAddresses: [{ value: "last@example.com" }] }] } }
            : {
                json: {
                  otherContacts: [
                    {
                      names: [{ displayName: "Other name" }],
                      emailAddresses: [{ value: "person@example.com" }],
                    },
                  ],
                  nextPageToken: "other2",
                },
              };
        },
      });
      const contacts = yield* run(http, (a) => a.contacts(account));
      assert.deepStrictEqual(contacts, [
        { name: "Saved name", address: "person@example.com" },
        { name: "", address: "second@example.com" },
        { name: "", address: "last@example.com" },
      ]);
      assert.strictEqual(http.calls.length, 4);
    }),
);

it.effect("Calendar responds only for the matched UID and self attendee using sendUpdates", () =>
  Effect.gen(function* () {
    const [parsed] = parseCalendar(
      "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:uid@example.com\r\nDTSTART:20261001T090000Z\r\nORGANIZER:mailto:alice@example.com\r\nATTENDEE:mailto:me@gmail.com\r\nEND:VEVENT\r\nEND:VCALENDAR",
    );
    assert.ok(parsed);
    const http = fakeHttp({
      "GET /calendar/v3/calendars/primary/events": (url) => {
        assert.strictEqual(url.searchParams.get("iCalUID"), "uid@example.com");
        return {
          json: {
            items: [
              {
                id: "e1",
                organizer: { email: "alice@example.com" },
                attendees: [
                  { email: "me@gmail.com", self: true },
                  { email: "other@example.com", responseStatus: "declined" },
                ],
              },
            ],
          },
        };
      },
      "PATCH /calendar/v3/calendars/primary/events/e1": { json: {} },
    });
    for (const response of ["accepted", "tentative", "declined"] as const)
      yield* run(http, (a) => a.respondInvite(account, "m1", parsed.invite, response));
    const writes = http.calls.filter((c) => c.method === "PATCH");
    assert.strictEqual(writes.length, 3);
    for (const [i, response] of ["accepted", "tentative", "declined"].entries()) {
      assert.strictEqual(writes[i]?.url.searchParams.get("sendUpdates"), "all");
      assert.deepStrictEqual(writes[i]?.body, {
        attendeesOmitted: true,
        attendees: [{ email: "me@gmail.com", responseStatus: response }],
      });
    }
  }),
);

it.effect(
  "Calendar targets a moved recurring instance by originalStartTime and leaves other occurrences alone",
  () =>
    Effect.gen(function* () {
      const [parsed] = parseCalendar(
        "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:series\r\nDTSTART:20261002T120000Z\r\nRECURRENCE-ID:20261001T090000Z\r\nORGANIZER:mailto:alice@example.com\r\nATTENDEE:mailto:me@gmail.com\r\nEND:VEVENT\r\nEND:VCALENDAR",
      );
      assert.ok(parsed);
      const http = fakeHttp({
        "GET /calendar/v3/calendars/primary/events": (url) => {
          assert.strictEqual(url.searchParams.get("singleEvents"), "true");
          assert.ok(url.searchParams.has("timeMin"));
          return url.searchParams.has("pageToken")
            ? {
                json: {
                  items: [
                    {
                      id: "target",
                      originalStartTime: { dateTime: "2026-10-01T09:00:00Z" },
                      organizer: { email: "alice@example.com" },
                      attendees: [{ email: "me@gmail.com", self: true }],
                    },
                  ],
                },
              }
            : {
                json: {
                  items: [{ id: "other", originalStartTime: { dateTime: "2026-09-30T09:00:00Z" } }],
                  nextPageToken: "next",
                },
              };
        },
        "PATCH /calendar/v3/calendars/primary/events/target": { json: {} },
      });
      yield* run(http, (a) => a.respondInvite(account, "m1", parsed.invite, "tentative"));
      assert.deepStrictEqual(
        http.calls.filter((c) => c.method === "PATCH").map((c) => c.url.pathname),
        ["/calendar/v3/calendars/primary/events/target"],
      );
    }),
);

it.effect("Calendar absent, cancelled, ambiguous or mismatched events never get patched", () =>
  Effect.gen(function* () {
    const [parsed] = parseCalendar(
      "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:uid\r\nDTSTART:20261001T090000Z\r\nORGANIZER:mailto:alice@example.com\r\nATTENDEE:mailto:me@gmail.com\r\nEND:VEVENT\r\nEND:VCALENDAR",
    );
    assert.ok(parsed);
    const event = {
      id: "e1",
      organizer: { email: "alice@example.com" },
      attendees: [{ email: "me@gmail.com", self: true }],
    };
    for (const items of [
      [],
      [event, { ...event, id: "e2" }],
      [{ ...event, status: "cancelled" }],
      [{ ...event, organizer: { email: "stranger@example.com" } }],
      [{ ...event, attendees: [] }],
    ]) {
      const http = fakeHttp({ "GET /calendar/v3/calendars/primary/events": { json: { items } } });
      assert.strictEqual(
        (yield* run(http, (a) => a.respondInvite(account, "m1", parsed.invite, "accepted")).pipe(
          Effect.result,
        ))._tag,
        "Failure",
      );
      assert.ok(!http.calls.some((c) => c.method === "PATCH"));
    }
  }),
);

it("Gmail detects calendar alternatives without a filename", () => {
  const raw = message("invite", ["INBOX"]);
  const parsed = parseGmailMessage({
    ...raw,
    payload: {
      ...raw.payload,
      parts: [{ mimeType: "text/calendar", body: { size: 10, data: b64("BEGIN:VCALENDAR") } }],
    },
  });
  assert.strictEqual(parsed.hasCalendar, true);
});

it.effect("missing otherContacts scope still returns all saved-contact pages", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /v1/people/me/connections": (url) =>
        url.searchParams.has("pageToken")
          ? { json: { connections: [{ emailAddresses: [{ value: "second@example.com" }] }] } }
          : {
              json: {
                connections: [
                  {
                    names: [{ displayName: "Saved" }],
                    emailAddresses: [{ value: "saved@example.com" }],
                  },
                ],
                nextPageToken: "next",
              },
            },
      "GET /v1/otherContacts": { status: 403, json: { error: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" } },
    });
    assert.deepStrictEqual(yield* run(http, (a) => a.contacts(account)), [
      { name: "Saved", address: "saved@example.com" },
      { name: "", address: "second@example.com" },
    ]);
    assert.strictEqual(http.calls.length, 3);
  }),
);

it.effect(
  "floating recurrence ids match offset wall times; malformed zoned instances do not crash lookup",
  () =>
    Effect.gen(function* () {
      const source =
        "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:series\r\nDTSTART:20261001T090000\r\nRECURRENCE-ID:20261001T090000\r\nORGANIZER:mailto:alice@example.com\r\nATTENDEE:mailto:alias@googlemail.com\r\nEND:VEVENT\r\nEND:VCALENDAR";
      const [floating] = parseCalendar(source);
      const [zoned] = parseCalendar(source.replaceAll(":20261001T090000", ":20261001T090000Z"));
      assert.ok(floating);
      assert.ok(zoned);
      for (const [invite, dateTime] of [
        [floating.invite, "2026-10-01T09:00:00.000-04:00"],
        [zoned.invite, "2026-10-01T09:00:00Z"],
      ] as const) {
        const http = fakeHttp({
          "GET /calendar/v3/calendars/primary/events": {
            json: {
              items: [
                {
                  id: "bad-date",
                  originalStartTime: { dateTime: "broken", timeZone: "Unknown/Zone" },
                },
                {
                  id: "bad-zone",
                  originalStartTime: { dateTime: "2026-10-01T09:00:00", timeZone: "Unknown/Zone" },
                },
                {
                  id: "target",
                  originalStartTime: { dateTime },
                  organizer: { email: "alice@example.com" },
                  attendees: [{ email: "alias@googlemail.com", self: true }],
                },
              ],
            },
          },
          "PATCH /calendar/v3/calendars/primary/events/target": { json: {} },
        });
        // A floating id with two equal wall times remains ambiguous and must not
        // update either event. A zoned id ignores the malformed competitor.
        const result = yield* run(http, (a) =>
          a.respondInvite(account, "m1", invite, "accepted"),
        ).pipe(Effect.result);
        if (invite.recurrenceId?.kind === "floating") assert.strictEqual(result._tag, "Failure");
        else {
          assert.strictEqual(result._tag, "Success");
          assert.deepStrictEqual(http.calls.at(-1)?.body, {
            attendeesOmitted: true,
            attendees: [{ email: "alias@googlemail.com", responseStatus: "accepted" }],
          });
        }
      }
      const http = fakeHttp({
        "GET /calendar/v3/calendars/primary/events": {
          json: {
            items: [
              {
                id: "target",
                originalStartTime: { dateTime: "2026-10-01T09:00:00.000-04:00" },
                organizer: { email: "alice@example.com" },
                attendees: [{ email: "alias@googlemail.com", self: true }],
              },
            ],
          },
        },
        "PATCH /calendar/v3/calendars/primary/events/target": { json: {} },
      });
      yield* run(http, (a) => a.respondInvite(account, "m1", floating.invite, "tentative"));
      assert.deepStrictEqual(http.calls.at(-1)?.body, {
        attendeesOmitted: true,
        attendees: [{ email: "alias@googlemail.com", responseStatus: "tentative" }],
      });
    }),
);

it.effect(
  "Google saved contacts join paginated group memberships and saved photos without extra scopes",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "GET /v1/people/me/connections": (url) => {
          assert.strictEqual(
            url.searchParams.get("personFields"),
            "names,emailAddresses,organizations,photos,memberships",
          );
          assert.strictEqual(url.searchParams.get("sources"), "READ_SOURCE_TYPE_CONTACT");
          return url.searchParams.get("pageToken")
            ? {
                json: {
                  connections: [
                    {
                      names: [{ displayName: "Bob" }],
                      emailAddresses: [{ value: "bob@example.com" }],
                      photos: [{ url: "https://photos.example.com/default", default: true }],
                      memberships: [
                        {
                          contactGroupMembership: {
                            contactGroupResourceName: "contactGroups/team",
                          },
                        },
                      ],
                    },
                  ],
                },
              }
            : {
                json: {
                  connections: [
                    {
                      names: [{ displayName: "Alice" }],
                      emailAddresses: [
                        { value: "Alice@example.com" },
                        { value: "second@example.com" },
                      ],
                      photos: [
                        { url: "https://photos.example.com/alice", metadata: { primary: true } },
                      ],
                      memberships: [
                        {
                          contactGroupMembership: {
                            contactGroupResourceName: "contactGroups/team",
                          },
                        },
                      ],
                    },
                  ],
                  nextPageToken: "next",
                },
              };
        },
        "GET /v1/otherContacts": {
          json: { otherContacts: [{ emailAddresses: [{ value: "other@example.com" }] }] },
        },
        "GET /v1/contactGroups": (url) => {
          assert.strictEqual(url.searchParams.get("groupFields"), "name,groupType");
          return url.searchParams.get("pageToken")
            ? {
                json: {
                  contactGroups: [
                    {
                      resourceName: "contactGroups/empty",
                      name: "Empty",
                      groupType: "USER_CONTACT_GROUP",
                    },
                  ],
                },
              }
            : {
                json: {
                  contactGroups: [
                    {
                      resourceName: "contactGroups/team",
                      name: "Team",
                      groupType: "USER_CONTACT_GROUP",
                    },
                    {
                      resourceName: "contactGroups/myContacts",
                      name: "My contacts",
                      groupType: "SYSTEM_CONTACT_GROUP",
                    },
                  ],
                  nextPageToken: "next",
                },
              };
        },
      });
      const snapshot = yield* run(http, (adapter) => {
        assert.ok("contactSnapshot" in adapter);
        if (!adapter.contactSnapshot) throw new Error("Missing contact snapshots");
        return adapter.contactSnapshot(account);
      });
      assert.deepStrictEqual(snapshot.groups, [
        {
          accountId: account.id,
          id: "contactGroups/team",
          name: "Team",
          members: [
            { name: "Alice", address: "alice@example.com" },
            { name: "Alice", address: "second@example.com" },
            { name: "Bob", address: "bob@example.com" },
          ],
        },
      ]);
      assert.deepStrictEqual(snapshot.photos, [
        { address: "alice@example.com", url: "https://photos.example.com/alice" },
        { address: "second@example.com", url: "https://photos.example.com/alice" },
      ]);
      assert.strictEqual(snapshot.contacts.length, 4);
      assert.strictEqual(http.calls.length, 5);
    }),
);

it.effect("repeated group pages fail rather than committing an incomplete snapshot", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /v1/people/me/connections": { json: { connections: [] } },
      "GET /v1/otherContacts": { json: { otherContacts: [] } },
      "GET /v1/contactGroups": { json: { contactGroups: [], nextPageToken: "repeat" } },
    });
    const result = yield* run(http, (adapter) => {
      assert.ok("contactSnapshot" in adapter);
      if (!adapter.contactSnapshot) throw new Error("Missing contact snapshots");
      return adapter.contactSnapshot(account);
    }).pipe(Effect.result);
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "InvalidInput");
  }),
);
