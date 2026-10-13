import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { makeGmail } from "../gmail.js";
import { makeOutlook } from "../outlook.js";
import { Mailbox } from "./mailbox.js";
import { Store } from "../services.js";
import {
  EMPTY_FILTER,
  sameFilterRule,
  MESSAGE_ACTION_FLAGS,
  type FilterCriteria,
  type FilterAction,
  type OutlookRulePredicates,
} from "../domain/organization.js";
import { labelOps } from "./mailbox-organization.js";
import { GraphMessage } from "../outlook/graph.js";
import { expandedAttachments, parseGraphMessage } from "../outlook/parse.js";
import { evaluateOutlookRule } from "../outlook-rules.js";
import { filterQuery, gmailSearch } from "../search.js";
import { fakeHttp } from "../platform/node/fake-http.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import { account, incoming, fakeServer, TestMailbox } from "../platform/node/testing.js";

const outlookAccount = account("outlook");
const gmailAccount = account("gmail");
const platform = MemoryPlatform({
  secrets: { [outlookAccount.id]: "refresh", [gmailAccount.id]: "refresh" },
  config: {
    microsoft: { clientId: "client" },
    google: { clientId: "client", clientSecret: "secret" },
  },
});
const ObjectFields = Schema.Record(Schema.String, Schema.Unknown);
const Definition = Schema.Struct({
  conditions: ObjectFields,
  exceptions: Schema.optionalKey(ObjectFields),
  actions: ObjectFields,
});

const additionalPredicates: readonly OutlookRulePredicates[] = [
  { bodyContains: ["literal OR text"] },
  { headerContains: ["X-Custom: value"] },
  ...(["low", "normal", "high"] as const).map((importance) => ({ importance })),
  ...(["normal", "personal", "private", "confidential"] as const).map((sensitivity) => ({
    sensitivity,
  })),
  { isAutomaticReply: true },
  { sentToMe: true },
  { sentOnlyToMe: true },
  { sentCcMe: true },
  { sentToOrCcMe: true },
  { notSentToMe: true },
  { withinSizeRange: { minimumSize: 1, maximumSize: 2 } },
  { withinSizeRange: { minimumSize: 1 } },
  { withinSizeRange: { maximumSize: 2 } },
  ...MESSAGE_ACTION_FLAGS.map((messageActionFlag) => ({ messageActionFlag })),
];

for (const area of ["conditions", "exceptions"] as const) {
  for (const predicate of additionalPredicates) {
    it.effect(`Graph ${area} writes and round-trips ${JSON.stringify(predicate)}`, () => {
      let definition: unknown = {};
      const http = fakeHttp({
        "GET /me/mailFolders/inbox/messageRules": { json: { value: [] } },
        "POST /me/mailFolders/inbox/messageRules": (_url, call) => {
          definition = call.body;
          return { json: { ...Schema.decodeUnknownSync(ObjectFields)(call.body), id: "rule" } };
        },
        "GET /me/mailFolders/inbox/messageRules/rule": () => ({
          json: { ...Schema.decodeUnknownSync(ObjectFields)(definition), id: "rule" },
        }),
        "PATCH /me/mailFolders/inbox/messageRules/rule": (_url, call) => ({
          json: { ...Schema.decodeUnknownSync(ObjectFields)(call.body), id: "rule" },
        }),
      });
      return makeOutlook.pipe(
        Effect.flatMap((adapter) =>
          Effect.gen(function* () {
            const input = {
              ...EMPTY_FILTER,
              name: "Rule",
              criteria: {
                ...EMPTY_FILTER.criteria,
                ...(area === "conditions"
                  ? { outlook: predicate }
                  : { outlookExceptions: predicate }),
              },
              action: { ...EMPTY_FILTER.action, markRead: true },
            };
            const created = yield* adapter.createFilter(outlookAccount, input);
            assert.notStrictEqual(created.editable, false);
            const posted = Schema.decodeUnknownSync(Definition)(definition);
            assert.deepStrictEqual(posted[area], predicate);
            assert.deepStrictEqual(posted.actions, { markAsRead: true });
            yield* adapter.updateFilter(outlookAccount, created.id, created);
            const patched = Schema.decodeUnknownSync(Definition)(
              http.calls.find((call) => call.method === "PATCH")?.body,
            );
            assert.deepStrictEqual(patched[area], predicate);
            const cleared = {
              ...created,
              criteria: { ...EMPTY_FILTER.criteria, subject: "Still applies" },
            };
            yield* adapter.updateFilter(outlookAccount, created.id, cleared);
            const last = Schema.decodeUnknownSync(Definition)(
              http.calls.filter((call) => call.method === "PATCH").at(-1)?.body,
            );
            assert.deepStrictEqual(last.conditions, { subjectContains: ["Still applies"] });
            assert.deepStrictEqual(last.exceptions ?? {}, {});
          }),
        ),
        Effect.provide(Layer.mergeAll(http.layer, platform)),
      );
    });
  }
}

