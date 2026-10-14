import { fakeHttp } from "../../platform/node/fake-http.js";
import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { makeGmailSettings } from "./gmail-settings.js";
import { ProviderError } from "../../domain/errors.js";
import { type GmailRuleDefinition, EMPTY_FILTER } from "../../domain/organization.js";
import { account, run } from "../../../test-support/gmail-fixtures.js";
it.live("an uncertain Gmail filter update matches the new rule before restoring", () =>
  Effect.gen(function* () {
    const original = {
      id: "old",
      criteria: { from: "alice" },
      action: { removeLabelIds: ["UNREAD"] },
    };
    const found = { id: "new", criteria: { from: "bob" }, action: { removeLabelIds: ["UNREAD"] } };
    let posts = 0;
    const settings = makeGmailSettings(
      (_id, schema, path) =>
        Schema.decodeUnknownEffect(schema)(
          path.endsWith("/old") ? original : { filter: [found] },
        ).pipe(Effect.orDie),
      (_id, method) =>
        method === "DELETE"
          ? Effect.void
          : Effect.suspend(() => {
              posts++;
              return posts === 1
                ? Effect.fail(new ProviderError({ message: "Lost response", status: 0 }))
                : Effect.succeed({ ...original, id: "restored" });
            }),
    );
    const result = yield* settings.updateFilter(account, "old", {
      ...EMPTY_FILTER,
      criteria: { ...EMPTY_FILTER.criteria, from: "bob" },
      action: { ...EMPTY_FILTER.action, markRead: true },
    });
    assert.strictEqual(result.id, "new");
    assert.strictEqual(posts, 1);
  }),
);

it.effect("Gmail filter actions map to labels; list/create/delete use settings filters", () =>
  Effect.gen(function* () {
    const criteria = {
      from: "ann@example.com",
      to: "",
      subject: "Report",
      query: "has:attachment",
      hasAttachment: true,
    };
    const filter = {
      id: "f1",
      criteria,
      action: { addLabelIds: ["STARRED", "Label_1"], removeLabelIds: ["UNREAD"] },
    };
    const http = fakeHttp({
      "GET /settings/filters": { json: { filter: [filter] } },
      "POST /settings/filters": { json: filter },
      "DELETE /settings/filters/f1": { status: 204 },
    });
    yield* run(http, (a) =>
      Effect.gen(function* () {
        const [existing] = yield* a.filters(account);
        assert.ok(existing);
        assert.strictEqual(existing.action.label, "Label_1");
        yield* a.createFilter(account, {
          name: "Reports",
          criteria,
          action: { archive: false, markRead: true, star: true, trash: false, label: "Label_1" },
        });
        yield* a.deleteFilter(account, "f1");
      }),
    );
    assert.deepStrictEqual(http.calls.find((c) => c.method === "POST")?.body, {
      criteria,
      action: filter.action,
    });
  }),
);

it.effect(
  "Gmail vacation roundtrips and send-as skips unverified aliases and decodes signatures",
  () =>
    Effect.gen(function* () {
      const http = fakeHttp({
        "GET /settings/vacation": {
          json: {
            enableAutoReply: true,
            startTime: "1000",
            endTime: "2000",
            responseSubject: "Away",
            responseBodyPlainText: "Back tomorrow",
            restrictToContacts: true,
          },
        },
        "PUT /settings/vacation": { json: {} },
        "GET /settings/sendAs": {
          json: {
            sendAs: [
              {
                sendAsEmail: "alias@example.com",
                displayName: "Me",
                isDefault: true,
                signature: "<p>Hello &amp; bye</p>",
                verificationStatus: "accepted",
              },
              { sendAsEmail: "pending@example.com", verificationStatus: "pending" },
            ],
          },
        },
      });
      yield* run(http, (a) =>
        Effect.gen(function* () {
          const v = yield* a.vacation(account);
          assert.strictEqual(v.contactsOnly, true);
          yield* a.setVacation(account, v);
          const aliases = yield* a.sendAs(account);
          assert.strictEqual(aliases.length, 1);
          assert.strictEqual(aliases[0]?.signature, "Hello & bye");
        }),
      );
      assert.deepStrictEqual(http.calls.find((c) => c.method === "PUT")?.body, {
        enableAutoReply: true,
        startTime: "1000",
        endTime: "2000",
        responseSubject: "Away",
        responseBodyPlainText: "Back tomorrow",
        restrictToContacts: true,
      });
    }),
);

