import { assert, it } from "@effect/vitest";
import { Clock, Effect, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/sql";
import { afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { databaseLayer, MIGRATIONS } from "./platform/node/db.js";
import {
  DEFAULT_ACTIVE_HOURS,
  DEFAULT_PREFS,
  Prefs,
  type Account,
  type ActiveHours,
  type IncomingMessage,
  type Provider,
} from "./domain/domain.js";
import { makeFakeProvider } from "./platform/node/fake-provider.js";
import { Mailbox } from "./mailbox.js";
import { MailboxLive } from "./mailbox-live.js";
import { MemoryPlatform } from "./platform/node/platform-memory.js";
import { NodeSystem } from "./platform/node/platform-node.js";
import { Providers, Store } from "./services.js";
import { StoreLive } from "./store.js";
import {
  dockUnreadCount,
  inActiveHours,
  menuBarCountTitle,
  MENU_BAR_MAIL_LIMIT,
  profileNotificationsActive,
  shouldNotify,
} from "./system.js";
import { fakeServer, TestMailbox } from "./platform/node/testing.js";

const workHours = { ...DEFAULT_ACTIVE_HOURS, enabled: true };
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute);
const incoming = (id: string, date: number): IncomingMessage => ({
  providerId: id,
  threadId: id,
  from: { name: "Sender", address: "sender@example.com" },
  to: [],
  cc: [],
  date,
  subject: id,
  snippet: "hello",
  bodyText: "hello",
  bodyHtml: "",
  labels: ["INBOX", "UNREAD"],
  attachments: [],
  isUnread: true,
  isStarred: false,
});
const account: Account = {
  id: "gmail:me@example.com",
  email: "me@example.com",
  provider: "gmail",
  profileId: "work",
  createdAt: 0,
  lastSyncedAt: null,
  lastSyncError: null,
  needsReauth: false,
};
afterEach(() => vi.unstubAllEnvs());

it("weekday windows include the start, exclude the end, support split periods and muted weekends", () => {
  const hours: ActiveHours = {
    ...workHours,
    days: {
      ...workHours.days,
      monday: [
        { start: 540, end: 720 },
        { start: 780, end: 1020 },
      ],
    },
  };
  for (const [date, active] of [
    [at(5, 8, 59), false],
    [at(5, 9), true],
    [at(5, 12), false],
    [at(5, 13), true],
    [at(5, 16, 59), true],
    [at(5, 17), false],
    [at(3, 12), false],
    [at(4, 12), false],
  ] satisfies [Date, boolean][])
    assert.strictEqual(inActiveHours(hours, date), active);
  assert.isTrue(inActiveHours({ ...hours, enabled: false }, at(3, 12)));
  assert.isTrue(
    inActiveHours(
      { ...hours, days: { ...hours.days, sunday: [{ start: 0, end: 0 }] } },
      at(4, 23, 59),
    ),
  );
});
it("overnight windows belong to the starting weekday, including Sunday and week wrap", () => {
  const hours: ActiveHours = {
    enabled: true,
    days: {
      ...DEFAULT_ACTIVE_HOURS.days,
      monday: [],
      tuesday: [],
      wednesday: [],
      thursday: [],
      friday: [{ start: 1320, end: 120 }],
      sunday: [{ start: 1380, end: 60 }],
    },
  };
  assert.isTrue(inActiveHours(hours, at(2, 22)));
  assert.isTrue(inActiveHours(hours, at(3, 1, 59)));
  assert.isFalse(inActiveHours(hours, at(3, 2)));
  assert.isFalse(inActiveHours(hours, at(2, 1)));
  assert.isTrue(inActiveHours(hours, at(4, 23)));
  assert.isTrue(inActiveHours(hours, at(5, 0, 59)));
  assert.isFalse(inActiveHours(hours, at(5, 1)));
});
it("DST skipped and repeated minutes follow the Mac's current local weekday and wall time", () => {
  vi.stubEnv("TZ", "America/New_York");
  const spring: ActiveHours = {
    ...workHours,
    days: { ...workHours.days, sunday: [{ start: 120, end: 180 }] },
  };
  const beforeJump = new Date("2026-03-08T06:59:00Z");
  const afterJump = new Date("2026-03-08T07:00:00Z");
  assert.strictEqual(beforeJump.getHours(), 1);
  assert.strictEqual(afterJump.getHours(), 3);
  assert.isFalse(inActiveHours(spring, beforeJump));
  assert.isFalse(inActiveHours(spring, afterJump));
  assert.isTrue(
    inActiveHours(
      { ...spring, days: { ...spring.days, sunday: [{ start: 120, end: 240 }] } },
      afterJump,
    ),
  );
  const fall = { ...spring, days: { ...spring.days, sunday: [{ start: 60, end: 120 }] } };
  for (const instant of ["2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"]) {
    const date = new Date(instant);
    assert.strictEqual(date.getHours(), 1);
    assert.isTrue(inActiveHours(fall, date));
  }
  assert.isFalse(inActiveHours(fall, new Date("2026-11-01T07:00:00Z")));
  vi.stubEnv("TZ", "Asia/Tokyo");
  // The same instant is Monday locally in Tokyo and still Sunday in New York.
  assert.isTrue(inActiveHours(workHours, new Date("2026-10-05T00:00:00Z")));
});
it("Dock and notifications share the schedule decision, retaining legacy settings until replaced", () => {
  const message = {
    ...incoming("one", 1),
    id: "one",
    accountId: account.id,
    hasAttachments: false,
  };
  const prefs = { ...DEFAULT_PREFS, activeHours: { work: workHours } };
  for (const now of [at(2, 16, 59), at(2, 17), at(3, 12), at(5, 9)]) {
    const active = profileNotificationsActive(account, prefs, now);
    assert.strictEqual(shouldNotify(account, message, prefs, now), active);
    assert.strictEqual(
      dockUnreadCount("all", [account], { [account.id]: 7 }, prefs, now),
      active ? 7 : 0,
    );
  }
  assert.strictEqual(dockUnreadCount("empty", [account], { [account.id]: 7 }, prefs, at(5, 9)), 0);
  const legacy = { ...DEFAULT_PREFS, quietHours: { work: { enabled: true, start: 0, end: 0 } } };
  assert.isFalse(profileNotificationsActive(account, legacy, at(5, 9)));
  assert.isTrue(
    profileNotificationsActive(
      account,
      { ...legacy, activeHours: { work: DEFAULT_ACTIVE_HOURS } },
      at(5, 9),
    ),
  );
  assert.strictEqual(menuBarCountTitle(false, 9), "");
  assert.strictEqual(menuBarCountTitle(true, 0), "0");
  assert.strictEqual(menuBarCountTitle(true, 99), "99");
  assert.strictEqual(MENU_BAR_MAIL_LIMIT, 50);
  assert.throws(() =>
    Schema.decodeUnknownSync(Prefs)({
      ...prefs,
      activeHours: {
        work: { ...workHours, days: { ...workHours.days, monday: [{ start: 1440, end: 60 }] } },
      },
    }),
  );
});

for (const provider of ["gmail", "outlook", "imap"] satisfies Provider[]) {
  it.effect(
    `${provider}: muted arrivals survive restart; read, deleted, archived and disabled mail is excluded; digest is consumed once`,
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.sync(() => mkdtempSync(join(tmpdir(), "openmail-notify-"))),
          (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
        );
        const server = fakeServer(`${provider}@example.com`);
        const adapter = makeFakeProvider(server);
        const layer = () =>
          MailboxLive({ backgroundFlush: false }).pipe(
            Layer.provide(
              Layer.merge(
                StoreLive.pipe(
                  Layer.provide(
                    databaseLayer(join(directory, "mail.db"), { vectorExtension: null }).pipe(
                      Layer.provide(NodeSystem),
                    ),
                  ),
                ),
                Layer.succeed(Providers, Providers.of({ get: () => adapter })),
              ),
            ),
            Layer.provide(MemoryPlatform()),
          );
        let accountId = "";
        let profileId = "";
        // Friday before closing: the initial sync stays silent.
        yield* TestClock.setTime(at(2, 16, 59).getTime());
        yield* Effect.gen(function* () {
          const m = yield* Mailbox;
          server.messages.set("initial", incoming("initial", yield* Clock.currentTimeMillis));
          yield* m.connect(
            provider === "imap"
              ? { provider, input: { preset: "qq", email: server.email, password: "fake" } }
              : { provider },
          );
          yield* m.sync();
          accountId = (yield* m.accounts)[0]!.id;
          const profile = yield* m.createProfile({
            name: "Work",
            icon: "briefcase",
            color: "blue",
          });
          profileId = profile.id;
          yield* m.assignProfile(accountId, profileId);
          yield* m.setPrefs({ activeHours: { [profileId]: workHours }, menuBarUnreadCount: true });
          assert.deepStrictEqual(yield* m.takeNotifications, []);
          yield* TestClock.setTime(at(2, 17).getTime());
          const date = yield* Clock.currentTimeMillis;
          for (const id of ["keep", "read", "delete", "archive", "secondary"])
            server.messages.set(id, {
              ...incoming(id, date),
              ...(provider === "outlook"
                ? {
                    labels: ["INBOX", "UNREAD", ...(id === "secondary" ? ["CATEGORY_OTHER"] : [])],
                  }
                : id === "secondary"
                  ? { labels: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"] }
                  : {}),
            });
          yield* m.pollInbox();
          yield* m.sync();
          assert.deepStrictEqual(yield* m.takeNotifications, []);
          yield* m.perform(
            { kind: "modify", threads: [`${accountId}/read`], op: { kind: "read", value: true } },
            { kind: "user", surface: "app" },
          );
          yield* m.perform(
            { kind: "modify", threads: [`${accountId}/archive`], op: { kind: "archive" } },
            { kind: "user", surface: "app" },
          );
          server.messages.delete("delete");
          yield* m.sync();
          yield* TestClock.setTime(at(3, 12).getTime());
          assert.deepStrictEqual(yield* m.takeNotifications, []);
        }).pipe(Effect.provide(layer()));
        // Reopen the same file with a fresh service layer on Monday.
        yield* TestClock.setTime(at(5, 9).getTime());
        yield* Effect.gen(function* () {
          const m = yield* Mailbox;
          const prefs = yield* m.prefs;
          assert.deepStrictEqual(prefs.activeHours[profileId], workHours);
          assert.isTrue(prefs.menuBarUnreadCount);
          const results = yield* Effect.all([m.takeNotifications, m.takeNotifications], {
            concurrency: 2,
          });
          const batches = results.flat();
          assert.strictEqual(batches.length, 1);
          assert.strictEqual(batches[0]?.kind, "digest");
          assert.strictEqual(batches[0]?.profileId, profileId);
          assert.deepStrictEqual(
            batches[0]?.messages.map((m) => m.id).toSorted(),
            (provider !== "imap"
              ? [`${accountId}/keep`]
              : [`${accountId}/keep`, `${accountId}/secondary`]
            ).toSorted(),
          );
          yield* m.sync();
          yield* m.pollInbox();
          assert.deepStrictEqual(yield* m.takeNotifications, []);
          // A new quiet period with notifications disabled before resume yields no digest.
          yield* TestClock.setTime(at(5, 17).getTime());
          server.messages.set("disabled", incoming("disabled", yield* Clock.currentTimeMillis));
          yield* m.pollInbox();
          yield* m.setPrefs({ notifications: { [accountId]: "off" } });
          yield* TestClock.setTime(at(6, 9).getTime());
          assert.deepStrictEqual(yield* m.takeNotifications, []);
        }).pipe(Effect.provide(layer()));
        assert.match(MIGRATIONS[15] ?? "", /CREATE TABLE pending_notifications/);
      }),
  );
}