const actionCases: readonly {
  action: Partial<FilterAction>;
  expected: Readonly<Record<string, unknown>>;
}[] = [
  ...(["low", "normal", "high"] as const).map((markImportance) => ({
    action: { markImportance },
    expected: { markImportance },
  })),
  {
    action: { assignCategories: ["Clients", "Budget"] },
    expected: { assignCategories: ["Clients", "Budget"] },
  },
  { action: { copyToFolder: "copy/folder" }, expected: { copyToFolder: "copy/folder" } },
  { action: { trash: true }, expected: { delete: true } },
  { action: { markRead: true }, expected: { markAsRead: true } },
  { action: { stopProcessing: true }, expected: { stopProcessingRules: true } },
  { action: { stopProcessing: false }, expected: { stopProcessingRules: false } },
];
for (const { action, expected } of actionCases) {
  it.effect(`Graph actions write and round-trip ${JSON.stringify(expected)}`, () => {
    let original: unknown = {};
    const http = fakeHttp({
      "GET /me/mailFolders/inbox/messageRules": { json: { value: [] } },
      "POST /me/mailFolders/inbox/messageRules": (_url, call) => {
        original = { ...Schema.decodeUnknownSync(ObjectFields)(call.body), id: "rule" };
        return { json: original };
      },
      "GET /me/mailFolders/inbox/messageRules/rule": () => ({ json: original }),
      "PATCH /me/mailFolders/inbox/messageRules/rule": (_url, call) => ({
        json: { ...Schema.decodeUnknownSync(ObjectFields)(call.body), id: "rule" },
      }),
    });
    return makeOutlook.pipe(
      Effect.flatMap((adapter) =>
        Effect.gen(function* () {
          const created = yield* adapter.createFilter(outlookAccount, {
            ...EMPTY_FILTER,
            name: "Rule",
            criteria: { ...EMPTY_FILTER.criteria, subject: "Budget" },
            action: { ...EMPTY_FILTER.action, ...action },
          });
          assert.notStrictEqual(created.editable, false);
          yield* adapter.updateFilter(outlookAccount, created.id, created);
          for (const call of http.calls.filter((c) => ["POST", "PATCH"].includes(c.method)))
            assert.deepStrictEqual(
              Schema.decodeUnknownSync(Definition)(call.body).actions,
              expected,
            );
        }),
      ),
      Effect.provide(Layer.mergeAll(http.layer, platform)),
    );
  });
}