it.effect(
  "Gmail vacation updates preserve the original rich HTML when body text is unchanged",
  () =>
    Effect.gen(function* () {
      const html = '<p style="color:blue">Rich <b>reply</b></p>';
      const http = fakeHttp({
        "GET /settings/vacation": {
          json: {
            enableAutoReply: true,
            responseBodyPlainText: "Alternative plain text",
            responseBodyHtml: html,
          },
        },
        "PUT /settings/vacation": { json: {} },
      });
      yield* run(http, (a) =>
        Effect.gen(function* () {
          const v = yield* a.vacation(account);
          yield* a.setVacation(account, { ...v, enabled: false });
        }),
      );
      const body = Schema.decodeUnknownSync(
        Schema.Struct({ responseBodyHtml: Schema.String, responseBodyPlainText: Schema.String }),
      )(http.calls.at(-1)?.body);
      assert.strictEqual(body.responseBodyHtml, html);
      assert.strictEqual(body.responseBodyPlainText, "Alternative plain text");
    }),
);

it.effect(
  "Gmail legacy vacation callers preserve existing HTML without sending a preservation field",
  () => {
    const html = "<p>Rich <b>reply</b></p>";
    const http = fakeHttp({
      "GET /settings/vacation": {
        json: { responseBodyPlainText: "Plain", responseBodyHtml: html },
      },
      "PUT /settings/vacation": { json: {} },
    });
    return run(http, (a) =>
      a.setVacation(account, {
        enabled: false,
        start: null,
        end: null,
        subject: "",
        body: "Plain",
        contactsOnly: false,
      }),
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          assert.strictEqual(
            Schema.decodeUnknownSync(Schema.Struct({ responseBodyHtml: Schema.String }))(
              http.calls.at(-1)?.body,
            ).responseBodyHtml,
            html,
          );
        }),
      ),
    );
  },
);

it.effect(
  "Gmail edits filters by delete and create; a failed create restores the original rule",
  () =>
    Effect.gen(function* () {
      const original = {
        id: "old",
        criteria: { from: "alice" },
        action: { removeLabelIds: ["UNREAD"] },
      };
      const replacement = {
        name: "Edited",
        criteria: { from: "bob", to: "", subject: "", query: "", hasAttachment: false },
        action: { archive: true, markRead: false, star: false, trash: false, label: null },
      };
      const success = fakeHttp({
        "GET /settings/filters/old": { json: original },
        "DELETE /settings/filters/old": { status: 204 },
        "POST /settings/filters": { json: { ...original, id: "new" } },
      });
      const edited = yield* run(success, (a) => a.updateFilter(account, "old", replacement));
      assert.strictEqual(edited.id, "new");
      assert.deepStrictEqual(
        success.calls.map((c) => c.method),
        ["GET", "DELETE", "POST"],
      );
      let posts = 0;
      const failure = fakeHttp({
        "GET /settings/filters": { json: { filter: [] } },
        "GET /settings/filters/old": { json: original },
        "DELETE /settings/filters/old": { status: 204 },
        "POST /settings/filters": () =>
          ++posts === 1
            ? { status: 400, json: { error: "invalid replacement" } }
            : { json: { ...original, id: "restored" } },
      });
      const error = yield* run(failure, (a) =>
        a.updateFilter(account, "old", replacement).pipe(Effect.flip),
      );
      assert.match(error.message, /previous filter was restored/);
      assert.deepStrictEqual(failure.calls.at(-1)?.body, {
        criteria: original.criteria,
        action: original.action,
      });
    }),
);

it.effect("Gmail rejects edits of rules with unrepresented actions before deleting them", () =>
  Effect.gen(function* () {
    const http = fakeHttp({
      "GET /settings/filters/old": {
        json: {
          id: "old",
          criteria: { from: "alice", negatedQuery: "urgent" },
          action: { forward: "someone@example.com", removeLabelIds: ["UNREAD"] },
        },
      },
    });
    const result = yield* run(http, (a) =>
      a
        .updateFilter(account, "old", {
          name: "",
          criteria: { from: "bob", to: "", subject: "", query: "", hasAttachment: false },
          action: { archive: false, markRead: true, star: false, trash: false, label: null },
        })
        .pipe(Effect.result),
    );
    assert.strictEqual(result._tag, "Failure");
    assert.strictEqual(http.calls.length, 1);
  }),
);

it.effect(
  "Gmail documented category and importance actions are editable while undocumented additions stay protected",
  () =>
    Effect.gen(function* () {
      const rules = ["CATEGORY_UPDATES", "SENT", "INBOX", "IMPORTANT"].map((label, index) => ({
        id: String(index),
        criteria: { from: "alice" },
        action: { addLabelIds: [label] },
      }));
      const http = fakeHttp({
        "GET /settings/filters": { json: { filter: rules } },
        ...Object.fromEntries(
          rules.map((rule) => [`DELETE /settings/filters/${rule.id}`, { status: 204 }]),
        ),
      });
      yield* run(http, (adapter) =>
        Effect.gen(function* () {
          const filters = yield* adapter.filters(account);
          assert.notStrictEqual(filters[0]?.editable, false);
          assert.strictEqual(filters[1]?.editable, false);
          assert.strictEqual(filters[2]?.editable, false);
          assert.notStrictEqual(filters[3]?.editable, false);
          for (const filter of filters) yield* adapter.deleteFilter(account, filter.id);
        }),
      );
      assert.strictEqual(
        http.calls.filter((call) => call.method === "DELETE").length,
        rules.length,
      );
    }),
);

