import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { Mailbox } from "./mailbox.js";
import { makeFakeProvider } from "./fake-provider.js";
import { MailboxLive } from "./mailbox-live.js";
import { fakeServer, TestMailbox } from "./testing.js";
import { Providers, Store } from "./services.js";
import { StoreLive } from "./store.js";
import { MemoryPlatform } from "./platform-memory.js";
import { buildMime } from "./compose.js";
import { parseRawDraft } from "./drafts.js";
import {
  composeHtmlHasUnsupported,
  composeTransportHtml,
  richComposeBody,
  outgoingComposeBody,
} from "./compose-body.js";

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

it("font wrappers and nested safe styles stay editable while arbitrary CSS and active attributes are rejected", () => {
  const valid = '<div style="font-family:Georgia;font-size:18px"><b>Hello</b></div>';
  assert.strictEqual(composeHtmlHasUnsupported(valid), false);
  assert.strictEqual(richComposeBody(valid).html.includes("style="), true);
  assert.strictEqual(composeHtmlHasUnsupported(`<span>${valid}</span>`), false);
  assert.strictEqual(composeHtmlHasUnsupported(valid.replace("<b>Hello</b>", valid)), false);
  for (const invalid of [
    valid.replace("18px", "999px"),
    valid.replace("Georgia", "Comic Sans"),
    valid.replace('18px"', '18px;color:red"'),
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
import { emojiAtCaret } from "./compose-extras.js";

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
      const layer = MailboxLive({
        backgroundFlush: false,
        imageDownloader: () =>
          Effect.gen(function* () {
            downloads++;
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return { mimeType: "image/png", content: png };
          }),
      }).pipe(
        Layer.provideMerge(
          Layer.mergeAll(StoreLive, Layer.succeed(Providers, { get: () => adapter })).pipe(
            Layer.provideMerge(MemoryPlatform()),
          ),
        ),
      );
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