it.effect(
  "Gmail edits excludeChats and arbitrary label additions/removals without losing them",
  () => {
    const definition = {
      criteria: {
        from: "",
        to: "",
        subject: "Budget",
        query: "",
        hasAttachment: false,
        excludeChats: true,
      },
      action: {
        addLabelIds: ["CATEGORY_SOCIAL", "CATEGORY_UPDATES"],
        removeLabelIds: ["Label_old", "STARRED", "SPAM"],
      },
    };
    const http = fakeHttp({
      "POST /settings/filters": (_url, call) => ({
        json: { ...Schema.decodeUnknownSync(ObjectFields)(call.body), id: "rule" },
      }),
      "GET /settings/filters/rule": { json: { ...definition, id: "rule" } },
      "DELETE /settings/filters/rule": { status: 204 },
      "GET /labels": { json: { labels: [] } },
      "GET /messages": { json: { messages: [] } },
    });
    return makeGmail.pipe(
      Effect.flatMap((adapter) =>
        Effect.gen(function* () {
          const created = yield* adapter.createFilter(gmailAccount, {
            ...EMPTY_FILTER,
            criteria: { ...EMPTY_FILTER.criteria, subject: "Budget", excludeChats: true },
            action: {
              ...EMPTY_FILTER.action,
              addLabelIds: definition.action.addLabelIds,
              removeLabelIds: definition.action.removeLabelIds,
            },
          });
          assert.notStrictEqual(created.editable, false);
          const updated = yield* adapter.updateFilter(gmailAccount, created.id, created);
          assert.strictEqual(updated.criteria.excludeChats, true);
          const posts = http.calls.filter((c) => c.method === "POST");
          for (const post of posts) {
            const body = Schema.decodeUnknownSync(
              Schema.Struct({
                criteria: ObjectFields,
                action: Schema.Struct({
                  addLabelIds: Schema.Array(Schema.String),
                  removeLabelIds: Schema.Array(Schema.String),
                }),
              }),
            )(post.body);
            assert.deepStrictEqual(body.criteria, definition.criteria);
            assert.deepStrictEqual(
              body.action.addLabelIds.toSorted(),
              definition.action.addLabelIds.toSorted(),
            );
            assert.deepStrictEqual(body.action.removeLabelIds, definition.action.removeLabelIds);
          }
          assert.ok(gmailSearch(filterQuery(updated.criteria)).includes("-is:chat"));
          yield* adapter.search(gmailAccount, filterQuery(updated.criteria));
          assert.ok(
            http.calls
              .find((call) => call.url.pathname.endsWith("/messages"))
              ?.url.searchParams.get("q")
              ?.includes("-is:chat"),
          );
        }),
      ),
      Effect.provide(Layer.mergeAll(http.layer, platform)),
    );
  },
);

for (const area of ["conditions", "exceptions"] as const) {
  for (const predicate of [
    { futurePredicate: { values: ["a", "b"] } },
    { constructor: "opaque" },
    { bodyContains: ["a", "b"] },
    { messageActionFlag: "futureFlag" },
    { withinSizeRange: { minimumSize: 1, futureBound: 2 } },
  ]) {
    it.effect(
      `Graph preserves read-only ${area} ${JSON.stringify(predicate)} without PATCH`,
      () => {
        const rule = {
          id: "rule",
          displayName: "Read only",
          [area]: predicate,
          actions: { markAsRead: true },
        };
        const snapshot = JSON.stringify(rule);
        const http = fakeHttp({
          "GET /me/mailFolders/inbox/messageRules": { json: { value: [rule] } },
          "GET /me/mailFolders/inbox/messageRules/rule": { json: rule },
        });
        return makeOutlook.pipe(
          Effect.flatMap((adapter) =>
            Effect.gen(function* () {
              const loaded = (yield* adapter.filters(outlookAccount))[0];
              assert.ok(loaded);
              assert.strictEqual(loaded.editable, false);
              const result = yield* adapter
                .updateFilter(outlookAccount, loaded.id, {
                  ...EMPTY_FILTER,
                  criteria: { ...EMPTY_FILTER.criteria, subject: "New" },
                  action: { ...EMPTY_FILTER.action, markRead: true },
                })
                .pipe(Effect.result);
              assert.strictEqual(result._tag, "Failure");
              assert.isFalse(http.calls.some((c) => c.method === "PATCH"));
              assert.strictEqual(JSON.stringify(rule), snapshot);
            }),
          ),
          Effect.provide(Layer.mergeAll(http.layer, platform)),
        );
      },
    );
  }
}

for (const actions of [
  { forwardTo: [{ emailAddress: { address: "external@example.com" } }] },
  { redirectTo: [{ emailAddress: { address: "external@example.com" } }] },
  { forwardAsAttachmentTo: [{ emailAddress: { address: "external@example.com" } }] },
  { permanentDelete: true },
  { futureAction: { values: ["a", "b"] } },
  { constructor: "opaque" },
]) {
  it.effect(`Graph risky actions remain read-only: ${JSON.stringify(actions)}`, () => {
    const rule = {
      id: "rule",
      displayName: "Read only",
      conditions: { subjectContains: ["Budget"] },
      actions,
    };
    const http = fakeHttp({
      "GET /me/mailFolders/inbox/messageRules": { json: { value: [rule] } },
      "GET /me/mailFolders/inbox/messageRules/rule": { json: rule },
    });
    return makeOutlook.pipe(
      Effect.flatMap((adapter) =>
        Effect.gen(function* () {
          const loaded = (yield* adapter.filters(outlookAccount))[0];
          assert.ok(loaded);
          assert.strictEqual(loaded.editable, false);
          assert.strictEqual(
            (yield* adapter.updateFilter(outlookAccount, loaded.id, loaded).pipe(Effect.result))
              ._tag,
            "Failure",
          );
          assert.isFalse(http.calls.some((c) => c.method === "PATCH"));
        }),
      ),
      Effect.provide(Layer.mergeAll(http.layer, platform)),
    );
  });
}

