import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  createAppleContactsCache,
  appleContactVCard,
  type AppleContactsSnapshot,
} from "./apple-contacts.js";
import { Mailbox } from "../mailbox/mailbox.js";
import { TestMailbox } from "../platform/node/testing.js";

const snapshot: AppleContactsSnapshot = {
  status: "authorized",
  contacts: [
    {
      id: "alice",
      name: "Apple Alice",
      company: "Acme Research",
      emails: ["ALICE@example.com", "work@example.com", "invalid", " alice@example.com "],
      thumbnail: "data:image/png;base64,AAAA",
    },
    {
      id: "bob",
      name: "",
      company: "Acme",
      emails: ["bob@example.com"],
      thumbnail: "https://example.com/photo",
    },
    { id: "robot", name: "Robot", company: "", emails: ["noreply@example.com"], thumbnail: null },
  ],
  groups: [
    {
      id: "team",
      name: "Research Team",
      members: [
        { id: "alice", address: "WORK@example.com" },
        { id: "alice", address: "WORK@example.com" },
        { id: "bob", address: "stale@example.com" },
        { id: "missing", address: "missing@example.com" },
      ],
    },
  ],
};

it("Apple names take priority over server/history duplicates, while hiding, exclusion, company tokens and limits still apply", () => {
  const cache = createAppleContactsCache();
  cache.replace(snapshot, true);
  const existing = [
    { name: "Server Alice", address: "alice@example.com" },
    { name: "History Bob", address: "bob@example.com" },
  ];
  const options = { hidden: [], available: true };
  assert.deepStrictEqual(cache.suggest("", existing, options), [
    { name: "Apple Alice", address: "alice@example.com" },
    { name: "History Bob", address: "bob@example.com" },
    { name: "Apple Alice", address: "work@example.com" },
  ]);
  assert.deepStrictEqual(cache.suggest("ali acm", [], options), [
    { name: "Apple Alice", address: "alice@example.com" },
    { name: "Apple Alice", address: "work@example.com" },
  ]);
  assert.deepStrictEqual(cache.suggest("!", [], options), []);
  assert.deepStrictEqual(
    cache.suggest("", [], {
      ...options,
      hidden: ["ALICE@example.com"],
      exclude: "WORK@example.com",
    }),
    [{ name: "", address: "bob@example.com" }],
  );
  const ranked = [{ name: "Frequent", address: "frequent@example.com" }, ...existing];
  assert.deepStrictEqual(cache.suggest("", ranked, { ...options, limit: 2 }), [
    ranked[0],
    { name: "Apple Alice", address: "alice@example.com" },
  ]);
  assert.deepStrictEqual(cache.suggest("", existing, { ...options, available: false }), existing);
  assert.strictEqual(cache.identifier(" ALICE@example.com "), "alice");
  assert.strictEqual(cache.photo("alice@example.com"), "data:image/png;base64,AAAA");
  assert.strictEqual(cache.photo("bob@example.com"), null);
  cache.discardPhotos();
  assert.strictEqual(cache.photo("alice@example.com"), null);
  cache.replace(snapshot, false);
  assert.strictEqual(cache.photo("alice@example.com"), null);
});

it("groups select one preferred email per member, dedupe, fall back from stale addresses and filter hidden members", () => {
  const cache = createAppleContactsCache();
  cache.replace(snapshot, false);
  assert.deepStrictEqual(cache.groups("res tea", [])[0]?.members, [
    { name: "Apple Alice", address: "work@example.com" },
    { name: "", address: "bob@example.com" },
  ]);
  assert.deepStrictEqual(cache.groups("team", ["WORK@example.com"])[0]?.members, [
    { name: "", address: "bob@example.com" },
  ]);
  assert.deepStrictEqual(cache.groups("team", ["work@example.com", "bob@example.com"]), []);
  assert.strictEqual(cache.alternatives("alice@example.com").length, 2);
  cache.replace({ status: "denied" }, true);
  assert.deepStrictEqual(cache.groups("", []), []);
  assert.deepStrictEqual(cache.alternatives("alice@example.com"), []);
  assert.strictEqual(cache.identifier("alice@example.com"), null);
});

it("vCard imports escape delimiters, fold Unicode safely and reject property injection", () => {
  const card = appleContactVCard({ name: "李,测试;\\".repeat(30), address: "TEST@example.com" });
  assert.ok(card.includes("EMAIL;TYPE=INTERNET:test@example.com\r\n"));
  assert.ok(card.includes("\\,测试\\;\\\\"));
  for (const line of card.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75);
  assert.ok(!card.includes("\ufffd"));
  assert.throws(() =>
    appleContactVCard({ name: "Alice\r\nNOTE:secret", address: "alice@example.com" }),
  );
  assert.throws(() => appleContactVCard({ name: "Alice", address: "invalid" }));
});

it.effect(
  "desktop Apple cache never changes Mailbox suggestions, groups or persistent contacts",
  () =>
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const cache = createAppleContactsCache();
      cache.replace(snapshot, true);
      assert.strictEqual((yield* mailbox.app.prefs).useAppleContacts, false);
      yield* mailbox.app.setPrefs({ useAppleContacts: true });
      assert.strictEqual((yield* mailbox.app.prefs).useAppleContacts, true);
      assert.deepStrictEqual(yield* mailbox.suggestContacts("Apple"), []);
      assert.deepStrictEqual(yield* mailbox.contactGroups("Research"), []);
    }).pipe(Effect.provide(TestMailbox())),
);