it.effect(
  "one Profile produces one digest across accounts; active arrivals remain immediate",
  () => {
    const gmail = fakeServer("me@gmail.com");
    const outlook = fakeServer("me@outlook.com");
    return Effect.gen(function* () {
      const m = yield* Mailbox;
      yield* TestClock.setTime(at(2, 17).getTime());
      yield* m.connect({ provider: "gmail" });
      yield* m.connect({ provider: "outlook" });
      yield* m.sync();
      const profile = yield* m.createProfile({ name: "Work", icon: "briefcase", color: "blue" });
      for (const account of yield* m.accounts) yield* m.assignProfile(account.id, profile.id);
      yield* m.setPrefs({ activeHours: { [profile.id]: workHours } });
      gmail.messages.set("g", incoming("g", yield* Clock.currentTimeMillis));
      outlook.messages.set("o", incoming("o", yield* Clock.currentTimeMillis));
      yield* m.pollInbox();
      yield* TestClock.setTime(at(5, 9).getTime());
      const batches = yield* m.takeNotifications;
      assert.strictEqual(batches.length, 1);
      assert.strictEqual(batches[0]?.kind, "digest");
      assert.strictEqual(batches[0]?.messages.length, 2);
      gmail.messages.set("now", incoming("now", yield* Clock.currentTimeMillis));
      yield* m.pollInbox();
      assert.strictEqual((yield* m.takeNotifications)[0]?.kind, "immediate");
      assert.deepStrictEqual(yield* m.takeNotifications, []);
    }).pipe(Effect.provide(TestMailbox({ gmail, outlook })));
  },
);

