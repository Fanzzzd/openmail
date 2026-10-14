import { assert, it } from "@effect/vitest";
import { parseCalendar } from "../../calendar/invites.js";
import { fakeHttp } from "../../platform/node/fake-http.js";
import { Effect, Option, Schema } from "effect";
import { GRAPH, account, run } from "../../../test-support/outlook-fixtures.js";
import { PlatformHost } from "../../platform/host.js";
for (const response of ["accepted", "tentative", "declined"] as const) {
  it.live(`uncertain Outlook ${response} response is reconciled without another POST`, () =>
    Effect.gen(function* () {
      const [parsed] = parseCalendar(
        "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:uid\r\nDTSTART:20261001T090000Z\r\nORGANIZER:mailto:alice@example.com\r\nATTENDEE:mailto:me@outlook.com\r\nEND:VEVENT\r\nEND:VCALENDAR",
      );
      assert.ok(parsed);
      const action =
        response === "accepted"
          ? "accept"
          : response === "declined"
            ? "decline"
            : "tentativelyAccept";
      let posts = 0;
      const http = fakeHttp({
        "GET /me/messages/m": {
          json: {
            event: { id: "e", organizer: { emailAddress: { address: "alice@example.com" } } },
          },
        },
        [`POST /me/events/e/${action}`]: () => ({ status: posts++ === 0 ? 503 : 202 }),
        "GET /me/events/e": {
          json: {
            id: "e",
            responseStatus: {
              response: response === "tentative" ? "tentativelyAccepted" : response,
            },
          },
        },
      });
      yield* run(http, (a) => a.respondInvite(account, "m", parsed.invite, response));
      assert.strictEqual(http.calls.filter((c) => c.method === "POST").length, 1);
    }),
  );
}

it.effect("missing Graph settings scope does not block reading mail", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /me/mailFolders/inbox/messageRules": { status: 403, json: { error: "AccessDenied" } },
      "GET /me/messages/m1/$value": { text: "mail still works" },
    });
    yield* run(http, (a) =>
      Effect.gen(function* () {
        assert.strictEqual(
          (yield* a.filters(account).pipe(Effect.flip))._tag,
          "SettingsScopeMissing",
        );
        assert.strictEqual(
          Buffer.from(yield* a.fetchRaw(account, "m1")).toString(),
          "mail still works",
        );
      }),
    );
  }),
);

it.effect("personal Outlook sign-in requests base mail scopes and stays on consumers", () => {
  const http = fakeHttp({
    "GET /me": { json: { mail: account.email, userPrincipalName: account.email } },
  });
  return run(http, (a) => a.connect({ provider: "outlook" }), {
    config: { microsoft: { clientId: "client" } },
    oauth: {
      authorize: (req) =>
        Effect.sync(() => {
          assert.ok(req.scopes.includes("MailboxSettings.ReadWrite"));
          assert.ok(req.scopes.includes("Mail.ReadWrite"));
          for (const scope of ["Calendars.ReadWrite", "Contacts.Read", "People.Read"])
            assert.isFalse(req.scopes.includes(scope));
          assert.ok(req.authUrl.includes("/consumers/"));
          return {
            accessToken: "access-token",
            refreshToken: Option.some("refresh-token"),
            expiresIn: 3600,
          };
        }),
    },
  });
});

it.effect(
  "Graph contacts paginate, people suggestions stay bounded, and foreign links are rejected",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "GET /me/contacts": (url) =>
          url.searchParams.has("$skiptoken")
            ? {
                json: {
                  value: [
                    { displayName: "Second", emailAddresses: [{ address: "second@example.com" }] },
                  ],
                },
              }
            : {
                json: {
                  value: [
                    { displayName: "Saved", emailAddresses: [{ address: "ONE@example.com" }] },
                  ],
                  "@odata.nextLink": `${GRAPH}/me/contacts?$skiptoken=second`,
                },
              },
        "GET /me/contactFolders": { json: { value: [] } },
        "GET /me/people": (url) =>
          url.searchParams.has("$skiptoken")
            ? { json: { value: [{ scoredEmailAddresses: [{ address: "last@example.com" }] }] } }
            : {
                json: {
                  value: [
                    {
                      displayName: "Recent",
                      scoredEmailAddresses: [{ address: "one@example.com" }],
                    },
                  ],
                  "@odata.nextLink": `${GRAPH}/me/people?$skiptoken=last`,
                },
              },
      });
      assert.deepStrictEqual(yield* run(http, (a) => a.contacts(account)), [
        { name: "Saved", address: "one@example.com" },
        { name: "Second", address: "second@example.com" },
      ]);
      assert.strictEqual(http.calls.length, 4);
      const bad = fakeHttp({
        "GET /me/contacts": { json: { value: [], "@odata.nextLink": "https://example.com/steal" } },
      });
      const result = yield* run(bad, (a) => a.contacts(account)).pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(bad.calls.length, 1);
    }),
);

