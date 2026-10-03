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

  it("parses RFC groups and drops empty groups and invalid members", () => {
    assert.deepStrictEqual(
      parseAddressList("Team: a@x.com, Bob <b@x.com>;, undisclosed-recipients:;, invalid"),
      [
        { name: "", address: "a@x.com" },
        { name: "Bob", address: "b@x.com" },
      ],
    );
    assert.deepStrictEqual(parseAddressList("undisclosed-recipients:;"), []);
    assert.deepStrictEqual(
      parseAddressList('"Support: East" <support@x.com>, "Team: Blue": blue@x.com;'),
      [
        { name: "Support: East", address: "support@x.com" },
        { name: "", address: "blue@x.com" },
      ],
    );
    assert.deepStrictEqual(parseAddressList("=?UTF-8?Q?Support:_East,_Team?= <support@x.com>"), [
      { name: "Support: East, Team", address: "support@x.com" },
    ]);
  });

  it("flattens html", () => {
    assert.strictEqual(
      htmlToText("<style>x{}</style><p>Hi&nbsp;there</p><p>b &amp; c</p>"),
      "Hi there\nb & c",
    );
  });
});

it("slice49: joins split RFC 2047 byte sequences before decoding GBK and UTF-8", () => {
  assert.strictEqual(decodeHeader("=?GBK?B?1g==?= =?gbk?B?0A==?="), "中");
  assert.strictEqual(decodeHeader("=?UTF-8?B?5A==?=\r\n =?UTF-8?Q?=B8=AD?="), "中");
  assert.strictEqual(decodeHeader("prefix =?UTF-8?B?5Lit?= suffix"), "prefix 中 suffix");
});
