import { assert, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { StoreLive } from "./store.js";
import { MemoryPlatform } from "./platform/node/platform-memory.js";
import { Mailbox } from "./mailbox.js";
import { Store } from "./services.js";
import { EMPTY_FILTER } from "./organization.js";
import { readOnlyAdapter, READ_ONLY_MESSAGE } from "./read-only.js";
import { fakeServer, TestMailbox } from "./platform/node/testing.js";
import { makeFakeProvider } from "./platform/node/fake-provider.js";
import { calendarEventIcs, detectMailEvents } from "./calendar.js";
import { parseCalendar } from "./invites.js";
import { filterQuery, matchesSearch, parseSearchQuery, gmailSearch } from "./search.js";
import type { IncomingMessage, OutgoingMessage } from "./domain.js";

const message = (id: string, bodyText = "alpha one beta"): IncomingMessage => ({
  providerId: id,
  threadId: id,
  subject: "Travel",
  from: { name: "Sender", address: "sender@example.com" },
  to: [],
  cc: [],
  date: 1,
  snippet: "",
  bodyText,
  bodyHtml: "",
  labels: ["INBOX"],
  attachments: [],
  isUnread: false,
  isStarred: false,
});
const outgoing: OutgoingMessage = {
  to: [{ name: "", address: "to@example.com" }],
  cc: [],
  bcc: [],
  subject: "Local draft",
  text: "Text",
  attachments: [],
};
const actor = { kind: "user", surface: "app" } as const;

it.effect(
  "read-only session retains old operations and drafts, permits local edits and refuses sending",
  () => {
    const server = fakeServer("me@gmail.com", [message("one")]);
    return Effect.gen(function* () {
      const mailbox = yield* Mailbox,
        store = yield* Store;
      const account = yield* mailbox.connect({ provider: "gmail" });
      yield* mailbox.sync();
      yield* store.enqueueOp(account.id, "one", { kind: "star", value: true });
      const before = yield* store.listPendingOps;
      yield* mailbox.sync();
      assert.deepStrictEqual(yield* store.listPendingOps, before);
      yield* mailbox.perform(
        { kind: "modify", threads: [`${account.id}/one`], op: { kind: "read", value: false } },
        actor,
      );
      assert.strictEqual((yield* store.getMessage(`${account.id}/one`)).isUnread, true);
      yield* mailbox.saveDraft({ id: "local", accountId: account.id, message: outgoing });
      assert.strictEqual(
        Option.getOrThrow(yield* store.getDraft("local")).message.subject,
        "Local draft",
      );
      assert.strictEqual(Option.getOrThrow(yield* store.getDraft("local")).remote, null);
      assert.strictEqual(server.draftLog.length, 0);
      assert.strictEqual(server.pushed.length, 0);
      const sent = yield* mailbox
        .perform({ kind: "send", accountId: account.id, message: outgoing }, actor)
        .pipe(Effect.result);
      assert.strictEqual(sent._tag, "Failure");
      if (sent._tag === "Failure") assert.strictEqual(sent.failure.message, READ_ONLY_MESSAGE);
      assert.strictEqual(
        (yield* mailbox
          .queueSend({ id: "local", accountId: account.id, message: outgoing }, 1)
          .pipe(Effect.result))._tag,
        "Failure",
      );
      yield* store.putQueuedSend({
        id: "old-send",
        accountId: account.id,
        message: outgoing,
        due: 0,
        status: "waiting",
      });
      yield* mailbox.flushQueuedSends();
      assert.strictEqual((yield* store.queuedSends)[0]?.status, "waiting");
      assert.strictEqual(server.sent.length, 0);
      assert.ok((yield* store.listPendingOps).length >= 3);
    }).pipe(
      Effect.provide(
        TestMailbox({ gmail: server }).pipe(
          Layer.provide(
            ConfigProvider.layer(ConfigProvider.fromEnvRecord({ OPENMAIL_READ_ONLY: "1" })),
          ),
        ),
      ),
    );
  },
);

it.effect(
  "read-only provider boundary refuses folder, draft, filter, vacation and calendar mutations",
  () => {
    const server = fakeServer("me@gmail.com");
    const adapter = readOnlyAdapter(makeFakeProvider(server));
    const account = {
      id: "gmail:me@gmail.com",
      provider: "gmail",
      email: "me@gmail.com",
      color: null,
      profileId: null,
      needsReauth: false,
      createdAt: 0,
      lastSyncedAt: null,
      lastSyncError: null,
    } as const;
    const event = detectMailEvents({ subject: "Travel", bodyText: "2026-10-03 09:00 to 10:00" })[0];
    assert.ok(event);
    return Effect.gen(function* () {
      const effects: Effect.Effect<unknown, { readonly message: string }>[] = [
        adapter.push(account, "one", { kind: "archive" }),
        adapter.send(account, outgoing, Option.none()),
        adapter.deleteDraft(account, { draftId: "draft", messageId: null }),
        adapter.markReadBatch(account, ["one"]),
        adapter.permanentlyDelete(account, ["one"], "trash"),
        adapter.changeLabel(account, { kind: "parent", id: "Label_one", parentId: null }),
        adapter.createFilter(account, EMPTY_FILTER),
        adapter.updateFilter(account, "one", EMPTY_FILTER),
        adapter.deleteFilter(account, "one"),
        adapter.setVacation(account, server.vacation),
        ...(adapter.createCalendarEvent ? [adapter.createCalendarEvent(account, event)] : []),
      ];
      for (const effect of effects) {
        const result = yield* effect.pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure")
          assert.strictEqual(result.failure.message, READ_ONLY_MESSAGE);
      }
      assert.deepStrictEqual(server.pushed, []);
      assert.deepStrictEqual(server.sent, []);
      assert.deepStrictEqual(server.deleted, []);
      assert.deepStrictEqual(server.filters, []);
      assert.deepStrictEqual(server.createdEvents, []);
    });
  },
);

it.effect(
  "local Gmail header, user label and AROUND operators agree with SQLite and preserve rowid",
  () => {
    const fixtures = [
      message("forward", "alpha one beta"),
      message("reverse", "beta alpha"),
      message("far", "alpha one two beta"),
      message("unknown", "nothing"),
    ];
    fixtures[0] = {
      ...message("forward", "alpha one beta"),
      headers: [
        { name: "List-ID", value: "News <list.example.com>" },
        { name: "delivered-to", value: "alias@example.com" },
        { name: "x-test", value: "100%_literal" },
      ],
      labels: ["INBOX", "Label_one"],
    };
    const server = fakeServer("me@gmail.com", fixtures);
    server.labels = [{ id: "Label_one", name: "User label", color: null }];
    return Effect.gen(function* () {
      const mailbox = yield* Mailbox,
        store = yield* Store;
      const account = yield* mailbox.connect({ provider: "gmail" });
      yield* mailbox.sync();
      const searches: [string, string[]][] = [
        ["alpha AROUND 1 beta", ["forward", "reverse"]],
        ["alpha AROUND 0 beta", ["reverse"]],
        ['"alpha AROUND 1 beta"', ["forward"]],
        ["(alpha AROUND 0 beta) OR list:list.example.com", ["forward", "reverse"]],
        ["-(alpha AROUND 0 beta)", ["far", "forward", "unknown"]],
        ["list:list.example.com", ["forward"]],
        ["deliveredto:alias@example.com", ["forward"]],
        ['header:"x-test:100%_literal"', ["forward"]],
        ["header:x-test", ["forward"]],
        ["has:userlabels", ["forward"]],
        ["has:nouserlabels", ["far", "reverse", "unknown"]],
        ["list:list.example.com deliveredto:alias@example.com", ["forward"]],
      ];
      for (const [search, expected] of searches) {
        const ids = (yield* store.listThreads({ search, flat: true }))
          .map((m) => m.id.slice(account.id.length + 1))
          .toSorted();
        assert.deepStrictEqual(ids, expected, search);
        assert.strictEqual(
          yield* store.countThreads({ search, flat: true }),
          expected.length,
          search,
        );
        assert.deepStrictEqual(
          fixtures
            .filter((m) => matchesSearch(m, { search }, server.labels))
            .map((m) => m.providerId)
            .toSorted(),
          expected,
          search,
        );
      }
      yield* store.upsertMessage(account.id, {
        ...message("forward"),
        providerId: "forward",
        threadId: "forward",
        headers: [{ name: "x-test", value: "updated" }],
      });
      assert.deepStrictEqual((yield* store.getMessage(`${account.id}/forward`)).headers, [
        { name: "x-test", value: "updated" },
      ]);
    }).pipe(Effect.provide(TestMailbox({ gmail: server })));
  },
);

it("structured JSON-LD flights, train microdata and reservations export inert, escaped ICS", () => {
  const flight = {
    "@context": "https://remote.invalid/context",
    "@type": "FlightReservation",
    reservationFor: {
      "@type": "Flight",
      flightNumber: "UA110",
      departureTime: "2026-10-03T20:15:00-08:00",
      arrivalTime: "2026-10-04T06:30:00-05:00",
      departureAirport: { name: "SFO" },
      arrivalAirport: { name: "JFK" },
    },
  };
  const events = detectMailEvents({
    subject: "Reservation",
    bodyText: "",
    bodyHtml: `<script type="application/ld+json">${JSON.stringify(flight)}</script><img src="https://remote.invalid/image">`,
  });
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0]?.title, "UA110");
  assert.strictEqual(events[0]?.location, "SFO → JFK");
  const train = detectMailEvents({
    subject: "Train",
    bodyText: "",
    bodyHtml:
      '<div itemscope itemtype="http://schema.org/TrainReservation"><div itemprop="reservationFor" itemscope itemtype="http://schema.org/TrainTrip"><meta itemprop="trainNumber" content="G123"><time itemprop="departureTime" datetime="2026-10-03T09:00:00+08:00"></time><meta itemprop="arrivalTime" content="2026-10-03T11:00:00+08:00"><div itemprop="departureStation" itemscope itemtype="https://schema.org/TrainStation"><span itemprop="name">南站</span></div></div></div>',
  });
  assert.strictEqual(train[0]?.title, "G123");
  const event = events[0];
  assert.ok(event);
  const ics = calendarEventIcs({
    ...event,
    title: "Trip, test\r\nLOCATION:injected",
    description: "行程".repeat(80),
  });
  assert.ok(!ics.includes("\r\nLOCATION:injected"));
  const parsed = parseCalendar(ics, true)[0]?.invite;
  assert.strictEqual(parsed?.title, "Trip, test\nLOCATION:injected");
  assert.strictEqual(
    parsed?.start?.kind === "zoned" ? parsed.start.timestamp : 0,
    Date.parse("2026-10-04T04:15:00Z"),
  );
  assert.strictEqual(parsed?.description, "行程".repeat(80));
  assert.ok(ics.split("\r\n").every((line) => new TextEncoder().encode(line).length <= 75));
  for (const reservation of [
    {
      "@type": "FoodEstablishmentReservation",
      startDate: "2026-10-03T18:00:00",
      endDate: "2026-10-03T20:00:00",
    },
    { "@type": "LodgingReservation", checkinTime: "2026-10-03", checkoutTime: "2026-10-05" },
  ])
    assert.strictEqual(
      detectMailEvents({
        subject: "Stay",
        bodyText: "",
        bodyHtml: `<script type="application/ld+json">${JSON.stringify(reservation)}</script>`,
      }).length,
      1,
    );
  for (const invalid of [
    { ...flight, reservationStatus: "https://schema.org/ReservationCancelled" },
    { "@type": "Event", startDate: "2026-02-30", endDate: "2026-03-01" },
    { "@type": "Event", startDate: "2026-10-03T12:00", endDate: "2026-10-03T11:00" },
  ])
    assert.deepStrictEqual(
      detectMailEvents({
        subject: "",
        bodyText: "",
        bodyHtml: `<script type="application/ld+json">${JSON.stringify(invalid)}</script>`,
      }),
      [],
    );
  assert.deepStrictEqual(
    detectMailEvents({
      subject: "",
      bodyText: "",
      bodyHtml: '<script type="application/ld+json">{broken</script>',
    }),
    [],
  );
});

