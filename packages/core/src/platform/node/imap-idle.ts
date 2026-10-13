import type { ImapFlow } from "imapflow";
import type { ImapSettings } from "../../domain/account.js";
import { IDLE_RENEW_MS } from "../../providers/imap/imap-idle.js";

export { IDLE_RENEW_MS, idleRetryDelay } from "../../providers/imap/imap-idle.js";

export async function watchImapInbox(
  settings: ImapSettings,
  password: string,
  signal: AbortSignal,
  changed: () => void,
  ready: () => void,
) {
  const { ImapFlow } = await import("imapflow");
  const client = new ImapFlow({
    host: settings.imapHost,
    port: settings.imapPort,
    secure: settings.imapPort === 993,
    doSTARTTLS: settings.imapPort !== 993,
    auth: { user: settings.username, pass: password },
    logger: false,
    clientInfo: { name: "openmail", version: "0.1.0", vendor: "openmail" },
    disableAutoIdle: true,
    maxIdleTime: IDLE_RENEW_MS,
    connectionTimeout: 20_000,
  });
  const close = () => client.close();
  client.on("error", close);
  signal.addEventListener("abort", close, { once: true });
  try {
    if (signal.aborted) return;
    await client.connect();
    return await keepInboxIdle(client, signal, changed, ready);
  } finally {
    signal.removeEventListener("abort", close);
    client.close();
  }
}

/** The signal owns the socket, including connection/SELECT failures and sleep. */
export async function keepInboxIdle(
  client: ImapFlow,
  signal: AbortSignal,
  changed: () => void,
  ready: () => void,
): Promise<"unsupported" | void> {
  const close = () => client.close();
  signal.addEventListener("abort", close, { once: true });
  if (signal.aborted) close();
  try {
    if (!client.capabilities.has("IDLE")) return "unsupported";
    await client.mailboxOpen("INBOX", { readOnly: true });
    if (signal.aborted) return;
    client.on("exists", changed);
    client.on("flags", changed);
    client.on("expunge", changed);
    ready();
    const aborted = () => signal.aborted;
    while (!aborted() && client.usable) await client.idle();
    if (!aborted()) throw new Error("IMAP IDLE connection closed");
  } finally {
    signal.removeEventListener("abort", close);
    client.off("exists", changed);
    client.off("flags", changed);
    client.off("expunge", changed);
    close();
  }
}

export { ImapIdle } from "../../providers/imap/imap-idle.js";