it.effect("fake clock crosses midnight and resumes an ungrouped Profile's pending digest", () => {
  const server = fakeServer("me@gmail.com");
  return Effect.gen(function* () {
    const m = yield* Mailbox;
    yield* TestClock.setTime(at(2, 21, 59).getTime());
    yield* m.connect({ provider: "gmail" });
    yield* m.sync();
    const hours: ActiveHours = {
      ...workHours,
      days: { ...workHours.days, friday: [{ start: 1320, end: 120 }], saturday: [] },
    };
    yield* m.setPrefs({ activeHours: { all: hours } });
    server.messages.set("waiting", incoming("waiting", yield* Clock.currentTimeMillis));
    yield* m.pollInbox();
    assert.deepStrictEqual(yield* m.takeNotifications, []);
    yield* TestClock.adjust("1 minute");
    assert.strictEqual((yield* m.takeNotifications)[0]?.kind, "digest");
    yield* TestClock.adjust("2 hours");
    server.messages.set("midnight", incoming("midnight", yield* Clock.currentTimeMillis));
    yield* m.pollInbox();
    assert.strictEqual((yield* m.takeNotifications)[0]?.kind, "immediate");
    yield* TestClock.adjust("2 hours");
    server.messages.set("closed", incoming("closed", yield* Clock.currentTimeMillis));
    yield* m.pollInbox();
    assert.deepStrictEqual(yield* m.takeNotifications, []);
  }).pipe(Effect.provide(TestMailbox({ gmail: server })));
});

