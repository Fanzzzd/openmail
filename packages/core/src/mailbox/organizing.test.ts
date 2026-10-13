import { applyNativeMigration } from "../platform/node/migrations.js";
import { TestMailbox } from "../platform/node/testing.js";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, vi } from "vitest";
import { databaseLayer, MIGRATIONS } from "../platform/node/db.js";
import { DEFAULT_ACTIVE_HOURS } from "../domain/prefs.js";
import type { IncomingMessage } from "../domain/message.js";
import type { Provider } from "../domain/account.js";
import { Mailbox } from "./mailbox.js";
import {
  type GmailRuleDefinition,
  EMPTY_FILTER,
  parseSnoozeTime,
  systemFolderId,
  moveSourceLabel,
} from "../domain/organization.js";
import { makeGmailSettings } from "../providers/gmail/gmail-settings.js";
import { gmailDelta } from "../providers/gmail/gmail.js";
import { destination } from "../providers/outlook/graph.js";
import { ProviderError } from "../domain/errors.js";
import { fakeServer, makeFakeProvider } from "../platform/node/fake-provider.js";
import { NodeSystem } from "../platform/node/platform-node.js";
import { Store } from "../store/service.js";
import type { ProviderAdapter } from "../providers/adapter.js";
import { StoreLive } from "../store/store.js";
const incoming = (id: string, overrides: Partial<IncomingMessage> = {}): IncomingMessage => ({
  providerId: id,
  threadId: "thread",
  from: { name: "Alice", address: "alice@example.com" },
  to: [],
  cc: [],
  date: 1000,
  subject: "Report",
  snippet: "report",
  bodyText: "report",
  bodyHtml: "",
  labels: ["INBOX"],
  attachments: [],
  isUnread: false,
  isStarred: false,
  ...overrides,
});
const rule = {
  ...EMPTY_FILTER,
  name: "Reports",
  criteria: { ...EMPTY_FILTER.criteria, from: "alice@example.com" },
  action: { ...EMPTY_FILTER.action, markRead: true },
};

function fixture<A, E>(
  provider: Provider,
  body: (
    m: Mailbox["Service"],
    store: Store["Service"],
    server: ReturnType<typeof fakeServer>,
    accountId: string,
  ) => Effect.Effect<A, E>,
  wrapProvider: (
    adapter: ProviderAdapter,
    server: ReturnType<typeof fakeServer>,
  ) => ProviderAdapter = (adapter) => adapter,
) {
  const server = fakeServer("me@example.com", [incoming("one"), incoming("two", { date: 2000 })]);
  return Effect.gen(function* () {
    const store = yield* Store;
    const m = yield* Mailbox;
    const account = yield* store.upsertAccount(provider, server.email);
    yield* store.setGrantedScopes(account.id, server.grantedScopes);
    for (const message of server.messages.values()) yield* store.upsertMessage(account.id, message);
    return yield* body(m, store, server, account.id);
  }).pipe(
    Effect.provide(
      TestMailbox.withAdapter(wrapProvider(makeFakeProvider(server), server), {
        options: { backgroundFlush: false },
        platformOptions: {},
      }),
    ),
  );
}
afterEach(() => vi.unstubAllEnvs());

for (const provider of ["gmail", "outlook"] as const) {
  it.effect(
    `${provider}: every rule can be deleted after plain confirmation, without preview validation`,
    () =>
      fixture(provider, (m, _store, server, accountId) =>
        Effect.gen(function* () {
          const existing = {
            ...rule,
            id: "unsupported",
            editable: false,
            criteria: { ...EMPTY_FILTER.criteria },
            action: {
              ...rule.action,
              label: provider === "gmail" ? "CATEGORY_UPDATES" : "archive-folder-id",
            },
          };
          server.filters.push(existing);
          assert.strictEqual(
            (yield* m.deleteFilter(accountId, existing.id).pipe(Effect.result))._tag,
            "Failure",
          );
          assert.strictEqual(server.filters.length, 1);
          yield* m.deleteFilter(accountId, existing.id, true);
          assert.deepStrictEqual(server.filters, []);
          assert.deepStrictEqual(server.searched, []);
        }),
      ),
  );
  it.effect(
    `${provider}: existing-mail preview excludes sent, drafts, trash and spam and applies only its IDs`,
    () =>
      fixture(provider, (m, store, server, accountId) =>
        Effect.gen(function* () {
          server.searchResults = [
            incoming("one"),
            ...["TRASH", "SPAM", "DRAFT", "SENT"].map((label) =>
              incoming(label, { labels: [label] }),
            ),
          ];
          const preview = yield* m.prepareFilter(accountId, rule);
          assert.deepStrictEqual(
            preview.matches.map((message) => message.id),
            [`${accountId}/one`],
          );
          assert.deepStrictEqual(
            (yield* m.previewFilter(accountId, rule.criteria)).map((message) => message.id),
            provider === "gmail" ? [`${accountId}/one`] : [`${accountId}/two`, `${accountId}/one`],
          );
          yield* store.upsertMessage(accountId, incoming("late"));
          assert.strictEqual(yield* m.applyFilter(accountId, rule, preview.token), 1);
          assert.deepStrictEqual(
            server.pushed.map((op) => op.providerId),
            ["one"],
          );
          assert.strictEqual((yield* store.getMessage(`${accountId}/late`)).isUnread, false);
        }),
      ),
  );
}

