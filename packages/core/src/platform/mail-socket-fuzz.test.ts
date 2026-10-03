import * as fc from "fast-check";
import { expect, it } from "vitest";
import { ImapWire, MailWire, encodeFolder, decodeFolder, type MailSocket } from "./mail-socket.js";
import { smtpSession } from "./react-native/imap.js";
import { ProviderError, AuthError } from "../errors.js";

const options = {
  seed: 0x520051,
  numRuns: process.env.OPENMAIL_LOW_MEMORY_TESTS === "1" ? 30 : 150,
};
function socketFor(bytes: Uint8Array, width = bytes.length || 1): MailSocket {
  let offset = 0;
  return {
    read: async () => {
      const chunk = bytes.subarray(offset, offset + width);
      offset += chunk.length;
      return chunk;
    },
    write: async () => {
      /* No server-side behavior in framing fixtures. */
    },
    startTLS: async () => {
      /* No native TLS connection. */
    },
    close: () => {
      /* In-memory byte stream. */
    },
  };
}
const raw = (value: string) => new TextEncoder().encode(value);
const settings = {
  preset: "custom",
  username: "me",
  imapHost: "imap.test",
  imapPort: 993,
  smtpHost: "smtp.test",
  smtpPort: 465,
  smtpSecure: true,
} as const;
const smtp = (bytes: Uint8Array, width = bytes.length || 1) =>
  smtpSession(
    { connect: async () => socketFor(bytes, width) },
    settings,
    "password",
    "account",
    new AbortController().signal,
  );

it("modified UTF-7 round-trips every UTF-16 folder code unit", () => {
  fc.assert(
    fc.property(fc.string({ unit: "binary", maxLength: 512 }), (name) => {
      expect(decodeFolder(encodeFolder(name))).toBe(name);
    }),
    options,
  );
});

it("IMAP binary literals and escaped quotes survive arbitrary TCP fragmentation", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uint8Array({ maxLength: 2048 }),
      fc.integer({ min: 1, max: 127 }),
      async (payload, width) => {
        const prefix = raw(`* 1 FETCH (UID 1 NAME "a\\"b\\\\c" BODY[] {${payload.length}}\r\n`);
        const suffix = raw(")\r\n* OK next\r\n");
        const data = new Uint8Array(prefix.length + payload.length + suffix.length);
        data.set(prefix);
        data.set(payload, prefix.length);
        data.set(suffix, prefix.length + payload.length);
        const wire = new ImapWire(new MailWire(socketFor(data, width)));
        const response = await wire.response();
        expect(response.values[3]).toEqual(["UID", "1", "NAME", 'a"b\\c', "BODY[]", payload]);
        expect((await wire.response()).text).toBe("* OK next");
        expect(response.byteLength).toBe(prefix.length + payload.length + 3);
      },
    ),
    options,
  );
});

it("IMAP rejects malformed lists, strings, NUL and overlong literals", async () => {
  for (const line of [
    "* LIST ((missing)",
    "* LIST ) trailing",
    '* LIST "unterminated',
    "* LIST \0",
    `* LIST ${"(".repeat(100)}x${")".repeat(100)}`,
    "* FETCH {999999999999999999999999999}",
  ]) {
    await expect(
      new ImapWire(new MailWire(socketFor(raw(`${line}\r\n`), 17))).response(),
    ).rejects.toBeInstanceOf(ProviderError);
  }
});

it("IMAP arbitrary protocol input only throws typed boundary errors", async () => {
  await fc.assert(
    fc.asyncProperty(fc.string({ unit: "binary-ascii", maxLength: 1024 }), async (value) => {
      try {
        await new ImapWire(new MailWire(socketFor(raw(`${value}\r\n`), 31))).response();
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderError);
      }
    }),
    options,
  );
});

it("IMAP resp-text tolerates unmatched parentheses, quotes and literal-looking suffixes", async () => {
  for (const text of [
    "* OK mail.example.test ready (maintenance",
    "* PREAUTH welcome )",
    'M1 OK [ALERT] address "quoted (notice',
    "M1 NO failed (retry later",
    "M1 BAD unexpected ) in user text",
    "* OK diagnostic {999999999999999999999}",
    "+ continue (ready",
  ]) {
    const reply = await new ImapWire(new MailWire(socketFor(raw(`${text}\r\n`), 7))).response();
    expect(reply.text).toBe(text);
  }
  await expect(
    new ImapWire(new MailWire(socketFor(raw("* BYE server ended (maintenance\r\n")))).response(),
  ).rejects.toThrow("connection ended");
});

it("mail framing rejects one MiB unterminated lines and overlong byte reads without allocating", async () => {
  const started = performance.now();
  const wire = new MailWire(socketFor(new Uint8Array(1024 * 1024).fill(97), 4096));
  await expect(wire.line()).rejects.toBeInstanceOf(ProviderError);
  await expect(wire.bytes(Number.MAX_SAFE_INTEGER)).rejects.toBeInstanceOf(ProviderError);
  expect(performance.now() - started).toBeLessThan(5000);
});

it("SMTP reply parser accepts fragmented, well-formed multiline replies", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 31 }),
      fc.array(fc.string({ unit: fc.constantFrom("a", "b", " "), maxLength: 32 }), {
        maxLength: 8,
      }),
      async (width, comments) => {
        const ehlo = comments.map((comment) => `250-${comment}\r\n`).join("");
        await smtp(
          raw(`220 ready\r\n${ehlo}250 AUTH PLAIN\r\n235 authenticated\r\n221 bye\r\n`),
          width,
        );
      },
    ),
    options,
  );
});

it("SMTP malformed bytes, lines and excessive continuation replies fail with typed errors", async () => {
  await fc.assert(
    fc.asyncProperty(fc.uint8Array({ maxLength: 1024 }), async (bytes) => {
      try {
        await smtp(bytes, 19);
        throw new Error("SMTP accepted arbitrary incomplete input");
      } catch (error) {
        expect(error instanceof ProviderError || error instanceof AuthError).toBe(true);
      }
    }),
    options,
  );
  await expect(smtp(raw(`220-${"x\r\n220-".repeat(101)}x\r\n`))).rejects.toBeInstanceOf(
    ProviderError,
  );
});

it("SMTP rejects multiline replies with inconsistent status codes", async () => {
  await expect(
    smtp(raw("550-rejected\r\n220 ready\r\n250 AUTH PLAIN\r\n235 authenticated\r\n221 bye\r\n")),
  ).rejects.toBeInstanceOf(ProviderError);
});

it("SMTP rejects code changes in either continuation or final lines under fragmentation", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 200, max: 599 }),
      fc.integer({ min: 1, max: 399 }),
      fc.integer({ min: 1, max: 31 }),
      async (code, offset, width) => {
        const other = 200 + ((code - 200 + offset) % 400);
        for (const reply of [
          `${code}-first\r\n${other} last\r\n`,
          `${code}-first\r\n${other}-changed\r\n${code} last\r\n`,
        ]) {
          await expect(
            new MailWire(socketFor(raw(reply), width)).smtpReply(),
          ).rejects.toMatchObject({
            _tag: "ProviderError",
            message: "Inconsistent SMTP response code",
          });
        }
      },
    ),
    options,
  );
});

it("SMTP authentication rejection remains an AuthError after complete reply parsing", async () => {
  await expect(
    smtp(raw("220 ready\r\n250 AUTH PLAIN\r\n535-rejected\r\n535 rejected\r\n")),
  ).rejects.toMatchObject({
    _tag: "AuthError",
    accountId: "account",
  });
});
