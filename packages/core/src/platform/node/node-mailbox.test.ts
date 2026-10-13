import { AsyncEntry } from "@napi-rs/keyring";
import { Context, Deferred, Effect, Layer, Option, Schedule } from "effect";
import { ImapFlow } from "imapflow";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { NodeMailbox } from "./layers.js";
import { NodeSystem } from "./platform-node.js";
import { databaseLayer } from "./db.js";
import { buildMime } from "./compose.js";
import { syntheticPdf } from "./fixtures/synthetic-pdf.js";
import { Mailbox } from "../../mailbox/mailbox.js";
import { Store } from "../../services.js";
import { StoreLive } from "../../store/store.js";
import { MailCodec } from "../mail-codec.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ2kAAAAASUVORK5CYII=",
  "base64",
);
afterEach(() => vi.restoreAllMocks());
it("real NodeMailbox captures MIME, files, PDF, image transport and random services for later calls", async () => {
  const directory = mkdtempSync(join(tmpdir(), "openmail-node-ports-"));
  try {
    const pdf = syntheticPdf();
    const calendar = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//OpenMail Test//EN",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:node-ports@example.com",
      "DTSTAMP:20261003T000000Z",
      "DTSTART:20261005T100000Z",
      "DTEND:20261005T110000Z",
      "SUMMARY:Layer invite",
      "ORGANIZER:mailto:sender@example.com",
      "ATTENDEE:mailto:me@example.com",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const embedded = await Effect.runPromise(
      buildMime(
        { name: "Sender", address: "sender@example.com" },
        {
          to: [],
          cc: [],
          bcc: [],
          subject: "Embedded",
          text: "Inside",
          attachments: [
            {
              filename: "leaf.txt",
              mimeType: "text/plain",
              content: Buffer.from("Leaf").toString("base64"),
            },
          ],
        },
      ),
    );
    const raw = await Effect.runPromise(
      buildMime(
        { name: "Sender", address: "sender@example.com" },
        {
          to: [{ name: "Me", address: "me@example.com" }],
          cc: [],
          bcc: [],
          subject: "Platform regression",
          text: "Body",
          attachments: [
            {
              filename: "document.pdf",
              mimeType: "application/pdf",
              content: Buffer.from(pdf).toString("base64"),
            },
            {
              filename: "embedded.eml",
              mimeType: "message/rfc822",
              content: embedded.toString("base64"),
            },
            {
              filename: "inline.png",
              mimeType: "image/png",
              content: png.toString("base64"),
              contentId: "inline@openmail",
            },
            {
              filename: "invite.ics",
              mimeType: "text/calendar",
              content: Buffer.from(calendar).toString("base64"),
            },
          ],
        },
      ),
    );
    // Only transport and credential IO are replaced; the real NodeMailbox, providers and services build.
    vi.spyOn(AsyncEntry.prototype, "getPassword").mockResolvedValue("synthetic-password");
    vi.spyOn(ImapFlow.prototype, "connect").mockResolvedValue();
    vi.spyOn(ImapFlow.prototype, "logout").mockResolvedValue();
    vi.spyOn(ImapFlow.prototype, "mailboxOpen").mockImplementation(async (path) => ({
      path: Array.isArray(path) ? path.join("/") : path,
      delimiter: "/",
      uidValidity: 1n,
      uidNext: 2,
      exists: 1,
      flags: new Set<string>(),
      permanentFlags: new Set<string>(),
      readOnly: true,
    }));
    const fetch = vi
      .spyOn(ImapFlow.prototype, "fetchOne")
      .mockImplementation(async () => ({ seq: 1, uid: 1, size: raw.length, source: raw }));
    const id = "imap:me@example.com/1:1:INBOX";
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const store = yield* Store;
          const account = yield* store.upsertAccount("imap", "me@example.com");
          yield* store.setImapSettings(account.id, {
            preset: "custom",
            username: "me@example.com",
            imapHost: "fake.invalid",
            imapPort: 993,
            smtpHost: "fake.invalid",
            smtpPort: 465,
            smtpSecure: true,
          });
          yield* store.upsertMessage(account.id, {
            providerId: "1:1:INBOX",
            threadId: "thread",
            subject: "Platform regression",
            from: { name: "Sender", address: "sender@example.com" },
            to: [],
            cc: [],
            date: 1,
            snippet: "Body",
            bodyText: "Body",
            bodyHtml: "",
            attachments: [
              { filename: "document.pdf", mimeType: "application/pdf", size: pdf.length },
              { filename: "embedded.eml", mimeType: "message/rfc822", size: embedded.length },
            ],
            labels: ["INBOX"],
            isUnread: false,
            isStarred: false,
          });
        }).pipe(
          Effect.provide(
            StoreLive.pipe(
              Layer.provide(
                databaseLayer(join(directory, "mail.db")).pipe(Layer.provide(NodeSystem)),
              ),
            ),
          ),
        );
        const ready = yield* Deferred.make<void>();
        const context = yield* Layer.build(
          NodeMailbox({
            dataDir: directory,
            backgroundReady: Deferred.await(ready),
            media: {
              vision: {
                available: true,
                version: "test",
                recognize: () => Effect.succeed({ revision: 1, lines: [] }),
              },
              onBattery: () => false,
              idle: () => true,
            },
          }),
        );
        const mailbox = Context.get(context, Mailbox);
        expect(Option.isNone(yield* Effect.serviceOption(MailCodec))).toBe(true);

        expect((yield* mailbox.attachment(id, 0)).data).toEqual(pdf);
        expect(fetch.mock.calls.some((call) => call[1].bodyStructure)).toBe(true);
        expect(Buffer.from((yield* mailbox.attachmentPart(id, [1, 0])).data).toString()).toBe(
          "Leaf",
        );
        expect((yield* mailbox.composeAttachments(id)).map((part) => part.filename)).toContain(
          "document.pdf",
        );
        expect((yield* mailbox.invitations(id))[0]?.title).toBe("Layer invite");
        expect((yield* mailbox.inlineImages(id))["inline@openmail"]).toContain(
          "data:image/png;base64,",
        );
        expect(
          (yield* mailbox.imageFromFile({
            filename: "image.png",
            mimeType: "image/png",
            content: png.toString("base64"),
          })).contentId,
        ).toMatch(/^image-[a-f0-9-]+@openmail$/);
        const rejected = yield* Effect.flip(mailbox.imageFromUrl("http://127.0.0.1/image.png"));
        expect(rejected._tag).toBe("ProviderError");
        expect(rejected.message).toContain("public image URL");
        yield* Deferred.succeed(ready, undefined);
        const chunks = yield* mailbox.derivedChunks(id).pipe(
          Effect.repeat({
            while: (result) => result.length === 0,
            times: 100,
            schedule: Schedule.spaced("50 millis"),
          }),
        );
        expect(chunks.some((chunk) => chunk.text.includes("Synthetic boarding document"))).toBe(
          true,
        );
      }).pipe(Effect.scoped),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