it("move source follows the viewed folder without stripping Inbox from Sent, Starred or Snoozed", () => {
  for (const mailbox of ["sent", "starred", "snoozed", "all"] as const)
    assert.strictEqual(moveSourceLabel(mailbox), null);
  assert.strictEqual(moveSourceLabel("inbox"), "INBOX");
  assert.strictEqual(moveSourceLabel("trash"), "TRASH");
  assert.strictEqual(moveSourceLabel("spam"), "SPAM");
  assert.strictEqual(moveSourceLabel("all", "Label_A"), "Label_A");
});

it.effect(
  "creation trims names and applies a new folder whose provider normalizes its display name",
  () =>
    fixture(
      "imap",
      (m, store, server, accountId) =>
        Effect.gen(function* () {
          yield* m.createLabelAndApply(
            accountId,
            "  Client.Report  ",
            null,
            [`${accountId}/one`],
            true,
            "INBOX",
            true,
          );
          assert.strictEqual(server.labels[0]?.name, "Client/Report");
          const label = server.labels[0];
          assert.ok(label);
          assert.deepStrictEqual((yield* store.getMessage(`${accountId}/one`)).labels, [label.id]);
          assert.deepStrictEqual((yield* store.getMessage(`${accountId}/two`)).labels, ["INBOX"]);
        }),
      (adapter, server) => ({
        ...adapter,
        changeLabel: (account, change) =>
          adapter.changeLabel(account, change).pipe(
            Effect.map(() => {
              server.labels = server.labels.map((label) => ({
                ...label,
                name: label.name.replaceAll(".", "/"),
              }));
              return server.labels;
            }),
          ),
      }),
    ),
);

it.effect(
  "failed Gmail rule edits persist recovery data until a confirmed restoration succeeds",
  () =>
    fixture(
      "gmail",
      (m, _store, server, accountId) =>
        Effect.gen(function* () {
          server.filters.push({ ...rule, id: "old" });
          const edited = { ...rule, name: "Edited" };
          const preview = yield* m.prepareFilter(accountId, edited);
          assert.strictEqual(
            (yield* m.updateFilter(accountId, "old", edited, preview.token).pipe(Effect.result))
              ._tag,
            "Failure",
          );
          const backup = (yield* m.filterRestorations(accountId))[0];
          assert.ok(backup);
          assert.strictEqual(backup.originalId, "old");
          assert.strictEqual(backup.input.name, "Reports");
          assert.deepStrictEqual(backup.definition, {
            criteria: { from: "alice@example.com" },
            action: { removeLabelIds: ["UNREAD"] },
          });
          assert.strictEqual(
            (yield* m.restoreFilter(accountId, backup.id, "no-preview").pipe(Effect.result))._tag,
            "Failure",
          );
          const first = yield* m.prepareFilter(accountId, backup.input);
          server.failNext = new ProviderError({ message: "still offline" });
          assert.strictEqual(
            (yield* m.restoreFilter(accountId, backup.id, first.token).pipe(Effect.result))._tag,
            "Failure",
          );
          assert.strictEqual((yield* m.filterRestorations(accountId)).length, 1);
          const second = yield* m.prepareFilter(accountId, backup.input);
          yield* m.restoreFilter(accountId, backup.id, second.token);
          assert.deepStrictEqual(yield* m.filterRestorations(accountId), []);
          assert.strictEqual(server.filters.length, 1);
        }),
      (adapter, server) => ({
        ...adapter,
        updateFilter: (_account, _id, _input, onRestoreFailure) =>
          Effect.gen(function* () {
            server.filters = [];
            if (onRestoreFailure)
              yield* onRestoreFailure({
                criteria: { from: "alice@example.com" },
                action: { removeLabelIds: ["UNREAD"] },
              });
            return yield* new ProviderError({ message: "Automatic recovery failed" });
          }),
        restoreFilter: (account, definition) => {
          assert.deepStrictEqual(definition, {
            criteria: { from: "alice@example.com" },
            action: { removeLabelIds: ["UNREAD"] },
          });
          return adapter.createFilter(account, rule);
        },
      }),
    ),
);

