import { useAtom, useAtomMount, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Switch } from "@base-ui/react/switch";
import { Trans, useLingui } from "@lingui/react/macro";
import { Copy, RefreshCw, X } from "lucide-react";
import createQrCode from "qrcode-generator";
import { useEffect, useMemo, useState } from "react";

import type { RemoteAccessProblem, RemoteAccessView } from "../../../../../shared/remote-access";
import { resultError } from "../../../lib/errors";
import { threadDate } from "../../../lib/format";
import { openMailLink } from "../../../state/desktop";
import { useRunMail } from "../../../state/mail";
import {
  refreshRemoteAccessAtom,
  remoteAccessAtom,
  remoteAccessFeedAtom,
  disconnectRemoteSessionAtom,
  setRemoteAccessAtom,
  setRemoteAllowlistAtom,
  setRemoteServiceAtom,
} from "../../../state/remote-access";
import { Disclosure } from "../../../ui/Disclosure";
import { SettingsGroup, SettingsRow } from "../../../ui/SettingsRows";
import {
  buttonLink,
  buttonSecondary,
  formInput,
  settingsHint,
  switchThumb,
  switchTrack,
} from "../../../ui/styles";

const DOWNLOAD_URL = "https://tailscale.com/download";
const ADMIN_DNS_URL = "https://login.tailscale.com/admin/dns";
const ADMIN_SERVICES_URL = "https://login.tailscale.com/admin/services";
const HELP_URL = "https://openmail-docs.vercel.app/docs/remote-access";

/** Opens a help or download page in the Mac's browser. */
function useOpenLink() {
  const run = useRunMail();
  return (url: string) => run(openMailLink(url, false));
}

/** A one-line field for logins and service names: no autocorrect or capitals. */
function LoginField({
  label,
  placeholder,
  value,
  onChange,
  className = "",
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <input
      aria-label={label}
      placeholder={placeholder}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      className={`${formInput} min-w-0 flex-1 ${className}`}
    />
  );
}

function FieldError({ error, className = "" }: { error: string | null; className?: string }) {
  if (!error) return null;
  return (
    <p role="alert" className={`text-footnote text-red-600 dark:text-red-400 ${className}`}>
      {error}
    </p>
  );
}

/** A QR code of the URL, drawn as one SVG path from the module grid. */
function QrCode({ value, label }: { value: string; label: string }) {
  const { size, path } = useMemo(() => {
    const code = createQrCode(0, "M");
    code.addData(value);
    code.make();
    const count = code.getModuleCount();
    let d = "";
    for (let row = 0; row < count; row++)
      for (let col = 0; col < count; col++)
        if (code.isDark(row, col)) d += `M${col + 4} ${row + 4}h1v1h-1z`;
    return { size: count + 8, path: d };
  }, [value]);
  return (
    <svg
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className="size-40 rounded-card bg-white ring-1 ring-edge"
    >
      <title>{label}</title>
      <path d={path} fill="#000" />
    </svg>
  );
}

/** Why remote access isn't on. A component, so the Lingui macro extracts these messages. */
function ProblemText({ problem }: { problem: RemoteAccessProblem }) {
  const { t } = useLingui();
  const texts: Record<RemoteAccessProblem, string> = {
    notInstalled: t`Tailscale isn't installed on this Mac.`,
    notRunning: t`Tailscale isn't connected. Open Tailscale on this Mac and sign in.`,
    httpsDisabled: t`HTTPS certificates are off for your tailnet. Turn on MagicDNS and HTTPS Certificates on the DNS page of the Tailscale admin console.`,
    conflict: t`Something else on this Mac already uses Tailscale Serve on this port. OpenMail won't replace it. Remove that mapping or use a Tailscale Service name below.`,
    funnel: t`Funnel is on for this port, which would put it on the public internet. OpenMail never uses Funnel. Turn Funnel off for this port first.`,
    serveFailed: t`Tailscale Serve didn't accept the change. Check the Tailscale app, then try again.`,
    serverFailed: t`OpenMail couldn't start its local server.`,
    removeFailed: t`Couldn't remove the Tailscale mapping. Open Tailscale, and OpenMail removes it as soon as Tailscale responds.`,
  };
  return <span className="text-red-600 dark:text-red-400">{texts[problem]}</span>;
}

