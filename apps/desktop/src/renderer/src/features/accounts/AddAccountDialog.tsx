import type { MessageDescriptor, I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Cause, Exit } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { ChevronLeft, ExternalLink, X } from "lucide-react";
import { type ReactNode, useState } from "react";

import type { Account, ImapConnectInput } from "../../../../shared/api";
import { type AppError, causeText, resultError } from "../../lib/errors";
import { clearClientAtom, connectAtom, saveClientAtom } from "../../state/mutations";
import { clientSetupAtom, imapPresetsAtom } from "../../state/queries";
import { ProviderIcon, type ProviderIconName } from "../../ui/ProviderIcon";
import { Dialog } from "../../ui/Dialog";
import { Disclosure } from "../../ui/Disclosure";
import { SegmentedControl } from "../../ui/SegmentedControl";
import { formInput } from "../../ui/styles";

/**
 * UI text for core's IMAP presets, keyed by preset id. Core keeps its own
 * Chinese `note` for the CLI; the app shows these instead and falls back to
 * core's text for a preset it does not know.
 */

/** Preset names that are not plain brand names. */
const PRESET_NAMES: Record<string, MessageDescriptor> = {
  qq: msg`QQ Mail`,
  "163": msg`163 Mail`,
};

/** The line under the password field: where to create the app password. */
const PRESET_NOTES: Record<string, MessageDescriptor> = {
  icloud: msg`Create an app-specific password under Sign-In and Security in your Apple Account.`,
  yahoo: msg`Create an app password under Account Security in your Yahoo account.`,
  qq: msg`On the web, turn on IMAP/SMTP under Settings > Account & Security > Security Settings, then generate an authorization code.`,
  "163": msg`On the web, turn on IMAP under Settings > POP3/SMTP/IMAP, then follow the prompts to generate an authorization code.`,
  fastmail: msg`Create an app password under Settings > Privacy & Security, with IMAP and SMTP checked.`,
};

type OAuthProvider = "gmail" | "outlook";
/** IMAP preset keys in core, plus "custom" for any other server. */
type ImapChoice = "icloud" | "yahoo" | "qq" | "163" | "fastmail" | "custom";
type Choice = OAuthProvider | ImapChoice;

/** Brand names stay as they are; the rest are translated. */
const TILES: { id: Choice; icon: ProviderIconName; label: string | MessageDescriptor }[] = [
  { id: "gmail", icon: "gmail", label: "Gmail" },
  { id: "outlook", icon: "outlook", label: "Outlook" },
  { id: "icloud", icon: "icloud", label: "iCloud" },
  { id: "yahoo", icon: "yahoo", label: "Yahoo" },
  { id: "qq", icon: "qq", label: PRESET_NAMES.qq! },
  { id: "163", icon: "163", label: PRESET_NAMES["163"]! },
  { id: "fastmail", icon: "fastmail", label: "Fastmail" },
  { id: "custom", icon: "imap", label: msg`Other IMAP` },
];

const tileLabel = (i18n: I18n, label: string | MessageDescriptor) =>
  typeof label === "string" ? label : i18n._(label);

const isOAuth = (c: Choice): c is OAuthProvider => c === "gmail" || c === "outlook";

const IMAP_CHOICES: ReadonlySet<string> = new Set([
  "icloud",
  "yahoo",
  "qq",
  "163",
  "fastmail",
  "custom",
]);
const isImapChoice = (preset: string): preset is ImapChoice => IMAP_CHOICES.has(preset);

/** A port field holds a whole number from 1 to 65535. */
const validPort = (port: string) =>
  /^\d{1,5}$/.test(port.trim()) && Number(port) >= 1 && Number(port) <= 65535;

interface Props {
  onClose: () => void;
  onAdded: (account: Account) => void;
  /** No account yet: the dialog greets the person. Closing it leaves an empty window with Add account. */
  firstRun?: boolean;
  /**
   * An IMAP account whose password the server rejected. The dialog opens on its
   * preset with the address and stored server settings filled in, never the password.
   */
  signInAgain?: Account;
}

