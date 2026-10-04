import { expect, it, vi } from "vitest";
import { parseMobileMime } from "./mail-codec.js";
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
it("rejects oversized MIME", async () => {
  await expect(parseMobileMime(new Uint8Array(25 * 1024 * 1024 + 1))).rejects.toThrow("25 MiB");
});

it("portable MIME decodes gbk without host charset support", async () => {
  const raw = new TextEncoder().encode(
    "Content-Type: text/plain; charset=gbk\r\nContent-Transfer-Encoding: base64\r\n\r\n1tDOxA==",
  );
  const NativeDecoder = globalThis.TextDecoder;
  vi.stubGlobal(
    "TextDecoder",
    class extends NativeDecoder {
      constructor(label = "utf-8", options?: ConstructorParameters<typeof NativeDecoder>[1]) {
        if (label.toLowerCase() !== "utf-8") throw new RangeError("Hermes only supports UTF-8");
        super(label, options);
      }
    },
  );
  try {
    expect((await parseMobileMime(raw)).text?.trim()).toBe("中文");
  } finally {
    vi.unstubAllGlobals();
  }
});
it("portable MIME decodes gb18030 without host charset support", async () => {
  const raw = new TextEncoder().encode(
    "Content-Type: text/plain; charset=gb18030\r\nContent-Transfer-Encoding: base64\r\n\r\n1tDOxJUygjY=",
  );
  const NativeDecoder = globalThis.TextDecoder;
  vi.stubGlobal(
    "TextDecoder",
    class extends NativeDecoder {
      constructor(label = "utf-8", options?: ConstructorParameters<typeof NativeDecoder>[1]) {
        if (label.toLowerCase() !== "utf-8") throw new RangeError("Hermes only supports UTF-8");
        super(label, options);
      }
    },
  );
  try {
    expect((await parseMobileMime(raw)).text?.trim()).toBe("中文𠀀");
  } finally {
    vi.unstubAllGlobals();
  }
});
it("portable MIME decodes big5 without host charset support", async () => {
  const raw = new TextEncoder().encode(
    "Content-Type: text/plain; charset=big5\r\nContent-Transfer-Encoding: base64\r\n\r\npKSk5Q==",
  );
  const NativeDecoder = globalThis.TextDecoder;
  vi.stubGlobal(
    "TextDecoder",
    class extends NativeDecoder {
      constructor(label = "utf-8", options?: ConstructorParameters<typeof NativeDecoder>[1]) {
        if (label.toLowerCase() !== "utf-8") throw new RangeError("Hermes only supports UTF-8");
        super(label, options);
      }
    },
  );
  try {
    expect((await parseMobileMime(raw)).text?.trim()).toBe("中文");
  } finally {
    vi.unstubAllGlobals();
  }
});
it("portable MIME decodes shift_jis without host charset support", async () => {
  const raw = new TextEncoder().encode(
    "Content-Type: text/plain; charset=shift_jis\r\nContent-Transfer-Encoding: base64\r\n\r\nk/qWe4zq",
  );
  const NativeDecoder = globalThis.TextDecoder;
  vi.stubGlobal(
    "TextDecoder",
    class extends NativeDecoder {
      constructor(label = "utf-8", options?: ConstructorParameters<typeof NativeDecoder>[1]) {
        if (label.toLowerCase() !== "utf-8") throw new RangeError("Hermes only supports UTF-8");
        super(label, options);
      }
    },
  );
  try {
    expect((await parseMobileMime(raw)).text?.trim()).toBe("日本語");
  } finally {
    vi.unstubAllGlobals();
  }
});
it("portable MIME decodes euc-kr without host charset support", async () => {
  const raw = new TextEncoder().encode(
    "Content-Type: text/plain; charset=euc-kr\r\nContent-Transfer-Encoding: base64\r\n\r\nx9Gxub7u",
  );
  const NativeDecoder = globalThis.TextDecoder;
  vi.stubGlobal(
    "TextDecoder",
    class extends NativeDecoder {
      constructor(label = "utf-8", options?: ConstructorParameters<typeof NativeDecoder>[1]) {
        if (label.toLowerCase() !== "utf-8") throw new RangeError("Hermes only supports UTF-8");
        super(label, options);
      }
    },
  );
  try {
    expect((await parseMobileMime(raw)).text?.trim()).toBe("한국어");
  } finally {
    vi.unstubAllGlobals();
  }
});
it("portable MIME decodes iso-2022-jp without host charset support", async () => {
  const raw = new TextEncoder().encode(
    "Content-Type: text/plain; charset=iso-2022-jp\r\nContent-Transfer-Encoding: base64\r\n\r\nGyRCRnxLXDhsGyhC",
  );
  const NativeDecoder = globalThis.TextDecoder;
  vi.stubGlobal(
    "TextDecoder",
    class extends NativeDecoder {
      constructor(label = "utf-8", options?: ConstructorParameters<typeof NativeDecoder>[1]) {
        if (label.toLowerCase() !== "utf-8") throw new RangeError("Hermes only supports UTF-8");
        super(label, options);
      }
    },
  );
  try {
    expect((await parseMobileMime(raw)).text?.trim()).toBe("日本語");
  } finally {
    vi.unstubAllGlobals();
  }
});
