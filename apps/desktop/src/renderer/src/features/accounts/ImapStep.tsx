import type { MessageDescriptor, I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Cause, Exit } from "effect";
import { AsyncResult } from "effect/reactivity";
import { ExternalLink } from "lucide-react";
import { useState } from "react";

import type { Account, ImapConnectInput } from "../../../../shared/api";
import { type AppError, causeText } from "../../lib/errors";
import { connectAtom } from "../../state/mutations";
import { imapPresetsAtom } from "../../state/queries";
import { SegmentedControl } from "../../ui/SegmentedControl";
import { Actions, ErrorLine, Field, PrimaryButton } from "./AccountFormParts";

/**
 * The line under the password field: where to create the app password. UI text for core's
 * IMAP presets, keyed by preset id. Core keeps its own Chinese `note` for the CLI; the app
 * shows these instead and falls back to core's text for a preset it does not know.
 */
const PRESET_NOTES: Record<string, MessageDescriptor> = {
  icloud: msg`Create an app-specific password under Sign-In and Security in your Apple Account.`,
  yahoo: msg`Create an app password under Account Security in your Yahoo account.`,
  qq: msg`On the web, turn on IMAP/SMTP under Settings → Account & Security → Security Settings, then generate an authorization code.`,
  "163": msg`On the web, turn on IMAP under Settings → POP3/SMTP/IMAP, then follow the prompts to generate an authorization code.`,
  fastmail: msg`Create an app password under Settings → Privacy & Security, with IMAP and SMTP checked.`,
};

/** IMAP preset keys in core, plus "custom" for any other server. */
export type ImapChoice = "icloud" | "yahoo" | "qq" | "163" | "fastmail" | "custom";

/** A port field holds a whole number from 1 to 65535. */
const validPort = (port: string) =>
  /^\d{1,5}$/.test(port.trim()) && Number(port) >= 1 && Number(port) <= 65535;

/** An IMAP server that rejects the login almost always got the web password. */
function imapErrorText(
  i18n: I18n,
  result: AsyncResult.AsyncResult<Account, AppError>,
): string | null {
  if (result._tag !== "Failure") return null;
  const error = Cause.findErrorOption(result.cause);
  if (error._tag === "Some" && error.value._tag === "AuthError") {
    return i18n._(
      msg`The server rejected the sign-in. Check the email address, and make sure you entered an app-specific password or authorization code, not your web password.`,
    );
  }
  return causeText(i18n, result.cause);
}