for (const source of ["TRASH", "SPAM"] as const) {
  it.effect(`Gmail Move To removes ${source} locally and on the fake server`, () =>
    fixture("gmail", (m, store, server, accountId) =>
      Effect.gen(function* () {
        const message = incoming("one", { labels: [source] });
        server.messages.set("one", message);
        yield* store.upsertMessage(accountId, message);
        yield* m.createLabelAndApply(
          accountId,
          "Destination",
          null,
          [`${accountId}/one`],
          true,
          source,
          true,
        );
        const label = (yield* m.labels([accountId]))[0];
        assert.ok(label);
        assert.deepStrictEqual((yield* store.getMessage(`${accountId}/one`)).labels, [label.id]);
        yield* m.sync();
        assert.deepStrictEqual(server.messages.get("one")?.labels, [label.id]);
      }),
    ),
  );
}

for (const provider of ["gmail", "outlook", "imap"] as const) {
  it.effect(
    `${provider}: create nested destination from a picker, move once per member, and undo`,
    () =>
      fixture(provider, (m, _store, server, accountId) =>
        Effect.gen(function* () {
          yield* m.changeLabel(accountId, { kind: "create", name: "Clients" });
          const parent = (yield* m.labels([accountId]))[0];
          assert.ok(parent);
          const result = yield* m.createLabelAndApply(
            accountId,
            "Reports",
            parent.id,
            [`${accountId}/one`],
            true,
            "INBOX",
            false,
          );
          const child = (yield* m.labels([accountId])).find((l) => l.name === "Clients/Reports");
          assert.ok(child);
          for (const message of yield* m.thread(`${accountId}/one`)) {
            assert.ok(message.labels.includes(child.id));
            assert.ok(!message.labels.includes("INBOX"));
          }
          yield* m.sync();
          assert.deepStrictEqual(
            server.pushed.map((p) => p.op),
            [
              { kind: "move", labelId: child.id, removeLabelId: "INBOX" },
              { kind: "move", labelId: child.id, removeLabelId: "INBOX" },
            ],
          );
          yield* m.undoBatch(result.undoId);
          assert.ok(
            (yield* m.thread(`${accountId}/one`)).every((message) =>
              message.labels.includes("INBOX"),
            ),
          );
        }),
      ),
  );

  it.effect(`${provider}: reparenting rejects cycles, supports root, and retains favorites`, () =>
    fixture(provider, (m, _store, _server, accountId) =>
      Effect.gen(function* () {
        yield* m.changeLabel(accountId, { kind: "create", name: "A" });
        yield* m.changeLabel(accountId, { kind: "create", name: "B" });
        const a = (yield* m.labels([accountId])).find((l) => l.name === "A");
        const b = (yield* m.labels([accountId])).find((l) => l.name === "B");
        assert.ok(a);
        assert.ok(b);
        yield* m.setLabelPreference({
          accountId,
          id: a.id,
          favorite: true,
          visible: true,
          color: null,
          position: 3,
        });
        yield* m.changeLabel(accountId, { kind: "parent", id: a.id, parentId: b.id });
        const moved = (yield* m.labels([accountId])).find((l) => l.name === "B/A");
        assert.ok(moved);
        assert.strictEqual((yield* m.labelPreferences).find((p) => p.id === moved.id)?.position, 3);
        assert.strictEqual(
          (yield* m
            .changeLabel(accountId, { kind: "parent", id: b.id, parentId: moved.id })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.strictEqual(
          (yield* m
            .changeLabel(accountId, { kind: "parent", id: moved.id, parentId: moved.id })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        yield* m.changeLabel(accountId, { kind: "parent", id: moved.id, parentId: null });
        assert.ok((yield* m.labels([accountId])).some((l) => l.name === "A"));
      }),
    ),
  );

  it.effect(
    `${provider}: wake produces one notification per conversation, defers while muted, and consumes once`,
    () =>
      fixture(provider, (m, _store, _server, accountId) =>
        Effect.gen(function* () {
          const profile = yield* m.createProfile({ name: "Work", icon: "W", color: "blue" });
          yield* m.moveAccount(accountId, { profileId: profile.id, beforeId: null });
          yield* m.setPrefs({
            notifications: { [accountId]: "inbox" },
            quietHours: { [profile.id]: { enabled: true, start: 0, end: 0 } },
          });
          yield* m.snooze([`${accountId}/one`], 1000);
          yield* TestClock.adjust("2 seconds");
          yield* m.wakeSnoozed();
          assert.deepStrictEqual(yield* m.takeNotifications, []);
          yield* m.setPrefs({
            quietHours: {},
            activeHours: {
              [profile.id]: {
                ...DEFAULT_ACTIVE_HOURS,
                enabled: true,
                days: {
                  monday: [],
                  tuesday: [],
                  wednesday: [],
                  thursday: [],
                  friday: [],
                  saturday: [],
                  sunday: [],
                },
              },
            },
          });
          assert.deepStrictEqual(yield* m.takeNotifications, []);
          yield* m.setPrefs({ activeHours: { [profile.id]: DEFAULT_ACTIVE_HOURS } });
          const batches = yield* m.takeNotifications;
          assert.strictEqual(batches.length, 1);
          assert.strictEqual(batches[0]?.kind, "digest");
          assert.strictEqual(batches[0]?.messages.length, 1);
          assert.ok(batches[0]?.messages[0]?.labels.includes("INBOX"));
          yield* m.wakeSnoozed();
          assert.deepStrictEqual(yield* m.takeNotifications, []);
        }),
      ),
  );
}

it("Gmail Move To sends one add/remove delta and Outlook uses the target folder", () => {
  assert.deepStrictEqual(gmailDelta({ kind: "move", labelId: "new", removeLabelId: "old" }), {
    add: ["new"],
    remove: ["old", "SPAM"],
  });
  assert.deepStrictEqual(gmailDelta({ kind: "move", labelId: "same", removeLabelId: "same" }), {
    add: ["same"],
    remove: ["SPAM"],
  });
  assert.deepStrictEqual(gmailDelta({ kind: "move", labelId: "new", removeLabelId: null }), {
    add: ["new"],
    remove: ["SPAM"],
  });
  assert.strictEqual(destination({ kind: "move", labelId: "INBOX", removeLabelId: null }), "inbox");
});
it.effect("Gmail Move To with no source label preserves Inbox and can undo the added label", () =>
  fixture("gmail", (m, store, server, accountId) =>
    Effect.gen(function* () {
      yield* m.changeLabel(accountId, { kind: "create", name: "Destination" });
      const label = (yield* m.labels([accountId]))[0];
      assert.ok(label);
      const result = yield* m.modifyWithUndo(
        [`${accountId}/one`],
        { kind: "move", labelId: label.id, removeLabelId: null },
        true,
      );
      assert.deepStrictEqual((yield* store.getMessage(`${accountId}/one`)).labels, [
        "INBOX",
        label.id,
      ]);
      yield* m.sync();
      assert.deepStrictEqual(server.messages.get("one")?.labels, ["INBOX", label.id]);
      yield* m.undoBatch(result.undoId);
      assert.deepStrictEqual((yield* store.getMessage(`${accountId}/one`)).labels, ["INBOX"]);
    }),
  ),
);
it.effect("Gmail label application keeps Inbox; Remove Current Label keeps all other labels", () =>
  fixture("gmail", (m, store, _server, accountId) =>
    Effect.gen(function* () {
      yield* m.createLabelAndApply(
        accountId,
        "Work",
        null,
        [`${accountId}/one`],
        false,
        null,
        true,
      );
      const label = (yield* m.labels([accountId]))[0];
      assert.ok(label);
      assert.deepStrictEqual((yield* store.getMessage(`${accountId}/one`)).labels, [
        "INBOX",
        label.id,
      ]);
      assert.deepStrictEqual((yield* store.getMessage(`${accountId}/two`)).labels, ["INBOX"]);
      yield* m.modifyWithUndo(
        [`${accountId}/one`],
        { kind: "label", labelId: label.id, value: false },
        true,
      );
      assert.deepStrictEqual((yield* store.getMessage(`${accountId}/one`)).labels, ["INBOX"]);
    }),
  ),
);
it.effect("cross-account destinations and creation are rejected before server writes", () =>
  fixture("gmail", (m, store, server, accountId) =>
    Effect.gen(function* () {
      const other = yield* store.upsertAccount("gmail", "other@example.com");
      yield* store.upsertMessage(other.id, incoming("foreign"));
      yield* store.replaceLabels(other.id, [{ id: "foreign-label", name: "Foreign", color: null }]);
      assert.strictEqual(
        (yield* m
          .modifyWithUndo([`${accountId}/one`], {
            kind: "move",
            labelId: "foreign-label",
            removeLabelId: "INBOX",
          })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.strictEqual(
        (yield* m
          .createLabelAndApply(accountId, "New", null, [`${other.id}/foreign`], true, "INBOX", true)
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.strictEqual(server.labels.length, 0);
      assert.strictEqual(server.pushed.length, 0);
    }),
  ),
);
it.effect(
  "Gmail visibility roundtrips through server refresh independently of favorite order",
  () =>
    fixture("gmail", (m, _store, server, accountId) =>
      Effect.gen(function* () {
        yield* m.changeLabel(accountId, { kind: "create", name: "Hidden" });
        const label = (yield* m.labels([accountId]))[0];
        assert.ok(label);
        yield* m.changeLabel(accountId, {
          kind: "visibility",
          id: label.id,
          labelListVisibility: "labelShowIfUnread",
          messageListVisibility: "hide",
        });
        yield* m.sync();
        assert.strictEqual(server.labels[0]?.labelListVisibility, "labelShowIfUnread");
        assert.strictEqual((yield* m.labels([accountId]))[0]?.messageListVisibility, "hide");
      }),
    ),
);
it.effect("system and user folders can be favorited and reordered atomically", () =>
  fixture("gmail", (m, _store, _server, accountId) =>
    Effect.gen(function* () {
      const ids = [systemFolderId("inbox"), systemFolderId("all"), systemFolderId("snoozed")];
      for (const [position, id] of ids.entries())
        yield* m.setLabelPreference({
          accountId,
          id,
          favorite: true,
          visible: true,
          color: null,
          position,
        });
      yield* m.reorderFavorites(ids.toReversed().map((id) => ({ accountId, id })));
      assert.deepStrictEqual(
        (yield* m.labelPreferences).map((p) => p.id),
        ids.toReversed(),
      );
      yield* m.reorderFavorites([
        { accountId, id: systemFolderId("inbox") },
        { accountId, id: systemFolderId("snoozed") },
      ]);
      assert.deepStrictEqual(
        (yield* m.labelPreferences).map((p) => p.id),
        ids,
      );
      const before = yield* m.labelPreferences;
      assert.strictEqual(
        (yield* m
          .reorderFavorites([
            { accountId, id: ids[0] ?? "" },
            { accountId, id: "missing" },
          ])
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.deepStrictEqual(yield* m.labelPreferences, before);
    }),
  ),
);

for (const provider of ["gmail", "outlook"] as const) {
  it.effect(
    `${provider}: rule edits require one-use confirmation and preserve intended API identity`,
    () =>
      fixture(provider, (m, _store, server, accountId) =>
        Effect.gen(function* () {
          assert.strictEqual(
            (yield* m.createFilter(accountId, rule).pipe(Effect.result))._tag,
            "Failure",
          );
          const preview = yield* m.prepareFilter(accountId, rule);
          assert.strictEqual(preview.matches.length, 2);
          assert.strictEqual(server.pushed.length, 0);
          const original = yield* m.createFilter(accountId, rule, preview.token);
          assert.strictEqual(
            (yield* m.createFilter(accountId, rule, preview.token).pipe(Effect.result))._tag,
            "Failure",
          );
          const edited = { ...rule, name: "Updated", action: { ...rule.action, archive: true } };
          const updatePreview = yield* m.prepareFilter(accountId, edited);
          const next = yield* m.updateFilter(accountId, original.id, edited, updatePreview.token);
          assert.strictEqual(next.name, "Updated");
          assert.strictEqual(server.filters.length, 1);
          assert.strictEqual(next.id === original.id, provider === "outlook");
          assert.strictEqual(
            (yield* m
              .updateFilter(accountId, next.id, edited, updatePreview.token)
              .pipe(Effect.result))._tag,
            "Failure",
          );
          yield* m.deleteFilter(accountId, next.id, true);
          assert.deepStrictEqual(server.filters, []);
        }),
      ),
  );
  it.effect(
    `${provider}: applying existing mail changes only confirmed message IDs, never newer conversation members`,
    () =>
      fixture(provider, (m, store, server, accountId) =>
        Effect.gen(function* () {
          const deleting = {
            ...rule,
            queryDeletionConfirmed: true as const,
            action: { ...EMPTY_FILTER.action, trash: true },
          };
          const preview = yield* m.prepareFilter(accountId, deleting);
          server.messages.set("after-preview", incoming("after-preview"));
          yield* store.upsertMessage(accountId, incoming("after-preview"));
          assert.strictEqual(yield* m.applyFilter(accountId, deleting, preview.token), 2);
          assert.deepStrictEqual(server.pushed.map((p) => p.providerId).toSorted(), ["one", "two"]);
          assert.ok(
            (yield* store.getMessage(`${accountId}/after-preview`)).labels.includes("INBOX"),
          );
          assert.strictEqual(
            (yield* m.applyFilter(accountId, deleting, preview.token).pipe(Effect.result))._tag,
            "Failure",
          );
        }),
      ),
  );
}
it.effect(
  "rule confirmation rejects changed actions, wrong accounts, expiration, and failed previews",
  () =>
    fixture("gmail", (m, store, server, accountId) =>
      Effect.gen(function* () {
        const preview = yield* m.prepareFilter(accountId, rule);
        const other = yield* store.upsertAccount("gmail", "other@example.com");
        assert.strictEqual(
          (yield* m.applyFilter(other.id, rule, preview.token).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.strictEqual(
          (yield* m
            .applyFilter(
              accountId,
              { ...rule, action: { ...rule.action, trash: true } },
              preview.token,
            )
            .pipe(Effect.result))._tag,
          "Failure",
        );
        yield* TestClock.adjust("5 minutes");
        assert.strictEqual(
          (yield* m.applyFilter(accountId, rule, preview.token).pipe(Effect.result))._tag,
          "Failure",
        );
        server.failNext = new ProviderError({ message: "offline" });
        assert.strictEqual(
          (yield* m.prepareFilter(accountId, rule).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.strictEqual(server.pushed.length, 0);
      }),
    ),
);
it.effect("truncated rule previews explicitly bound the confirmed apply to 200 messages", () =>
  fixture("gmail", (m, store, server, accountId) =>
    Effect.gen(function* () {
      server.searchResults = Array.from({ length: 205 }, (_, i) =>
        incoming(`match-${i}`, { threadId: `thread-${i}` }),
      );
      const preview = yield* m.prepareFilter(accountId, rule);
      assert.strictEqual(preview.truncated, true);
      assert.strictEqual(preview.matches.length, 200);
      yield* store.deleteMessage(accountId, "match-0");
      assert.strictEqual(yield* m.applyFilter(accountId, rule, preview.token), 199);
      assert.strictEqual(server.pushed.length, 199);
    }),
  ),
);

it("English and Chinese reminder phrases use local calendar days and reject invalid or past times", () => {
  const now = new Date(2026, 9, 2, 14, 30).getTime();
  for (const [phrase, expected] of [
    ["1 week", new Date(2026, 9, 9, 14, 30)],
    ["in 2d", new Date(2026, 9, 4, 14, 30)],
    ["tomorrow 9am", new Date(2026, 9, 3, 9)],
    ["next monday", new Date(2026, 9, 5, 9)],
    ["明天上午9点", new Date(2026, 9, 3, 9)],
    ["下周一", new Date(2026, 9, 5, 9)],
    ["两天后", new Date(2026, 9, 4, 14, 30)],
    ["一周后", new Date(2026, 9, 9, 14, 30)],
    ["明天下午3点30分", new Date(2026, 9, 3, 15, 30)],
    ["明天18点30分", new Date(2026, 9, 3, 18, 30)],
    ["tomorrow 12am", new Date(2026, 9, 3, 0)],
    ["tomorrow 12pm", new Date(2026, 9, 3, 12)],
    ["今天晚上12点", new Date(2026, 9, 3, 0)],
    ["晚上12点", new Date(2026, 9, 3, 0)],
    ["半夜12点", new Date(2026, 9, 3, 0)],
    ["明天晚上12点", new Date(2026, 9, 4, 0)],
    ["明天半夜12点", new Date(2026, 9, 4, 0)],
    ["今天晚上12点30分", new Date(2026, 9, 3, 0, 30)],
  ] satisfies [string, Date][])
    assert.strictEqual(parseSnoozeTime(phrase, now), expected.getTime(), phrase);
  for (const phrase of [
    "",
    "0d",
    "in -2d",
    "tomorrow 25:00",
    "明天上午13点",
    "today 9am",
    "nonsense",
    "tomorrow 9:60",
  ])
    assert.strictEqual(parseSnoozeTime(phrase, now), null, phrase);
  vi.stubEnv("TZ", "America/New_York");
  const beforeDST = new Date(2026, 2, 7, 9).getTime();
  assert.strictEqual(parseSnoozeTime("1d", beforeDST), new Date(2026, 2, 8, 9).getTime());
  assert.strictEqual((parseSnoozeTime("1d", beforeDST) ?? 0) - beforeDST, 23 * 60 * 60_000);
});
it.effect(
  "migration 20 preserves old label preferences and FTS rows; visibility and order survive reopening",
  () =>
    Effect.gen(function* () {
      const directory = mkdtempSync(join(tmpdir(), "openmail-organizing-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
      );
      const filename = join(directory, "mail.db");
      const db = new DatabaseSync(filename);
      for (const migration of MIGRATIONS.slice(0, 18)) applyNativeMigration(db, migration);
      db.exec("PRAGMA user_version=18");
      db.prepare("INSERT INTO accounts(id,provider,email,created_at) VALUES(?,?,?,?)").run(
        "gmail:me",
        "gmail",
        "me@example.com",
        1,
      );
      db.prepare("INSERT INTO labels(account_id,id,name,color) VALUES(?,?,?,?)").run(
        "gmail:me",
        "old",
        "Old",
        null,
      );
      db.prepare(
        "INSERT INTO label_preferences(account_id,id,visible,favorite,color) VALUES(?,?,?,?,?)",
      ).run("gmail:me", "old", 0, 1, null);
      db.close();
      const layer = () =>
        StoreLive.pipe(
          Layer.provide(
            databaseLayer(filename, { vectorExtension: null }).pipe(Layer.provide(NodeSystem)),
          ),
        );
      yield* Effect.gen(function* () {
        const store = yield* Store;
        assert.strictEqual((yield* store.labelPreferences)[0]?.visible, false);
        yield* store.saveFilterRestoration({
          id: "backup",
          accountId: "gmail:me",
          originalId: "old-rule",
          input: rule,
          definition: { criteria: { from: "alice" }, action: { removeLabelIds: ["UNREAD"] } },
        });
        yield* store.replaceLabels("gmail:me", [
          {
            id: "old",
            name: "Old",
            color: null,
            labelListVisibility: "labelHide",
            messageListVisibility: "hide",
          },
        ]);
        yield* store.setLabelPreference({
          accountId: "gmail:me",
          id: "old",
          visible: false,
          favorite: true,
          color: null,
          position: 2,
        });
        yield* store.upsertMessage("gmail:me", incoming("indexed"));
        yield* store.upsertMessage("gmail:me", incoming("indexed", { bodyText: "updated report" }));
        assert.strictEqual(
          (yield* store.listThreads({ mailbox: "all", search: "updated" })).length,
          1,
        );
      }).pipe(Effect.provide(layer()));
      yield* Effect.gen(function* () {
        const store = yield* Store;
        assert.strictEqual((yield* store.labelPreferences)[0]?.position, 2);
        const backups = yield* store.filterRestorations("gmail:me");
        assert.strictEqual(backups[0]?.originalId, "old-rule");
        assert.deepStrictEqual(backups[0]?.definition, {
          criteria: { from: "alice" },
          action: { removeLabelIds: ["UNREAD"] },
        });
        assert.strictEqual((yield* store.listLabels())[0]?.labelListVisibility, "labelHide");
        assert.strictEqual((yield* store.listLabels())[0]?.messageListVisibility, "hide");
        assert.strictEqual(
          (yield* store.listThreads({ mailbox: "all", search: "updated" })).length,
          1,
        );
      }).pipe(Effect.provide(layer()));
    }).pipe(Effect.scoped),
);

it.effect(
  "Gmail label plus skip Inbox rules load, edit and apply through the provider and mailbox",
  () => {
    const writes: { method: string; body: unknown }[] = [];
    return fixture(
      "gmail",
      (m, store, server, accountId) =>
        Effect.gen(function* () {
          const label = { id: "Label_1", name: "Reports", color: null };
          server.labels.push(label);
          yield* store.replaceLabels(accountId, [label]);
          const loaded = (yield* m.filters(accountId))[0];
          assert.ok(loaded);
          assert.notStrictEqual(loaded.editable, false);
          assert.strictEqual(loaded.action.archive, true);
          assert.strictEqual(loaded.action.label, label.id);
          const edited = { ...loaded, action: { ...loaded.action, markRead: true } };
          const preview = yield* m.prepareFilter(accountId, edited);
          const updated = yield* m.updateFilter(accountId, loaded.id, edited, preview.token);
          assert.strictEqual(updated.action.archive, true);
          assert.strictEqual(updated.action.label, label.id);
          assert.deepStrictEqual(writes.find((write) => write.method === "POST")?.body, {
            criteria: edited.criteria,
            action: { addLabelIds: ["Label_1"], removeLabelIds: ["INBOX", "UNREAD"] },
          });
          const applyPreview = yield* m.prepareFilter(accountId, updated);
          assert.strictEqual(yield* m.applyFilter(accountId, updated, applyPreview.token), 2);
          assert.ok(
            [...server.messages.values()].every(
              (message) => message.labels.includes(label.id) && !message.labels.includes("INBOX"),
            ),
          );
        }),
      (adapter) => {
        let filters: (GmailRuleDefinition & { readonly id: string })[] = [
          {
            id: "old",
            criteria: { from: "alice@example.com" },
            action: { addLabelIds: ["Label_1"], removeLabelIds: ["INBOX"] },
          },
        ];
        const settings = makeGmailSettings(
          (_id, schema, path) =>
            Schema.decodeUnknownEffect(schema)(
              path === "/settings/filters" ? { filter: filters } : filters[0],
            ).pipe(Effect.orDie),
          (_id, method, _path, body) =>
            Effect.sync(() => {
              writes.push({ method, body });
              if (method === "DELETE") {
                filters = [];
                return null;
              }
              const definition = Schema.decodeUnknownSync(
                Schema.Struct({
                  criteria: Schema.Struct({ from: Schema.String }),
                  action: Schema.Struct({
                    addLabelIds: Schema.Array(Schema.String),
                    removeLabelIds: Schema.Array(Schema.String),
                  }),
                }),
              )(body);
              const filter = { id: "new", ...definition };
              filters.push(filter);
              return filter;
            }),
        );
        return { ...adapter, ...settings };
      },
    );
  },
);

for (const provider of ["gmail", "outlook"] as const) {
  it.effect(`${provider}: trash stays exclusive and Outlook has only one destination`, () =>
    fixture(provider, (m, store, server, accountId) =>
      Effect.gen(function* () {
        const label = { id: "Label_1", name: "Reports", color: null };
        yield* store.replaceLabels(accountId, [label]);
        const combinations = [
          { archive: false, trash: true, label: label.id },
          { archive: true, trash: true, label: null },
          ...(provider === "outlook" ? [{ archive: true, trash: false, label: label.id }] : []),
        ];
        for (const action of combinations)
          assert.strictEqual(
            (yield* m
              .prepareFilter(accountId, { ...rule, action: { ...rule.action, ...action } })
              .pipe(Effect.result))._tag,
            "Failure",
          );
        assert.deepStrictEqual(server.searched, []);
      }),
    ),
  );
}

it.effect(
  "an already recovered rule clears its backup before invalid label or preview checks",
  () =>
    fixture("gmail", (m, store, server, accountId) =>
      Effect.gen(function* () {
        const original = { ...rule, action: { ...rule.action, label: "Label_missing" } };
        const backup = {
          id: "backup",
          accountId,
          originalId: "old",
          input: original,
          definition: {
            criteria: { from: "alice@example.com" },
            action: { addLabelIds: ["Label_missing"], removeLabelIds: ["UNREAD"] },
          },
        };
        yield* store.saveFilterRestoration(backup);
        server.filters.push({ ...original, name: "Renamed", id: "already-restored" });
        assert.deepStrictEqual(yield* m.prepareFilterRestoration(accountId, backup.id), {
          kind: "complete",
        });
        assert.deepStrictEqual(yield* m.filterRestorations(accountId), []);
        yield* store.saveFilterRestoration(backup);
        assert.strictEqual(
          (yield* m.restoreFilter(accountId, backup.id, "expired-preview")).id,
          "already-restored",
        );
        assert.deepStrictEqual(yield* m.filterRestorations(accountId), []);
        assert.strictEqual(server.filters.length, 1);
        assert.deepStrictEqual(server.searched, []);
      }),
    ),
);

it.effect(
  "recovery rechecks the server after preview and never creates an identical rule twice",
  () =>
    fixture("gmail", (m, store, server, accountId) =>
      Effect.gen(function* () {
        yield* store.saveFilterRestoration({
          id: "backup",
          accountId,
          originalId: "old",
          input: rule,
          definition: {
            criteria: { from: "alice@example.com" },
            action: { removeLabelIds: ["UNREAD"] },
          },
        });
        const prepared = yield* m.prepareFilterRestoration(accountId, "backup");
        assert.strictEqual(prepared.kind, "preview");
        if (prepared.kind !== "preview") return;
        server.filters.push({ ...rule, name: "Manual recovery", id: "manual" });
        assert.strictEqual(
          (yield* m.restoreFilter(accountId, "backup", prepared.preview.token)).id,
          "manual",
        );
        assert.strictEqual(server.filters.length, 1);
        assert.deepStrictEqual(yield* m.filterRestorations(accountId), []);
      }),
    ),
);

it.effect("a lossy rule projection or failed server lookup cannot erase a recovery copy", () =>
  fixture("gmail", (m, store, server, accountId) =>
    Effect.gen(function* () {
      yield* store.saveFilterRestoration({
        id: "backup",
        accountId,
        originalId: "old",
        input: rule,
        definition: {
          criteria: { from: "alice@example.com" },
          action: { removeLabelIds: ["UNREAD"] },
        },
      });
      server.filters.push({ ...rule, id: "unsupported", editable: false });
      const prepared = yield* m.prepareFilterRestoration(accountId, "backup");
      assert.strictEqual(prepared.kind, "preview");
      assert.strictEqual((yield* m.filterRestorations(accountId)).length, 1);
      server.failNext = new ProviderError({ message: "offline" });
      assert.strictEqual(
        (yield* m.prepareFilterRestoration(accountId, "backup").pipe(Effect.result))._tag,
        "Failure",
      );
      assert.strictEqual((yield* m.filterRestorations(accountId)).length, 1);
    }),
  ),
);

it.effect(
  "discarding a recovery copy requires confirmation, is account scoped and leaves server rules unchanged",
  () =>
    fixture("gmail", (m, store, server, accountId) =>
      Effect.gen(function* () {
        yield* store.saveFilterRestoration({
          id: "backup",
          accountId,
          originalId: "old",
          input: rule,
          definition: {},
        });
        server.filters.push({ ...rule, id: "server-rule" });
        assert.strictEqual(
          (yield* m.discardFilterRestoration(accountId, "backup", false).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.strictEqual((yield* m.filterRestorations(accountId)).length, 1);
        const other = yield* store.upsertAccount("gmail", "other@example.com");
        yield* m.discardFilterRestoration(other.id, "backup", true);
        assert.strictEqual((yield* m.filterRestorations(accountId)).length, 1);
        yield* m.discardFilterRestoration(accountId, "backup", true);
        assert.deepStrictEqual(yield* m.filterRestorations(accountId), []);
        assert.strictEqual(server.filters.length, 1);
        assert.deepStrictEqual(server.searched, []);
      }),
    ),
);
