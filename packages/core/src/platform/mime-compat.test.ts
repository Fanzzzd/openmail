import { describe, expect, it } from "vitest";
import { nodeMailCodec } from "./node/mail-codec.js";
import { parseMobileMime } from "./react-native/mail-codec.js";
import { Buffer } from "./bytes.js";

const tlv = (tag: number, bytes: Uint8Array) =>
  Buffer.concat([
    new Uint8Array(
      bytes.length < 128 ? [tag, bytes.length] : [tag, 0x82, bytes.length >> 8, bytes.length & 255],
    ),
    bytes,
  ]);
const signed = (inner: Uint8Array) =>
  tlv(
    48,
    Buffer.concat([
      tlv(6, Buffer.from("2a864886f70d010702", "hex")),
      tlv(
        160,
        tlv(
          48,
          Buffer.concat([
            tlv(2, new Uint8Array([1])),
            tlv(49, new Uint8Array()),
            tlv(
              48,
              Buffer.concat([
                tlv(6, Buffer.from("2a864886f70d010701", "hex")),
                tlv(160, tlv(4, inner)),
              ]),
            ),
          ]),
        ),
      ),
    ]),
  );
for (const [name, parse] of [
  ["node", nodeMailCodec.parse],
  ["mobile", parseMobileMime],
] as const)
  describe(name, () => {
    it("slice49: opaque SignedData exposes encapsulated MIME without decrypting", async () => {
      const inner = Buffer.from("Content-Type: text/plain\r\n\r\nsigned body");
      const raw = Buffer.from(
        `Content-Type: application/pkcs7-mime; smime-type=signed-data; name=smime.p7m\r\nContent-Transfer-Encoding: base64\r\n\r\n${signed(inner).toString("base64")}`,
      );
      expect((await parse(raw)).text?.trim()).toBe("signed body");
    });
    it("slice49: text/plain uuencode becomes a downloadable attachment", async () => {
      const mail = await parse(
        Buffer.from(
          "Content-Type: text/plain\r\n\r\nhello\r\nbegin 644 file.txt\r\n#0V%T\r\n`\r\nend\r\n",
        ),
      );
      expect(mail.attachments).toHaveLength(1);
      expect(mail.attachments[0]?.filename).toBe("file.txt");
      expect(Buffer.from(mail.attachments[0]!.content).toString()).toBe("Cat");
      expect(mail.text).not.toContain("begin 644");
    });
  });

for (const [name, parse] of [
  ["node", nodeMailCodec.parse],
  ["mobile", parseMobileMime],
] as const) {
  it(`slice49-fix: ${name} preserves CAdES attachments and the outer message body`, async () => {
    const cms = signed(Buffer.from("%PDF-1.7\r\n\r\nPDF tail")).toString("base64");
    const raw = Buffer.from(
      `Content-Type: multipart/mixed; boundary="x"\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nInvoice enclosed\r\n--x\r\nContent-Type: application/pkcs7-mime; smime-type=signed-data; name=invoice.pdf.p7m\r\nContent-Disposition: attachment; filename=invoice.pdf.p7m\r\nContent-Transfer-Encoding: base64\r\n\r\n${cms}\r\n--x--\r\n`,
    );
    const mail = await parse(raw);
    expect(mail.text?.trim()).toBe("Invoice enclosed");
    expect(mail.attachments.map((a) => a.filename)).toEqual(["invoice.pdf.p7m"]);
    expect(Buffer.from(mail.attachments[0]!.content).toString("base64")).toBe(cms);
  });
}
it("slice49-fix: mobile charset decoding preserves text attachment bytes", async () => {
  const raw = Buffer.from(
    'Content-Type: multipart/mixed; boundary="x"\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nhello\r\n--x\r\nContent-Type: text/csv; charset=windows-1252; name=data.csv\r\nContent-Disposition: attachment; filename=data.csv\r\nContent-Transfer-Encoding: base64\r\n\r\nY2Fm6Q==\r\n--x--\r\n',
  );
  const mail = await parseMobileMime(raw);
  expect([...mail.attachments[0]!.content]).toEqual([99, 97, 102, 233]);
});

it("slice49-fix: uuencode requires an exact end line and respects the body cap", async () => {
  const { uuAttachments, MAX_UU_BODY } = await import("./mime-compat.js");
  const block = "begin 644 file.txt\n#0V%T\n`\nend\n";
  expect(uuAttachments(block.replace("end\n", "end \n")).attachments).toHaveLength(0);
  expect(uuAttachments(block + "x".repeat(MAX_UU_BODY)).attachments).toHaveLength(0);
  expect(uuAttachments("begin 644 a\n".repeat(10000)).attachments).toHaveLength(0);
});

it("slice49-fix: a root CAdES file with no MIME entity does not become body text", async () => {
  const cms = signed(Buffer.from("%PDF-1.7\r\n\r\nPDF tail"));
  const mail = await nodeMailCodec.parse(
    Buffer.from(
      `Content-Type: application/pkcs7-mime; smime-type=signed-data; name=invoice.pdf.p7m\r\nContent-Transfer-Encoding: base64\r\n\r\n${cms.toString("base64")}`,
    ),
  );
  expect(mail.text ?? "").not.toContain("PDF tail");
  expect(mail.attachments[0]?.filename).toBe("invoice.pdf.p7m");
});

it("slice49-fix: signed body decoding keeps the outer envelope and authentication headers", async () => {
  const cms = signed(
    Buffer.from(
      "From: Inner <inner@example.test>\r\nSubject: Forged subject\r\nContent-Type: text/plain\r\n\r\nSigned body",
    ),
  );
  const raw = Buffer.from(
    `From: Outer <outer@example.test>\r\nSubject: Outer subject\r\nContent-Type: application/pkcs7-mime; smime-type=signed-data; name=smime.p7m\r\nContent-Transfer-Encoding: base64\r\n\r\n${cms.toString("base64")}`,
  );
  const mail = await nodeMailCodec.parse(raw);
  expect(mail.text?.trim()).toBe("Signed body");
  expect(mail.subject).toBe("Outer subject");
  expect(mail.from?.value[0]?.address).toBe("outer@example.test");
});
