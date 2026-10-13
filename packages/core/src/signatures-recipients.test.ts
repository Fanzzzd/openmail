import { applyNativeMigration } from "./platform/node/migrations.js";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databaseLayer, MIGRATIONS } from "./platform/node/db.js";
import { type IncomingMessage, type OutgoingMessage } from "./domain/domain.js";
import { AuthError, PermanentError, ProviderError } from "./domain/errors.js";
import { Mailbox } from "./mailbox/mailbox.js";
import { TestMailbox, fakeServer } from "./platform/node/testing.js";
import { Store } from "./services.js";
import { StoreLive } from "./store.js";
import { NodeSystem } from "./platform/node/platform-node.js";
import { replyFromAddress, signatureDefault } from "./signatures.js";
import {
  applyComposeSignature,
  remoteComposeBody,
  richComposeBody,
  textComposeHtml,
  preservedComposeHtml,
} from "./compose-body.js";
import { fillTemplate, customTemplateVariables } from "./compose-text.js";

const accountId = "gmail:me@example.com";
const message: OutgoingMessage = {
  to: [{ name: "John", address: "j@acme.com" }],
  cc: [],
  bcc: [],
  subject: "Hello",
  text: "Latest edits",
  attachments: [],
};
const incoming = (id: string, patch: Partial<IncomingMessage> = {}): IncomingMessage => ({
  providerId: id,
  threadId: id,
  from: { name: "Received name", address: "j@acme.com" },
  to: [],
  cc: [],
  subject: "",
  bodyText: "",
  bodyHtml: "",
  snippet: "",
  attachments: [],
  date: 1000,
  labels: ["INBOX"],
  isStarred: false,
  isUnread: false,
  ...patch,
});

it.effect(
  "named local signatures have separate new/reply defaults, sender isolation and sanitized Gmail fallback",
  () => {
    const server = fakeServer("me@example.com");
    server.aliases = [
      {
        accountId,
        address: "alias@example.com",
        name: "Me",
        isDefault: true,
        signature: "Gmail",
        signatureHtml:
          '<b>Gmail</b><img src="https://tracker.test/pixel"><script>attack()</script>',
      },
    ];
    return Effect.gen(function* () {
      const m = yield* Mailbox;
      yield* m.connect({ provider: "gmail" });
      yield* m.sync();
      const imported = (yield* m.namedSignatures)[0];
      assert.ok(imported);
      assert.strictEqual(imported.html, "<strong>Gmail</strong>");
      const short = yield* m.saveNamedSignature({
        address: "ALIAS@example.com",
        name: "Short",
        text: "ignored",
        html: '<p><b>Short</b><img src="https://tracker.test"><a href="javascript:bad()">safe</a></p>',
      });
      const long = yield* m.saveNamedSignature({
        address: "alias@example.com",
        name: "Long",
        text: "Long text",
      });
      yield* m.setSignatureDefault({
        address: "alias@example.com",
        kind: "new",
        signatureId: long.id,
      });
      yield* m.setSignatureDefault({
        address: "alias@example.com",
        kind: "reply",
        signatureId: short.id,
      });
      assert.strictEqual((yield* m.signatures).find((s) => s.kind === "new")?.text, "Long text");
      assert.strictEqual(
        (yield* m.signatures).find((s) => s.kind === "reply")?.html,
        "<div><strong>Short</strong>safe</div>",
      );
      assert.strictEqual(
        (yield* Effect.flip(
          m.setSignatureDefault({
            address: "other@example.com",
            kind: "new",
            signatureId: short.id,
          }),
        ))._tag,
        "InvalidInput",
      );
      yield* m.saveNamedSignature(
        { address: short.address, name: "Renamed", text: "edited" },
        short.id,
      );
      server.aliases[0] = {
        ...server.aliases[0]!,
        signature: "Changed",
        signatureHtml: "<i>Changed</i>",
      };
      yield* m.sync();
      assert.strictEqual((yield* m.signatures).find((s) => s.kind === "reply")?.text, "edited");
      assert.strictEqual(
        (yield* m.namedSignatures).find((s) => s.id === short.id)?.name,
        "Renamed",
      );
      yield* m.deleteNamedSignature(short.id);
      assert.strictEqual((yield* m.signatures).find((s) => s.kind === "reply")?.text, "Changed");
      assert.deepStrictEqual(
        signatureDefault(
          yield* m.namedSignatures,
          yield* m.signatureDefaults,
          long.address,
          "reply",
        ),
        (yield* m.namedSignatures).find((s) => s.source === "gmail"),
      );
      assert.strictEqual(server.aliases[0].signature, "Changed");
    }).pipe(Effect.provide(TestMailbox({ gmail: server })));
  },
);

