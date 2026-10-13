import { parseGraphMessage } from "../providers/outlook/parse.js";
import { expect, it } from "vitest";
import { messageSecurity, cleanDisplayName, senderSpoofed } from "./message-security.js";
import { cleanLink, linkHint, linkNeedsConfirmation, registrableDomain } from "./link-security.js";
import { parseAppLink } from "../system.js";
{
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

  it("does not re-encode retained query bytes or clean signed links", () => {
    expect(
      cleanLink(
        "https://example.com/?q=hello%20world&filter=a%2fb&UTM_source=x&tag=one+two&bare#h",
      ),
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
}

{
  const header = (name: string, value: string) => ({ name, value });

  it("trusts only the provider authserv-id, never a sender's claimed pass", () => {
    const results = "dmarc=fail; spf=pass; dkim=fail";
    expect(
      messageSecurity([header("Authentication-Results", `attacker.example; ${results}`)], "gmail"),
    ).toEqual({ dmarc: "unknown", spf: "unknown", dkim: "unknown" });
    for (const [provider, id] of [
      ["gmail", "mx.google.com"],
      ["imap", "imap.example.com"],
    ] as const)
      expect(
        messageSecurity(
          [header("Authentication-Results", `${id}; ${results}`)],
          provider,
          "imap.example.com",
        ),
      ).toEqual({ dmarc: "fail", spf: "pass", dkim: "fail" });
    expect(
      messageSecurity(
        [header("Authentication-Results", `mx.google.com.evil.example; ${results}`)],
        "gmail",
      ).dmarc,
    ).toBe("unknown");
    expect(
      messageSecurity([header("Authentication-Results", `imap.example.com; ${results}`)], "imap")
        .dmarc,
    ).toBe("unknown");
    expect(
      messageSecurity(
        [
          header("Authentication-Results", "mx.google.com; dmarc=fail"),
          header("Authentication-Results", "mx.google.com; dmarc=pass"),
        ],
        "gmail",
      ).dmarc,
    ).toBe("fail");
    expect(cleanDisplayName("Pay\u202epal\u200b")).toBe("Paypal");
    expect(
      senderSpoofed({ name: "CEO <boss@company.example>", address: "thief@evil.example" }),
    ).toBe(true);
    expect(senderSpoofed({ name: "boss@company.example", address: "boss@company.example" })).toBe(
      false,
    );
  });

  const listHeaders = [
    header("From", "News <news@example.com>"),
    header(
      "Authentication-Results",
      "mx.google.com; dmarc=pass; dkim=pass header.d=example.com header.s=mail header.b=ABCDEFGH",
    ),
    header(
      "DKIM-Signature",
      "v=1; d=example.com; s=mail; h=from:list-unsubscribe:list-unsubscribe-post; b=ABCDEFGHIJK",
    ),
    header(
      "List-Unsubscribe",
      "<https://lists.example.com/remove?id=123>, <mailto:leave@example.com?subject=unsubscribe&attach=file:///private>",
    ),
    header("List-Unsubscribe-Post", "List-Unsubscribe=One-Click"),
  ];

  it("only enables POST for an aligned, provider-verified signature covering both list headers", () => {
    expect(messageSecurity(listHeaders, "gmail").unsubscribe).toEqual({
      kind: "post",
      url: "https://lists.example.com/remove?id=123",
    });
    for (const [name, value] of [
      [
        "Authentication-Results",
        "evil.example; dkim=pass header.d=example.com header.s=mail header.b=ABCDEFGH",
      ],
      [
        "Authentication-Results",
        "mx.google.com; dkim=fail header.d=example.com header.s=mail header.b=ABCDEFGH",
      ],
      [
        "Authentication-Results",
        "mx.google.com; dkim=pass header.d=evil.example header.s=mail header.b=ABCDEFGH",
      ],
      ["DKIM-Signature", "v=1; d=example.com; s=mail; h=from:list-unsubscribe; b=ABCDEFGHIJK"],
      ["List-Unsubscribe-Post", "wrong=One-Click"],
      ["List-Unsubscribe", "<http://example.com/remove>"],
    ]) {
      const changed = listHeaders.map((h) => (h.name === name ? header(name, value ?? "") : h));
      expect(messageSecurity(changed, "gmail").unsubscribe?.kind).not.toBe("post");
    }
    for (const name of ["List-Unsubscribe", "List-Unsubscribe-Post", "DKIM-Signature"])
      expect(
        messageSecurity([...listHeaders, ...listHeaders.filter((h) => h.name === name)], "gmail")
          .unsubscribe?.kind,
      ).not.toBe("post");
    const fallback = messageSecurity(
      listHeaders.filter((h) => h.name !== "Authentication-Results"),
      "gmail",
    ).unsubscribe;
    expect(fallback?.kind).toBe("mailto");
    expect(parseAppLink(fallback?.url ?? "")).toEqual({
      kind: "compose",
      draft: { to: "leave@example.com", cc: "", bcc: "", subject: "unsubscribe", body: "" },
    });
  });

  it("compares registrable domains, flags international hosts, and cleans only tracking keys", () => {
    expect(registrableDomain("mail.bank.co.uk")).toBe("bank.co.uk");
    expect(linkNeedsConfirmation("https://evil.co.uk", "https://bank.co.uk")).toBe(true);
    expect(linkNeedsConfirmation("https://login.bank.co.uk", "bank.co.uk")).toBe(false);
    expect(linkNeedsConfirmation("https://evil.example", "Read more")).toBe(false);
    expect(linkNeedsConfirmation("https://other.github.io", "mine.github.io")).toBe(true);
    expect(linkNeedsConfirmation("https://xn--pple-43d.com", "Continue")).toBe(true);
    expect(linkHint("https://xn--pple-43d.com")).toContain("аpple.com");
    expect(linkHint("https://xn--pple-43d.com")).toContain("xn--pple-43d.com");
    expect(
      cleanLink(
        "https://example.com/?utm_source=x&UTM_CAMPAIGN=y&fbclid=a&gclid=b&mc_eid=c&mc_cid=d&id=5#here",
      ),
    ).toBe("https://example.com/?id=5#here");
    expect(cleanLink("https://example.com/?utm_source=x", false)).toBe(
      "https://example.com/?utm_source=x",
    );
  });

  it("accepts Gmail's verified DKIM AUID only with an unambiguous aligned signature", () => {
    const gmail = listHeaders.map((h) =>
      h.name === "Authentication-Results"
        ? header(
            h.name,
            "mx.google.com; dkim=pass header.i=@example.com header.s=mail header.b=ABCDEFGH",
          )
        : h,
    );
    expect(messageSecurity(gmail, "gmail").unsubscribe?.kind).toBe("post");
    expect(
      messageSecurity(
        gmail.map((h) =>
          h.name === "Authentication-Results"
            ? header(h.name, h.value.replace("@example.com", "@evil.example"))
            : h,
        ),
        "gmail",
      ).unsubscribe?.kind,
    ).toBe("mailto");
  });
}