it.effect("Gmail unknown fields round-trip unchanged through saved-rule recovery", () => {
  const definition = {
    criteria: { from: "alice", futureCondition: { values: ["a", "b"] } },
    action: { addLabelIds: ["Label_old"], futureAction: "opaque" },
  };
  const http = fakeHttp({
    "GET /settings/filters": { json: { filter: [] } },
    "POST /settings/filters": (_url, call) => ({
      json: { ...Schema.decodeUnknownSync(ObjectFields)(call.body), id: "restored" },
    }),
  });
  return makeGmail.pipe(
    Effect.flatMap((adapter) =>
      Effect.gen(function* () {
        assert.ok(adapter.restoreFilter !== undefined);
        const restored = yield* adapter.restoreFilter(gmailAccount, definition);
        assert.strictEqual(restored.editable, false);
        assert.deepStrictEqual(http.calls.find((c) => c.method === "POST")?.body, definition);
      }),
    ),
    Effect.provide(Layer.mergeAll(http.layer, platform)),
  );
});

const message = incoming("match", {
  from: { name: "Alice", address: "alice@example.com" },
  to: [{ name: "Someone", address: "other@example.com" }],
  cc: [{ name: "Owner", address: outlookAccount.email }],
  subject: "Budget overview",
  bodyText: "Please call OR reply",
  size: 2048,
  labels: ["INBOX"],
});
const evaluableCases: readonly { criteria: Partial<FilterCriteria>; matches: boolean }[] = [
  { criteria: { from: "ALICE" }, matches: true },
  { criteria: { from: "Alice alice@" }, matches: false },
  { criteria: { to: "Owner me@" }, matches: false },
  { criteria: { to: outlookAccount.email }, matches: true },
  { criteria: { to: "absent" }, matches: false },
  { criteria: { hasWords: "Budget overview" }, matches: true },
  { criteria: { hasWords: "call OR reply" }, matches: true },
  { criteria: { hasWords: "Budget reply" }, matches: false },
  { criteria: { outlook: { bodyContains: ["call OR reply"] } }, matches: true },
  { criteria: { outlook: { bodyContains: ["Budget"] } }, matches: false },
  { criteria: { outlook: { sentCcMe: true } }, matches: true },
  { criteria: { outlook: { sentToMe: true } }, matches: false },
  { criteria: { outlook: { sentToOrCcMe: true } }, matches: true },
  { criteria: { outlook: { withinSizeRange: { minimumSize: 2, maximumSize: 2 } } }, matches: true },
  {
    criteria: { outlook: { withinSizeRange: { minimumSize: 3, maximumSize: 4 } } },
    matches: false,
  },
  { criteria: { outlookExceptions: { bodyContains: ["call OR reply"] } }, matches: false },
  { criteria: { outlookExceptions: { sentCcMe: true } }, matches: false },
  {
    criteria: { outlookExceptions: { withinSizeRange: { minimumSize: 2, maximumSize: 2 } } },
    matches: false,
  },
  // Either exception excludes a message; the two exceptions need not match together.
  { criteria: { exceptFrom: "alice", exceptTo: "absent" }, matches: false },
];
for (const { criteria, matches } of evaluableCases) {
  it.effect(`Outlook cached preview and confirmation agree for ${JSON.stringify(criteria)}`, () => {
    const c = { ...EMPTY_FILTER.criteria, ...criteria };
    const server = fakeServer(outlookAccount.email, [message]);
    return Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const store = yield* Store;
      const saved = yield* store.upsertAccount("outlook", outlookAccount.email);
      yield* store.upsertMessage(saved.id, message);
      yield* store.replaceSendAs(saved.id, [
        {
          accountId: saved.id,
          address: saved.email,
          name: "Owner",
          isDefault: true,
          signature: "",
        },
      ]);
      const expected = matches ? [`${saved.id}/match`] : [];
      assert.deepStrictEqual(evaluateOutlookRule(c, message, [saved.email]), {
        matches,
        unavailable: [],
      });
      assert.deepStrictEqual(
        (yield* mailbox.previewFilter(saved.id, c)).map((m) => m.id),
        expected,
      );
      const prepared = yield* mailbox.prepareFilter(saved.id, {
        ...EMPTY_FILTER,
        criteria: c,
        action: { ...EMPTY_FILTER.action, markRead: true },
      });
      assert.deepStrictEqual(
        prepared.matches.map((m) => m.id),
        expected,
      );
      assert.strictEqual(prepared.unavailable, undefined);
    }).pipe(Effect.provide(TestMailbox({ outlook: server })));
  });
}

