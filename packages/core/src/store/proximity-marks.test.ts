import { DatabaseSync } from "node:sqlite";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import { SqlClient } from "effect/sql";
import { WORD_SEPARATORS, withoutSoftHyphens, wordTokens } from "../search/fts.js";
import { MIGRATIONS } from "../db/migrations.js";
import { splitStatements } from "../db/migrate.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import { Store } from "./service.js";
import { StoreLive } from "./store.js";

const base = {
  from: { name: "Bob", address: "bob@example.com" },
  to: [],
  cc: [],
  snippet: "",
  bodyHtml: "",
  labels: ["INBOX"],
  attachments: [],
  isUnread: false,
  isStarred: false,
};

// wordTokens used to strip every combining mark and join the pieces, while
// unicode61 splits on most marks and keeps Greek and Cyrillic accents. AROUND
// then looked up words the index never stored.
// The bidi isolates, the Arabic letter mark and skin tone modifiers are newer
// than unicode61's tables, so it glued them to the next word; soft hyphens split
// words. The word indexes now split at the former and stored text has none of the latter.
it("wordTokens splits text into the tokens the word indexes store", () => {
  const samples = [
    "नमस्ते दुनिया आज",
    "مَرْحَبًا بِالْعَالَمِ today",
    "café café Ångström naïve ḁ ỏ ǖ ǣ",
    "ﬁle ß Straße İstanbul ı µ ſ",
    "Ǆemal x² ΟΔΟΣ ϐ άλφα άλφα",
    "Привет ёжик й",
    "́abc x́́y क́ख",
    "Hello, WORLD_42 foo-bar",
    "\u2068Alice Smith\u2069 commented",
    "\u2066a\u2067b\u2068c\u2069d a\u061Cb",
    "ok\u{1F44D}\u{1F3FD}ok x\u{1F3FB}y\u{1F3FF}z",
    "Our inter\u00ADnational news\u00ADletter \u00ADsoft\u00AD",
  ];
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      `CREATE VIRTUAL TABLE t USING fts5(x, tokenize="unicode61 separators '${WORD_SEPARATORS}'"); CREATE VIRTUAL TABLE v USING fts5vocab(t, instance);`,
    );
    const insert = db.prepare("INSERT INTO t(rowid, x) VALUES (?, ?)");
    for (const [i, text] of samples.entries()) insert.run(i + 1, withoutSoftHyphens(text));
    const terms = db.prepare("SELECT term FROM v WHERE doc=? ORDER BY offset");
    for (const [i, text] of samples.entries())
      expect(wordTokens(text), text).toEqual(terms.all(i + 1).map((row) => String(row["term"])));
  } finally {
    db.close();
  }
});

it.effect("AROUND matches words written with combining marks", () =>
  Effect.gen(function* () {
    const store = yield* Store;
    const a = yield* store.upsertAccount("gmail", "me@example.com");
    const bodies = {
      hindi: "नमस्ते दुनिया आज",
      arabic: "مَرْحَبًا بِالْعَالَمِ today",
      russian: "Привет ёжик дружище",
      latin: "hello brave world",
    };
    for (const [i, [subject, bodyText]] of Object.entries(bodies).entries())
      yield* store.upsertMessage(a.id, {
        ...base,
        providerId: subject,
        threadId: subject,
        subject,
        date: i + 1,
        bodyText,
      });
    while (!(yield* store.backfillWordIndex(100)).ready) {
      /* drain */
    }
    const searches = {
      "नमस्ते AROUND 1 दुनिया": "hindi",
      "दुनिया AROUND 2 नमस्ते": "hindi",
      "مَرْحَبًا AROUND 1 بِالْعَالَمِ": "arabic",
      "ёжик AROUND 1 Привет": "russian",
      "Привет AROUND 3 дружище": "russian",
      "hello AROUND 1 world": "latin",
    };
    for (const [search, subject] of Object.entries(searches))
      assert.deepStrictEqual(
        (yield* store.listThreads({ search })).map((row) => row.subject),
        [subject],
        search,
      );
  }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
);

const drain = Effect.gen(function* () {
  const store = yield* Store;
  while (!(yield* store.backfillWordIndex(100)).ready) {
    /* drain */
  }
});

it.effect("the word indexes use the separators wordTokens splits at", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables = yield* sql<{
      sql: string;
    }>`SELECT sql FROM sqlite_master WHERE name IN ('messages_words','derived_words')`;
    expect(tables).toHaveLength(2);
    for (const table of tables)
      expect(table.sql).toContain(`tokenize="unicode61 separators '${WORD_SEPARATORS}'"`);
  }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
);