it.effect("Graph responds through accept/tentativelyAccept/decline on the related occurrence", () =>
  Effect.gen(function* () {
    const [parsed] = parseCalendar(
      "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:uid\r\nDTSTART:20261001T090000Z\r\nRECURRENCE-ID:20261001T090000Z\r\nORGANIZER:mailto:alice@example.com\r\nATTENDEE:mailto:me@outlook.com\r\nEND:VEVENT\r\nEND:VCALENDAR",
    );
    assert.ok(parsed);
    const http = fakeHttp({
      "GET /me/messages/m1": (url) => {
        assert.strictEqual(url.searchParams.get("$expand"), "microsoft.graph.eventMessage/event");
        return {
          json: {
            event: {
              id: "occurrence",
              organizer: { emailAddress: { address: "alice@example.com" } },
            },
          },
        };
      },
      "POST /me/events/occurrence/accept": { status: 202 },
      "POST /me/events/occurrence/tentativelyAccept": { status: 202 },
      "POST /me/events/occurrence/decline": { status: 202 },
    });
    for (const response of ["accepted", "tentative", "declined"] as const)
      yield* run(http, (a) => a.respondInvite(account, "m1", parsed.invite, response));
    const writes = http.calls.filter((c) => c.method === "POST");
    assert.deepStrictEqual(
      writes.map((c) => c.url.pathname),
      [
        "/v1.0/me/events/occurrence/accept",
        "/v1.0/me/events/occurrence/tentativelyAccept",
        "/v1.0/me/events/occurrence/decline",
      ],
    );
    for (const c of writes) assert.deepStrictEqual(c.body, { sendResponse: true });
  }),
);

it.effect("Graph missing contacts/calendar grants are typed independently from mail auth", () =>
  Effect.gen(function* () {
    const [parsed] = parseCalendar(
      "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:uid\r\nDTSTART:20261001T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR",
    );
    assert.ok(parsed);
    const forbidden = {
      status: 403,
      json: { error: { code: "ErrorAccessDenied", message: "Access is denied" } },
    };
    const http = fakeHttp({ "GET /me/contacts": forbidden, "GET /me/messages/m1": forbidden });
    for (const feature of ["contacts", "calendar"] as const) {
      const result = yield* run(http, (a) =>
        feature === "contacts"
          ? a.contacts(account).pipe(Effect.asVoid)
          : a.respondInvite(account, "m1", parsed.invite, "accepted"),
      ).pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.strictEqual(result.failure._tag, "FeatureScopeMissing");
        if (result.failure._tag === "FeatureScopeMissing")
          assert.strictEqual(result.failure.feature, feature);
      }
    }
    assert.ok(!http.calls.some((c) => c.method === "POST"));
  }),
);

it.effect(
  "Graph resolves a plain .ics by escaped UID, and does not respond to a cancelled linked event",
  () =>
    Effect.gen(function* () {
      const [parsed] = parseCalendar(
        "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:uid'quoted\r\nDTSTART:20261001T090000Z\r\nORGANIZER:mailto:alice@example.com\r\nATTENDEE:mailto:me@outlook.com\r\nEND:VEVENT\r\nEND:VCALENDAR",
      );
      assert.ok(parsed);
      const event = { id: "e1", organizer: { emailAddress: { address: "alice@example.com" } } };
      const http = fakeHttp({
        "GET /me/messages/m1": {
          json: { event: { ...event, id: "unrelated", iCalUId: "different-uid" } },
        },
        "GET /me/events": (url) => {
          assert.strictEqual(url.searchParams.get("$filter"), "iCalUId eq 'uid''quoted'");
          return { json: { value: [event] } };
        },
        "POST /me/events/e1/decline": { status: 202 },
      });
      yield* run(http, (a) => a.respondInvite(account, "m1", parsed.invite, "declined"));
      assert.ok(http.calls.some((c) => c.url.pathname === "/v1.0/me/events/e1/decline"));
      const cancelled = fakeHttp({
        "GET /me/messages/m1": { json: { event: { ...event, isCancelled: true } } },
      });
      assert.strictEqual(
        (yield* run(cancelled, (a) =>
          a.respondInvite(account, "m1", parsed.invite, "accepted"),
        ).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.ok(!cancelled.calls.some((c) => c.method === "POST"));
    }),
);

it.effect(
  "calendar view preserves local timezone preference and immutable IDs; personal event POST carries no attendees",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "GET /me/calendarView": {
          json: {
            value: [
              {
                id: "busy",
                isAllDay: true,
                start: { dateTime: "2026-10-10T00:00:00", timeZone: "UTC" },
                end: { dateTime: "2026-10-11T00:00:00", timeZone: "UTC" },
              },
            ],
          },
        },
        "POST /me/events": { json: { id: "created" } },
      });
      const event = {
        key: "candidate",
        title: "Train",
        start: { kind: "date", value: "2026-10-10" },
        end: { kind: "date", value: "2026-10-11" },
        location: "Station",
        description: "Ticket",
        recurrence: [],
      } as const;
      yield* run(http, (adapter) =>
        Effect.gen(function* () {
          assert.ok(typeof adapter.calendarEvents === "function");
          assert.ok(typeof adapter.createCalendarEvent === "function");
          assert.deepStrictEqual(
            (yield* adapter.calendarEvents(account, event))[0]?.start,
            event.start,
          );
          yield* adapter.createCalendarEvent(account, event);
        }),
      ).pipe(
        // The adapter takes the zone from PlatformHost, not from the process.
        Effect.provideService(PlatformHost, {
          timeZone: () => "Pacific/Auckland",
          os: "darwin",
          arch: "arm64",
        }),
      );
      const read = http.calls.find((call) => call.url.pathname.endsWith("/calendarView"));
      assert.strictEqual(read?.prefer, `IdType="ImmutableId", outlook.timezone="Pacific/Auckland"`);
      const write = http.calls.find((call) => call.url.pathname.endsWith("/events"));
      assert.deepStrictEqual(write?.body, {
        subject: "Train",
        transactionId: Schema.decodeUnknownSync(Schema.Struct({ transactionId: Schema.String }))(
          write?.body,
        ).transactionId,
        start: {
          dateTime: "2026-10-10T00:00:00",
          timeZone: "Pacific/Auckland",
        },
        end: {
          dateTime: "2026-10-11T00:00:00",
          timeZone: "Pacific/Auckland",
        },
        isAllDay: true,
        location: { displayName: "Station" },
        body: { contentType: "text", content: "Ticket" },
      });
    }),
);