/**
 * Adds a mail account. Step one picks the provider; step two signs in through
 * the browser (Gmail, Outlook) or with an app password (IMAP providers).
 */
export function AddAccountDialog({ onClose, onAdded, firstRun, signInAgain }: Props) {
  const { t, i18n } = useLingui();
  const againPreset = signInAgain?.imap?.preset;
  const [choice, setChoice] = useState<Choice | null>(
    signInAgain ? (againPreset && isImapChoice(againPreset) ? againPreset : "custom") : null,
  );
  const tile = TILES.find((item) => item.id === choice);

  const provider = tile ? tileLabel(i18n, tile.label) : "";
  const title = signInAgain
    ? t`Sign in again`
    : tile
      ? t`Add ${provider}`
      : firstRun
        ? t`Add Your First Account`
        : t`Add email account`;

  return (
    <Dialog
      aria-label={title}
      onClose={onClose}
      ownClose
      className="w-[min(460px,calc(100vw-48px))] p-6"
      backdropClassName="bg-black/30 backdrop-blur-[2px]"
    >
      <header className="flex h-7 items-center gap-2">
        {tile && !signInAgain && (
          <button
            type="button"
            aria-label={t`Back`}
            onClick={() => setChoice(null)}
            className="-ml-1.5 flex size-7 items-center justify-center rounded-control text-a11y-muted hover:bg-fill-hover"
          >
            <ChevronLeft className="size-4" />
          </button>
        )}
        {tile && <ProviderIcon provider={tile.icon} className="size-5 shrink-0" />}
        <h2 className="flex-1 text-headline font-semibold">{title}</h2>
        <button
          type="button"
          aria-label={t`Close`}
          onClick={onClose}
          className="-mr-1.5 flex size-7 items-center justify-center rounded-control text-a11y-muted hover:bg-fill-hover"
        >
          <X className="size-4" />
        </button>
      </header>

      {choice === null && (
        <>
          <p className="mt-1.5 text-a11y-muted">
            {firstRun ? (
              <Trans>
                Welcome to openmail. Choose your email provider. Your credentials stay on this
                computer.
              </Trans>
            ) : (
              <Trans>Choose your email provider.</Trans>
            )}
          </p>
          <div className="mt-5 grid grid-cols-4 gap-2">
            {TILES.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-label={tileLabel(i18n, item.label)}
                onClick={() => setChoice(item.id)}
                className="flex flex-col items-center gap-2 rounded-card px-1 py-4 ring-1 ring-edge transition-colors hover:bg-fill-hover active:bg-fill-pressed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-a11y-focus motion-reduce:transition-none"
              >
                <ProviderIcon provider={item.icon} className="size-8" />
                <span className="text-footnote text-neutral-700 dark:text-neutral-300">
                  {tileLabel(i18n, item.label)}
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {choice !== null && isOAuth(choice) && (
        <OAuthStep key={choice} provider={choice} onAdded={onAdded} />
      )}
      {choice !== null && !isOAuth(choice) && (
        <ImapStep
          key={choice}
          preset={choice}
          onAdded={onAdded}
          {...(signInAgain ? { signInAgain } : {})}
        />
      )}
    </Dialog>
  );
}

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

// Gmail and Outlook

const OAUTH_COPY: Record<OAuthProvider, { name: string; doc: string }> = {
  gmail: { name: "Google", doc: "docs/setup-google.md" },
  outlook: { name: "Microsoft", doc: "docs/setup-microsoft.md" },
};

function OAuthStep({
  provider,
  onAdded,
}: {
  provider: OAuthProvider;
  onAdded: (account: Account) => void;
}) {
  const setup = AsyncResult.getOrElse(useAtomValue(clientSetupAtom), () => null);
  const [signIn, runSignIn] = useAtom(connectAtom(provider), { mode: "promiseExit" });
  // Interrupting the call reaches the main process, which closes the loopback server.
  const control = useAtomSet(connectAtom(provider));
  const { i18n } = useLingui();
  // Cancel interrupts the sign-in; that is not an error to show.
  const signInError = AsyncResult.isInterrupted(signIn) ? null : resultError(i18n, signIn);
  const { name, doc } = OAUTH_COPY[provider];

  const signInNow = async () => {
    const exit = await runSignIn({ provider });
    if (Exit.isSuccess(exit)) onAdded(exit.value);
  };

  if (!setup)
    return (
      <p className="mt-5 text-a11y-muted">
        <Trans>Loading settings…</Trans>
      </p>
    );
  const gmail = provider === "gmail";
  const active = gmail ? setup.googleClient : setup.microsoftClient;
  const configured = active !== "none";
  const builtIn = gmail ? setup.googleBuiltIn : setup.microsoftBuiltIn;

  // No built-in or saved client: the person registers one first.
  if (!configured)
    return (
      <ClientForm provider={provider} autoFocus>
        {provider === "gmail" ? (
          <Trans>
            openmail signs in with an OAuth client you register yourself. First enter the OAuth
            client you created in Google Cloud, with the Desktop app type. See {doc} in the
            repository for the steps.
          </Trans>
        ) : (
          <Trans>
            openmail signs in with an OAuth client you register yourself. First enter the app you
            registered in Azure, with the Mobile and desktop applications type. Only personal
            outlook.com and Hotmail accounts are supported. See {doc} in the repository for the
            steps.
          </Trans>
        )}
      </ClientForm>
    );

  return (
    <div className="mt-4">
      <p className="text-a11y-muted">
        {signIn.waiting ? (
          <Trans>Finish signing in in your browser, then come back here.</Trans>
        ) : provider === "gmail" ? (
          <Trans>
            Sign in with your Google account in the browser. openmail keeps the sign-in token in
            this computer's keychain.
          </Trans>
        ) : (
          <Trans>
            Sign in with your personal Microsoft account (outlook.com or Hotmail) in the browser.
            openmail keeps the sign-in token in this computer's keychain.
          </Trans>
        )}
      </p>
      <p className="mt-2 text-footnote text-a11y-muted">
        {active === "own" ? (
          <Trans>New sign-ins use your own OAuth client.</Trans>
        ) : (
          <Trans>New sign-ins use openmail's built-in client.</Trans>
        )}
      </p>
      {active === "own" && builtIn && <UseBuiltIn provider={provider} />}
      {signInError && <ErrorLine text={signInError} />}
      <Actions>
        {signIn.waiting && (
          <SecondaryButton onClick={() => control(Atom.Interrupt)}>
            <Trans>Cancel</Trans>
          </SecondaryButton>
        )}
        <PrimaryButton disabled={signIn.waiting} onClick={() => void signInNow()}>
          {signIn.waiting ? (
            <Trans>Waiting for sign-in…</Trans>
          ) : (
            <Trans>Sign in with {name}</Trans>
          )}
        </PrimaryButton>
      </Actions>
      <Disclosure
        className="mt-4"
        summaryClassName="text-footnote text-a11y-muted"
        summary={
          builtIn ? (
            <Trans>Use your own OAuth client</Trans>
          ) : (
            <Trans>Change your OAuth client</Trans>
          )
        }
      >
        <ClientForm provider={provider}>
          {builtIn ? (
            <Trans>
              Enter an OAuth client you registered yourself. New sign-ins use it instead of the
              built-in client. See {doc} in the repository.
            </Trans>
          ) : (
            <Trans>
              Enter a different OAuth client you registered yourself. New sign-ins use it. See {doc}{" "}
              in the repository.
            </Trans>
          )}
        </ClientForm>
      </Disclosure>
    </div>
  );
}

/** Drops the person's own client from config.json. Accounts keep the client that signed them in. */
function UseBuiltIn({ provider }: { provider: OAuthProvider }) {
  const { i18n } = useLingui();
  const [clear, runClear] = useAtom(clearClientAtom);
  const clearError = resultError(i18n, clear);
  return (
    <>
      <p className="mt-1 text-footnote text-a11y-muted">
        <Trans>Accounts you already added keep the client they signed in with.</Trans>{" "}
        <button
          type="button"
          disabled={clear.waiting}
          onClick={() => runClear(provider)}
          className="text-a11y-accent hover:underline disabled:opacity-40 dark:text-blue-400"
        >
          <Trans>Use the built-in client</Trans>
        </button>
      </p>
      {clearError && <ErrorLine text={clearError} />}
    </>
  );
}

/** The OAuth client fields, saved to config.json through the main process. */
function ClientForm({
  provider,
  autoFocus,
  children,
}: {
  provider: OAuthProvider;
  autoFocus?: boolean;
  children: ReactNode;
}) {
  const { t, i18n } = useLingui();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saveClient, runSaveClient] = useAtom(saveClientAtom);
  const saveError = resultError(i18n, saveClient);
  const ready = clientId.trim() && (provider === "outlook" || clientSecret.trim());
  const { name } = OAUTH_COPY[provider];
  return (
    <form
      aria-label={t`${name} client`}
      className="mt-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        runSaveClient(
          provider === "gmail"
            ? { provider, clientId: clientId.trim(), clientSecret: clientSecret.trim() }
            : { provider, clientId: clientId.trim() },
        );
      }}
    >
      <p className="text-a11y-muted">{children}</p>
      <Field
        label={provider === "gmail" ? t`Client ID` : t`Application (client) ID`}
        value={clientId}
        onChange={setClientId}
        autoFocus={autoFocus}
      />
      {provider === "gmail" && (
        <Field label={t`Client secret`} value={clientSecret} onChange={setClientSecret} password />
      )}
      {saveError && <ErrorLine text={saveError} />}
      {saveClient._tag === "Success" && (
        <output className="mt-3 block text-footnote text-a11y-muted">
          <Trans>Saved. New sign-ins use this client.</Trans>
        </output>
      )}
      <Actions>
        <PrimaryButton disabled={!ready || saveClient.waiting}>
          {saveClient.waiting ? <Trans context="in progress">Saving…</Trans> : <Trans>Save</Trans>}
        </PrimaryButton>
      </Actions>
    </form>
  );
}