it.effect(
  "DST jump resumes catch-up; a repeated active window does not deliver the same digest twice",
  () => {
    vi.stubEnv("TZ", "America/New_York");
    const server = fakeServer("me@gmail.com");
    return Effect.gen(function* () {
      const m = yield* Mailbox;
      yield* TestClock.setTime(new Date("2026-03-08T06:59:00Z").getTime());
      yield* m.connect({ provider: "gmail" });
      yield* m.sync();
      const hours: ActiveHours = {
        ...workHours,
        days: { ...workHours.days, sunday: [{ start: 120, end: 240 }] },
      };
      yield* m.setPrefs({ activeHours: { all: hours } });
      server.messages.set("spring", incoming("spring", yield* Clock.currentTimeMillis));
      yield* m.pollInbox();
      assert.deepStrictEqual(yield* m.takeNotifications, []);
      yield* TestClock.adjust("1 minute");
      assert.strictEqual((yield* m.takeNotifications)[0]?.messages[0]?.subject, "spring");
      yield* TestClock.setTime(new Date("2026-11-01T04:59:00Z").getTime());
      yield* m.setPrefs({
        activeHours: {
          all: { ...hours, days: { ...hours.days, sunday: [{ start: 60, end: 90 }] } },
        },
      });
      server.messages.set("fall", incoming("fall", yield* Clock.currentTimeMillis));
      yield* m.pollInbox();
      assert.deepStrictEqual(yield* m.takeNotifications, []);
      yield* TestClock.adjust("1 minute");
      assert.strictEqual((yield* m.takeNotifications)[0]?.messages[0]?.subject, "fall");
      yield* TestClock.adjust("30 minutes");
      assert.deepStrictEqual(yield* m.takeNotifications, []);
      yield* TestClock.adjust("30 minutes");
      assert.deepStrictEqual(yield* m.takeNotifications, []);
    }).pipe(Effect.provide(TestMailbox({ gmail: server })));
  },
);

