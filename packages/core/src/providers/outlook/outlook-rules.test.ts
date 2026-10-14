import { assert, it } from "@effect/vitest";
import { EMPTY_FILTER } from "../../domain/organization.js";
import { fakeHttp } from "../../platform/node/fake-http.js";
import { Effect, Schema } from "effect";
import { account, run } from "../../../test-support/outlook-fixtures.js";
it.live("Outlook uncertain rule creation matches the complete definition", () =>
  Effect.gen(function* () {
    let posted = false;
    const http = fakeHttp({
      "GET /me/mailFolders/inbox/messageRules": () => ({
        json: {
          value: posted
            ? [
                {
                  id: "found",
                  displayName: "Rule",
                  sequence: 1,
                  conditions: { subjectContains: ["hello"] },
                  actions: {},
                },
              ]
            : [],
        },
      }),
      "POST /me/mailFolders/inbox/messageRules": () => {
        const status = posted ? 200 : 503;
        posted = true;
        return {
          status,
          json: {
            id: "found",
            displayName: "Rule",
            conditions: { subjectContains: ["hello"] },
            actions: {},
          },
        };
      },
    });
    const rule = yield* run(http, (a) =>
      a.createFilter(account, {
        ...EMPTY_FILTER,
        name: "Rule",
        criteria: { ...EMPTY_FILTER.criteria, subject: "hello" },
      }),
    );
    assert.strictEqual(rule.id, "found");
    assert.strictEqual(http.calls.filter((c) => c.method === "POST").length, 1);
  }),
);

it.effect("Graph inbox rules map conditions and actions, allocate sequence, and delete", () =>
  Effect.gen(function* () {
    const rule = {
      id: "r1",
      displayName: "Reports",
      sequence: 5,
      conditions: { senderContains: ["alice"], subjectContains: ["Report"], hasAttachments: true },
      actions: { markAsRead: true, moveToFolder: "archive-id" },
    };
    const http = fakeHttp({
      "GET /me/mailFolders/inbox/messageRules": { json: { value: [rule] } },
      "POST /me/mailFolders/inbox/messageRules": { json: rule },
      "GET /me/mailFolders/archive": { json: { id: "archive-id" } },
      "DELETE /me/mailFolders/inbox/messageRules/r1": { status: 204 },
    });
    yield* run(http, (a) =>
      Effect.gen(function* () {
        assert.strictEqual((yield* a.filters(account))[0]?.name, "Reports");
        yield* a.createFilter(account, {
          name: "Reports",
          criteria: { from: "alice", to: "", subject: "Report", query: "", hasAttachment: true },
          action: { archive: true, markRead: true, star: false, trash: false, label: null },
        });
        yield* a.deleteFilter(account, "r1");
      }),
    );
    assert.deepStrictEqual(http.calls.find((c) => c.method === "POST")?.body, {
      displayName: "Reports",
      sequence: 6,
      isEnabled: true,
      conditions: rule.conditions,
      actions: rule.actions,
    });
  }),
);

it.effect("Graph scheduled automatic replies use UTC dates and contacts-only", () =>
  Effect.gen(function* () {
    const settings = {
      status: "scheduled",
      scheduledStartDateTime: { dateTime: "2026-09-30T09:00:00.000", timeZone: "UTC" },
      scheduledEndDateTime: { dateTime: "2026-10-01T09:00:00.000", timeZone: "UTC" },
      externalAudience: "contactsOnly",
      internalReplyMessage: "<p>Back tomorrow</p>",
      externalReplyMessage: "<p>Back tomorrow</p>",
    };
    const http = fakeHttp({
      "GET /me/mailboxSettings/automaticRepliesSetting": { json: settings },
      "PATCH /me/mailboxSettings": { status: 204 },
    });
    yield* run(http, (a) =>
      Effect.gen(function* () {
        const v = yield* a.vacation(account);
        assert.strictEqual(v.start, Date.parse("2026-09-30T09:00:00Z"));
        assert.strictEqual(v.body, "Back tomorrow");
        yield* a.setVacation(account, v);
      }),
    );
    const body = Schema.decodeUnknownSync(
      Schema.Struct({
        automaticRepliesSetting: Schema.Struct({
          externalAudience: Schema.String,
          status: Schema.String,
          scheduledStartDateTime: Schema.Struct({
            dateTime: Schema.String,
            timeZone: Schema.String,
          }),
        }),
      }),
    )(http.calls.at(-1)?.body);
    assert.strictEqual(body.automaticRepliesSetting.externalAudience, "contactsOnly");
    assert.strictEqual(body.automaticRepliesSetting.status, "scheduled");
    assert.deepStrictEqual(
      body.automaticRepliesSetting.scheduledStartDateTime,
      settings.scheduledStartDateTime,
    );
  }),
);