// IMAP

function ImapStep({
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

// Shared bits

function Field({
  label,
  value,
  onChange,
  password,
  type,
  autoFocus,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  password?: boolean;
  type?: "text" | "email";
  autoFocus?: boolean;
  inputMode?: "numeric";
}) {
  return (
    <label className="mt-3 block text-footnote font-medium text-a11y-muted">
      {label}
      <input
        type={password ? "password" : (type ?? "text")}
        value={value}
        autoFocus={autoFocus}
        inputMode={inputMode}
        spellCheck={false}
        autoCapitalize="off"
        onChange={(e) => onChange(e.target.value)}
        className={`selectable mt-1 h-8 ${formInput}`}
      />
    </label>
  );
}

function ErrorLine({ text }: { text: string }) {
  return (
    <p role="alert" className="mt-3 text-footnote text-a11y-danger">
      {text}
    </p>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="mt-5 flex justify-end gap-2">{children}</div>;
}

function SecondaryButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-8 rounded-control bg-white px-4 font-medium text-neutral-900 shadow-control ring-1 ring-edge hover:bg-neutral-50 active:bg-neutral-100 dark:bg-white/[0.08] dark:text-neutral-100 dark:hover:bg-white/[0.12] dark:active:bg-white/[0.16]"
    >
      {children}
    </button>
  );
}

function PrimaryButton({
  children,
  disabled,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type={onClick ? "button" : "submit"}
      disabled={disabled}
      onClick={onClick}
      className="h-8 rounded-control bg-blue-600 px-4 font-medium text-white hover:bg-blue-700 disabled:opacity-40"
    >
      {children}
    </button>
  );
}