it.effect(
  "Graph contacts include paged root and nested folders, dedupe ids and bound people",
  () => {
    const contact = (id: string, address: string) => ({
      id,
      displayName: id,
      emailAddresses: [{ address }],
    });
    const next = `${GRAPH}/me/contactfolders('root')/contacts?$skiptoken=a%2Fb`;
    const http = fakeHttp({
      "GET /me/contacts": { json: { value: [contact("saved", "saved@example.com")] } },
      "GET /me/contactFolders": (url) => ({
        json: url.searchParams.has("$skiptoken")
          ? { value: [{ id: "other" }] }
          : {
              value: [{ id: "root" }],
              "@odata.nextLink": `${GRAPH}/me/contactfolders?$skiptoken=2`,
            },
      }),
      "GET /me/contactfolders": { json: { value: [{ id: "other" }] } },
      "GET /me/contactFolders/root/contacts": {
        json: { value: [contact("saved", "duplicate@example.com")], "@odata.nextLink": next },
      },
      "GET /me/contactfolders('root')/contacts": {
        json: { value: [contact("root", "root@example.com")] },
      },
      "GET /me/contactFolders/root/childFolders": {
        json: {
          value: [{ id: "child" }],
          "@odata.nextLink": `${GRAPH}/me/contactfolders('root')/childfolders?$skiptoken=2`,
        },
      },
      "GET /me/contactfolders('root')/childfolders": {
        json: { value: [{ id: "child" }, { id: "nested" }] },
      },
      "GET /me/contactFolders/other/contacts": {
        json: { value: [contact("other", "other@example.com")] },
      },
      "GET /me/contactFolders/other/childFolders": { json: { value: [] } },
      "GET /me/contactFolders/child/contacts": {
        json: { value: [contact("child", "child@example.com")] },
      },
      "GET /me/contactFolders/child/childFolders": { json: { value: [{ id: "nested" }] } },
      "GET /me/contactFolders/nested/contacts": {
        json: { value: [contact("nested", "nested@example.com")] },
      },
      "GET /me/contactFolders/nested/childFolders": { json: { value: [] } },
      "GET /me/people": (url) => ({
        json: url.searchParams.has("$skip")
          ? { value: [] }
          : {
              value: [{ id: "recent", scoredEmailAddresses: [{ address: "recent@example.com" }] }],
              "@odata.nextLink": `${GRAPH}/me/people?$skip=250`,
            },
      }),
    });
    return run(http, (adapter) =>
      Effect.gen(function* () {
        const contacts = yield* adapter.contacts(account);
        assert.deepStrictEqual(
          contacts.map((item) => item.address).toSorted(),
          ["saved", "root", "other", "child", "nested", "recent"]
            .map((id) => `${id}@example.com`)
            .toSorted(),
        );
        assert.strictEqual(
          http.calls.filter((call) => call.url.pathname.endsWith("/child/contacts")).length,
          1,
        );
        assert.strictEqual(
          http.calls.filter((call) => call.url.pathname.endsWith("/people")).length,
          1,
        );
        assert.isTrue(http.calls.some((call) => call.url.href === next));
      }),
    );
  },
);