it.effect(
  "Outlook vacation saves preserve all three audiences and the distinct internal HTML",
  () =>
    Effect.gen(function* () {
      for (const audience of ["none", "contactsOnly", "all"]) {
        const internal = "<p>Internal <b>reply</b></p>";
        const external = "<p>External reply</p>";
        const http = fakeHttp({
          "GET /me/mailboxSettings/automaticRepliesSetting": {
            json: {
              status: "alwaysEnabled",
              externalAudience: audience,
              internalReplyMessage: internal,
              externalReplyMessage: external,
            },
          },
          "PATCH /me/mailboxSettings": { status: 204 },
        });
        yield* run(http, (a) =>
          Effect.gen(function* () {
            const value = yield* a.vacation(account);
            yield* a.setVacation(account, { ...value, enabled: false });
          }),
        );
        const body = Schema.decodeUnknownSync(
          Schema.Struct({
            automaticRepliesSetting: Schema.Struct({
              externalAudience: Schema.String,
              internalReplyMessage: Schema.String,
              externalReplyMessage: Schema.String,
            }),
          }),
        )(http.calls.at(-1)?.body);
        assert.strictEqual(body.automaticRepliesSetting.externalAudience, audience);
        assert.strictEqual(body.automaticRepliesSetting.internalReplyMessage, internal);
        assert.strictEqual(body.automaticRepliesSetting.externalReplyMessage, external);
      }
    }),
);

it.effect(
  "Outlook legacy vacation callers cannot widen external audience or replace internal replies",
  () => {
    const internal = "<p>Internal only</p>";
    const http = fakeHttp({
      "GET /me/mailboxSettings/automaticRepliesSetting": {
        json: {
          status: "alwaysEnabled",
          externalAudience: "none",
          internalReplyMessage: internal,
          externalReplyMessage: "<p>External</p>",
        },
      },
      "PATCH /me/mailboxSettings": { status: 204 },
    });
    return run(http, (a) =>
      a.setVacation(account, {
        enabled: false,
        start: null,
        end: null,
        subject: "",
        body: "External",
        contactsOnly: false,
      }),
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const body = Schema.decodeUnknownSync(
            Schema.Struct({
              automaticRepliesSetting: Schema.Struct({
                externalAudience: Schema.String,
                internalReplyMessage: Schema.String,
              }),
            }),
          )(http.calls.at(-1)?.body);
          assert.strictEqual(body.automaticRepliesSetting.externalAudience, "none");
          assert.strictEqual(body.automaticRepliesSetting.internalReplyMessage, internal);
        }),
      ),
    );
  },
);

it.effect("Graph edits a rule with PATCH without resetting its sequence or enabled state", () =>
  Effect.gen(function* () {
    const original = {
      id: "r1",
      displayName: "Old",
      sequence: 7,
      isEnabled: false,
      conditions: { senderContains: ["alice"] },
      actions: { markAsRead: true },
    };
    const http = fakeHttp({
      "GET /me/mailFolders/inbox/messageRules/r1": { json: original },
      "PATCH /me/mailFolders/inbox/messageRules/r1": { json: { ...original, displayName: "New" } },
    });
    const result = yield* run(http, (a) =>
      a.updateFilter(account, "r1", {
        name: "New",
        criteria: { from: "bob", to: "", subject: "", query: "", hasAttachment: false },
        action: { archive: false, markRead: true, star: false, trash: false, label: null },
      }),
    );
    assert.strictEqual(result.id, "r1");
    assert.deepStrictEqual(
      http.calls.filter((c) => c.method === "PATCH").map((c) => c.body),
      [
        {
          displayName: "New",
          conditions: { senderContains: ["bob"] },
          actions: { markAsRead: true },
        },
      ],
    );
    assert.strictEqual(
      http.calls.some((c) => c.method === "DELETE" || c.method === "POST"),
      false,
    );
  }),
);

it.effect("Graph rejects replacing unsupported compound rule conditions before PATCH", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /me/mailFolders/inbox/messageRules/r1": {
        json: {
          id: "r1",
          displayName: "Compound",
          conditions: { senderContains: ["alice", "bob"], importance: "high" },
          actions: { markAsRead: true },
        },
      },
    });
    const result = yield* run(http, (a) =>
      a
        .updateFilter(account, "r1", {
          name: "Changed",
          criteria: { from: "bob", to: "", subject: "", query: "", hasAttachment: false },
          action: { archive: false, markRead: true, star: false, trash: false, label: null },
        })
        .pipe(Effect.result),
    );
    assert.strictEqual(result._tag, "Failure");
    assert.strictEqual(http.calls.length, 1);
  }),
);

