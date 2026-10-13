/** A portable SMTP session over MailTransport: EHLO, STARTTLS, AUTH and one message. */

import { AuthError, PermanentError, ProviderError, SendUncertain } from "../../domain/errors.js";
import { MailWire, writeMailChunks, type MailTransport } from "../mail-socket.js";
import type { ImapSettings } from "../../domain/account.js";
import { isLoginRefusal } from "../../providers/reauth.js";
import { Buffer } from "../bytes.js";
import { address } from "./imap-parse.js";

const uncertain = () =>
  new SendUncertain({
    message: "This message may have been sent. Check Sent before sending it again.",
  });

/** SMTP STARTTLS is mandatory on submission ports; no credentials precede TLS. */
export async function smtpSession(
  transport: MailTransport["Service"],
  settings: ImapSettings,
  pass: string,
  accountId: string,
  signal: AbortSignal,
  deliver?: { from: string; to: readonly string[]; raw: Uint8Array },
) {
  const socket = await transport.connect({
    host: settings.smtpHost,
    port: settings.smtpPort,
    tls: settings.smtpSecure,
    signal,
  });
  const wire = new MailWire(socket);
  const reply = async (expected: number[], final = false) => {
    const { code, lines } = await wire.smtpReply().catch((error: unknown) => {
      if (final) throw uncertain();
      throw error;
    });
    if (code === 454 || code === 534 || code === 535)
      throw isLoginRefusal({ smtpCode: code })
        ? new AuthError({ accountId, message: "SMTP login rejected", reason: "imap_auth_failed" })
        : new ProviderError({ message: `SMTP login deferred (${code})` });
    if (!expected.includes(code)) {
      if (code >= 500) throw new PermanentError({ message: `SMTP rejected the message (${code})` });
      throw new ProviderError({ message: `SMTP command rejected (${code})` });
    }
    return lines;
  };
  const command = async (value: string, expected: number[]) => {
    await wire.write(value);
    return reply(expected);
  };
  try {
    await reply([220]);
    let ehlo = await command("EHLO openmail.local", [250]);
    if (!settings.smtpSecure) {
      if (!ehlo.some((line) => /^250[- ]STARTTLS\b/i.test(line)))
        throw new ProviderError({ message: "SMTP requires STARTTLS" });
      await command("STARTTLS", [220]);
      await wire.upgrade();
      ehlo = await command("EHLO openmail.local", [250]);
    }
    if (ehlo.some((line) => /^250[- ]AUTH.*\bPLAIN\b/i.test(line))) {
      await command(
        `AUTH PLAIN ${Buffer.from(`\0${settings.username}\0${pass}`).toString("base64")}`,
        [235],
      );
    } else if (ehlo.some((line) => /^250[- ]AUTH.*\bLOGIN\b/i.test(line))) {
      await command("AUTH LOGIN", [334]);
      await command(Buffer.from(settings.username).toString("base64"), [334]);
      await command(Buffer.from(pass).toString("base64"), [235]);
    } else throw new ProviderError({ message: "SMTP password authentication unavailable" });
    if (deliver) {
      await command(`MAIL FROM:${address(deliver.from)}`, [250]);
      for (const recipient of new Set(deliver.to))
        await command(`RCPT TO:${address(recipient)}`, [250, 251]);
      await command("DATA", [354]);
      // Preserve MIME bytes with latin1; remove folded Bcc and dot-stuff every line.
      const raw = Buffer.from(deliver.raw).toString("latin1");
      const end = raw.indexOf("\r\n\r\n");
      if (end < 0) throw new PermanentError({ message: "Invalid outgoing MIME" });
      let dropping = false;
      const headers = raw
        .slice(0, end)
        .split("\r\n")
        .filter((line) => {
          if (!/^[ \t]/.test(line)) dropping = /^bcc:/i.test(line);
          return !dropping;
        })
        .join("\r\n");
      const data = `${headers}\r\n\r\n${raw.slice(end + 4)}`.replace(/(^|\r\n)\./g, "$1..");
      try {
        await writeMailChunks(
          socket,
          Buffer.from(`${data.replace(/\r\n$/, "")}\r\n.\r\n`, "latin1"),
        );
      } catch {
        throw uncertain();
      }
      // An explicit rejection is definite; only a missing final reply is ambiguous.
      await reply([250], true);
    }
    // Delivery was acknowledged. A failed QUIT must not turn it into a failed send.
    await command("QUIT", [221]).catch(() => null);
  } finally {
    socket.close();
  }
}