for (const predicate of additionalPredicates.filter(
  (p) =>
    p.headerContains ||
    p.importance ||
    p.sensitivity ||
    p.isAutomaticReply ||
    p.messageActionFlag ||
    p.sentOnlyToMe ||
    p.notSentToMe,
)) {
  it.effect(
    `Uncached metadata is reported and blocks existing-mail application: ${JSON.stringify(predicate)}`,
    () => {
      const server = fakeServer(outlookAccount.email, [message]);
      return Effect.gen(function* () {
        const store = yield* Store;
        const mailbox = yield* Mailbox;
        const saved = yield* store.upsertAccount("outlook", outlookAccount.email);
        yield* store.upsertMessage(saved.id, message);
        const input = {
          ...EMPTY_FILTER,
          criteria: { ...EMPTY_FILTER.criteria, outlook: predicate },
          action: { ...EMPTY_FILTER.action, markRead: true },
        };
        assert.strictEqual(
          (yield* mailbox.previewFilter(saved.id, input.criteria).pipe(Effect.result))._tag,
          "Failure",
        );
        const prepared = yield* mailbox.prepareFilter(saved.id, input);
        assert.ok(prepared.unavailable?.length);
        assert.deepStrictEqual(prepared.matches, []);
        assert.strictEqual(
          (yield* mailbox.applyFilter(saved.id, input, prepared.token).pipe(Effect.result))._tag,
          "Failure",
        );
        const created = yield* mailbox.createFilter(saved.id, input, prepared.token);
        assert.ok(created.id);
        assert.deepStrictEqual(server.pushed, []);
      }).pipe(Effect.provide(TestMailbox({ outlook: server })));
    },
  );
}

it("Body and size previews report missing cache data instead of matching empty text or size zero", () => {
  for (const criteria of [
    { outlook: { bodyContains: ["call"] } },
    { outlook: { withinSizeRange: { minimumSize: 0 } } },
    { outlookExceptions: { bodyContains: ["ignore"] } },
    { outlookExceptions: { withinSizeRange: { maximumSize: 10 } } },
  ]) {
    const uncached = { ...message, bodyCached: false, size: undefined };
    // Construct an incoming message without an optional size key.
    const { size: _size, ...withoutSize } = uncached;
    const evaluation = evaluateOutlookRule({ ...EMPTY_FILTER.criteria, ...criteria }, withoutSize, [
      outlookAccount.email,
    ]);
    assert.ok(evaluation.unavailable.length);
  }
});

