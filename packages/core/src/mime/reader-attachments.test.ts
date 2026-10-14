import { vi, expect } from "vitest";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IncomingMessage } from "../domain/message.js";
import { DEFAULT_PREFS } from "../domain/prefs.js";
import { buildMime } from "../platform/node/compose.js";
import { databaseLayer } from "../platform/node/db.js";
import { Mailbox } from "../mailbox/mailbox.js";
import { MailboxLive } from "../mailbox/mailbox-live.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import { NodeSystem } from "../platform/node/platform-node.js";
import { Providers } from "../providers/adapter.js";
import { makeFakeProvider } from "../platform/node/fake-provider.js";
import { fakeServer } from "../platform/node/testing.js";
import { StoreLive } from "../store/store.js";
import { LIST_DENSITIES, listWindow, specialFolderBadge } from "../app/list-window.js";
import { inspectAttachment } from "./attachment-import.js";
{
  const original: IncomingMessage = {
    providerId: "original",
    threadId: "thread",
    subject: "Containers",
    from: { name: "Sender", address: "sender@example.com" },
    to: [],
    cc: [],
    date: 1000,
    snippet: "",
    bodyText: "",
    bodyHtml: "",
    labels: ["INBOX"],
    attachments: [],
    isUnread: true,
    isStarred: false,
  };

  for (const provider of ["gmail", "outlook", "imap"] as const) {
    it.effect(`${provider}: reader containers and prefs survive a temporary database reopen`, () =>
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.sync(() => mkdtempSync(join(tmpdir(), "om-reader-"))),
          (folder) => Effect.sync(() => rmSync(folder, { recursive: true, force: true })),
        );
        const winmail = readFileSync(
          new URL("../../test-support/fixtures/legacy-winmail.dat", import.meta.url),
        );
        // Raw incoming RFC822 deliberately bypasses our outgoing HTML sanitizer.
        const nested = Buffer.from(
          [
            "From: Sender <sender@example.com>",
            "To: Receiver <to@example.com>",
            "Subject: Inside",
            "Date: Fri, 02 Oct 2026 10:00:00 +0000",
            "MIME-Version: 1.0",
            'Content-Type: multipart/mixed; boundary="embedded"',
            "",
            "--embedded",
            "Content-Type: text/html; charset=utf-8",
            "Content-Transfer-Encoding: 8bit",
            "",
            '<p onclick="alert(1)">Hello</p><script>alert(1)</script><img src="https://remote.example/image.png"><iframe src="https://remote.example"></iframe>',
            "--embedded",
            "Content-Type: text/plain",
            'Content-Disposition: attachment; filename="inside.txt"',
            "Content-Transfer-Encoding: base64",
            "",
            "aW5zaWRl",
            "--embedded--",
            "",
          ].join("\r\n"),
        );
        const items = [
          {
            filename: "winmail.dat",
            mimeType: "application/ms-tnef",
            content: winmail.toString("base64"),
          },
          {
            filename: "attached.eml",
            mimeType: "message/rfc822",
            content: Buffer.from(nested).toString("base64"),
          },
          { filename: "same.txt", mimeType: "text/plain", content: "dG9w" },
          { filename: "winmail.dat", mimeType: "application/ms-tnef", content: "YmFk" },
        ];
        const server = fakeServer("me@example.com", [
          {
            ...original,
            attachments: items.map((file) => ({
              ...file,
              size: Buffer.from(file.content, "base64").length,
            })),
          },
        ]);
        server.raw.set(
          "original",
          yield* buildMime(original.from, {
            to: [],
            cc: [],
            bcc: [],
            subject: "Containers",
            text: "",
            attachments: items,
          }),
        );
        const adapter = makeFakeProvider(server);
        const fetched = vi.spyOn(adapter, "fetchAttachment");
        const layer = () =>
          MailboxLive({ backgroundFlush: false }).pipe(
            Layer.provide(
              Layer.merge(
                StoreLive.pipe(
                  Layer.provide(
                    databaseLayer(join(directory, "mail.db")).pipe(Layer.provide(NodeSystem)),
                  ),
                ),
                Layer.succeed(Providers, Providers.of({ get: () => adapter })),
              ),
            ),
            Layer.provide(MemoryPlatform()),
          );
        const id = yield* Effect.gen(function* () {
          const m = yield* Mailbox;
          const account = yield* m.connect(
            provider === "imap"
              ? {
                  provider,
                  input: {
                    preset: "custom",
                    email: server.email,
                    password: "pw",
                    imapHost: "imap.example.com",
                    imapPort: 993,
                    smtpHost: "smtp.example.com",
                    smtpPort: 465,
                  },
                }
              : { provider },
          );
          yield* m.sync();
          yield* m.app.setPrefs({
            messageListDensity: "expanded",
            specialFolderBadges: { starred: false, drafts: true, spam: false },
          });
          const id = `${account.id}/original`;
          const files = yield* m.reading.readerAttachments(id);
          const calls = fetched.mock.calls.length;
          yield* m.reading.readerAttachments(id);
          assert.strictEqual(fetched.mock.calls.length, calls);
          assert.deepStrictEqual(
            files.map((file) => file.path),
            [[0, 0], [0, 1], [0, 2], [1], [2], [3]],
          );
          assert.strictEqual(files[5]?.decodeError, true);
          assert.ok(files.every((file) => !("data" in file)));
          assert.strictEqual(
            Buffer.from((yield* m.reading.attachmentPart(id, [0, 1])).data).toString(),
            "second",
          );
          assert.strictEqual(
            Buffer.from((yield* m.reading.attachmentPart(id, [2])).data).toString(),
            "top",
          );
          const inside = yield* m.reading.embeddedMessage(id, [1]);
          assert.strictEqual(inside.subject, "Inside");
          assert.include(inside.from, "sender@example.com");
          assert.include(inside.to, "to@example.com");
          assert.notInclude(inside.bodyHtml, "script");
          assert.notInclude(inside.bodyHtml, "iframe");
          assert.include(inside.bodyHtml, "Hello");
          assert.deepStrictEqual(
            inside.attachments.map((a) => a.path),
            [[1, 0]],
          );
          assert.strictEqual(
            Buffer.from((yield* m.reading.attachmentPart(id, [1, 0])).data).toString(),
            "inside",
          );
          for (const invalid of [[], [-1], [0, 99], Array.from({ length: 9 }, () => 0)])
            assert.strictEqual(
              (yield* m.reading.attachmentPart(id, invalid).pipe(Effect.result))._tag,
              "Failure",
            );
          assert.strictEqual(
            (yield* m.reading.embeddedMessage(id, [2]).pipe(Effect.result))._tag,
            "Failure",
          );
          return id;
        }).pipe(Effect.provide(layer()));
        yield* Effect.gen(function* () {
          const m = yield* Mailbox;
          const prefs = yield* m.app.prefs;
          assert.strictEqual(prefs.messageListDensity, "expanded");
          assert.deepStrictEqual(prefs.specialFolderBadges, {
            starred: false,
            drafts: true,
            spam: false,
          });
          assert.strictEqual((yield* m.reading.readerAttachments(id)).length, 6);
        }).pipe(Effect.provide(layer()));
      }),
    );
  }

  it("all densities keep virtual row geometry and special-folder toggles independent", () => {
    assert.deepStrictEqual(
      Object.values(LIST_DENSITIES).map((d) => d.previewLines),
      [0, 1, 1, 2],
    );
    for (const density of Object.values(LIST_DENSITIES)) {
      const window = listWindow(100000, density.height * 50000, 600, density.height);
      assert.strictEqual(window.total, 100000 * density.height);
      assert.strictEqual(window.offset, window.first * density.height);
      assert.isAtMost(window.end - window.first, Math.ceil(600 / density.height) + 13);
    }
    const counts = { INBOX: 4, STARRED: 3, DRAFT: 2, SPAM: 1 };
    for (const folder of ["starred", "drafts", "spam"] as const) {
      assert.isAbove(specialFolderBadge(folder, counts, DEFAULT_PREFS.specialFolderBadges), 0);
      assert.strictEqual(
        specialFolderBadge(folder, counts, {
          ...DEFAULT_PREFS.specialFolderBadges,
          [folder]: false,
        }),
        0,
      );
    }
    assert.strictEqual(
      specialFolderBadge("inbox", counts, { starred: false, drafts: false, spam: false }),
      4,
    );
  });
}

{
  it("inspects active documents and vCards without running a native handler", () => {
    const data = (text: string) => new TextEncoder().encode(text);
    expect(
      inspectAttachment({
        filename: "card.vcf",
        mimeType: "text/vcard",
        data: data("BEGIN:VCARD\r\nFN:Ali\u200bce\r\nEMAIL:alice@example.com\r\nEND:VCARD"),
      }),
    ).toEqual({ kind: "contacts", contacts: [{ name: "Alice", address: "alice@example.com" }] });
    expect(
      inspectAttachment({
        filename: "image.svg",
        mimeType: "image/svg+xml",
        data: data("<svg><script>alert(1)</script></svg>"),
      })?.kind,
    ).toBe("html");
  });
}
