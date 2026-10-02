import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleParser } from "mailparser";
import { databaseLayer } from "./db.js";
import { DEFAULT_PREFS, Prefs as importedPrefs, type IncomingMessage } from "./domain.js";
import { makeFakeProvider, fakeServer } from "./fake-provider.js";
import { Mailbox } from "./mailbox.js";
import { MailboxLive } from "./mailbox-live.js";
import { MemoryPlatform } from "./platform-memory.js";
import { NodeSystem } from "./platform-node.js";
import { Providers, Store } from "./services.js";
import { StoreLive } from "./store.js";
import {
  imageAttachment,
  downloadRemoteImage,
  publicImageAddress,
  CONTACT_PHOTO_LIMIT,
  COMPOSE_IMAGE_LIMIT,
} from "./compose-images.js";
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
} from "./compose-body.js";
import { bestComposeSender } from "./compose-sender.js";
import { buildMime } from "./compose.js";
import { FeatureScopeMissing } from "./errors.js";

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
        delete server.featureFailure;
        server.contactPhotos = [
          { address: alice.address, url: "https://lh3.googleusercontent.com/2.png" },
        ];
        server.contactGroups = [];
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
      const sent: IncomingMessage = {
        providerId: "sent",
        threadId: "sent",
        subject: "",
        from: { name: "Work", address: "alias@example.org" },
        to: [alice],
        cc: [],
        date: 1000,
        snippet: "",
        bodyText: "",
        bodyHtml: "",
        labels: ["SENT"],
        attachments: [],
        isUnread: false,
        isStarred: false,
      };
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
      const html = `${inlineImageHtml(file, "small")}${mentionHtml(alice, "00000000-0000-4000-8000-000000000000")}<span style="font-family:evil;font-size:999px" onclick="evil()">safe</span><img src="https://tracker.example.com/x">`;
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
      assert.strictEqual(small.html, '<img src="cid:x@openmail" width="320">');
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
