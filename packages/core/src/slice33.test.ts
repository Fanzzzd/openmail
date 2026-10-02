import { Mailbox } from "./mailbox.js";
import { TestMailbox } from "./testing.js";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream, Fiber } from "effect";
import { SqlClient } from "effect/sql";
import { Store } from "./services.js";
import { contactMatch } from "./store-compose.js";
import { StoreLive } from "./store.js";
import { MemoryPlatform } from "./platform-memory.js";
import type { Account, IncomingMessage } from "./domain.js";
import { makeGmailFeatures } from "./gmail-features.js";
import { makeOutlookFeatures } from "./outlook-features.js";
import { ProviderError } from "./errors.js";
import { gmailSearch, graphSearch, parseSearchQuery, serverSearchIgnored } from "./search.js";
import type { DerivedChunk } from "./media.js";

const layer = StoreLive.pipe(Layer.provideMerge(MemoryPlatform()));
const message = (id: string, bodyText: string): IncomingMessage => ({
  providerId: id,
  threadId: id,
  from: { name: "Sender", address: "sender@example.com" },
  to: [],
  cc: [],
  date: 1000,
  subject: "Report",
  snippet: "",
  bodyText,
  bodyHtml: "",
  labels: ["INBOX"],
  attachments: [],
  isUnread: true,
  isStarred: false,
});

it.effect(
  "provider company completion combines name/address/company, preserves scope and removes stale metadata",
  () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const first = yield* store.upsertAccount("gmail", "one@example.com");
      const second = yield* store.upsertAccount("outlook", "two@example.com");
      yield* store.replaceServerContacts(
        first.id,
        [{ name: "John Smith", address: "john@example.com", company: "Acme Research" }],
        1,
      );
      yield* store.replaceServerContacts(
        second.id,
        [{ name: "Jane", address: "jane@example.com", company: "Acme" }],
        2,
      );
      assert.deepStrictEqual(yield* store.suggestContacts("john acm", 10, undefined, [first.id]), [
        { name: "John Smith", address: "john@example.com" },
      ]);
      assert.strictEqual((yield* store.suggestContacts("research example", 10)).length, 1);
      assert.strictEqual((yield* store.suggestContacts("Acme", 10)).length, 2);
      assert.deepStrictEqual(
        yield* store.suggestContacts("Acme", 10, "john@example.com", [first.id]),
        [],
      );
      yield* store.setContactHidden("john@example.com", true);
      assert.deepStrictEqual(yield* store.suggestContacts("Research", 10), []);
      yield* store.setContactHidden("john@example.com", false);
      yield* store.replaceServerContacts(
        first.id,
        [{ name: "John Smith", address: "john@example.com", company: "New Organization" }],
        3,
      );
      assert.deepStrictEqual(yield* store.suggestContacts("Research", 10), []);
      assert.strictEqual((yield* store.suggestContacts("john organization", 10)).length, 1);
      yield* store.replaceServerContacts(first.id, [], 4);
      assert.deepStrictEqual(yield* store.suggestContacts("Organization", 10), []);
      yield* sql`INSERT INTO contact_organizations_fts(contact_organizations_fts) VALUES('integrity-check')`;
      yield* store.removeAccount(second.id);
      assert.deepStrictEqual(yield* store.suggestContacts("Acme", 10), []);
    }).pipe(Effect.provide(layer)),
);

