import { parseGraphMessage } from "./outlook.js";
import { expect, it } from "vitest";
import { messageSecurity } from "./message-security.js";
import { cleanLink, linkNeedsConfirmation } from "./link-security.js";
import { visibleHtmlText } from "./visible-text.js";

const h = (name: string, value: string) => ({ name, value });
const gmailFail =
  "mx.google.com; dkim=fail header.i=@example.com header.s=mail header.b=ABCDEFGH; spf=fail (google.com: domain does not designate this IP) smtp.mailfrom=sender@example.com; dmarc=fail (p=REJECT sp=REJECT dis=REJECT) header.from=example.com";
const fastmailFail =
  'mx1.messagingengine.com; dkim=fail reason="signature verification failed" header.d=example.com header.s=mail; spf=fail smtp.mailfrom=sender@example.com; dmarc=fail header.from=example.com';
const microsoftFail =
  "spf=fail (sender IP is 203.0.113.4) smtp.mailfrom=example.com; dkim=fail (signature did not verify) header.d=example.com; dmarc=fail action=oreject header.from=example.com; compauth=fail reason=000";

it("only the topmost received Authentication-Results can influence provider trust", () => {
  expect(
    messageSecurity(
      [
        h("Authentication-Results", gmailFail),
        h("Authentication-Results", "mx.google.com; dmarc=pass"),
      ],
      "gmail",
    ).dmarc,
  ).toBe("fail");
  expect(
    messageSecurity(
      [
        h("Authentication-Results", "relay.example; dmarc=fail"),
        h("Authentication-Results", "mx.google.com; dmarc=pass"),
      ],
      "gmail",
    ).dmarc,
  ).toBe("unknown");
  expect(messageSecurity([h("Authentication-Results", fastmailFail)], "imap").dmarc).toBe(
    "unknown",
  );
  expect(
    messageSecurity(
      [
        h("Authentication-Results", fastmailFail),
        h("Authentication-Results", "mx1.messagingengine.com; dmarc=pass"),
      ],
      "imap",
      "mx1.messagingengine.com",
    ).dmarc,
  ).toBe("fail");
  const received = h(
    "Received",
    "from AM0PR02MB1234.eurprd02.prod.outlook.com by LO4P123MB0001.GBRP123.PROD.OUTLOOK.COM with Microsoft SMTP Server; Sat, 3 Oct 2026 08:00:00 +0000",
  );
  expect(
    messageSecurity(
      [
        received,
        h("Authentication-Results", microsoftFail),
        h("Authentication-Results", "eur01.mail.protection.outlook.com; dmarc=pass"),
      ],
      "outlook",
    ).dmarc,
  ).toBe("fail");
  expect(
    messageSecurity(
      [
        h("Received", "from attacker.example by relay.example; today"),
        received,
        h("Authentication-Results", microsoftFail),
      ],
      "outlook",
    ).dmarc,
  ).toBe("unknown");
});
it("parses only top-level AR clauses and takes the last result per method", () => {
  for (const value of [
    "mx.google.com; dmarc=pass (nested (comment; dmarc=pass)); dmarc=fail header.from=example.com",
    'mx.google.com; dmarc=pass reason="quoted; dmarc=pass"; dmarc=fail',
  ])
    expect(messageSecurity([h("Authentication-Results", value)], "gmail").dmarc).toBe("fail");
  expect(
    messageSecurity(
      [h("Authentication-Results", 'mx.google.com; spf=pass reason="; dmarc=pass"')],
      "gmail",
    ).dmarc,
  ).toBe("unknown");
});

