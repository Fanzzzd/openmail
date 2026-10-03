import { sha256Hex } from "./platform/crypto.js";
import { Effect } from "effect";
import { InvalidInput } from "./errors.js";
import { IMAP_PRESETS, type ImapConnectInput } from "./imap-presets.js";
import type { ImapSettings } from "./domain.js";

const invalid = (message: string) => Effect.fail(new InvalidInput({ message }));

/** Resolves a preset plus overrides into stored settings. */
export const resolveImapSettings = Effect.fnUntraced(function* (
  input: ImapConnectInput,
): Effect.fn.Return<ImapSettings, InvalidInput> {
  const email = input.email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return yield* invalid(`Invalid email address: ${email}`);
  }
  if ([input.username ?? email, input.password].some((value) => /[\r\n\0]/.test(value)))
    return yield* invalid("Invalid login characters");
  if (!input.password) return yield* invalid("Password is required");
  const preset = input.preset === "custom" ? undefined : IMAP_PRESETS[input.preset];
  if (input.preset !== "custom" && !preset) {
    return yield* invalid(`Unknown IMAP preset: ${input.preset}`);
  }

  const imapHost = input.imapHost?.trim() || preset?.imapHost;
  const smtpHost = input.smtpHost?.trim() || preset?.smtpHost;
  if (!imapHost) return yield* invalid("IMAP server is required");
  if (!smtpHost) return yield* invalid("SMTP server is required");
  if ([imapHost, smtpHost].some((host) => !/^[a-zA-Z0-9.-]+$/.test(host)))
    return yield* invalid("Invalid server hostname");
  const imapPort = input.imapPort ?? preset?.imapPort ?? 993;
  const smtpPort = input.smtpPort ?? preset?.smtpPort ?? 465;
  for (const port of [imapPort, smtpPort]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return yield* invalid(`Invalid port: ${port}`);
    }
  }
  return {
    preset: preset ? input.preset : "custom",
    username: input.username?.trim() || email,
    imapHost,
    imapPort,
    smtpHost,
    smtpPort,
    // 465 is implicit TLS; 587 and 25 upgrade with STARTTLS.
    smtpSecure: input.smtpSecure ?? preset?.smtpSecure ?? smtpPort === 465,
  };
});

/** SMTP providers that file sent copies even for manually configured accounts. */
export function serverSavesSent(settings: ImapSettings): boolean {
  return (
    IMAP_PRESETS[settings.preset]?.serverSavesSent === true ||
    /^(?:smtp\.gmail\.com|smtp\.office365\.com|smtp(?:-mail)?\.outlook\.com)$/i.test(
      settings.smtpHost,
    )
  );
}

export const imapSettingsKey = (settings: ImapSettings) =>
  sha256Hex(JSON.stringify(Object.entries(settings).toSorted(([a], [b]) => a.localeCompare(b))));