function Status({ view }: { view: RemoteAccessView }) {
  const { t } = useLingui();
  const openLink = useOpenLink();
  const tailscale = view.tailscale;
  if (!tailscale.installed)
    return (
      <SettingsRow
        label={<Trans>Tailscale isn't installed</Trans>}
        hint={
          <Trans>
            Install the Tailscale app on this Mac and sign in, then come back here. OpenMail doesn't
            install anything itself.
          </Trans>
        }
      >
        <button type="button" className={buttonSecondary} onClick={() => openLink(DOWNLOAD_URL)}>
          <Trans>Get Tailscale</Trans>
        </button>
      </SettingsRow>
    );
  if (!tailscale.running)
    return (
      <SettingsRow
        label={<Trans>Tailscale isn't connected</Trans>}
        hint={<Trans>Open Tailscale on this Mac and sign in.</Trans>}
      />
    );
  const tailnet = tailscale.tailnet ?? "";
  const login = tailscale.login ?? "";
  const device = tailscale.dnsName ?? "";
  return (
    <>
      <SettingsRow
        label={<Trans>Connected to {tailnet}</Trans>}
        hint={
          <Trans>
            Signed in as {login}. This Mac is {device}.
          </Trans>
        }
      />
      {!tailscale.https && (
        <SettingsRow
          label={<Trans>HTTPS certificates are off</Trans>}
          hint={t`Remote access needs MagicDNS and HTTPS Certificates turned on for your tailnet.`}
        >
          <button type="button" className={buttonSecondary} onClick={() => openLink(ADMIN_DNS_URL)}>
            <Trans>Open admin console</Trans>
          </button>
        </SettingsRow>
      )}
    </>
  );
}

function Address({ url }: { url: string }) {
  const { t } = useLingui();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-start gap-4 px-3 py-3">
      <QrCode value={url} label={t`QR code for ${url}`} />
      <div className="min-w-0 flex-1 basis-56 space-y-2">
        <p className="font-medium">
          <Trans>Open this address on your phone or another computer</Trans>
        </p>
        <p className="font-mono text-body break-all select-text">{url}</p>
        <button
          type="button"
          className={buttonSecondary}
          onClick={() => void navigator.clipboard.writeText(url).then(() => setCopied(true))}
        >
          <Copy className="size-3.5" />
          {copied ? <Trans>Copied</Trans> : <Trans>Copy address</Trans>}
        </button>
        <p className={settingsHint}>
          <Trans>
            The other device needs the Tailscale app, signed in to the same tailnet. This Mac must
            stay on with OpenMail open. Quitting OpenMail takes the address offline until it opens
            again.
          </Trans>
        </p>
      </div>
    </div>
  );
}

function Allowlist({ view }: { view: RemoteAccessView }) {
  const { t, i18n } = useLingui();
  const [result, save] = useAtom(setRemoteAllowlistAtom);
  const [draft, setDraft] = useState("");
  const error = resultError(i18n, result);
  const add = () => {
    const login = draft.trim();
    if (!login) return;
    save({ payload: { logins: [...view.allowlist, login] } });
    setDraft("");
  };
  return (
    <SettingsGroup
      title={<Trans>Who can sign in</Trans>}
      footer={
        <Trans>
          Tailscale tells OpenMail who is visiting. Only these tailnet logins get in. Removing a
          login disconnects its browsers and keeps them out. The list starts with this Mac's own
          login.
        </Trans>
      }
    >
      {view.allowlist.length === 0 && (
        <SettingsRow label={<Trans>Nobody can sign in. Add a tailnet login below.</Trans>} />
      )}
      {view.allowlist.map((login) => (
        <SettingsRow key={login} label={<span className="font-mono">{login}</span>}>
          <button
            type="button"
            aria-label={t`Remove ${login}`}
            className={buttonSecondary}
            onClick={() =>
              save({ payload: { logins: view.allowlist.filter((item) => item !== login) } })
            }
          >
            <X className="size-3.5" />
            <Trans>Remove</Trans>
          </button>
        </SettingsRow>
      ))}
      <form
        className="flex flex-wrap items-center gap-2 px-3 py-2"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <LoginField
          label={t`Tailnet login`}
          placeholder="name@github"
          value={draft}
          onChange={setDraft}
        />
        <button type="submit" className={buttonSecondary} disabled={!draft.trim()}>
          <Trans>Add</Trans>
        </button>
        <FieldError error={error} className="basis-full" />
      </form>
    </SettingsGroup>
  );
}

function Sessions({ view }: { view: RemoteAccessView }) {
  const { t, i18n } = useLingui();
  const disconnect = useAtomSet(disconnectRemoteSessionAtom);
  return (
    <SettingsGroup
      title={<Trans>Browsers</Trans>}
      footer={
        <Trans>
          Disconnect closes a browser's connection. Reloading the page connects it again while its
          login is on the list above. To keep someone out, remove their login.
        </Trans>
      }
    >
      {view.sessions.length === 0 ? (
        <SettingsRow label={<Trans>No browser has opened OpenMail.</Trans>} />
      ) : (
        view.sessions.map((session) => {
          const since = threadDate(session.lastSeenAt, i18n);
          return (
            <SettingsRow
              key={session.id}
              label={
                <span>
                  {session.name} <span className="text-a11y-muted">{session.login}</span>
                </span>
              }
              hint={
                session.connected ? <Trans>Connected now</Trans> : <Trans>Last seen {since}</Trans>
              }
            >
              <button
                type="button"
                className={buttonSecondary}
                aria-label={t`Disconnect ${session.login}`}
                onClick={() => disconnect({ payload: { id: session.id } })}
              >
                <Trans>Disconnect</Trans>
              </button>
            </SettingsRow>
          );
        })
      )}
    </SettingsGroup>
  );
}

function ServiceName({ view }: { view: RemoteAccessView }) {
  const { t, i18n } = useLingui();
  const openLink = useOpenLink();
  const [result, save] = useAtom(setRemoteServiceAtom);
  const [value, setValue] = useState(view.service);
  const error = resultError(i18n, result);
  return (
    <Disclosure summary={<Trans>Advanced: Tailscale Service</Trans>}>
      <div className="space-y-2 px-1">
        <p className={settingsHint}>
          <Trans>
            Publish OpenMail as a Tailscale Service, such as svc:openmail, with its own name instead
            of port 8443 on this Mac. Define the service in the Tailscale admin console and approve
            this Mac as its host first. Leave empty to use this Mac's name.
          </Trans>
        </p>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            save({ payload: { service: value.trim() } });
          }}
        >
          <LoginField
            label={t`Tailscale Service name`}
            placeholder="svc:openmail"
            value={value}
            onChange={setValue}
            className="font-mono"
          />
          <button type="submit" className={buttonSecondary}>
            <Trans>Save</Trans>
          </button>
          <button type="button" className={buttonLink} onClick={() => openLink(ADMIN_SERVICES_URL)}>
            <Trans>Open admin console</Trans>
          </button>
        </form>
        <FieldError error={error} />
      </div>
    </Disclosure>
  );
}