it.effect("structured event creation requires app confirmation and never fetches raw mail", () => {
  const server = fakeServer("me@gmail.com", [
    {
      ...message("one"),
      bodyText: "",
      bodyHtml:
        '<script type="application/ld+json">{"@type":"Event","name":"Dinner","startDate":"2026-10-03T18:00:00Z","endDate":"2026-10-03T20:00:00Z"}</script>',
    },
  ]);
  return Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    const account = yield* mailbox.connect({ provider: "gmail" });
    yield* mailbox.sync();
    const id = `${account.id}/one`,
      event = (yield* mailbox.detectedEvents(id))[0];
    assert.ok(event);
    assert.strictEqual(
      (yield* mailbox
        .createCalendarEvent(id, event.key, { kind: "agent", name: "test", surface: "mcp" })
        .pipe(Effect.result))._tag,
      "Failure",
    );
    yield* mailbox.createCalendarEvent(id, event.key, actor);
    assert.strictEqual(server.createdEvents.length, 1);
    assert.deepStrictEqual(server.rawFetched, []);
  }).pipe(Effect.provide(TestMailbox({ gmail: server })));
});

it("rule exception preview excludes sender, To/CC, subject and attachment independently", () => {
  const fixtures = [
    message("keep"),
    { ...message("sender"), from: { name: "", address: "except@example.com" } },
    { ...message("cc"), cc: [{ name: "", address: "except@example.com" }] },
    { ...message("subject"), subject: "Skip" },
    { ...message("attachment"), attachments: [{ filename: "a", mimeType: "text/plain", size: 1 }] },
  ];
  const query = filterQuery({
    ...EMPTY_FILTER.criteria,
    exceptFrom: "except@",
    exceptTo: "except@",
    exceptSubject: "Skip",
    exceptAttachment: true,
  });
  assert.deepStrictEqual(
    fixtures.filter((m) => matchesSearch(m, query)).map((m) => m.providerId),
    ["keep"],
  );
  assert.strictEqual(
    parseSearchQuery({ search: 'header:"x-test:100%_literal"' }).criteria?.header?.value,
    "100%_literal",
  );
});