for (const tag of ["title", "desc", "video", "audio", "canvas", "datalist"]) {
  it(`omits ${tag} text from model context`, () => {
    expect(visibleHtmlText(`<${tag}>Injected instructions</${tag}><p>Visible</p>`).text).toBe(
      "Visible",
    );
  });
}
it("keeps only details summaries", () => {
  expect(
    visibleHtmlText("<details><summary>Visible</summary><p>Injected instructions</p></details>")
      .text,
  ).toBe("Visible");
});
for (const style of [
  "color:hsl(0,0%,100%)",
  "color:hsla(0,0%,100%,1)",
  "color:rgb(100%,100%,100%)",
  "color:papayawhip;background:#ffefd5",
  "color:#ffff",
  "color:#ffffffff",
  "color:#fff1",
  "color:#ffffff19",
  "color:rgba(0,0,0,0.1)",
  "color:hsla(0,100%,50%,0.1)",
  "opacity:0.1",
  "opacity:10%",
  "transform:scale(0.1)",
  "transform:scale(0.1,0.1)",
  "transform:scaleX(0.1)",
  "color:white;background: url(https://example.com/bg) no-repeat center / cover #fff",
  "text-indent:-100px",
  "left:-10em",
  "top:-10rem",
  "margin-left:-50vw",
  "margin:-100px 0 0",
  "max-width:0;overflow:hidden",
  "max-height:0;overflow:hidden",
  "font-size:0.1vw",
  "font-size:0.1vh",
]) {
  it(`omits text concealed by ${style}`, () => {
    const result = visibleHtmlText(`<p style="${style}">Injected instructions</p><p>Visible</p>`);
    expect(result.text).toBe("Visible");
    expect(result.hidden).toBe(true);
  });
}
for (const label of [
  "Continue to bank.com",
  "<bank.com>",
  "https://bank.com/login.",
  "bank.com,",
  "Visit bank.com or shop.com",
  "ｂａｎｋ．ｃｏｍ",
  "bank。com",
  "bank｡com",
]) {
  it(`confirms every displayed domain in ${label}`, () => {
    expect(linkNeedsConfirmation("https://evil.example", label)).toBe(true);
  });
}
it("does not re-encode retained query bytes or clean signed links", () => {
  expect(
    cleanLink("https://example.com/?q=hello%20world&filter=a%2fb&UTM_source=x&tag=one+two&bare#h"),
  ).toBe("https://example.com/?q=hello%20world&filter=a%2fb&tag=one+two&bare#h");
  for (const key of [
    "X-Amz-Signature",
    "X-Amz-Credential",
    "Signature",
    "sig",
    "signature",
    "token",
    "hmac",
    "Expires",
    "Key-Pair-Id",
    "Policy",
  ])
    expect(cleanLink(`https://example.com/?utm_source=x&${key}=value&q=a%20b`)).toBe(
      `https://example.com/?utm_source=x&${key}=value&q=a%20b`,
    );
});

it("Graph keeps authentication unknown even if a payload contains unordered header data", () => {
  const message = parseGraphMessage(
    {
      id: "m1",
      conversationId: "t1",
      internetMessageHeaders: [h("Authentication-Results", "spf=pass; dkim=pass; dmarc=pass")],
    },
    "INBOX",
    [],
  );
  expect(message.security).toEqual({ dmarc: "unknown", spf: "unknown", dkim: "unknown" });
});

it("AR comments and later DKIM failure cannot authorize a POST", () => {
  const base = [
    h("From", "Newsletter <news@example.com>"),
    h(
      "DKIM-Signature",
      "v=1; d=example.com; s=mail; h=from:list-unsubscribe:list-unsubscribe-post; b=ABCDEFGHIJK",
    ),
    h("List-Unsubscribe", "<https://example.com/leave>"),
    h("List-Unsubscribe-Post", "List-Unsubscribe=One-Click"),
  ];
  for (const result of [
    "mx.google.com; dkim=pass header.d=example.com header.s=mail header.b=ABCDEFGH; dkim=fail header.d=example.com",
    "mx.google.com; spf=pass (nested (detail; dkim=pass header.d=example.com header.s=mail header.b=ABCDEFGH))",
    'mx.google.com; spf=pass reason="; dkim=pass header.d=example.com header.s=mail header.b=ABCDEFGH"',
  ])
    expect(
      messageSecurity([h("Authentication-Results", result), ...base], "gmail").unsubscribe,
    ).toBeUndefined();
});
it("different colour spellings cannot conceal text from the parser", () => {
  for (const style of [
    "color:rebeccapurple;background:hsl(270,50%,40%)",
    "color:#1231",
    "color:#11223319",
    "color:rgb(100% 100% 100% / 10%)",
    "opacity:.3",
  ]) {
    if (style === "opacity:.3") {
      expect(
        visibleHtmlText(
          '<div style="opacity:.3"><span style="opacity:.3">Hidden</span></div><p>Visible</p>',
        ).text,
      ).toBe("Visible");
    } else
      expect(visibleHtmlText(`<p style="${style}">Hidden</p><p>Visible</p>`).text).toBe("Visible");
  }
  expect(visibleHtmlText('<p style="opacity:.11;font-size:14px">Visible</p>').text).toBe("Visible");
});