it.effect("Gmail forwarding stays read-only and cannot be replaced through the editor", () => {
  const rule = {
    id: "rule",
    criteria: { subject: "Budget" },
    action: { forward: "verified@example.com", addLabelIds: ["Label_old"] },
  };
  const http = fakeHttp({
    "GET /settings/filters": { json: { filter: [rule] } },
    "GET /settings/filters/rule": { json: rule },
  });
  return makeGmail.pipe(
    Effect.flatMap((adapter) =>
      Effect.gen(function* () {
        const loaded = (yield* adapter.filters(gmailAccount))[0];
        assert.ok(loaded);
        assert.strictEqual(loaded.editable, false);
        assert.strictEqual(
          (yield* adapter.updateFilter(gmailAccount, loaded.id, loaded).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.isFalse(http.calls.some((call) => ["POST", "DELETE"].includes(call.method)));
      }),
    ),
    Effect.provide(Layer.mergeAll(http.layer, platform)),
  );
});

for (const action of [
  { stopProcessing: true },
  { copyToFolder: "copy" },
  { assignCategories: ["Category"] },
  { markImportance: "low" as const },
]) {
  it.effect(
    `Graph server-only action cannot silently disappear when applying to existing mail: ${JSON.stringify(action)}`,
    () => {
      const server = fakeServer(outlookAccount.email, [message]);
      return Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const store = yield* Store;
        const saved = yield* store.upsertAccount("outlook", outlookAccount.email);
        yield* store.upsertMessage(saved.id, message);
        yield* store.replaceLabels(saved.id, [{ id: "copy", name: "Copy", color: null }]);
        const input = {
          ...EMPTY_FILTER,
          criteria: { ...EMPTY_FILTER.criteria, subject: "Budget" },
          action: { ...EMPTY_FILTER.action, ...action },
        };
        const preview = yield* mailbox.prepareFilter(saved.id, input);
        assert.strictEqual(
          (yield* mailbox.applyFilter(saved.id, input, preview.token).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.deepStrictEqual(server.pushed, []);
      }).pipe(Effect.provide(TestMailbox({ outlook: server })));
    },
  );
}

it.effect("Gmail label actions apply additions and removals to previewed messages", () => {
  const original = {
    ...message,
    labels: ["INBOX", "STARRED", "UNREAD", "Label_old"],
    isStarred: true,
    isUnread: true,
  };
  const server = fakeServer(gmailAccount.email, [original]);
  return Effect.gen(function* () {
    const store = yield* Store;
    const mailbox = yield* Mailbox;
    const saved = yield* store.upsertAccount("gmail", gmailAccount.email);
    yield* store.replaceLabels(saved.id, [{ id: "Label_old", name: "Old", color: null }]);
    yield* store.upsertMessage(saved.id, original);
    const input = {
      ...EMPTY_FILTER,
      criteria: { ...EMPTY_FILTER.criteria, subject: "Budget" },
      action: {
        ...EMPTY_FILTER.action,
        addLabelIds: ["CATEGORY_UPDATES"],
        removeLabelIds: ["UNREAD", "STARRED", "Label_old"],
      },
    };
    const preview = yield* mailbox.prepareFilter(saved.id, input);
    assert.strictEqual(yield* mailbox.applyFilter(saved.id, input, preview.token), 1);
    const cached = yield* store.getMessage(`${saved.id}/match`);
    assert.strictEqual(cached.isUnread, false);
    assert.strictEqual(cached.isStarred, false);
    assert.ok(cached.labels.includes("CATEGORY_UPDATES"));
    assert.isFalse(cached.labels.includes("Label_old"));
    assert.ok(server.pushed.some((entry) => entry.op.kind === "read" && entry.op.value));
    assert.ok(server.pushed.some((entry) => entry.op.kind === "star" && !entry.op.value));
  }).pipe(Effect.provide(TestMailbox({ gmail: server })));
});

it("Rule recovery comparison preserves field positions and ignores object-key order", () => {
  const left = {
    ...EMPTY_FILTER,
    criteria: { ...EMPTY_FILTER.criteria, from: "Alice", subject: "Budget" },
  };
  const swapped = {
    ...EMPTY_FILTER,
    criteria: { ...EMPTY_FILTER.criteria, from: "Budget", subject: "Alice" },
  };
  assert.isFalse(sameFilterRule(left, swapped));
  assert.isTrue(
    sameFilterRule(
      {
        ...left,
        criteria: {
          ...left.criteria,
          outlook: { sentCcMe: true, withinSizeRange: { minimumSize: 1, maximumSize: 2 } },
        },
      },
      {
        ...left,
        criteria: {
          ...left.criteria,
          outlook: { withinSizeRange: { maximumSize: 2, minimumSize: 1 }, sentCcMe: true },
        },
      },
    ),
  );
});

it.effect("Gmail raw trash-label actions retain query deletion confirmation", () => {
  const server = fakeServer(gmailAccount.email, [message]);
  return Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    const store = yield* Store;
    const saved = yield* store.upsertAccount("gmail", gmailAccount.email);
    const input = {
      ...EMPTY_FILTER,
      criteria: { ...EMPTY_FILTER.criteria, query: "Budget" },
      action: { ...EMPTY_FILTER.action, addLabelIds: ["TRASH"] },
    };
    const preview = yield* mailbox.prepareFilter(saved.id, input);
    assert.strictEqual(
      (yield* mailbox.createFilter(saved.id, input, preview.token).pipe(Effect.result))._tag,
      "Failure",
    );
    assert.strictEqual(server.filters.length, 0);
    yield* mailbox.createFilter(
      saved.id,
      { ...input, queryDeletionConfirmed: true },
      preview.token,
    );
    assert.strictEqual(server.filters.length, 1);
  }).pipe(Effect.provide(TestMailbox({ gmail: server })));
});