it.effect("company fields use existing Google connections and Graph contacts grants", () =>
  Effect.gen(function* () {
    const account: Account = {
      id: "gmail:me@example.com",
      provider: "gmail",
      email: "me@example.com",
      createdAt: 0,
      lastSyncedAt: null,
      lastSyncError: null,
      profileId: null,
      needsReauth: false,
    };
    const paths: string[] = [];
    const get = <A>(_id: string, schema: Schema.Decoder<A>, path: string) => {
      paths.push(path);
      const data = path.includes("connections")
        ? {
            connections: [
              {
                names: [{ displayName: "John" }],
                emailAddresses: [{ value: "john@example.com" }],
                organizations: [{ name: "Acme" }, { name: "Research" }],
              },
            ],
          }
        : path.includes("otherContacts")
          ? { otherContacts: [] }
          : path.startsWith("/me/contacts")
            ? {
                value: [
                  {
                    id: "saved",
                    displayName: "John",
                    emailAddresses: [{ address: "john@example.com" }],
                    companyName: "Acme",
                  },
                ],
              }
            : { value: [] };
      return Schema.decodeUnknownEffect(schema)(data).pipe(
        Effect.mapError(() => new ProviderError({ message: "Invalid fixture" })),
      );
    };
    const write = () => Effect.void;
    const google = makeGmailFeatures(get, write);
    assert.strictEqual((yield* google.contacts(account))[0]?.company, "Acme Research");
    assert.ok(new URL(paths[0] ?? "").searchParams.get("personFields")?.includes("organizations"));
    assert.strictEqual(
      new URL(paths[1] ?? "").searchParams.get("readMask"),
      "names,emailAddresses",
    );
    paths.length = 0;
    const graph = makeOutlookFeatures(get, write);
    assert.strictEqual(
      (yield* graph.contacts({ ...account, provider: "outlook" }))[0]?.company,
      "Acme",
    );
    assert.ok(paths[0]?.includes("companyName"));
  }),
);

it.effect(
  "layout and automatic download preferences default safely and persist independently",
  () =>
    Effect.gen(function* () {
      const store = yield* Store;
      assert.strictEqual((yield* store.prefs).toolbarVisible, true);
      assert.strictEqual((yield* store.prefs).readingPaneVisible, true);
      assert.strictEqual((yield* store.prefs).updateAutoDownload, true);
      yield* store.setPrefs({
        toolbarVisible: false,
        readingPaneVisible: false,
        updateAutoDownload: false,
      });
      assert.strictEqual((yield* store.prefs).toolbarVisible, false);
      assert.strictEqual((yield* store.prefs).readingPaneVisible, false);
      assert.strictEqual((yield* store.prefs).updateAutoDownload, false);
      assert.strictEqual((yield* store.prefs).readingPanePosition, "right");
      yield* store.setPrefs({ readingPanePosition: "bottom" });
      assert.strictEqual((yield* store.prefs).readingPaneVisible, false);
    }).pipe(Effect.provide(layer)),
);

it("older/newer date aliases stay equivalent through local, Gmail and Graph search", () => {
  for (const [alias, canonical] of [
    ["older", "before"],
    ["newer", "after"],
  ] as const) {
    const search = `${alias}:2026/10/01`;
    assert.deepStrictEqual(
      parseSearchQuery({ search }).criteria,
      parseSearchQuery({ search: `${canonical}:2026/10/01` }).criteria,
    );
    assert.strictEqual(gmailSearch({ search }), gmailSearch({ search: `${canonical}:2026/10/01` }));
    assert.strictEqual(graphSearch({ search }), graphSearch({ search: `${canonical}:2026/10/01` }));
    assert.deepStrictEqual(serverSearchIgnored({ search }, "imap"), []);
    assert.deepStrictEqual(serverSearchIgnored({ search }, "outlook"), []);
  }
});

