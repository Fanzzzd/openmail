import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { makeReaderAttachments as unboundReader } from "./reader-attachments.js";
import { MailCodec } from "../platform/mail-codec.js";
import { NodeRuntime } from "../platform/node/runtime.js";
const codec = await Effect.runPromise(MailCodec.pipe(Effect.provide(NodeRuntime)));
const makeReaderAttachments = (
  attachment: Parameters<typeof unboundReader>[0],
  thread: Parameters<typeof unboundReader>[1],
) => unboundReader(attachment, thread, codec);
import { AttachmentCache } from "./attachment-cache.js";
import { buildMime } from "../platform/node/compose.js";
import type { Message } from "../domain/message.js";

const message = (data: Uint8Array): Message => ({
  id: "message",
  accountId: "account",
  threadId: "thread",
  subject: "",
  from: { name: "", address: "a@example.com" },
  to: [],
  cc: [],
  date: 0,
  snippet: "",
  labels: [],
  isUnread: false,
  isStarred: false,
  hasAttachments: true,
  bodyHtml: "",
  bodyText: "",
  attachments: [{ filename: "outer.eml", mimeType: "message/rfc822", size: data.byteLength }],
});
it("200 TNEF parts in one attached RFC822 message fetch the root once per request", async () => {
  const fixture = readFileSync(
    new URL("../../test-support/fixtures/legacy-winmail.dat", import.meta.url),
  );
  const winmail = Buffer.concat([
    fixture.subarray(0, 40),
    ...Array.from({ length: 200 }, () => fixture.subarray(40, 101)),
  ]);
  const raw = await Effect.runPromise(
    buildMime(
      { name: "", address: "a@example.com" },
      {
        to: [],
        cc: [],
        bcc: [],
        subject: "Inside",
        text: "",
        attachments: [
          {
            filename: "winmail.dat",
            mimeType: "application/ms-tnef",
            content: winmail.toString("base64"),
          },
        ],
      },
    ),
  );
  const fetch = vi.fn(() =>
    Effect.succeed({ filename: "outer.eml", mimeType: "message/rfc822", data: raw }),
  );
  const reader = makeReaderAttachments(fetch, () => Effect.succeed([message(raw)]));
  const paths = Array.from({ length: 200 }, (_, index) => [0, 0, index]);
  const result = await Effect.runPromise(reader.attachmentParts("message", paths));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(result.length).toBe(200);
  expect(
    result.every(
      (entry) => entry.kind === "file" && Buffer.from(entry.content.data).toString() === "first",
    ),
  ).toBe(true);
  fetch.mockClear();
  const embedded = await Effect.runPromise(reader.embeddedMessage("message", [0]));
  expect(embedded.attachments.length).toBe(200);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("ancestor bodies consume the budget even when the requested leaf is tiny or missing", async () => {
  const raw = Buffer.from(`Content-Type: text/plain\r\n\r\n${"a".repeat(17 * 1024 * 1024)}`);
  const fetch = vi.fn(() =>
    Effect.succeed({ filename: "outer.eml", mimeType: "message/rfc822", data: raw }),
  );
  const reader = makeReaderAttachments(fetch, () => Effect.succeed([message(raw)]));
  const entries = await Effect.runPromise(
    reader.attachmentParts("message", [
      [0, 0],
      [0, 1],
    ]),
  );
  expect(
    entries.every((entry) => entry.kind === "failed" && entry.error._tag === "InvalidInput"),
  ).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("byte LRU evicts per-message and global entries and copies small views", () => {
  const cache = new AttachmentCache(8, 4, 2);
  const source = new Uint8Array(100);
  source[0] = 7;
  cache.set("a", "one", source.subarray(0, 2));
  const file = cache.get("a", "one");
  expect(file?.buffer.byteLength).toBe(2);
  source[0] = 0;
  expect(file?.[0]).toBe(7);
  cache.set("a", "two", new Uint8Array(3));
  expect(cache.get("a", "one")).toBeNull();
  cache.set("b", "one", new Uint8Array(4));
  cache.get("a", "two");
  cache.set("c", "one", new Uint8Array(3));
  expect(cache.get("b", "one")).toBeNull();
  cache.set("c", "oversized", new Uint8Array(9));
  expect(cache.get("c", "oversized")).toBeNull();
});
it("core descriptors replace bidi/format characters before filenames reach the renderer", async () => {
  const data = new Uint8Array();
  const value = message(data);
  const reader = makeReaderAttachments(
    () => Effect.succeed({ filename: "", mimeType: "", data }),
    () =>
      Effect.succeed([
        {
          ...value,
          attachments: [
            {
              filename: "report\u202E\u200F\u2066\u061C\uFEFF.pdf",
              mimeType: "application/pdf",
              size: 0,
            },
          ],
        },
      ]),
  );
  expect((await Effect.runPromise(reader.readerAttachments("message")))[0]?.filename).toBe(
    "report_____.pdf",
  );
});
