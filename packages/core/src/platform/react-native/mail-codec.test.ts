import { expect, it } from "vitest";
import { Effect } from "effect";
import { parseMobileMime, mobileMailCodecLayer } from "./mail-codec.js";
import { MailCodec } from "../mail-codec.js";
import { unsupportedMobileImap } from "./providers.js";

it("parses portable MIME body text, HTML, addresses and inline binary attachments", async () => {
  const raw = [
    "From: Test <person@example.test>",
    "To: Me <me@example.test>",
    "Subject: Mobile",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="outer"',
    "",
    "--outer",
    'Content-Type: multipart/alternative; boundary="inner"',
    "",
    "--inner",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "message text",
    "--inner",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<b>message HTML</b>",
    "--inner--",
    "--outer",
    "Content-Type: image/png",
    "Content-Disposition: inline; filename=photo.png",
    "Content-ID: <image>",
    "Content-Transfer-Encoding: base64",
    "",
    "AQID",
    "--outer--",
    "",
  ].join("\r\n");
  const mail = await parseMobileMime(new TextEncoder().encode(raw));
  expect(mail.text).toContain("message text");
  expect(mail.html).toContain("<b>message HTML</b>");
  expect(mail.from?.value[0]?.address).toBe("person@example.test");
  expect(mail.attachments[0]).toMatchObject({
    filename: "photo.png",
    cid: "image",
    content: new Uint8Array([1, 2, 3]),
  });
});
it("rejects oversized MIME and explicitly reports unsupported IMAP/SMTP and composing", async () => {
  await expect(parseMobileMime(new Uint8Array(25 * 1024 * 1024 + 1))).rejects.toThrow("25 MiB");
  const result = await Effect.runPromise(
    unsupportedMobileImap.connect({ provider: "outlook" }).pipe(Effect.result),
  );
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure")
    expect(result.failure.message).toContain("IMAP/SMTP is unsupported on mobile");
  await Effect.runPromise(
    Effect.gen(function* () {
      const codec = yield* MailCodec;
      expect(typeof codec.parse).toBe("function");
    }).pipe(Effect.provide(mobileMailCodecLayer)),
  );
});