/** Settings → Remote access: publish OpenMail to the person's own tailnet. Desktop only. */
export function RemoteAccessSettings() {
  const { t, i18n } = useLingui();
  const openLink = useOpenLink();
  useAtomMount(remoteAccessFeedAtom);
  const view = useAtomValue(remoteAccessAtom);
  const refresh = useAtomSet(refreshRemoteAccessAtom);
  const [toggled, toggle] = useAtom(setRemoteAccessAtom);
  const toggleError = resultError(i18n, toggled);
  useEffect(() => {
    refresh({ payload: undefined });
  }, [refresh]);
  if (!view) return null;
  const on = view.enabled;
  return (
    <div className="space-y-6">
      <p className={`px-1 ${settingsHint}`}>
        <Trans>
          Read and send mail from your phone or another computer through your own tailnet. This Mac
          stays the host: mail, tokens and keys stay here, and nothing passes through OpenMail
          servers. OpenMail uses Tailscale Serve, which only devices on your tailnet can reach. It
          never uses Funnel, so the page is never on the public internet.
        </Trans>{" "}
        <button type="button" className={buttonLink} onClick={() => openLink(HELP_URL)}>
          <Trans>Learn more</Trans>
        </button>
      </p>
      <SettingsGroup title={<Trans>Tailscale</Trans>}>
        <Status view={view} />
        <SettingsRow label={<Trans>Tailscale status</Trans>}>
          <button
            type="button"
            className={buttonSecondary}
            aria-label={t`Check Tailscale again`}
            onClick={() => refresh({ payload: undefined })}
          >
            <RefreshCw className="size-3.5" />
            <Trans>Check again</Trans>
          </button>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup>
        <SettingsRow
          label={<Trans>Allow access from my tailnet</Trans>}
          hint={
            view.status === "starting" ? (
              <Trans>Starting…</Trans>
            ) : view.problem ? (
              <ProblemText problem={view.problem} />
            ) : (
              toggleError
            )
          }
        >
          <Switch.Root
            className={switchTrack}
            checked={on}
            disabled={view.status === "starting" || (!on && !view.tailscale.installed)}
            aria-label={t`Allow access from my tailnet`}
            onCheckedChange={(enabled) => toggle({ payload: { enabled } })}
          >
            <Switch.Thumb className={switchThumb} />
          </Switch.Root>
        </SettingsRow>
        {view.status === "on" && view.url && <Address url={view.url} />}
      </SettingsGroup>
      <Allowlist view={view} />
      {on && <Sessions view={view} />}
      <ServiceName key={view.service} view={view} />
    </div>
  );
}
