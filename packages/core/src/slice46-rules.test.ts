import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { makeOutlookSettings } from "./outlook-settings.js";
import { EMPTY_FILTER, sameFilterRule } from "./organization.js";
import { Mailbox } from "./mailbox.js";
import { fakeServer, TestMailbox } from "./platform/node/testing.js";
import { ProviderError } from "./errors.js";
import type { Account } from "./domain.js";

it.effect("Graph rules preserve and clear supported exceptions and stopProcessingRules", () => {
  let rule: unknown = {
    id: "one",
    displayName: "Rule",
    conditions: { subjectContains: ["Travel"] },
    exceptions: {
      senderContains: ["exclude@"],
      recipientContains: ["friend@"],
      subjectContains: ["Skip"],
      hasAttachments: true,
      bodyOrSubjectContains: ["ignore"],
    },
    actions: { markAsRead: true, stopProcessingRules: true },
  };
  const writes: unknown[] = [];
  const adapter = makeOutlookSettings<ProviderError>(
    (_id, schema, path) =>
      Schema.decodeUnknownEffect(schema)(
        path === "/me/mailFolders/inbox/messageRules" ? { value: [] } : rule,
      ).pipe(Effect.orDie),
    (_id, _method, _path, body) =>
      Effect.sync(() => {
        writes.push(body);
        rule = {
          id: "one",
          ...Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(body),
        };
        return rule;
      }),
  );
  const account: Account = {
    id: "outlook:me@example.com",
    provider: "outlook",
    email: "me@example.com",
    color: null,
    profileId: null,
    needsReauth: false,
    createdAt: 0,
    lastSyncedAt: null,
    lastSyncError: null,
  };
  return Effect.gen(function* () {
    const created = yield* adapter.createFilter(account, {
      ...EMPTY_FILTER,
      name: "Rule",
      criteria: {
        ...EMPTY_FILTER.criteria,
        subject: "Travel",
        exceptFrom: "exclude@",
        exceptTo: "friend@",
        exceptSubject: "Skip",
        exceptAttachment: true,
        notWords: "ignore",
      },
      action: { ...EMPTY_FILTER.action, markRead: true, stopProcessing: true },
    });
    assert.notStrictEqual(created.editable, false);
    assert.strictEqual(created.criteria.exceptAttachment, true);
    const updated = yield* adapter.updateFilter(account, "one", created);
    assert.ok(sameFilterRule(created, updated));
    const cleared = yield* adapter.updateFilter(account, "one", {
      ...created,
      criteria: { ...EMPTY_FILTER.criteria, subject: "Travel" },
      action: { ...EMPTY_FILTER.action, markRead: true, stopProcessing: false },
    });
    assert.strictEqual(cleared.criteria.exceptFrom, undefined);
    assert.strictEqual(cleared.criteria.exceptAttachment, undefined);
    assert.strictEqual(cleared.action.stopProcessing, false);
    const parsed = Schema.decodeUnknownSync(
      Schema.Struct({ exceptions: Schema.Record(Schema.String, Schema.Unknown) }),
    )(writes[2]);
    assert.deepStrictEqual(parsed.exceptions, {});
  });
});

it.effect(
  "Outlook refuses no-attachment exceptions in preview preparation and provider writes",
  () => {
    const server = fakeServer("me@outlook.com");
    return Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const account = yield* mailbox.connect({ provider: "outlook" });
      yield* mailbox.sync();
      const input = {
        ...EMPTY_FILTER,
        name: "Unsafe",
        criteria: { ...EMPTY_FILTER.criteria, subject: "Travel", exceptAttachment: false },
        action: { ...EMPTY_FILTER.action, markRead: true },
      };
      assert.strictEqual(
        (yield* mailbox.prepareFilter(account.id, input).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.strictEqual(
        (yield* mailbox.createFilter(account.id, input).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.strictEqual(
        (yield* mailbox.previewFilter(account.id, input.criteria).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.deepStrictEqual(server.filters, []);
      let calls = 0;
      const get = <A>(_id: string, _schema: Schema.Decoder<A>, _path: string) =>
        Effect.die("Unexpected provider read");
      const adapter = makeOutlookSettings<ProviderError>(get, () =>
        Effect.sync(() => {
          calls++;
          return {};
        }),
      );
      assert.strictEqual(
        (yield* adapter.createFilter(account, input).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.strictEqual(
        (yield* adapter.updateFilter(account, "one", input).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.strictEqual(calls, 0);
    }).pipe(Effect.provide(TestMailbox({ outlook: server })));
  },
);
