import { assert, it } from "@effect/vitest";
import { nodeMailCodec } from "./mail-codec.js";
import { threadIdOf } from "./imap/parse.js";
import { mobileIncoming } from "../react-native/imap.js";
import { parseMobileMime } from "../react-native/mail-codec.js";

for (const example of [
  { headers: ["Message-ID: bare@example.test"], node: "bare@example.test", mobile: "9:1:INBOX" },
  {
    headers: ["Message-ID: <child@example.test>", "References: root@example.test"],
    node: "root@example.test",
    mobile: "9:1:INBOX",
  },
  {
    headers: [
      "Message-ID: <child@example.test>",
      "References: noise",
      "In-Reply-To: <parent@example.test>",
    ],
    node: "noise",
    mobile: "9:1:INBOX",
  },
]) {
  it(`known difference: Node and RN IMAP thread IDs for ${example.headers.join("; ")}`, async () => {
    const raw = Buffer.from(
      [...example.headers, "Content-Type: text/plain", "", "body"].join("\r\n"),
    );
    const desktop = await nodeMailCodec.parse(raw);
    const mobile = await parseMobileMime(raw);
    assert.strictEqual(threadIdOf(desktop), example.node);
    assert.strictEqual(
      mobileIncoming(
        mobile,
        { path: "INBOX", name: "INBOX", label: "INBOX" },
        "9",
        1,
        [],
        raw.length,
      ).threadId,
      example.mobile,
    );
  });
}