it.effect("word search finds words next to soft hyphens and bidi isolates", () =>
  Effect.gen(function* () {
    const store = yield* Store;
    const sql = yield* SqlClient.SqlClient;
    const a = yield* store.upsertAccount("gmail", "me@example.com");
    yield* store.upsertMessage(a.id, {
      ...base,
      providerId: "shy",
      threadId: "shy",
      subject: "Weekly news\u00ADletter",
      date: 1,
      bodyText: "Our inter\u00ADnational news",
    });
    yield* store.upsertMessage(a.id, {
      ...base,
      providerId: "isolate",
      threadId: "isolate",
      subject: "\u2068Alice Smith\u2069 commented",
      date: 2,
      bodyText: "Thanks \u{1F44D}\u{1F3FD}great work",
    });
    // A row written before soft hyphens were dropped, as an older version stored it.
    yield* store.upsertMessage(a.id, {
      ...base,
      providerId: "old",
      threadId: "old",
      subject: "old",
      date: 3,
      bodyText: "",
    });
    yield* sql`UPDATE messages SET body_text='an older con'||char(173)||'tract' WHERE provider_id='old'`;
    // Rebuild the word indexes as the separators migration does.
    const migration = MIGRATIONS.at(-1) ?? "";
    expect(migration).toContain("DROP TABLE messages_words");
    yield* sql.withTransaction(
      Effect.forEach(splitStatements(migration), (statement) => sql.unsafe(statement).unprepared),
    );
    yield* drain;
    const subjects = (search: string) =>
      store.listThreads({ search }).pipe(Effect.map((rows) => rows.map((row) => row.subject)));
    const searches = {
      international: ["Weekly newsletter"],
      newsletter: ["Weekly newsletter"],
      "inter\u00ADnational": ["Weekly newsletter"],
      contract: ["old"],
      alice: ["\u2068Alice Smith\u2069 commented"],
      smith: ["\u2068Alice Smith\u2069 commented"],
      '"alice smith"': ["\u2068Alice Smith\u2069 commented"],
      "smith AROUND 1 commented": ["\u2068Alice Smith\u2069 commented"],
      "great AROUND 1 work": ["\u2068Alice Smith\u2069 commented"],
      "our AROUND 1 international": ["Weekly newsletter"],
    };
    for (const [search, expected] of Object.entries(searches))
      assert.deepStrictEqual(yield* subjects(search), expected, search);
    expect(
      yield* sql`SELECT COUNT(*) AS n FROM messages WHERE instr(subject||body_text,char(173))>0`,
    ).toEqual([{ n: 0 }]);
  }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
);

// parseSearchQuery drops an empty phrase and lone format characters, so these used to match
// every message.
it.effect("a search whose words strip to nothing finds nothing, like a blank one", () =>
  Effect.gen(function* () {
    const store = yield* Store;
    const a = yield* store.upsertAccount("gmail", "me@example.com");
    yield* store.upsertMessage(a.id, {
      ...base,
      providerId: "one",
      threadId: "one",
      subject: "Quarterly report",
      date: 1,
      bodyText: "numbers",
    });
    yield* drain;
    for (const search of [" ", '""', '"" ""', "\u00AD", "\u2068\u2069", "\u200B", '"\u00AD"'])
      assert.deepStrictEqual(
        [yield* store.listThreads({ search }), yield* store.countThreads({ search })],
        [[], 0],
        JSON.stringify(search),
      );
    assert.lengthOf(yield* store.listThreads({ search: 'report ""' }), 1);
    assert.lengthOf(yield* store.listThreads({ search: "is:read ­" }), 1);
  }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
);
