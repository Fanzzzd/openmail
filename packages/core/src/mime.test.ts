import { assert, describe, it } from "@effect/vitest";

import { decodeBytes, decodeHeader, htmlToText, parseAddressList } from "./mime.js";

describe("mime", () => {
  it("decodes base64 and quoted-printable encoded words", () => {
    assert.strictEqual(decodeHeader("=?UTF-8?B?5L2g5aW9?= world"), "你好 world");
    assert.strictEqual(decodeHeader("=?GBK?B?xOO6ww==?="), "你好");
    assert.strictEqual(decodeHeader("=?ISO-8859-1?Q?caf=E9_au_lait?="), "café au lait");
    assert.strictEqual(decodeHeader("=?UTF-8?B?5L2g?= =?UTF-8?B?5aW9?="), "你好");
  });

  it("falls back to UTF-8 for a charset ICU does not know", () => {
    assert.strictEqual(decodeBytes(new TextEncoder().encode("你好"), "x-unknown"), "你好");
  });

  it("splits address lists outside quotes", () => {
    assert.deepStrictEqual(
      parseAddressList('"Doe, John" <john@x.com>, jane@y.com, Ann <a@z.com>'),
      [
        { name: "Doe, John", address: "john@x.com" },
        { name: "", address: "jane@y.com" },
        { name: "Ann", address: "a@z.com" },
      ],
    );
  });

  it("flattens html", () => {
    assert.strictEqual(
      htmlToText("<style>x{}</style><p>Hi&nbsp;there</p><p>b &amp; c</p>"),
      "Hi there\nb & c",
    );
  });
});