it("rich signature switching preserves authored formatting and goes before the reply quote", () => {
  const first = { text: "Short", html: "<b>Short</b>" };
  const second = { text: "Long", html: "<i>Long</i>" };
  const original = richComposeBody(
    "<b>My edited text</b><br><br>On Monday Alice wrote:<br>&gt; Original",
  );
  const signed = applyComposeSignature(original, undefined, first);
  assert.ok(signed.kind === "rich");
  assert.ok(signed.html.indexOf("Short") < signed.html.indexOf("On Monday"));
  const switched = applyComposeSignature(signed, first, second);
  assert.ok(switched.kind === "rich");
  assert.ok(switched.html.includes("<strong>My edited text</strong>"));
  assert.ok(switched.html.includes("<em>Long</em>"));
  assert.ok(!switched.html.includes("Short"));
  const edited = richComposeBody(switched.html.replace("Long", "Long, edited by me"));
  assert.deepStrictEqual(applyComposeSignature(edited, second, first), edited);
  assert.ok(!applyComposeSignature(switched, second, undefined).text.includes("Long"));
});

it("legacy flat signatures can be picked again without replacing signatures inside quotes", () => {
  const previous = { text: "Old" };
  const next = { text: "New", html: "<b>New</b>" };
  const legacy = richComposeBody(
    textComposeHtml("Authored\n\n-- \nOld\n\nOn Monday Alice wrote:\n> Quote"),
  );
  const switched = applyComposeSignature(legacy, previous, next);
  assert.ok(switched.text.includes("New"));
  assert.ok(!switched.text.includes("Old"));
  const quotedOnly = richComposeBody("Authored<br>On Monday Alice wrote:<br><div>--<br>Old</div>");
  const inserted = applyComposeSignature(quotedOnly, previous, next);
  assert.ok(inserted.text.includes("Old"));
  assert.ok(inserted.text.indexOf("New") < inserted.text.indexOf("On Monday"));
});

it("switching a signature retains safe original layout and excludes remote images", () => {
  const source = '<table><tr><td>Quoted</td></tr></table><img src="https://remote.test/image">';
  const first = { text: "Old", html: "<b>Old</b>" },
    next = { text: "New", html: "<i>New</i>" };
  const signed = applyComposeSignature(remoteComposeBody(source), undefined, first);
  const switched = applyComposeSignature(signed, first, next);
  assert.ok(switched.kind === "rich");
  assert.ok(switched.originalHtml?.endsWith(preservedComposeHtml(source)));
  assert.ok(!switched.html.includes("<img"));
  assert.ok(switched.html.includes("<em>New</em>"));
  assert.ok(!switched.html.includes("Old"));
});

it("reply From follows verified received aliases in To/Cc, falls back to this account's default", () => {
  const account = { id: accountId, email: "me@example.com" };
  const aliases = [
    { accountId, address: "alias@example.com", name: "Alias", isDefault: false, signature: "" },
    { accountId, address: "default@example.com", name: "Default", isDefault: true, signature: "" },
    {
      accountId: "other",
      address: "foreign@example.com",
      name: "Foreign",
      isDefault: true,
      signature: "",
    },
  ];
  const received = {
    from: { name: "Remote", address: "remote@example.com" },
    labels: [],
    to: [{ name: "", address: "foreign@example.com" }],
    cc: [{ name: "", address: "ALIAS@example.com" }],
  };
  assert.deepStrictEqual(replyFromAddress(received, account, aliases, "received"), {
    name: "Alias",
    address: "alias@example.com",
  });
  assert.strictEqual(
    replyFromAddress(received, account, aliases, "default").address,
    "default@example.com",
  );
  assert.strictEqual(
    replyFromAddress(
      {
        from: { name: "Remote", address: "remote@example.com" },
        labels: [],
        to: [{ name: "", address: "unverified@example.com" }],
        cc: [],
      },
      account,
      aliases,
      "received",
    ).address,
    "default@example.com",
  );
  assert.strictEqual(
    replyFromAddress(
      { from: { name: "Remote", address: "remote@example.com" }, labels: [], to: [], cc: [] },
      account,
      [],
      "received",
    ).address,
    account.email,
  );
});