for (const recoverySucceeds of [true, false]) {
  it.effect(
    `Gmail uncertain restoration preserves a backup without replay even when ${recoverySucceeds ? "a later POST would succeed" : "all later POSTs would fail"}`,
    () =>
      Effect.gen(function* () {
        const original = {
          id: "old",
          criteria: { from: "alice" },
          action: { removeLabelIds: ["UNREAD"] },
        };
        let posts = 0;
        const attempted: unknown[] = [];
        const saved: GmailRuleDefinition[] = [];
        const settings = makeGmailSettings(
          (_id, schema, path) =>
            Schema.decodeUnknownEffect(schema)(
              path.endsWith("/old") ? original : { filter: [] },
            ).pipe(Effect.orDie),
          (_id, method, _path, body) =>
            Effect.suspend(() => {
              if (method === "DELETE") return Effect.void;
              posts++;
              attempted.push(body);
              return recoverySucceeds && posts === 3
                ? Effect.succeed({ ...original, id: "restored" })
                : Effect.fail(
                    new ProviderError({ message: "offline", status: posts === 1 ? 400 : 503 }),
                  );
            }),
        );
        const request = yield* Effect.forkChild(
          settings
            .updateFilter(
              account,
              "old",
              {
                ...EMPTY_FILTER,
                criteria: { ...EMPTY_FILTER.criteria, from: "bob" },
                action: { ...EMPTY_FILTER.action, markRead: true },
              },
              (definition) =>
                Effect.sync(() => {
                  saved.push(definition);
                }),
            )
            .pipe(Effect.result),
        );
        yield* TestClock.adjust("2 seconds");
        const result = yield* Fiber.join(request);
        assert.strictEqual(result._tag, "Failure");
        const definition = { criteria: original.criteria, action: original.action };
        assert.deepStrictEqual(attempted.slice(1), [definition]);
        assert.deepStrictEqual(saved, [definition]);
      }),
  );
}

it.effect(
  "Gmail exposes archive plus one label for editing but rejects other destination combinations",
  () =>
    Effect.gen(function* () {
      const rules = [
        {
          id: "label-and-archive",
          action: { addLabelIds: ["Label_1"], removeLabelIds: ["INBOX"] },
        },
        {
          id: "trash-and-label",
          action: { addLabelIds: ["TRASH", "Label_1"], removeLabelIds: [] },
        },
        { id: "trash-and-archive", action: { addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] } },
        {
          id: "multiple-labels",
          action: { addLabelIds: ["Label_1", "Label_2"], removeLabelIds: ["INBOX"] },
        },
      ].map((rule) => ({ ...rule, criteria: { from: "alice" } }));
      const http = fakeHttp({ "GET /settings/filters": { json: { filter: rules } } });
      const filters = yield* run(http, (adapter) => adapter.filters(account));
      assert.notStrictEqual(filters[0]?.editable, false);
      assert.ok(filters.slice(1, 3).every((filter) => filter.editable === false));
      assert.notStrictEqual(filters[3]?.editable, false);
      assert.deepStrictEqual(filters[3]?.action.labels, ["Label_2"]);
    }),
);

it.effect(
  "Gmail extended rules map words, exclusions, size, importance, category and multiple labels without forwarding",
  () =>
    Effect.gen(function* () {
      const rule = {
        id: "extended",
        criteria: {
          from: "",
          to: "",
          subject: "",
          hasAttachment: false,
          query: "(budget)",
          negatedQuery: "private",
          size: 1_000_000,
          sizeComparison: "larger",
        },
        action: {
          addLabelIds: ["Label_1", "Label_2", "CATEGORY_UPDATES"],
          removeLabelIds: ["IMPORTANT"],
        },
      };
      const http = fakeHttp({ "POST /settings/filters": { json: rule } });
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
            size: 1_000_000,
            sizeComparison: "larger",
          },
          action: {
            archive: false,
            markRead: false,
            star: false,
            trash: false,
            label: "Label_1",
            labels: ["Label_2"],
            important: false,
            category: "CATEGORY_UPDATES",
          },
        }),
      );
      assert.deepStrictEqual(http.calls.find((call) => call.method === "POST")?.body, {
        criteria: rule.criteria,
        action: rule.action,
      });
      assert.notStrictEqual(saved.editable, false);
      assert.strictEqual(saved.criteria.notWords, "private");
      assert.strictEqual(saved.criteria.size, 1_000_000);
      assert.deepStrictEqual(saved.action.labels, ["Label_2"]);
      assert.strictEqual(saved.action.category, "CATEGORY_UPDATES");
      assert.strictEqual(saved.action.important, false);
    }),
);
