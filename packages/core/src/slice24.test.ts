import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { databaseLayer } from "./platform/node/db.js";
import { DEFAULT_PREFS, type IncomingMessage } from "./domain.js";
import { StoreLive } from "./store.js";
import { makeBatchMailbox } from "./mailbox-batch.js";
import { MemoryPlatform } from "./platform/node/platform-memory.js";
import { Store } from "./services.js";
import { Mailbox } from "./mailbox.js";
import { TestMailbox, fakeServer } from "./platform/node/testing.js";
import {
  calendarTimestamp,
  calendarWindow,
  detectMailEvents,
  type CalendarEvent,
} from "./calendar.js";
import { parseCalendar } from "./invites.js";

const message: IncomingMessage = {
  providerId: "one",
  threadId: "one",
  subject: "Train",
  from: { name: "", address: "tickets@example.com" },
  to: [],
  cc: [],
  date: 1,
  snippet: "",
  bodyText: "Departure 2026-10-10 09:00 to 10:30",
  bodyHtml: "",
  labels: ["INBOX"],
  attachments: [],
  isUnread: true,
  isStarred: false,
};
const event: CalendarEvent = {
  key: "busy",
  title: "Personal meeting",
  start: { kind: "floating", value: "2026-10-10T09:30:00" },
  end: { kind: "floating", value: "2026-10-10T10:00:00" },
  location: "",
  description: "",
  recurrence: [],
};
const source = (method: string, title = "Travel") =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${method ? `METHOD:${method}\r\n` : ""}BEGIN:VEVENT\r\nUID:invite\r\nDTSTART:20261010T090000\r\nDTEND:20261010T103000\r\nSUMMARY:${title}\r\nEND:VEVENT\r\nEND:VCALENDAR`;
const raw = (method: string, title?: string) =>
  Buffer.from(`MIME-Version: 1.0\r\nContent-Type: text/calendar\r\n\r\n${source(method, title)}`);

it("detects explicit dates and ranges in local time, preserves all-day dates and rejects invalid times", () => {
  const [found] = detectMailEvents(message);
  assert.ok(found);
  assert.deepStrictEqual(found.start, { kind: "floating", value: "2026-10-10T09:00:00" });
  assert.strictEqual(calendarTimestamp(found.end) - calendarTimestamp(found.start), 90 * 60000);
  const [day] = detectMailEvents({ ...message, bodyText: "2026-10-10" });
  assert.ok(day);
  assert.deepStrictEqual(day.end, { kind: "date", value: "2026-10-11" });
  assert.strictEqual(calendarWindow(day).timeMin, new Date("2026-10-10T00:00:00").toISOString());
  assert.deepStrictEqual(
    detectMailEvents({
      ...message,
      bodyText: "2026-02-31 09:00, 2026-10-10 24:30, 2026-10-10 12:80",
    }),
    [],
  );
  assert.deepStrictEqual(parseCalendar(source("PUBLISH")), []);
  assert.strictEqual(parseCalendar(source("PUBLISH"), true)[0]?.invite.method, "PUBLISH");
  assert.strictEqual(parseCalendar(source(""), true)[0]?.invite.method, "PUBLISH");
});

it.effect(
  "event reading never creates; creation is app-only, rechecks the confirmed content and separates iTIP requests",
  () => {
    const server = fakeServer("me@gmail.com", [message]);
    return Effect.gen(function* () {
      const m = yield* Mailbox;
      const account = yield* m.connect({ provider: "gmail" });
      yield* m.sync();
      const id = `${account.id}/one`;
      const [candidate] = yield* m.detectedEvents(id);
      assert.ok(candidate);
      assert.strictEqual(server.createdEvents.length, 0);
      for (const actor of [
        { kind: "agent", surface: "mcp", name: "bot" },
        { kind: "user", surface: "cli" },
      ] as const)
        assert.strictEqual(
          (yield* m.createCalendarEvent(id, candidate.key, actor).pipe(Effect.result))._tag,
          "Failure",
        );
      yield* m.createCalendarEvent(id, candidate.key, { kind: "user", surface: "app" });
      assert.strictEqual(server.createdEvents.length, 1);
      server.messages.set("one", {
        ...message,
        hasCalendar: true,
        attachments: [{ filename: "travel.ics", mimeType: "text/calendar", size: 300 }],
      });
      server.raw.set("one", raw("PUBLISH"));
      yield* m.sync();
      const [published] = yield* m.detectedEvents(id);
      assert.ok(published);
      server.raw.set("one", raw("PUBLISH", "Changed details"));
      assert.strictEqual(
        (yield* m
          .createCalendarEvent(id, published.key, { kind: "user", surface: "app" })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      server.raw.set("one", raw("REQUEST"));
      assert.deepStrictEqual(yield* m.detectedEvents(id), []);
      const [invite] = yield* m.invitations(id);
      assert.ok(invite);
      server.calendarEvents.push(event, {
        ...event,
        key: "later",
        start: { kind: "floating", value: "2026-10-10T11:00:00" },
        end: { kind: "floating", value: "2026-10-10T12:00:00" },
      });
      assert.deepStrictEqual(
        (yield* m.calendarEvents(id, invite.key)).map((e) => e.key),
        ["busy"],
      );
      assert.strictEqual(server.createdEvents.length, 1);
      assert.ok((yield* m.audit(10)).some((entry) => entry.action === "calendar_create"));
    }).pipe(Effect.provide(TestMailbox({ gmail: server })));
  },
);

it.effect(
  "missing cache falls back to Gmail IDs and validated Outlook webLink without writing mail",
  () => {
    const gmail = fakeServer("me@gmail.com", [message]);
    const outlook = fakeServer("me@outlook.com", [
      { ...message, webLink: "https://outlook.live.com/mail/0/id/one" },
    ]);
    return Effect.gen(function* () {
      const m = yield* Mailbox;
      const a = yield* m.connect({ provider: "gmail" }),
        b = yield* m.connect({ provider: "outlook" });
      assert.match(yield* m.messageWebUrl(`${a.id}/deadbeef`), /#all\/deadbeef$/);
      assert.strictEqual(
        yield* m.messageWebUrl(`${b.id}/one`),
        "https://outlook.live.com/mail/0/id/one",
      );
      outlook.messages.set("one", { ...message, webLink: "https://evil.example/mail/one" });
      assert.strictEqual(
        (yield* m.messageWebUrl(`${b.id}/one`).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.strictEqual(gmail.pushed.length + outlook.pushed.length, 0);
    }).pipe(Effect.provide(TestMailbox({ gmail, outlook })));
  },
);

it.effect(
  "snooze undo restores Inbox locally and preserves a previous reminder without provider changes",
  () => {
    const server = fakeServer("me@gmail.com", [message]);
    return Effect.gen(function* () {
      const m = yield* Mailbox;
      const account = yield* m.connect({ provider: "gmail" });
      yield* m.sync();
      const id = `${account.id}/one`;
      const batch = yield* m.snoozeWithUndo([id], 2000000000000);
      assert.ok((yield* m.thread(id))[0]?.labels.includes("SNOOZED"));
      yield* m.undoBatch(batch.undoId);
      assert.ok((yield* m.thread(id))[0]?.labels.includes("INBOX"));
      assert.strictEqual((yield* m.threads({ mailbox: "snoozed" })).length, 0);
      yield* m.snooze([id], 2000000000000);
      const change = yield* m.snoozeWithUndo([id], 2100000000000);
      yield* m.undoBatch(change.undoId);
      assert.strictEqual((yield* m.threads({ mailbox: "snoozed" })).length, 1);
      assert.strictEqual(server.pushed.length, 0);
    }).pipe(Effect.provide(TestMailbox({ gmail: server })));
  },
);

it.effect(
  "channel, Labs, gesture choices and toolbar ordering survive reopening a temporary database",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem,
        path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "openmail-slice24-" });
      const file = path.join(directory, "mail.db");
      const layer = () => StoreLive.pipe(Layer.provide(databaseLayer(file)));
      yield* Effect.gen(function* () {
        const store = yield* Store;
        assert.deepStrictEqual(yield* store.prefs, DEFAULT_PREFS);
        yield* store.setPrefs({
          updateChannel: "latest",
          labs: { markdown: false, calendarDetection: false },
          swipeActions: {
            leftShort: "none",
            leftLong: "star",
            rightShort: "snooze",
            rightLong: "read",
          },
          toolbarActions: ["star", "reply", "archive"],
        });
      }).pipe(Effect.provide(layer()));
      yield* Effect.gen(function* () {
        const store = yield* Store,
          prefs = yield* store.prefs;
        assert.strictEqual(prefs.updateChannel, "latest");
        assert.deepStrictEqual(prefs.labs, { markdown: false, calendarDetection: false });
        assert.strictEqual(prefs.swipeActions.rightShort, "snooze");
        assert.deepStrictEqual(prefs.toolbarActions, ["star", "reply", "archive"]);
      }).pipe(Effect.provide(layer()));
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
);

it.effect("snooze undo restores the exact prior due date in the real SQLite store", () =>
  Effect.gen(function* () {
    const store = yield* Store;
    const account = yield* store.upsertAccount("gmail", "me@gmail.com");
    yield* store.upsertMessage(account.id, message);
    const id = `${account.id}/one`;
    const batch = yield* makeBatchMailbox(store, Effect.void, Effect.void);
    yield* store.snooze(id, 2000000000000);
    const changed = yield* batch.snoozeWithUndo([id], 2100000000000);
    yield* batch.undoBatch(changed.undoId);
    const restored = yield* store.reminderSnapshot(id);
    assert.strictEqual(restored._tag === "Some" && restored.value.dueAt, 2000000000000);
  }).pipe(Effect.provide(StoreLive.pipe(Layer.provide(MemoryPlatform())))),
);

it("all-day query windows follow local DST rather than assuming every day has 24 hours", () => {
  const previous = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    const window = calendarWindow({
      start: { kind: "date", value: "2026-03-08" },
      end: { kind: "date", value: "2026-03-09" },
    });
    assert.strictEqual(window.timeMin, "2026-03-08T08:00:00.000Z");
    assert.strictEqual(window.timeMax, "2026-03-09T07:00:00.000Z");
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