for (const failure of [
  new ProviderError({ message: "Offline" }),
  new PermanentError({ message: "Rejected" }),
  new AuthError({ message: "Expired" }),
]) {
  it.effect(
    `draft sync error survives ${failure._tag}; keep-local stops autosave pushes without losing edits`,
    () => {
      const server = fakeServer("me@example.com");
      return Effect.gen(function* () {
        const m = yield* Mailbox;
        yield* m.connect({ provider: "gmail" });
        server.failNext = failure;
        const saved = yield* m.saveDraft({ id: "draft:failed", accountId, message });
        assert.strictEqual(saved.syncError, failure.message);
        assert.strictEqual(saved.synced, false);
        assert.strictEqual((yield* m.openDraft(saved.id)).syncError, failure.message);
        const kept = yield* m.recoverDraft(saved.id, "local");
        assert.strictEqual(kept.localOnly, true);
        assert.strictEqual(kept.syncError, null);
        yield* m.saveDraft({
          id: kept.id,
          accountId,
          message: { ...message, text: "Edited after keeping" },
        });
        yield* m.sync();
        assert.strictEqual(server.drafts.size, 0);
        assert.strictEqual((yield* m.openDraft(kept.id)).message.text, "Edited after keeping");
        assert.strictEqual((yield* m.openDraft(kept.id)).localOnly, true);
        assert.strictEqual(
          (yield* Effect.flip(m.recoverDraft("missing", "retry")))._tag,
          "NotFound",
        );
      }).pipe(Effect.provide(TestMailbox({ gmail: server })));
    },
  );
}

it.effect("Retry recovers a permanently failed draft after its queue entry was removed", () => {
  const server = fakeServer("me@example.com");
  return Effect.gen(function* () {
    const m = yield* Mailbox;
    yield* m.connect({ provider: "gmail" });
    server.failNext = new PermanentError({ message: "Rejected" });
    yield* m.saveDraft({ id: "draft:retry", accountId, message });
    const retried = yield* m.recoverDraft("draft:retry", "retry");
    assert.strictEqual(retried.synced, true);
    assert.strictEqual(retried.syncError, null);
    assert.strictEqual(server.drafts.size, 1);
    yield* m.recoverDraft(retried.id, "local");
    yield* m.sync();
    assert.strictEqual((yield* m.openDraft(retried.id)).localOnly, true);
    assert.strictEqual((yield* m.recoverDraft(retried.id, "retry")).synced, true);
    assert.strictEqual(server.drafts.size, 1);
  }).pipe(Effect.provide(TestMailbox({ gmail: server })));
});

it.effect(
  "FTS matches multiple name/address tokens, dedupes server > sent > received and tracks updates/deletes",
  () => {
    const server = fakeServer("me@example.com", [
      incoming("received", {
        date: 999999,
        from: { name: "Received name", address: "j@acme.com" },
      }),
      incoming("sent", { labels: ["SENT"], to: [{ name: "John Smith", address: "j@acme.com" }] }),
    ]);
    server.contacts = [
      { name: "Server John", address: "j@acme.com", contactKey: "people/1" },
      { name: "Server John", address: "john@other.com", contactKey: "people/1" },
      { name: "Server John", address: "different@other.com", contactKey: "people/2" },
    ];
    return Effect.gen(function* () {
      const m = yield* Mailbox;
      yield* m.connect({ provider: "gmail" });
      yield* m.sync();
      assert.deepStrictEqual(yield* m.suggestContacts("john acme"), [
        { name: "Server John", address: "j@acme.com" },
      ]);
      assert.deepStrictEqual(yield* m.contactAlternatives("J@acme.com"), [
        { name: "Server John", address: "j@acme.com" },
        { name: "Server John", address: "john@other.com" },
      ]);
      assert.strictEqual((yield* m.suggestContacts("john", { limit: 1 })).length, 1);
      assert.deepStrictEqual(yield* m.suggestContacts('" OR * % _'), []);
      assert.deepStrictEqual(yield* m.suggestContacts("john acme", { accountIds: [] }), []);
      assert.deepStrictEqual(yield* m.suggestContacts("john acme", { exclude: "J@ACME.COM" }), []);
      server.contacts = [];
      yield* m.refreshContacts(accountId);
      assert.strictEqual((yield* m.suggestContacts("john acme"))[0]?.name, "John Smith");
      server.messages.set(
        "sent",
        incoming("sent", { labels: ["SENT"], to: [{ name: "Jane", address: "j@acme.com" }] }),
      );
      yield* m.sync();
      assert.deepStrictEqual(yield* m.suggestContacts("john acme"), []);
      assert.strictEqual((yield* m.suggestContacts("jane acme"))[0]?.name, "Jane");
      server.messages.delete("sent");
      yield* m.sync();
      assert.deepStrictEqual(yield* m.suggestContacts("jane acme"), []);
      yield* m.setContactHidden("j@acme.com", true);
      assert.deepStrictEqual(yield* m.suggestContacts("acme"), []);
    }).pipe(Effect.provide(TestMailbox({ gmail: server })));
  },
);