it.effect("Outlook archive-folder rules roundtrip as archive actions and remain deletable", () =>
  Effect.gen(function* () {
    const rule = {
      id: "archive-rule",
      displayName: "Archive",
      conditions: { senderContains: ["alice"] },
      actions: { moveToFolder: "archive-id" },
    };
    const http = fakeHttp({
      "GET /me/mailFolders/archive": { json: { id: "archive-id" } },
      "GET /me/mailFolders/inbox/messageRules": { json: { value: [rule] } },
      "GET /me/mailFolders/inbox/messageRules/archive-rule": { json: rule },
      "PATCH /me/mailFolders/inbox/messageRules/archive-rule": { json: rule },
      "DELETE /me/mailFolders/inbox/messageRules/archive-rule": { status: 204 },
    });
    yield* run(http, (adapter) =>
      Effect.gen(function* () {
        const current = (yield* adapter.filters(account))[0];
        assert.ok(current);
        assert.strictEqual(current.action.archive, true);
        assert.strictEqual(current.action.label, null);
        const edited = yield* adapter.updateFilter(account, current.id, current);
        assert.strictEqual(edited.action.archive, true);
        assert.strictEqual(edited.action.label, null);
        yield* adapter.deleteFilter(account, current.id);
      }),
    );
    assert.deepStrictEqual(http.calls.find((call) => call.method === "PATCH")?.body, {
      displayName: "Archive",
      conditions: { senderContains: ["alice"] },
      actions: { moveToFolder: "archive-id" },
    });
  }),
);

it.effect("Outlook rules with delete and another destination are not offered for editing", () => {
  const actions = [
    { delete: true, moveToFolder: "archive-id" },
    { delete: true, moveToFolder: "custom-id" },
    { delete: true },
    { moveToFolder: "archive-id" },
  ];
  const http = fakeHttp({
    "GET /me/mailFolders/archive": { json: { id: "archive-id" } },
    "GET /me/mailFolders/inbox/messageRules": {
      json: {
        value: actions.map((action, index) => ({
          id: String(index),
          displayName: "Rule",
          conditions: { senderContains: ["alice"] },
          actions: action,
        })),
      },
    },
  });
  return run(http, (adapter) => adapter.filters(account)).pipe(
    Effect.tap((rules) =>
      Effect.sync(() => {
        assert.deepStrictEqual(
          rules.map((rule) => rule.editable !== false),
          [false, false, true, true],
        );
      }),
    ),
  );
});

it.effect("Graph extended rules preserve native word exclusions, size and importance", () =>
  Effect.gen(function* () {
    const rule = {
      id: "extended",
      displayName: "Budget",
      conditions: { bodyOrSubjectContains: ["budget"], withinSizeRange: { minimumSize: 1024 } },
      exceptions: { bodyOrSubjectContains: ["private"] },
      actions: { markImportance: "high", moveToFolder: "destination" },
    };
    const http = fakeHttp({
      "GET /me/mailFolders/inbox/messageRules": { json: { value: [] } },
      "POST /me/mailFolders/inbox/messageRules": { json: rule },
      "GET /me/mailFolders/archive": { json: { id: "archive-id" } },
    });
    const saved = yield* run(http, (adapter) =>
      adapter.createFilter(account, {
        name: "Budget",
        criteria: {
          from: "",
          to: "",
          subject: "",
          query: "",
          hasAttachment: false,
          hasWords: "budget",
          notWords: "private",
          size: 1_048_576,
          sizeComparison: "larger",
        },
        action: {
          archive: false,
          markRead: false,
          star: false,
          trash: false,
          label: "destination",
          important: true,
        },
      }),
    );
    assert.deepStrictEqual(http.calls.find((call) => call.method === "POST")?.body, {
      displayName: "Budget",
      sequence: 1,
      isEnabled: true,
      conditions: rule.conditions,
      exceptions: rule.exceptions,
      actions: rule.actions,
    });
    assert.notStrictEqual(saved.editable, false);
    assert.strictEqual(saved.criteria.hasWords, "budget");
    assert.strictEqual(saved.criteria.notWords, "private");
    assert.strictEqual(saved.criteria.size, 1_048_576);
    assert.strictEqual(saved.action.important, true);
  }),
);
