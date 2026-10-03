import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { Store } from "../../services.js";
import {
  PerformanceMailbox,
  fixtureAccounts,
  fixtureNow,
  seedMailbox,
  traceQueries,
} from "./fixtures/performance-mailbox.js";

it.effect("slice61: actual health, stale, reset and budget queries use indexed metadata", () => {
  const trace = traceQueries();
  return Effect.gen(function* () {
    yield* seedMailbox(120);
    const store = yield* Store;
    const imap = fixtureAccounts[2],
      gmail = fixtureAccounts[0];
    trace.start();
    yield* store.messageIdForProvider(gmail, "absent");
    yield* store.syncHealthLocal(imap, "Folder_2", true);
    yield* store.syncHealthLocal(gmail, "Folder_0", false);
    yield* store.staleCandidates(imap, ["Folder_2"], true, "7:9:Folder_2", 2);
    yield* store.staleCandidates(gmail, ["INBOX", "DRAFT"], false, "m5", 2);
    yield* store.resetCandidates(imap, {
      _tag: "RebuildFolder",
      previous: { path: "Folder_2", uidValidity: "7" },
      keep: [],
      since: fixtureNow - 86400000,
    });
    yield* store.resetCandidates(gmail, { _tag: "Reset", keep: [], since: fixtureNow - 86400000 });
    yield* store.listThreads({ search: '"alpha AROUND 0 beta"', limit: 5 });
    yield* store.bodySizes;
    yield* store.evictBodyBudget(1, true);
    const queries = trace.stop();
    assert.isAbove(queries.length, 8);
    for (const query of queries) {
      const plan = query.plan.join("\n");
      assert.notMatch(plan, /\bSCAN (?:messages|m)(?:$|\n)/, query.sql);
    }
    const lookup = queries.find((q) => q.sql.includes("ORDER BY date DESC,id LIMIT 1"));
    assert.ok(lookup);
    assert.include(
      lookup.plan.join("\n"),
      "COVERING INDEX messages_provider (account_id=? AND provider_id=?)",
    );
    assert.notInclude(lookup.plan.join("\n"), "TEMP B-TREE");
    const health = queries.find((q) => q.sql.includes("AS total") && q.sql.includes("substr"));
    assert.ok(health);
    assert.include(health.plan.join("\n"), "messages_imap_scope");
    const stale = queries.filter((q) => q.sql.includes("draftOnly"));
    assert.isAbove(stale.length, 0);
    for (const query of stale) {
      assert.notInclude(query.plan.join("\n"), "TEMP B-TREE FOR ORDER BY", query.sql);
      assert.match(query.plan.join("\n"), /messages_provider|messages_imap_scope/);
    }
    const window = queries.find(
      (q) =>
        q.sql.includes("AS providerId") && /date\s*>=/.test(q.sql) && !q.sql.includes("substr"),
    );
    assert.ok(window);
    assert.include(window.plan.join("\n"), "messages_account_date");
    const sizes = queries.find((q) => q.sql.includes("SUM(body_bytes)"));
    assert.ok(sizes);
    assert.include(sizes.plan.join("\n"), "COVERING INDEX messages_body_sizes");
    const proximity = queries.find((q) => q.sql.includes("WITH matches AS MATERIALIZED"));
    assert.ok(proximity);
    assert.include(proximity.plan.join("\n"), "COVERING INDEX messages_list_date_id");
    assert.strictEqual(
      proximity.plan.filter((line) => line.includes("SCAN messages_word_positions")).length,
      1,
    );
    const lru = queries.find((q) => q.sql.includes("AS opened_at"));
    assert.ok(lru);
    assert.include(lru.plan.join("\n"), "messages_body_lru");
    const nextLru = queries.find(
      (q) => q.sql.includes("AS opened_at") && q.sql.includes("date),id)>"),
    );
    assert.ok(nextLru);
    assert.match(nextLru.plan.join("\n"), /SEARCH messages USING INDEX messages_body_lru/);
  }).pipe(Effect.provide(PerformanceMailbox()), Effect.ensuring(Effect.sync(trace.restore)));
});

it.effect("slice61: stale keyset pages wrap and include distinct orphan drafts", () =>
  Effect.gen(function* () {
    yield* seedMailbox(120);
    const store = yield* Store,
      gmail = fixtureAccounts[0];
    const expected = (yield* store.staleCandidates(gmail, ["INBOX"], false, "", 1000)).map(
      (row) => row.providerId,
    );
    let after = "";
    const actual: string[] = [];
    while (actual.length < expected.length) {
      const rows = yield* store.staleCandidates(gmail, ["INBOX"], false, after, 7);
      actual.push(...rows.map((row) => row.providerId));
      after = rows.at(-1)?.providerId ?? "";
    }
    assert.deepStrictEqual(actual.slice(0, expected.length), expected);
    assert.deepStrictEqual(
      actual.slice(expected.length),
      expected.slice(0, actual.length - expected.length),
    );
    assert.deepStrictEqual(yield* store.staleCandidates(gmail, [], false, "", 10), []);
    const last = expected.at(-1);
    assert.ok(last);
    assert.deepStrictEqual(
      (yield* store.staleCandidates(gmail, ["INBOX"], false, last, 3)).map((row) => row.providerId),
      expected.slice(0, 3),
    );
    const draftMessage = {
      to: [],
      cc: [],
      bcc: [],
      subject: "Draft",
      text: "Text",
      attachments: [],
    };
    for (const [id, remote] of [
      ["one", "😀"],
      ["two", "\ue000"],
      ["duplicate", "😀"],
      ["cached", "m0"],
    ]) {
      if (!id || !remote) continue;
      yield* store.putDraft({ id, accountId: gmail, message: draftMessage });
      yield* store.setDraftRemote(id, { draftId: id, messageId: remote }, null);
    }
    const sql = yield* SqlClient.SqlClient;
    const sorted =
      yield* sql`SELECT DISTINCT remote_message_id FROM drafts WHERE remote_message_id NOT IN ('m0') ORDER BY remote_message_id`;
    assert.deepStrictEqual(
      (yield* store.staleCandidates(gmail, ["DRAFT"], false, "", 10)).map((row) => row.providerId),
      sorted.map((row) => row.remote_message_id),
    );
    const mixed = yield* store.staleCandidates(gmail, ["INBOX", "DRAFT"], false, last, 4);
    assert.deepStrictEqual(
      mixed.map((row) => row.providerId),
      ["\ue000", "😀", ...expected.slice(0, 2)],
    );
  }).pipe(Effect.provide(PerformanceMailbox())),
);