it.effect(
  "template CRUD includes subject/to/cc/bcc/body and predefined variables stay out of custom prompts",
  () =>
    Effect.gen(function* () {
      const m = yield* Mailbox;
      const created = yield* m.saveTemplate({
        name: "Greeting",
        subject: "Hello {first_name}",
        to: message.to,
        cc: [],
        bcc: [{ name: "", address: "audit@example.com" }],
        body: "{sender_name} on {date} {time} {project}",
      });
      const updated = yield* m.saveTemplate(
        { ...created, name: "Renamed", subject: "Changed", body: "Updated" },
        created.id,
      );
      assert.strictEqual(updated.id, created.id);
      assert.strictEqual((yield* m.templates).length, 1);
      assert.strictEqual(updated.bcc?.[0]?.address, "audit@example.com");
      yield* m.deleteTemplate(created.id);
      assert.deepStrictEqual(yield* m.templates, []);
    }).pipe(Effect.provide(TestMailbox())),
);

it("predefined template values use the current sender, recipient, date and fields once", () => {
  const context = {
    sender: { name: "Ada Lovelace", address: "ada@example.com" },
    now: new Date(2026, 9, 2, 14, 30),
    locale: "en-US",
    subject: "Report",
    to: message.to,
    cc: [],
    bcc: [],
  };
  assert.strictEqual(
    fillTemplate(
      "{sender_name}|{sender_first_name}|{sender_last_name}|{sender_email}|{recipient_first_name}|{recipient_last_name}|{date}|{time}|{day}|{month}|{year}|{subject}|{to}|{cc}|{bcc}|{project}",
      { name: "John Smith", address: "j@acme.com" },
      { project: "{date}" },
      context,
    ),
    "Ada Lovelace|Ada|Lovelace|ada@example.com|John|Smith|10/2/2026|02:30 PM|2|10|2026|Report|John <j@acme.com>|||{date}",
  );
  assert.deepStrictEqual(
    customTemplateVariables(
      "{date}{time}{sender_name}{recipient_last_name}{subject}{to}{cc}{bcc}{project}",
    ),
    ["project"],
  );
});

it.effect(
  "migration 21 to 23 preserves local signatures and FTS candidates across reopening a temp database",
  () =>
    Effect.gen(function* () {
      const directory = mkdtempSync(join(tmpdir(), "openmail-signatures-"));
      try {
        const filename = join(directory, "mail.sqlite");
        const db = new DatabaseSync(filename);
        for (const migration of MIGRATIONS.slice(0, 21)) applyNativeMigration(db, migration);
        db.exec("PRAGMA user_version=21");
        db.prepare("INSERT INTO accounts(id,provider,email,created_at) VALUES(?,?,?,?)").run(
          accountId,
          "gmail",
          "me@example.com",
          0,
        );
        db.prepare("INSERT INTO signatures(address,kind,source,text) VALUES(?,?,?,?)").run(
          "me@example.com",
          "new",
          "local",
          "Preserved",
        );
        db.prepare("INSERT INTO server_contacts(account_id,address,name) VALUES(?,?,?)").run(
          accountId,
          "j@acme.com",
          "John Smith",
        );
        db.close();
        const layer = () =>
          StoreLive.pipe(
            Layer.provide(
              databaseLayer(filename, { vectorExtension: null }).pipe(Layer.provide(NodeSystem)),
            ),
          );
        yield* Effect.gen(function* () {
          const store = yield* Store;
          assert.strictEqual((yield* store.signatures)[0]?.text, "Preserved");
          assert.strictEqual(
            (yield* store.suggestContacts("john acme", 10))[0]?.address,
            "j@acme.com",
          );
          yield* store.upsertMessage(
            accountId,
            incoming("sent", {
              labels: ["SENT"],
              to: [{ name: "Jane Miller", address: "jane@business.com" }],
            }),
          );
          yield* store.putDraft({ id: "draft:persist", accountId, message });
          yield* store.setDraftSyncError("draft:persist", "Persistent failure");
          yield* store.setPrefs({ replyFrom: "default" });
          yield* store.saveNamedSignature({
            address: "me@example.com",
            name: "Persisted",
            text: "Signature",
          });
        }).pipe(Effect.provide(layer()));
        yield* Effect.gen(function* () {
          const store = yield* Store;
          const failed = yield* store.getDraft("draft:persist");
          assert.ok(failed._tag === "Some");
          assert.strictEqual(failed.value.syncError, "Persistent failure");
          yield* store.setDraftLocalOnly("draft:persist", true);
          yield* store.enqueueDraftSave(accountId, "draft:persist");
          assert.strictEqual((yield* store.listPendingOps).length, 0);
          assert.strictEqual(
            yield* store.setDraftRemote(
              "draft:persist",
              { draftId: "remote", messageId: "remote-message" },
              null,
            ),
            true,
          );
          assert.strictEqual((yield* store.prefs).replyFrom, "default");
          assert.strictEqual((yield* store.namedSignatures).length, 2);
          assert.strictEqual(
            (yield* store.suggestContacts("jane business", 10))[0]?.name,
            "Jane Miller",
          );
        }).pipe(Effect.provide(layer()));
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }),
);