for (const area of ["outlook", "outlookExceptions"] as const) {
  for (const predicate of ["sentToMe", "sentCcMe", "sentToOrCcMe"] as const) {
    it.effect(
      `${area}.${predicate} needs account-scoped identities and matches cached aliases`,
      () => {
        const alias = "alias@outlook.com";
        const addressed = (id: string, email: string) =>
          incoming(id, {
            subject: "Budget",
            labels: ["INBOX"],
            to: predicate === "sentCcMe" ? [] : [{ name: "Recipient", address: email }],
            cc: predicate === "sentCcMe" ? [{ name: "Recipient", address: email }] : [],
          });
        const messages = [
          addressed("primary", outlookAccount.email),
          addressed("alias", alias),
          addressed("other", "other@example.com"),
        ];
        const server = fakeServer(outlookAccount.email, messages);
        return Effect.gen(function* () {
          const mailbox = yield* Mailbox;
          const store = yield* Store;
          const saved = yield* store.upsertAccount("outlook", outlookAccount.email);
          for (const item of messages) yield* store.upsertMessage(saved.id, item);
          const other = yield* store.upsertAccount("gmail", "other@example.com");
          yield* store.replaceSendAs(other.id, [
            { accountId: other.id, address: alias, name: "Other", isDefault: true, signature: "" },
          ]);
          const criteria = {
            ...EMPTY_FILTER.criteria,
            subject: "Budget",
            [area]: { [predicate]: true },
          };
          const input = {
            ...EMPTY_FILTER,
            criteria,
            action: { ...EMPTY_FILTER.action, markRead: true },
          };
          assert.strictEqual(
            (yield* mailbox.previewFilter(saved.id, criteria).pipe(Effect.result))._tag,
            "Failure",
          );
          const unavailable = yield* mailbox.prepareFilter(saved.id, input);
          assert.ok(unavailable.unavailable?.includes(predicate));
          assert.deepStrictEqual(unavailable.matches, []);
          assert.strictEqual(
            (yield* mailbox.applyFilter(saved.id, input, unavailable.token).pipe(Effect.result))
              ._tag,
            "Failure",
          );
          yield* store.replaceSendAs(saved.id, [
            {
              accountId: saved.id,
              address: alias.toUpperCase(),
              name: "Alias",
              isDefault: false,
              signature: "",
            },
          ]);
          const expected = (area === "outlook" ? ["alias", "primary"] : ["other"])
            .map((id) => `${saved.id}/${id}`)
            .toSorted();
          assert.deepStrictEqual(
            (yield* mailbox.previewFilter(saved.id, criteria)).map((row) => row.id).toSorted(),
            expected,
          );
          const known = yield* mailbox.prepareFilter(saved.id, input);
          assert.strictEqual(known.unavailable, undefined);
          assert.deepStrictEqual(known.matches.map((row) => row.id).toSorted(), expected);
        }).pipe(Effect.provide(TestMailbox({ outlook: server })));
      },
    );
  }
}

