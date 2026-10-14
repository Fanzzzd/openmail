import { DatabaseSync } from "node:sqlite";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import { wordTokens } from "../search/fts.js";
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
it("wordTokens splits text into the tokens unicode61 stores", () => {
  const samples = [
    "नमस्ते दुनिया आज",
    "مَرْحَبًا بِالْعَالَمِ today",
    "café café Ångström naïve ḁ ỏ ǖ ǣ",
    "ﬁle ß Straße İstanbul ı µ ſ",
    "Ǆemal x² ΟΔΟΣ ϐ άλφα άλφα",
    "Привет ёжик й",
    "́abc x́́y क́ख",
    "Hello, WORLD_42 foo-bar",
  ];
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE VIRTUAL TABLE t USING fts5(x, tokenize='unicode61'); CREATE VIRTUAL TABLE v USING fts5vocab(t, instance);",
    );
    const insert = db.prepare("INSERT INTO t(rowid, x) VALUES (?, ?)");
    for (const [i, text] of samples.entries()) insert.run(i + 1, text);
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