it.effect(
  "boolean search includes indexed attachments and excludes a forbidden term across body and chunks",
  () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const account = yield* store.upsertAccount("gmail", "me@example.com");
      for (const [id, text, attachment] of [
        ["good", "budget", "invoice"],
        ["bad", "budget", "invoice secret"],
        ["body", "invoice budget", ""],
        ["none", "unrelated", ""],
      ]) {
        if (!id || text === undefined || attachment === undefined)
          throw new Error("Incomplete fixture");
        yield* store.upsertMessage(account.id, message(id, text));
        if (attachment) {
          const chunk: DerivedChunk = {
            messageId: `${account.id}/${id}`,
            text: attachment,
            source: { kind: "attachment", index: 0, name: "scan.pdf", mimeType: "application/pdf" },
            page: 1,
            region: null,
            pipelineVersion: "fixture",
            visionRevision: null,
          };
          yield* sql`INSERT INTO derived_chunks(message_id,text,provenance_json) VALUES(${chunk.messageId},${chunk.text},${JSON.stringify(chunk)})`;
        }
      }
      const ids = (search: string) =>
        store
          .listThreads({ search, flat: true })
          .pipe(
            Effect.map((rows) =>
              rows
                .map((row) => row.id.split("/").at(-1))
                .toSorted((a, b) => (a ?? "").localeCompare(b ?? "")),
            ),
          );
      assert.deepStrictEqual(yield* ids("(invoice OR contract) budget -secret"), ["body", "good"]);
      assert.deepStrictEqual(yield* ids("invoice -secret"), ["body", "good"]);
      assert.deepStrictEqual(yield* ids("in:attachment (invoice OR contract) -secret"), ["good"]);
      assert.deepStrictEqual(yield* ids("in:attachment invoice -secret"), ["good"]);
      assert.deepStrictEqual(yield* ids("-(in:attachment invoice)"), ["body", "none"]);
      assert.deepStrictEqual(yield* ids("in:attachment -secret"), ["good"]);
      assert.deepStrictEqual(yield* ids("-(invoice OR contract)"), ["none"]);
      // Verify both the trigram fallback and the completed unicode61 index.
      while (!(yield* store.backfillWordIndex(200)).ready) {
        /* bounded fixture */
      }
      assert.deepStrictEqual(yield* ids("(invoice OR contract) budget -secret"), ["body", "good"]);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "contact completion starts from FTS rowids and expands companies using the address index",
  () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const account = yield* store.upsertAccount("gmail", "one@example.com");
      yield* store.replaceServerContacts(
        account.id,
        [{ name: "John Smith", address: "john@example.com", company: "Acme" }],
        1,
      );
      yield* sql`WITH RECURSIVE entries(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM entries WHERE n<160000)
      INSERT INTO contact_candidates(id,account_id,address,name,date,weight,source)
      SELECT 'fixture:'||n,${account.id},'person'||n||'@example.org','Correspondent '||n,0,1,1 FROM entries`;
      const statement = sql`SELECT c.* FROM contact_candidates c WHERE c.account_id IN (SELECT id FROM accounts WHERE enabled=1)
      AND ${contactMatch(sql, '"john"*')} AND ${contactMatch(sql, '"acme"*')}`;
      const [text, parameters] = statement.compile();
      const plan = yield* sql.unsafe(`EXPLAIN QUERY PLAN ${text}`, parameters);
      const details = Schema.decodeUnknownSync(
        Schema.Array(Schema.Struct({ detail: Schema.String })),
      )(plan)
        .map((row) => row.detail)
        .join("\n");
      assert.match(details, /SEARCH c USING INTEGER PRIMARY KEY/);
      assert.match(details, /contact_candidates_(?:address|score|company)/);
      assert.match(details, /contact_candidates_fts/);
      assert.match(details, /contact_organizations_fts/);
      assert.strictEqual(/SCAN (?:c|cc|contact_candidates)\b/.test(details), false, details);
      const started = performance.now();
      assert.deepStrictEqual(yield* store.suggestContacts("john acme", 10), [
        { name: "John Smith", address: "john@example.com" },
      ]);
      yield* Effect.logInfo(
        `160k contact completion: ${Math.round(performance.now() - started)} ms`,
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "update preference events preserve ready state while actual channel and token changes reset it",
  () =>
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const listener = yield* mailbox.events.pipe(
        Stream.filter((event) => event._tag === "UpdateSettingsChanged"),
        Stream.take(4),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* mailbox.setPrefs({ updateAutoDownload: false });
      yield* mailbox.setPrefs({ updateChannel: "stable" });
      yield* mailbox.setPrefs({ updateChannel: "latest" });
      yield* mailbox.setUpdateToken("fixture-token");
      const events = yield* Fiber.join(listener);
      assert.deepStrictEqual(
        Array.from(events).map((event) => event.resetState),
        [false, false, true, true],
      );
    }).pipe(Effect.scoped, Effect.provide(TestMailbox())),
);
