import { incoming as makeIncoming, TestMailbox } from "../platform/node/testing.js";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema, Deferred, Fiber } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleParser } from "mailparser";
import { databaseLayer } from "../platform/node/db.js";
import { DEFAULT_PREFS, Prefs as importedPrefs } from "../domain/prefs.js";
import type { IncomingMessage } from "../domain/message.js";
import type { Account } from "../domain/account.js";
import { makeFakeProvider, fakeServer } from "../platform/node/fake-provider.js";
import { Mailbox } from "../mailbox/mailbox.js";
import { MailboxLive } from "../mailbox/mailbox-live.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import { NodeSystem } from "../platform/node/platform-node.js";
import { Providers } from "../providers/adapter.js";
import { Store } from "../store/service.js";
import { StoreLive } from "../store/store.js";
import {
  imageAttachment,
  downloadRemoteImage,
  publicImageAddress,
  CONTACT_PHOTO_LIMIT,
  COMPOSE_IMAGE_LIMIT,
  parseRawDraft,
} from "../platform/node/portable-helpers.js";
import {
  inlineImageHtml,
  mentionHtml,
  mentionQuery,
  reconcileMentionRecipients,
  emojiAtCaret,
} from "./compose-extras.js";
import {
  richComposeBody,
  editedComposeBody,
  composeTransportHtml,
  normalizeComposeMessage,
  composeHtmlHasUnsupported,
  outgoingComposeBody,
} from "./compose-body.js";
import { bestComposeSender } from "./compose-sender.js";
import { buildMime } from "../platform/node/compose.js";
import { FeatureScopeMissing, ProviderError } from "../domain/errors.js";
import { SqlClient } from "effect/sql";
import { makeGmailFeatures } from "../providers/gmail/gmail-features.js";
import { makeOutlookFeatures } from "../providers/outlook/outlook-features.js";
{
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ2kAAAAASUVORK5CYII=";

  const alice = { name: "Alice", address: "alice@example.com" };

  const bob = { name: "Bob", address: "bob@example.com" };

  it.effect(
    "temporary DB: groups/photos survive reopen, refresh invalidates photos, opt-out prevents downloads and account deletion removes caches",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.sync(() => mkdtempSync(join(tmpdir(), "openmail-contact-extras-"))),
          (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
        );
        const server = fakeServer("me@example.com");
        const id = "gmail:me@example.com";
        server.contacts = [alice, bob];
        server.contactGroups = [
          {
            accountId: id,
            id: "contactGroups/team",
            name: "Team",
            members: [alice, bob, { ...alice, address: "ALICE@example.com" }],
          },
        ];
        server.contactPhotos = [
          { address: alice.address, url: "https://lh3.googleusercontent.com/1.png" },
        ];
        const adapter = makeFakeProvider(server);
        const downloads: { url: string; limit: number }[] = [];
        const layer = () =>
          MailboxLive({
            backgroundFlush: false,
            imageDownloader: (url, limit) =>
              Effect.sync(() => {
                downloads.push({ url, limit });
                return { mimeType: "image/png", content: png };
              }),
          }).pipe(
            Layer.provide(
              Layer.merge(
                StoreLive.pipe(
                  Layer.provide(
                    databaseLayer(join(directory, "mail.db")).pipe(Layer.provide(NodeSystem)),
                  ),
                ),
                Layer.succeed(Providers, { get: () => adapter }),
              ),
            ),
            Layer.provide(MemoryPlatform()),
          );
        yield* Effect.gen(function* () {
          const m = yield* Mailbox;
          yield* m.connect({ provider: "gmail" });
          yield* m.refreshContacts(id);
          assert.deepStrictEqual((yield* m.contactGroups("team", [id]))[0]?.members, [alice, bob]);
          assert.deepStrictEqual(yield* m.contactGroups("team", []), []);
          yield* m.setPrefs({
            contactPhotos: false,
            composeFont: { family: "Georgia", size: 18 },
            inlineImageSize: "large",
            emojiReplacement: false,
          });
          assert.strictEqual(yield* m.contactPhoto(id, alice.address), null);
          assert.strictEqual(downloads.length, 0);
          yield* m.setPrefs({ contactPhotos: true });
          assert.strictEqual(
            yield* m.contactPhoto(id, alice.address),
            `data:image/png;base64,${png}`,
          );
          assert.deepStrictEqual(downloads, [
            { url: server.contactPhotos[0]?.url, limit: CONTACT_PHOTO_LIMIT },
          ]);
          assert.strictEqual(yield* m.contactPhoto(id, bob.address), null);
        }).pipe(Effect.provide(layer()));
        yield* Effect.gen(function* () {
          const m = yield* Mailbox;
          assert.strictEqual((yield* m.contactGroups("Team"))[0]?.members.length, 2);
          assert.strictEqual((yield* m.prefs).composeFont.family, "Georgia");
          assert.strictEqual((yield* m.prefs).inlineImageSize, "large");
          assert.strictEqual((yield* m.prefs).emojiReplacement, false);
          yield* m.contactPhoto(id, alice.address);
          assert.strictEqual(downloads.length, 1);
          server.featureFailure = new FeatureScopeMissing({
            accountId: id,
            feature: "contacts",
            message: "Missing grant",
          });
          yield* m.refreshContacts(id).pipe(Effect.result);
          assert.strictEqual((yield* m.contactGroups("Team")).length, 1);
          assert.strictEqual(yield* m.contactPhoto(id, alice.address), null);
          assert.strictEqual(downloads.length, 1);
          delete server.featureFailure;
          server.contactPhotos = [
            { address: alice.address, url: "https://lh3.googleusercontent.com/2.png" },
          ];
          server.contactGroups = [];
          yield* m.reauth(id);
          yield* m.refreshContacts(id);
          assert.deepStrictEqual(yield* m.contactGroups("Team"), []);
          yield* m.contactPhoto(id, alice.address);
          assert.strictEqual(downloads.length, 2);
          yield* m.setAccountSettings(id, { enabled: false, description: "", color: null });
          assert.strictEqual(yield* m.contactPhoto(id, alice.address), null);
          assert.deepStrictEqual(yield* m.contactGroups(""), []);
          yield* m.perform(
            { kind: "removeAccount", accountId: id },
            { kind: "user", surface: "app" },
          );
          assert.strictEqual(yield* m.contactPhoto(id, alice.address), null);
        }).pipe(Effect.provide(layer()));
      }),
  );

  it.effect(
    "sender scoring uses exact sent recipients/alias, respects enabled accounts and rejects ties",
    () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const one = yield* store.upsertAccount("gmail", "me@gmail.com");
        const two = yield* store.upsertAccount("gmail", "work@example.org");
        const sent: IncomingMessage = makeIncoming("sent", {
          threadId: "sent",
          subject: "",
          from: { name: "Work", address: "alias@example.org" },
          to: [alice],
          bodyText: "",
          labels: ["SENT"],
          isUnread: false,
        });
        yield* store.upsertMessage(two.id, sent);
        const history = yield* store.senderHistory(["ALICE@example.com"]);
        const current = { accountId: one.id, address: one.email, name: "" };
        const alias = { accountId: two.id, address: "alias@example.org", name: "Work" };
        assert.deepStrictEqual(
          bestComposeSender([current, alias], current, [alice.address], history),
          alias,
        );
        assert.strictEqual(
          bestComposeSender([current, alias], current, ["other@gmail.com"], history),
          null,
        );
        assert.strictEqual(
          bestComposeSender([current, alias], alias, [alice.address], history),
          null,
        );
        assert.strictEqual(
          bestComposeSender(
            [current, alias],
            current,
            [alice.address],
            [...history, { ...history[0]!, accountId: one.id, address: one.email }],
          ),
          null,
        );
        yield* store.setAccountSettings(two.id, { enabled: false, description: "", color: null });
        assert.deepStrictEqual(yield* store.senderHistory([alice.address]), []);
      }).pipe(Effect.provide(StoreLive.pipe(Layer.provide(MemoryPlatform())))),
  );

  it.effect(
    "file/URL inline images, numeric resize and font wrapper survive draft normalization and MIME while arbitrary styles and hotlinks are removed",
    () =>
      Effect.gen(function* () {
        const file = yield* imageAttachment({
          filename: "picture.png",
          content: png,
          mimeType: "image/png",
        });
        assert.ok(file.contentId);
        const html = `${inlineImageHtml(file, "small")}${mentionHtml(alice, "00000000-0000-4000-8000-000000000000")}<span style="font-family:url(https://tracker.example.com/font);font-size:999px" onclick="evil()">safe</span><img src="https://tracker.example.com/x">`;
        const body = richComposeBody(html);
        assert.ok(body.html.includes('width="160"'));
        assert.ok(!body.html.includes("tracker"));
        assert.ok(!body.html.includes("style="));
        assert.ok(!body.html.includes("onclick"));
        const message = normalizeComposeMessage({
          to: [alice],
          cc: [],
          bcc: [],
          subject: "Image",
          text: "",
          html: body.html,
          composeFont: { family: "Georgia", size: 18 },
          attachments: [file],
        });
        const normalized = normalizeComposeMessage(message);
        assert.deepStrictEqual(normalized, message);
        assert.deepStrictEqual(
          editedComposeBody({ ...body, font: message.composeFont }, `${body.html}edit`).font,
          message.composeFont,
        );
        assert.ok(
          composeTransportHtml(message)?.startsWith(
            '<div style="font-family:Georgia;font-size:18px">',
          ),
        );
        assert.ok(!composeTransportHtml(message)?.includes("data-compose-mention"));
        const raw = yield* buildMime({ name: "Me", address: "me@example.com" }, message);
        const parsed = yield* Effect.promise(() => simpleParser(raw));
        assert.strictEqual(parsed.attachments[0]?.contentId, `<${file.contentId}>`);
        assert.strictEqual(parsed.attachments[0]?.contentDisposition, "inline");
        assert.ok(String(parsed.html).includes('width="160"'));
        assert.ok(String(parsed.html).includes("font-family:Georgia"));
        const small = richComposeBody(
          '<img src="cid:x@openmail" width="320" height="9" style="width:99px" onerror="evil()">',
        );
        assert.strictEqual(small.html, '<img src="cid:x@openmail" width="320" height="9">');
        assert.ok(!inlineImageHtml(file, "original").includes("width="));
        assert.strictEqual(
          (yield* imageAttachment({
            filename: "x.svg",
            mimeType: "image/svg+xml",
            content: Buffer.from("<svg/>").toString("base64"),
          }).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.strictEqual(
          (yield* imageAttachment({
            filename: "x.png",
            mimeType: "image/png",
            content: Buffer.from("<html>fake</html>").toString("base64"),
          }).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.strictEqual(
          (yield* imageAttachment({
            filename: "x.png",
            mimeType: "image/png",
            content: Buffer.alloc(COMPOSE_IMAGE_LIMIT + 1).toString("base64"),
          }).pipe(Effect.result))._tag,
          "Failure",
        );
      }),
  );

  it.effect("URL downloader rejects private/literal addresses before making an HTTP request", () =>
    Effect.gen(function* () {
      for (const address of [
        "127.0.0.1",
        "10.1.2.3",
        "172.20.1.1",
        "192.168.1.1",
        "169.254.169.254",
        "::1",
        "::ffff:127.0.0.1",
        "fe80::1",
      ])
        assert.strictEqual(publicImageAddress(address), false);
      assert.strictEqual(publicImageAddress("8.8.8.8"), true);
      for (const url of [
        "http://127.0.0.1/image.png",
        "https://user:pass@example.com/image.png",
        "file:///tmp/image.png",
        "https://example.com:9000/image.png",
      ])
        assert.strictEqual(
          (yield* downloadRemoteImage(url, 100).pipe(Effect.result))._tag,
          "Failure",
        );
    }),
  );

  it("mentions retain existing To/Cc/Bcc, remove only fresh recipients, support duplicate mentions and escape name links", () => {
    assert.deepStrictEqual(mentionQuery("Hello @Ali"), { query: "Ali", length: 4 });
    assert.deepStrictEqual(mentionQuery("+Bob"), { query: "Bob", length: 4 });
    assert.strictEqual(mentionQuery("alice@example.com"), null);
    const added = reconcileMentionRecipients(
      [alice],
      [bob],
      [alice, bob, { name: "New", address: "new@example.com" }],
      new Set(),
    );
    assert.deepStrictEqual([...added.fresh], ["new@example.com"]);
    const removed = reconcileMentionRecipients(added.to, [bob], [alice, bob], added.fresh);
    assert.deepStrictEqual(removed.to, [alice]);
    const kept = reconcileMentionRecipients(
      added.to,
      [bob],
      [
        { name: "New", address: "new@example.com" },
        { name: "New", address: "new@example.com" },
      ],
      added.fresh,
    );
    assert.strictEqual(kept.to.length, 2);
    assert.ok(mentionHtml({ ...alice, name: '<img onerror="evil()">' }).includes("&lt;img"));
  });

  it("emoji tokens replace only complete typed text and fonts reject arbitrary schema values", () => {
    const text = "Great :+1: ";
    const replacement = emojiAtCaret(text);
    assert.ok(replacement);
    assert.strictEqual(
      text.slice(0, replacement.start) + replacement.replacement + text.slice(replacement.end),
      "Great 👍 ",
    );
    assert.ok(emojiAtCaret(":) "));
    assert.strictEqual(emojiAtCaret("https://example.com/:) "), null);
    assert.strictEqual(emojiAtCaret("unfinished :)"), null);
    assert.throws(() =>
      Schema.decodeUnknownSync(importedPrefs)({
        ...DEFAULT_PREFS,
        composeFont: { family: "Arial; background:url(https://evil)", size: 14 },
      }),
    );
  });

  it.effect(
    "mailbox API: From suggestion chooses a verified Gmail alias and URL downloads become CID attachments in saved drafts",
    () => {
      const gmail = fakeServer("me@gmail.com", [
        {
          providerId: "sent",
          threadId: "sent",
          subject: "",
          from: { name: "Alias", address: "alias@example.org" },
          to: [alice],
          cc: [bob],
          date: 1000,
          snippet: "",
          bodyText: "",
          bodyHtml: "",
          labels: ["SENT"],
          attachments: [],
          isUnread: false,
          isStarred: false,
        },
      ]);
      const outlook = fakeServer("me@outlook.com");
      gmail.aliases = [
        {
          accountId: "gmail:me@gmail.com",
          address: "alias@example.org",
          name: "Alias",
          signature: "",
          isDefault: false,
        },
      ];
      const adapters = { gmail: makeFakeProvider(gmail), outlook: makeFakeProvider(outlook) };
      let limitSeen = 0;
      const layer = MailboxLive({
        backgroundFlush: false,
        imageDownloader: (_url, limit) =>
          Effect.sync(() => {
            limitSeen = limit;
            return { mimeType: "image/png", content: png };
          }),
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            StoreLive,
            Layer.succeed(Providers, {
              get: (provider) => (provider === "gmail" ? adapters.gmail : adapters.outlook),
            }),
          ).pipe(Layer.provideMerge(MemoryPlatform())),
        ),
      );
      return Effect.gen(function* () {
        const m = yield* Mailbox;
        const first = yield* m.connect({ provider: "gmail" });
        const second = yield* m.connect({ provider: "outlook" });
        yield* m.sync();
        yield* m.syncSendAs(first.id);
        const current = { accountId: second.id, address: second.email };
        assert.deepStrictEqual(
          yield* m.suggestSender(current, [alice.address], [first.id, second.id]),
          { accountId: first.id, address: "alias@example.org", name: "Alias" },
        );
        assert.deepStrictEqual(
          yield* m.suggestSender(current, [bob.address], [first.id, second.id]),
          { accountId: first.id, address: "alias@example.org", name: "Alias" },
        );
        assert.strictEqual(yield* m.suggestSender(current, [alice.address], [second.id]), null);
        const image = yield* m.imageFromUrl("https://images.example.com/test.png");
        assert.strictEqual(limitSeen, COMPOSE_IMAGE_LIMIT);
        assert.ok(image.contentId);
        const draft = yield* m.saveDraft({
          id: "draft:image",
          accountId: first.id,
          message: {
            to: [alice],
            cc: [],
            bcc: [],
            subject: "Inline",
            text: "",
            html: inlineImageHtml(image, "large"),
            attachments: [image],
            composeFont: { family: "Georgia", size: 18 },
          },
        });
        assert.strictEqual(draft.message.attachments[0]?.contentId, image.contentId);
        assert.ok(draft.message.html?.includes(`cid:${image.contentId}`));
        assert.ok(!draft.message.html?.includes("https://images"));
        assert.deepStrictEqual(draft.message.composeFont, { family: "Georgia", size: 18 });
        yield* m.setAccountSettings(first.id, { enabled: false, description: "", color: null });
        assert.strictEqual(
          yield* m.suggestSender(current, [alice.address], [first.id, second.id]),
          null,
        );
      }).pipe(Effect.provide(layer));
    },
  );
}

{
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ2kAAAAASUVORK5CYII=";

  const font = { family: "Georgia", size: 18 } as const;

  const person = { name: "Alice", address: "alice@example.com" };

  const message = {
    to: [person],
    cc: [],
    bcc: [],
    subject: "Default font",
    text: "Hello",
    html: "<strong>Hello</strong>",
    attachments: [],
    composeFont: font,
  };

  it.effect(
    "default font survives MIME parsing and provider draft import without locking the editor or nesting wrappers on save",
    () =>
      Effect.gen(function* () {
        const raw = yield* buildMime(
          { name: "Me", address: "me@example.com" },
          message,
          {},
          { draft: true },
        );
        const parsed = yield* parseRawDraft(raw);
        assert.strictEqual(composeHtmlHasUnsupported(parsed.originalHtml ?? ""), false);
        const html = composeTransportHtml(message);
        assert.ok(html);
        const server = fakeServer("me@example.com", [
          {
            providerId: "remote",
            threadId: "remote",
            subject: message.subject,
            from: { name: "Me", address: serverEmail },
            to: [person],
            cc: [],
            date: 1,
            snippet: "Hello",
            bodyText: "Hello",
            bodyHtml: html,
            labels: ["DRAFT"],
            attachments: [],
            isUnread: false,
            isStarred: false,
          },
        ]);
        server.raw.set("remote", raw);
        yield* Effect.gen(function* () {
          const m = yield* Mailbox;
          const account = yield* m.connect({ provider: "gmail" });
          yield* m.sync();
          const draft = yield* m.openDraft(`${account.id}/remote`);
          assert.deepStrictEqual(draft.message.composeFont, font);
          const body = outgoingComposeBody(draft.message);
          assert.ok(body.kind === "rich");
          assert.deepStrictEqual(body.font, font);
          assert.strictEqual(composeHtmlHasUnsupported(body.originalHtml ?? body.html), false);
          const saved = yield* m.saveDraft({
            id: draft.id,
            accountId: account.id,
            message: draft.message,
          });
          const savedRaw = yield* buildMime(
            { name: "Me", address: account.email },
            saved.message,
            {},
            { draft: true },
          );
          const reimport = yield* parseRawDraft(savedRaw);
          assert.strictEqual(composeHtmlHasUnsupported(reimport.originalHtml ?? ""), false);
          assert.strictEqual(
            (composeTransportHtml(saved.message)?.match(/font-family:/g) ?? []).length,
            1,
          );
        }).pipe(Effect.provide(TestMailbox({ gmail: server })));
      }),
  );

  const serverEmail = "me@example.com";

  it("font wrappers and nested safe styles stay editable while unsafe CSS and active attributes are rejected", () => {
    const valid = '<div style="font-family:Georgia;font-size:18px"><b>Hello</b></div>';
    assert.strictEqual(composeHtmlHasUnsupported(valid), false);
    assert.strictEqual(richComposeBody(valid).html.includes("style="), true);
    assert.strictEqual(composeHtmlHasUnsupported(`<span>${valid}</span>`), false);
    assert.strictEqual(composeHtmlHasUnsupported(valid.replace("<b>Hello</b>", valid)), false);
    assert.strictEqual(composeHtmlHasUnsupported(valid.replace('18px"', '18px;color:red"')), false);
    for (const invalid of [
      valid.replace("18px", "999px"),
      valid.replace("Georgia", "url(https://tracker.example.com/font)"),
      valid.replace('18px"', '18px;color:var(--unsafe)"'),
      valid.replace("<div style", '<div onclick="evil()" style'),
    ])
      assert.strictEqual(composeHtmlHasUnsupported(invalid), true);
  });

  it.effect(
    "contact photo downloads require Google HTTPS hosts, while generic image URL insertion remains available",
    () => {
      const server = fakeServer("me@example.com");
      server.contactPhotos = [{ address: person.address, url: "https://evil.example/image.png" }];
      let downloads = 0;
      return Effect.gen(function* () {
        const m = yield* Mailbox;
        const account = yield* m.connect({ provider: "gmail" });
        for (const url of [
          "https://evil.example/image.png",
          "http://lh3.googleusercontent.com/image.png",
          "https://googleusercontent.com.evil.test/image.png",
          "https://evilgoogleusercontent.com/image.png",
          "https://user:secret@lh3.googleusercontent.com/image.png",
        ]) {
          server.contactPhotos = [{ address: person.address, url }];
          yield* m.refreshContacts(account.id);
          assert.strictEqual(yield* m.contactPhoto(account.id, person.address), null);
          assert.strictEqual(downloads, 0);
        }
        for (const url of [
          "https://googleusercontent.com/image.png",
          "https://lh3.googleusercontent.com/image.png",
        ]) {
          server.contactPhotos = [{ address: person.address, url }];
          yield* m.refreshContacts(account.id);
          assert.strictEqual(
            yield* m.contactPhoto(account.id, person.address),
            `data:image/png;base64,${png}`,
          );
        }
        assert.strictEqual(downloads, 2);
        yield* m.imageFromUrl("https://public.example/image.png");
        assert.strictEqual(downloads, 3);
      }).pipe(
        Effect.provide(
          TestMailbox(
            { gmail: server },
            {
              backgroundFlush: false,
              imageDownloader: () =>
                Effect.sync(() => {
                  downloads++;
                  return { mimeType: "image/png", content: png };
                }),
            },
          ),
        ),
      );
    },
  );

  it.effect(
    "turning off photos removes cached bytes, including a late download, and LRU caps cached rows and bytes",
    () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const account = yield* store.upsertAccount("gmail", "me@example.com");
        const photos = Array.from({ length: 140 }, (_, i) => ({
          address: `person-${i}@example.com`,
          url: `https://lh3.googleusercontent.com/${i}.png`,
        }));
        yield* store.replaceContactExtras(account.id, { groups: [], photos });
        const first = photos[0]!;
        yield* store.cacheContactPhoto(
          account.id,
          first.address,
          first.url,
          `data:image/png;base64,${png}`,
        );
        yield* store.setPrefs({ contactPhotos: false });
        assert.strictEqual(
          (yield* store.contactPhotoSource(account.id, first.address))?.dataUrl,
          null,
        );
        yield* store.cacheContactPhoto(
          account.id,
          first.address,
          first.url,
          `data:image/png;base64,${png}`,
        );
        assert.strictEqual(
          (yield* store.contactPhotoSource(account.id, first.address))?.dataUrl,
          null,
        );
        yield* store.setPrefs({ contactPhotos: true });
        for (const photo of photos.slice(0, 128))
          yield* store.cacheContactPhoto(
            account.id,
            photo.address,
            photo.url,
            `data:image/png;base64,${png}`,
          );
        yield* store.contactPhotoSource(account.id, first.address);
        const next = photos[128]!;
        yield* store.cacheContactPhoto(
          account.id,
          next.address,
          next.url,
          `data:image/png;base64,${png}`,
        );
        assert.ok((yield* store.contactPhotoSource(account.id, first.address))?.dataUrl);
        assert.strictEqual(
          (yield* store.contactPhotoSource(account.id, photos[1]!.address))?.dataUrl,
          null,
        );
        for (const photo of photos.slice(0, 32))
          yield* store.cacheContactPhoto(
            account.id,
            photo.address,
            photo.url,
            `data:image/png;base64,${png}${"A".repeat(330000)}`,
          );
        const sql = yield* SqlClient.SqlClient;
        const [stats] =
          yield* sql`SELECT COUNT(*) AS rows, COALESCE(SUM(length(data_url)),0) AS bytes FROM contact_photos WHERE data_url IS NOT NULL`.pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Array(Schema.Struct({ rows: Schema.Number, bytes: Schema.Number })),
              ),
            ),
          );
        assert.ok(stats && stats.rows <= 128 && stats.bytes <= 8 * 1024 * 1024);
        assert.ok(stats.bytes > 7 * 1024 * 1024);
        assert.strictEqual(
          (yield* store.contactPhotoSource(account.id, first.address))?.dataUrl,
          null,
        );
      }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
  );

  it("Markdown emoji replacement skips open fences, inline code, escaped delimiters and multiline code spans", () => {
    for (const text of [
      "```js\n:+1: ",
      "~~~\n:) ",
      "````\n```\n:) ",
      "Type ` :) ",
      "Type `` one ` :) ",
      "`one\n:) ",
    ])
      assert.strictEqual(emojiAtCaret(text, true), null, text);
    for (const text of [
      "```\ncode\n```\n:) ",
      "~~~\ncode\n~~~\n:+1: ",
      "`code` :) ",
      "\\` :) ",
      "Plain :) ",
    ])
      assert.ok(emojiAtCaret(text, true), text);
    assert.ok(emojiAtCaret("```\n:) ", false));
  });

  it.effect(
    "an in-flight photo cannot refill the cache after opt-out; re-enabling downloads a fresh copy",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const server = fakeServer("me@example.com");
        server.contactPhotos = [
          { address: person.address, url: "https://lh3.googleusercontent.com/photo.png" },
        ];
        const adapter = makeFakeProvider(server);
        let downloads = 0;
        const layer = TestMailbox.withAdapter(adapter, {
          options: {
            backgroundFlush: false,
            imageDownloader: () =>
              Effect.gen(function* () {
                downloads++;
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
                return { mimeType: "image/png", content: png };
              }),
          },
          platformOptions: {},
        });
        yield* Effect.gen(function* () {
          const m = yield* Mailbox;
          const store = yield* Store;
          const account = yield* m.connect({ provider: "gmail" });
          yield* m.refreshContacts(account.id);
          const photo = yield* Effect.forkChild(m.contactPhoto(account.id, person.address));
          yield* Deferred.await(started);
          yield* m.setPrefs({ contactPhotos: false });
          yield* Deferred.succeed(release, undefined);
          assert.strictEqual(yield* Fiber.join(photo), null);
          assert.strictEqual(
            (yield* store.contactPhotoSource(account.id, person.address))?.dataUrl,
            null,
          );
          yield* m.setPrefs({ contactPhotos: true });
          assert.strictEqual(
            yield* m.contactPhoto(account.id, person.address),
            `data:image/png;base64,${png}`,
          );
          assert.strictEqual(downloads, 2);
        }).pipe(Effect.provide(layer));
      }),
  );
}

{
  const layer = StoreLive.pipe(Layer.provideMerge(MemoryPlatform()));

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
        assert.deepStrictEqual(
          yield* store.suggestContacts("john acm", 10, undefined, [first.id]),
          [{ name: "John Smith", address: "john@example.com" }],
        );
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
      assert.ok(
        new URL(paths[0] ?? "").searchParams.get("personFields")?.includes("organizations"),
      );
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
}