export function ImapStep({
  preset,
  onAdded,
  signInAgain,
}: {
  preset: ImapChoice;
  onAdded: (account: Account) => void;
  signInAgain?: Account;
}) {
  const { t, i18n } = useLingui();
  const presets = AsyncResult.getOrElse(useAtomValue(imapPresetsAtom), () => null);
  const info = preset === "custom" ? undefined : presets?.[preset];
  const presetNote = PRESET_NOTES[preset];
  const note = presetNote ? i18n._(presetNote) : info?.note;
  const custom = preset === "custom";
  const authCode = preset === "qq" || preset === "163";

  // Sign in again keeps the stored servers; only the password is typed again.
  const stored = signInAgain?.imap;
  const storedEmail = signInAgain?.email ?? "";
  const [email, setEmail] = useState(storedEmail);
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState(
    stored && stored.username !== storedEmail ? stored.username : "",
  );
  const [imapHost, setImapHost] = useState(stored?.imapHost ?? "");
  const [imapPort, setImapPort] = useState(String(stored?.imapPort ?? 993));
  const [smtpHost, setSmtpHost] = useState(stored?.smtpHost ?? "");
  const [smtpPort, setSmtpPort] = useState(String(stored?.smtpPort ?? 465));
  const [smtpSecure, setSmtpSecure] = useState(stored?.smtpSecure ?? true);

  const [add, runAdd] = useAtom(connectAtom(preset), { mode: "promiseExit" });
  const addError = imapErrorText(i18n, add);

  const submit = async () => {
    const base = { preset, email: email.trim(), password };
    // Optional fields are left out, not sent as undefined: the main process
    // decodes the input strictly.
    const input: ImapConnectInput = custom
      ? {
          ...base,
          imapHost: imapHost.trim(),
          imapPort: Number(imapPort),
          smtpHost: smtpHost.trim(),
          smtpPort: Number(smtpPort),
          smtpSecure,
          ...(username.trim() ? { username: username.trim() } : {}),
        }
      : base;
    const exit = await runAdd({ provider: "imap", input });
    if (Exit.isSuccess(exit)) onAdded(exit.value);
  };

  const portsValid = validPort(imapPort) && validPort(smtpPort);
  const ready =
    email.includes("@") &&
    password &&
    (!custom || (imapHost.trim() && smtpHost.trim() && portsValid));
  const secretLabel = custom
    ? t`Password`
    : authCode
      ? t`Authorization code`
      : t`App-specific password`;

  return (
    <form
      aria-label={t`IMAP account`}
      className="mt-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !add.waiting) void submit();
      }}
    >
      {info && note && <p className="text-a11y-muted">{note}</p>}
      {custom && (
        <p className="text-a11y-muted">
          <Trans>Enter the IMAP and SMTP servers your email provider gives you.</Trans>
        </p>
      )}

      <Field
        label={t`Email address`}
        value={email}
        onChange={setEmail}
        type="email"
        autoFocus={!signInAgain}
      />
      <Field
        label={secretLabel}
        value={password}
        onChange={setPassword}
        password
        autoFocus={!!signInAgain}
      />
      {info?.appPasswordUrl && (
        <a
          href={info.appPasswordUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-1.5 inline-flex items-center gap-1 text-footnote text-a11y-accent hover:underline dark:text-blue-400"
        >
          {authCode ? (
            <Trans>Generate authorization code</Trans>
          ) : (
            <Trans>Generate app-specific password</Trans>
          )}
          <ExternalLink className="size-3" />
        </a>
      )}

      {custom && (
        <>
          <Field
            label={t`Username (defaults to the email address)`}
            value={username}
            onChange={setUsername}
          />
          <div className="flex gap-2">
            <div className="flex-1">
              <Field label={t`IMAP server`} value={imapHost} onChange={setImapHost} />
            </div>
            <div className="w-20">
              <Field label={t`Port`} value={imapPort} onChange={setImapPort} inputMode="numeric" />
            </div>
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <Field label={t`SMTP server`} value={smtpHost} onChange={setSmtpHost} />
            </div>
            <div className="w-20">
              <Field
                label={t`Port`}
                value={smtpPort}
                onChange={(v) => {
                  setSmtpPort(v);
                  if (v === "465") setSmtpSecure(true);
                  else if (v === "587") setSmtpSecure(false);
                }}
                inputMode="numeric"
              />
            </div>
          </div>
          {!portsValid && (
            <p className="mt-1.5 text-footnote text-a11y-danger">
              <Trans>Enter port numbers from 1 to 65535.</Trans>
            </p>
          )}
          <div className="mt-3">
            <span className="block text-footnote font-medium text-a11y-muted">
              <Trans>SMTP encryption</Trans>
            </span>
            <SegmentedControl
              aria-label={t`SMTP encryption`}
              value={smtpSecure ? "tls" : "starttls"}
              options={[
                { value: "tls", label: t`SSL/TLS (usually 465)` },
                { value: "starttls", label: t`STARTTLS (usually 587)` },
              ]}
              onValueChange={(v) => setSmtpSecure(v === "tls")}
              className="mt-1 w-full"
            />
          </div>
        </>
      )}

      {addError && <ErrorLine text={addError} />}
      <Actions>
        <PrimaryButton disabled={!ready || add.waiting}>
          {add.waiting ? <Trans>Verifying…</Trans> : <Trans>Add</Trans>}
        </PrimaryButton>
      </Actions>
    </form>
  );
}