for (const provider of ["gmail", "outlook"] as const) {
  it.effect(
    `${provider} deletion without a query requires explicit confirmation for save and apply`,
    () => {
      const server = fakeServer("me@example.com", [message]);
      return Effect.gen(function* () {
        const store = yield* Store;
        const mailbox = yield* Mailbox;
        const saved = yield* store.upsertAccount(provider, server.email);
        const input = {
          ...EMPTY_FILTER,
          criteria: { ...EMPTY_FILTER.criteria, subject: "Budget" },
          action: { ...EMPTY_FILTER.action, trash: true },
        };
        const preview = yield* mailbox.prepareFilter(saved.id, input);
        assert.strictEqual(
          (yield* mailbox.createFilter(saved.id, input, preview.token).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.strictEqual(
          (yield* mailbox.applyFilter(saved.id, input, preview.token).pipe(Effect.result))._tag,
          "Failure",
        );
        yield* mailbox.createFilter(
          saved.id,
          { ...input, queryDeletionConfirmed: true },
          preview.token,
        );
        const confirmed = yield* mailbox.prepareFilter(saved.id, input);
        assert.strictEqual(
          yield* mailbox.applyFilter(
            saved.id,
            { ...input, queryDeletionConfirmed: true },
            confirmed.token,
          ),
          1,
        );
      }).pipe(Effect.provide(TestMailbox({ [provider]: server })));
    },
  );
}

it("Gmail system label additions and removals use read, star and importance operations", () => {
  assert.deepStrictEqual(labelOps(["UNREAD", "STARRED", "IMPORTANT", "Label_custom"], true), [
    { kind: "read", value: false },
    { kind: "star", value: true },
    { kind: "important", value: true },
    { kind: "label", labelId: "Label_custom", value: true },
  ]);
  assert.deepStrictEqual(labelOps(["UNREAD", "STARRED", "IMPORTANT"], false), [
    { kind: "read", value: true },
    { kind: "star", value: false },
    { kind: "important", value: false },
  ]);
});

it("Graph inline attachments are excluded before the rule preview evaluates hasAttachments", () => {
  for (const inlineOnly of [true, false]) {
    const raw = Schema.decodeUnknownSync(GraphMessage)({
      id: "inline",
      conversationId: "thread",
      subject: "Budget",
      body: { content: "", contentType: "text" },
      attachments: [
        { name: "inline.png", contentType: "image/png", size: 1, isInline: true },
        ...(inlineOnly
          ? []
          : [{ name: "report.pdf", contentType: "application/pdf", size: 10, isInline: false }]),
      ],
    });
    const attachments = expandedAttachments(raw) ?? [];
    const parsed = parseGraphMessage(raw, "INBOX", attachments);
    assert.deepStrictEqual(
      attachments.map((entry) => entry.filename),
      inlineOnly ? [] : ["report.pdf"],
    );
    assert.deepStrictEqual(
      evaluateOutlookRule({ ...EMPTY_FILTER.criteria, hasAttachment: true }, parsed, undefined),
      { matches: !inlineOnly, unavailable: [] },
    );
  }
});

it.effect(
  "Outlook literal word preview retains bounded candidates and reports uncached bodies",
  () => {
    const unseen = incoming("match", { subject: "Other", bodyText: "superbudget" });
    const unrelated = Array.from({ length: 201 }, (_, index) =>
      incoming(`unrelated-${index}`, { bodyText: "other", subject: "Other", date: 3000 + index }),
    );
    const server = fakeServer(outlookAccount.email, [...unrelated, unseen]);
    return Effect.gen(function* () {
      const store = yield* Store;
      const mailbox = yield* Mailbox;
      const saved = yield* store.upsertAccount("outlook", outlookAccount.email);
      yield* store.upsertMessage(saved.id, unseen);
      const criteria = { ...EMPTY_FILTER.criteria, hasWords: "budget" };
      assert.strictEqual((yield* mailbox.previewFilter(saved.id, criteria)).length, 1);
      const input = {
        ...EMPTY_FILTER,
        criteria,
        action: { ...EMPTY_FILTER.action, markRead: true },
      };
      const bounded = yield* mailbox.prepareFilter(saved.id, input);
      assert.strictEqual(bounded.truncated, true);
      assert.deepStrictEqual(bounded.matches, []);
      assert.strictEqual(server.searched[0]?.search, undefined);
      server.searchResults = [{ ...unseen, bodyCached: false }];
      const uncached = yield* mailbox.prepareFilter(saved.id, input);
      assert.ok(uncached.unavailable?.includes("bodyOrSubjectContains"));
      assert.deepStrictEqual(uncached.matches, []);
    }).pipe(Effect.provide(TestMailbox({ outlook: server })));
  },
);

it("Outlook preview cannot infer no attachments from an incomplete empty cache", () => {
  const partial = { ...message, attachments: [], bodyCached: false };
  const evaluation = evaluateOutlookRule(
    { ...EMPTY_FILTER.criteria, hasAttachment: true },
    partial,
    undefined,
  );
  assert.deepStrictEqual(evaluation.unavailable, ["hasAttachments"]);
});