it.effect(
  "CLI sync arrivals older than five minutes become one digest rather than fresh notices",
  () => {
    const server = fakeServer("me@gmail.com");
    return Effect.gen(function* () {
      const m = yield* Mailbox;
      yield* m.connect({ provider: "gmail" });
      yield* m.sync();
      server.messages.set("fresh", incoming("fresh", yield* Clock.currentTimeMillis));
      yield* m.sync();
      assert.strictEqual((yield* m.takeNotifications)[0]?.kind, "immediate");
      for (const id of ["old-a", "old-b"])
        server.messages.set(id, incoming(id, yield* Clock.currentTimeMillis));
      yield* m.sync();
      yield* TestClock.adjust("2 days");
      const batches = yield* m.takeNotifications;
      assert.strictEqual(batches.length, 1);
      assert.strictEqual(batches[0]?.kind, "digest");
      assert.strictEqual(batches[0]?.messages.length, 2);
    }).pipe(Effect.provide(TestMailbox({ gmail: server })));
  },
);

const notificationStore = StoreLive.pipe(Layer.provideMerge(MemoryPlatform()));
it.effect("pending notification retention expires on both enqueue and take", () =>
  Effect.gen(function* () {
    const store = yield* Store;
    const sql = yield* SqlClient.SqlClient;
    const account = yield* store.upsertAccount("gmail", "me@gmail.com");
    const enqueue = (id: string) =>
      Effect.gen(function* () {
        yield* store.upsertMessage(account.id, incoming(id, yield* Clock.currentTimeMillis));
        yield* store.enqueueNotification(`${account.id}/${id}`, false);
      });
    yield* enqueue("expire-at-take");
    yield* TestClock.adjust("8 days");
    assert.deepStrictEqual(yield* store.takeNotifications(yield* Clock.currentTimeMillis), []);
    assert.strictEqual((yield* sql`SELECT message_id FROM pending_notifications`).length, 0);
    yield* enqueue("expire-at-enqueue");
    yield* TestClock.adjust("8 days");
    // No desktop consumer is running while the CLI adds more mail.
    yield* enqueue("newest");
    assert.deepStrictEqual(
      (yield* sql`SELECT message_id FROM pending_notifications`).map((row) => row["message_id"]),
      [`${account.id}/newest`],
    );
  }).pipe(Effect.provide(notificationStore)),
);

it.effect("muted notification ticks write digest only once", () =>
  Effect.gen(function* () {
    const store = yield* Store;
    const sql = yield* SqlClient.SqlClient;
    const account = yield* store.upsertAccount("gmail", "me@gmail.com");
    yield* store.upsertMessage(account.id, incoming("one", 0));
    yield* store.enqueueNotification(`${account.id}/one`, false);
    yield* store.setPrefs({ quietHours: { all: { enabled: true, start: 0, end: 0 } } });
    yield* sql`CREATE TABLE notification_updates (message_id TEXT)`;
    yield* sql`CREATE TRIGGER notification_update_probe AFTER UPDATE ON pending_notifications BEGIN
    INSERT INTO notification_updates VALUES(new.message_id); END`;
    for (let i = 0; i < 3; i++) {
      assert.deepStrictEqual(yield* store.takeNotifications(yield* Clock.currentTimeMillis), []);
      yield* TestClock.adjust("15 seconds");
    }
    assert.strictEqual((yield* sql`SELECT message_id FROM notification_updates`).length, 1);
  }).pipe(Effect.provide(notificationStore)),
);

it.effect("pending notification storage caps CLI-only accumulation at the newest 1000 rows", () =>
  Effect.gen(function* () {
    const store = yield* Store;
    const sql = yield* SqlClient.SqlClient;
    const account = yield* store.upsertAccount("gmail", "me@gmail.com");
    const enqueue = (id: string) =>
      Effect.gen(function* () {
        yield* store.upsertMessage(account.id, incoming(id, yield* Clock.currentTimeMillis));
        yield* store.enqueueNotification(`${account.id}/${id}`, false);
      });
    yield* store.transaction(
      Effect.gen(function* () {
        for (let i = 0; i < 1001; i++) yield* enqueue(`cap-${i}`);
      }),
    );
    const retained = yield* sql`SELECT message_id FROM pending_notifications ORDER BY rowid`;
    assert.strictEqual(retained.length, 1000);
    assert.strictEqual(retained[0]?.["message_id"], `${account.id}/cap-1`);
    assert.strictEqual(retained.at(-1)?.["message_id"], `${account.id}/cap-1000`);
  }).pipe(Effect.provide(notificationStore)),
);