it.effect(
  "AROUND degrades to AND without writes during indexing, then checks phrases within each chunk",
  () =>
    Effect.gen(function* () {
      const store = yield* Store,
        sql = yield* SqlClient.SqlClient;
      const account = yield* store.upsertAccount("gmail", "old@example.com");
      for (const [id, body] of [
        ["body", "red fox near blue bird"],
        ["ocr", "unrelated"],
        ["split", "unrelated"],
      ]) {
        yield* store.upsertMessage(account.id, message(id ?? "", body));
      }
      for (const [id, text] of [
        ["ocr", "red fox near blue bird"],
        ["split", "red fox"],
        ["split", "blue bird"],
      ]) {
        yield* sql`INSERT INTO derived_chunks(message_id,text,provenance_json) VALUES(${`${account.id}/${id}`},${text},'{}')`;
      }
      yield* sql`INSERT INTO messages_words(messages_words) VALUES('delete-all')`;
      yield* sql`INSERT INTO derived_words(derived_words) VALUES('delete-all')`;
      yield* sql`DELETE FROM search_word_rows`;
      yield* sql`UPDATE search_word_index SET cursor=0,end_rowid=CASE WHEN kind='messages' THEN (SELECT MAX(rowid) FROM messages) ELSE (SELECT MAX(id) FROM derived_chunks) END,ready=0`;
      const before = yield* sql`SELECT * FROM search_word_index`;
      assert.strictEqual(
        yield* store.countThreads({ search: '"red fox" AROUND 0 "blue bird"', flat: true }),
        2,
      );
      yield* store.listThreads({ search: '"red fox" AROUND 0 "blue bird"', flat: true });
      assert.deepStrictEqual(yield* sql`SELECT * FROM search_word_index`, before);
      while (!(yield* store.backfillWordIndex(500)).ready) {
        /* Background indexer equivalent. */
      }
      for (const [query, expected] of [
        ['"red fox" AROUND 1 "blue bird"', ["body", "ocr"]],
        ['in:attachment "red fox" AROUND 1 "blue bird"', ["ocr"]],
        ['-("red fox" AROUND 1 "blue bird")', ["split"]],
        ['"red fox AROUND 1 blue bird"', ["body", "ocr"]],
      ] as const) {
        assert.deepStrictEqual(
          (yield* store.listThreads({ search: query, flat: true }))
            .map((m) => m.id.slice(account.id.length + 1))
            .toSorted(),
          [...expected],
          query,
        );
      }
      assert.strictEqual((yield* store.wordIndexReady).messages, true);
      assert.ok(
        gmailSearch({ search: "(alpha AROUND 2 beta) OR list:news@example.com" }).includes(
          '"alpha" AROUND 2 "beta"',
        ),
      );
    }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
);

it("structured missing ends are estimated, date-only endDate is inclusive and unusable data falls back", () => {
  const parse = (data: unknown, bodyText = "") =>
    detectMailEvents({
      subject: "Trip",
      bodyText,
      bodyHtml: `<script type="application/ld+json">${JSON.stringify(data)}</script>`,
    });
  const food = parse({
    "@type": "FoodEstablishmentReservation",
    startTime: "2026-10-03T22:30:00",
  })[0];
  assert.ok(food);
  assert.strictEqual(food.endEstimated, true);
  assert.deepStrictEqual(food.end, { kind: "floating", value: "2026-10-04T00:30:00" });
  const flight = parse({
    "@type": "FlightReservation",
    reservationFor: { "@type": "Flight", departureTime: "2026-10-03T09:00:00+08:00" },
  })[0];
  assert.ok(flight);
  assert.strictEqual(flight.endEstimated, true);
  assert.strictEqual(
    flight.end.kind === "zoned" ? flight.end.timestamp : 0,
    Date.parse("2026-10-03T02:00:00Z"),
  );
  const event = parse({ "@type": "Event", startDate: "2026-10-03T09:00:00" })[0];
  assert.ok(event);
  assert.strictEqual(event.endEstimated, true);
  assert.deepStrictEqual(event.end, { kind: "floating", value: "2026-10-03T10:00:00" });
  for (const endDate of ["2026-10-03", "2026-10-05"]) {
    const day = parse({ "@type": "Event", startDate: "2026-10-03", endDate })[0];
    assert.ok(day);
    assert.deepStrictEqual(day.end, {
      kind: "date",
      value: endDate === "2026-10-03" ? "2026-10-04" : "2026-10-06",
    });
    assert.strictEqual(day.endEstimated, undefined);
  }
  const lodging = parse({
    "@type": "LodgingReservation",
    checkinTime: "2026-10-03",
    checkoutTime: "2026-10-05",
  })[0];
  assert.deepStrictEqual(lodging?.end, { kind: "date", value: "2026-10-05" });
  const body = "2026-10-03 09:00 to 10:00";
  assert.strictEqual(parse({ "@type": "Event", startDate: "invalid" }, body).length, 1);
  assert.strictEqual(
    parse(
      {
        "@type": "FlightReservation",
        reservationStatus: "https://schema.org/ReservationCancelled",
      },
      body,
    ).length,
    0,
  );
});
