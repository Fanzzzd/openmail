import { ProfileSettings } from "../accounts";
import { OptionalServices } from "../accounts/OptionalServices";
import { AiSettings } from "./sections/AiSettings";
import { AiClientsSettings, WRITE_MODE_ANCHOR } from "./sections/AiClientsSettings";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { Tabs } from "@base-ui/react/tabs";
import { AsyncResult } from "effect/reactivity";
import { type ComponentType, type ReactNode, useRef, useState } from "react";
import {
  AtSign,
  Bell,
  BookOpen,
  FlaskConical,
  Hand,
  HardDrive,
  History,
  Keyboard,
  Layers,
  Server,
  Settings as SettingsIcon,
  Signature,
  Smartphone,
  Sparkles,
  SquarePen,
  Tags,
} from "lucide-react";
import { useLayoutMode } from "../../lib/responsive-layout";

import type { Account, AgentWriteMode, Language } from "../../../../shared/api";
import { resultError, OAUTH_CONFIGURATION_ERROR } from "../../lib/errors";
import { Keys, MAIL_KEYS } from "../../state/keys";
import {
  reauthAtom,
  removeAccountAtom,
  setAgentModeAtom,
  setPrefsAtom,
  moveAccountAtom,
} from "../../state/mutations";
import {
  agentModeAtom,
  auditAtom,
  prefsAtom,
  profilesAtom,
  clientSetupAtom,
} from "../../state/queries";
import { runAccountMove } from "./sections/account-settings";
import { SyncHealthCheck } from "./sections/SyncHealth";
import { AccountControls } from "./sections/AccountControls";
import { accountName } from "../../lib/format";
import { InteractionSettings, LabsSettings } from "./sections/InteractionSettings";
import {
  DefaultMailClient,
  NotificationsSettings,
  ShortcutsSettings,
} from "./sections/SystemSettings";
import { ComposeSettings, Signatures } from "./sections/ComposeSettings";
import { UpdateSettings } from "./sections/UpdateSettings";
import { SpellcheckSettings } from "./sections/SpellcheckSettings";
import { CacheSettings } from "./sections/CacheSettings";
import { ProviderIcon } from "../../ui/ProviderIcon";
import { ReadingSettings } from "./sections/ReadingSettings";
import { reauthText } from "../sync-status";
import { isKeychainLocked } from "@openmail/core/schema";
import { Alert, AlertCancel, alertDanger, Dialog } from "../../ui/Dialog";
import { SettingsGroup, SettingsRow } from "../../ui/SettingsRows";
import {
  buttonLink,
  buttonSecondary,
  choiceRow,
  radioDot,
  settingsGroup,
  settingsHeading,
  settingsHint,
  touchTarget,
} from "../../ui/styles";
import { Select } from "../../ui/Select";

import { OrganizationSettings } from "../organize";
import { ServerSettings } from "./sections/ServerSettings";
import { RemoteAccessSettings } from "./sections/RemoteAccessSettings";
import { isDesktop } from "../../lib/platform";

type Tab =
  | "profiles"
  | "cache"
  | "labs"
  | "interactions"
  | "notifications"
  | "shortcuts"
  | "signatures"
  | "organize"
  | "server"
  | "accounts"
  | "general"
  | "reading"
  | "compose"
  | "ai"
  | "remote"
  | "log";

type TabIcon = ComponentType<{ className?: string }>;

/**
 * Tabs in sidebar order, grouped like System Settings: the app, mail, input, services, history.
 * `group` starts a new group with a gap above it. Each icon sits on its own colour tile.
 */
const TABS: { id: Tab; label: MessageDescriptor; icon: TabIcon; tile: string; group?: true }[] = [
  { id: "general", label: msg`General`, icon: SettingsIcon, tile: "bg-neutral-500" },
  { id: "accounts", label: msg`Accounts`, icon: AtSign, tile: "bg-blue-500" },
  { id: "profiles", label: msg`Profiles`, icon: Layers, tile: "bg-indigo-500" },
  { id: "reading", label: msg`Reading`, icon: BookOpen, tile: "bg-sky-500", group: true },
  { id: "compose", label: msg`Compose`, icon: SquarePen, tile: "bg-blue-500" },
  { id: "signatures", label: msg`Signatures`, icon: Signature, tile: "bg-orange-500" },
  { id: "organize", label: msg`Organize`, icon: Tags, tile: "bg-green-600" },
  { id: "notifications", label: msg`Notifications`, icon: Bell, tile: "bg-red-500" },
  {
    id: "interactions",
    label: msg`Gestures and toolbar`,
    icon: Hand,
    tile: "bg-cyan-600",
    group: true,
  },
  { id: "shortcuts", label: msg`Shortcuts`, icon: Keyboard, tile: "bg-neutral-500" },
  { id: "ai", label: msg`AI Access`, icon: Sparkles, tile: "bg-violet-500", group: true },
  { id: "remote", label: msg`Remote access`, icon: Smartphone, tile: "bg-emerald-600" },
  { id: "server", label: msg`Server`, icon: Server, tile: "bg-teal-600" },
  { id: "cache", label: msg`Local cache`, icon: HardDrive, tile: "bg-neutral-500" },
  { id: "labs", label: msg`Labs`, icon: FlaskConical, tile: "bg-purple-500", group: true },
  { id: "log", label: msg`Activity`, icon: History, tile: "bg-neutral-500" },
];

/**
 * Tabs a browser on the tailnet can use: mail settings only. Accounts, keys,
 * notifications, caches, updates and remote access itself stay on the Mac.
 */
const WEB_TABS: ReadonlySet<Tab> = new Set([
  "general",
  "reading",
  "compose",
  "signatures",
  "organize",
  "server",
  "interactions",
  "shortcuts",
  "labs",
  "log",
]);
const visibleTabs = () => (isDesktop() ? TABS : TABS.filter((item) => WEB_TABS.has(item.id)));

/** The scrolling content of a tab: its title, then the sections at a readable measure. */
const panel = "min-h-0 flex-1 overflow-y-auto outline-none";
const measure = "mx-auto max-w-[620px] space-y-6 px-6 pt-4 pb-8 max-sm:px-4";

interface Props {
  accounts: readonly Account[];
  initialTab?: Tab;
  optionalAccountId?: string | null;
  onClose: () => void;
  onAddAccount: () => void;
}

export function Settings({
  accounts,
  initialTab = "general",
  optionalAccountId,
  onClose,
  onAddAccount,
}: Props) {
  const { t, i18n } = useLingui();
  const [tab, setTab] = useState<Tab>(
    isDesktop() || WEB_TABS.has(initialTab) ? initialTab : "general",
  );
  const narrow = useLayoutMode() === "narrow";
  const pane = (id: Tab, children: ReactNode, className = "") => (
    <Tabs.Panel value={id} className={`${panel} ${className}`}>
      <div className={measure}>
        <h3 className="text-title font-semibold max-sm:hidden">
          {i18n._(TABS.find((item) => item.id === id)!.label)}
        </h3>
        {children}
      </div>
    </Tabs.Panel>
  );

  return (
    <Dialog
      aria-label={t`Settings`}
      onClose={onClose}
      className="flex h-[min(640px,calc(100dvh-48px))] w-[min(880px,calc(100vw-48px))] overflow-hidden max-sm:flex-col"
    >
      <Tabs.Root
        orientation={narrow ? "horizontal" : "vertical"}
        value={tab}
        onValueChange={(value) => {
          const next = visibleTabs().find((item) => item.id === value);
          if (next) setTab(next.id);
        }}
        className="flex min-h-0 min-w-0 flex-1 max-sm:flex-col"
      >
        <div className="flex w-52 shrink-0 flex-col border-r border-separator bg-fill-quiet max-md:w-44 max-sm:w-auto max-sm:border-r-0 max-sm:border-b max-sm:bg-transparent">
          <h2 className="px-5 pt-4 pb-2 text-headline font-semibold max-sm:px-4 max-sm:pt-1">
            <Trans>Settings</Trans>
          </h2>
          <Tabs.List className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2.5 pb-3 max-sm:flex-none max-sm:flex-row max-sm:gap-1 max-sm:overflow-x-auto max-sm:px-3 max-sm:pb-2">
            {visibleTabs().map((item) => {
              const Icon = item.icon;
              return (
                <Tabs.Tab
                  key={item.id}
                  value={item.id}
                  className={`flex h-7 shrink-0 items-center gap-2 rounded-control px-2 ${touchTarget} text-left whitespace-nowrap outline-none hover:bg-fill-hover focus-visible:ring-2 focus-visible:ring-a11y-focus data-active:bg-fill-pressed data-active:font-medium max-sm:pr-2.5 ${item.group ? "sm:mt-3" : "sm:mt-px"}`}
                >
                  <span
                    aria-hidden
                    className={`flex size-5 shrink-0 items-center justify-center rounded-[5px] text-white shadow-control ${item.tile}`}
                  >
                    <Icon className="size-3.5" />
                  </span>
                  <span className="min-w-0 truncate">{i18n._(item.label)}</span>
                </Tabs.Tab>
              );
            })}
          </Tabs.List>
        </div>
        {isDesktop() && pane("remote", <RemoteAccessSettings />)}
        {pane(
          "accounts",
          <Accounts
            optionalAccountId={optionalAccountId}
            accounts={accounts}
            onAddAccount={onAddAccount}
          />,
        )}
        {pane("organize", <OrganizationSettings accounts={accounts} />)}
        {pane("server", <ServerSettings accounts={accounts} />)}
        {pane("profiles", <ProfileSettings accounts={accounts} />)}
        {pane("cache", <CacheSettings accounts={accounts} />)}
        {pane("notifications", <NotificationsSettings accounts={accounts} />)}
        {pane("shortcuts", <ShortcutsSettings />)}
        {pane("signatures", <Signatures accounts={accounts} />)}
        {pane(
          "general",
          <>
            <General />
            {isDesktop() && <UpdateSettings />}
          </>,
        )}
        {pane("labs", <LabsSettings />)}
        {pane("interactions", <InteractionSettings />)}
        {pane("reading", <ReadingSettings />)}
        {pane(
          "compose",
          <>
            <ComposeSettings />
            {isDesktop() && <SpellcheckSettings />}
          </>,
        )}
        {pane(
          "ai",
          <>
            <AiSettings accounts={accounts} />
            {isDesktop() && <AiClientsSettings accounts={accounts} />}
            <AgentPolicy />
          </>,
        )}
        {/* A narrow panel moves the account under the action instead of cutting off a fourth column. */}
        {pane("log", <AuditLog accounts={accounts} />, "@container/log")}
      </Tabs.Root>
    </Dialog>
  );
}

function Accounts({
  optionalAccountId,
  accounts,
  onAddAccount,
}: {
  optionalAccountId?: string | null;
  accounts: readonly Account[];
  onAddAccount: () => void;
}) {
  const { t, i18n } = useLingui();
  const profiles = AsyncResult.getOrElse(useAtomValue(profilesAtom), () => []);
  const dragged = useRef<string | null>(null);
  const [result, reorder] = useAtom(moveAccountAtom, { mode: "promiseExit" });
  const moving = useRef(false);
  const move = (id: string, profileId: string | null, beforeId: string | null) =>
    void runAccountMove(moving, () =>
      reorder({
        payload: { accountId: id, input: { profileId, beforeId } },
        reactivityKeys: MAIL_KEYS,
      }),
    );
  return (
    <>
      <p className={`px-1 ${settingsHint}`}>
        <Trans>
          Drag accounts to reorder or move between spaces. You can also use the space picker and
          Move up / Move down buttons.
        </Trans>
      </p>
      {[{ id: null, name: t`Ungrouped accounts` }, ...profiles].map((profile) => (
        <section
          key={profile.id ?? "ungrouped"}
          onDragOver={(event) => {
            if (!result.waiting && dragged.current) event.preventDefault();
          }}
          onDrop={(event) => {
            event.preventDefault();
            if (dragged.current) move(dragged.current, profile.id, null);
            dragged.current = null;
          }}
        >
          <h3 className={settingsHeading}>{profile.name}</h3>
          <ul className={`min-h-11 ${settingsGroup}`}>
            {accounts
              .filter((a) => a.profileId === profile.id)
              .map((a) => (
                <AccountRow
                  key={a.id}
                  optionalFocus={optionalAccountId === a.id}
                  account={a}
                  accounts={accounts}
                  move={move}
                  moving={result.waiting}
                  onAddAccount={onAddAccount}
                  onDragStart={(event) => {
                    if (moving.current) {
                      event.preventDefault();
                      return;
                    }
                    dragged.current = a.id;
                    event.dataTransfer.setData("application/x-openmail-account", a.id);
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  onDragEnd={() => {
                    dragged.current = null;
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (dragged.current && dragged.current !== a.id)
                      move(dragged.current, profile.id, a.id);
                    dragged.current = null;
                  }}
                />
              ))}
          </ul>
        </section>
      ))}
      {resultError(i18n, result) && (
        <output role="alert" className="text-a11y-danger">
          {resultError(i18n, result)}
        </output>
      )}
      <div>
        <button type="button" onClick={onAddAccount} className={buttonSecondary}>
          <Trans>Add email account</Trans>
        </button>
      </div>
    </>
  );
}

/** A text action in an account row. Remove reads as a quiet danger link. */
const removeLink =
  "rounded-item text-a11y-danger outline-offset-1 outline-a11y-focus hover:underline focus-visible:outline-2 disabled:opacity-50";

function AccountRow({
  optionalFocus,
  account: a,
  accounts,
  move,
  onAddAccount,
  moving,
  ...dragProps
}: {
  optionalFocus: boolean;
  account: Account;
  moving: boolean;
  accounts: readonly Account[];
  onAddAccount: () => void;
  move: (id: string, profileId: string | null, beforeId: string | null) => void;
  onDragStart: React.DragEventHandler<HTMLLIElement>;
  onDragEnd: React.DragEventHandler<HTMLLIElement>;
  onDrop: React.DragEventHandler<HTMLLIElement>;
}) {
  const { t, i18n } = useLingui();
  const [confirming, setConfirming] = useState(false);
  const [reauth, runReauth] = useAtom(reauthAtom(a.id));
  const [remove, runRemove] = useAtom(removeAccountAtom(a.id));
  const email = a.email;
  const setup = AsyncResult.getOrElse(useAtomValue(clientSetupAtom), () => null);
  const missingClient =
    setup &&
    ((a.provider === "gmail" && setup.googleClient === "none") ||
      (a.provider === "outlook" && setup.microsoftClient === "none"));

  const warning = "text-orange-700 dark:text-orange-400";
  const accountStatus = () => {
    if (a.enabled === false) return { text: t`Disabled`, className: "text-a11y-muted" };
    if (missingClient) return { text: i18n._(OAUTH_CONFIGURATION_ERROR), className: warning };
    if (a.needsReauth) return { text: t`Needs sign-in`, className: "text-a11y-danger" };
    if (isKeychainLocked(a.lastSyncError))
      return { text: t`Keychain is locked`, className: warning };
    if (a.lastSyncError) return { text: t`Last sync failed`, className: warning };
    return { text: t`Syncing normally`, className: "text-a11y-muted" };
  };
  const status = accountStatus();

  return (
    <li {...dragProps} draggable={!moving} className="px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <ProviderIcon provider={a.imap?.preset ?? a.provider} className="size-5 shrink-0" />
        <span className="min-w-0 flex-1 basis-40">
          <span className="block truncate font-medium" title={a.email}>
            {accountName(a)}
          </span>
          <span
            className={`block truncate text-footnote ${status.className}`}
            title={a.needsReauth ? reauthText(i18n, a) : (a.lastSyncError ?? undefined)}
          >
            {reauth.waiting
              ? t`Finish signing in in your browser`
              : (resultError(i18n, reauth) ?? status.text)}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-3">
          <button
            type="button"
            disabled={reauth.waiting}
            // IMAP signs in again by adding the same address with a new password.
            onClick={() => (a.provider === "imap" ? onAddAccount() : runReauth(undefined))}
            className={buttonLink}
          >
            <Trans>Sign in again</Trans>
          </button>
          <button type="button" onClick={() => setConfirming(true)} className={removeLink}>
            <Trans>Remove</Trans>
          </button>
        </span>
      </div>
      {/* Per-account settings sit under the name, past the 20 px icon and its 12 px gap. */}
      <div className="mt-2 ml-8 space-y-2.5 text-footnote">
        <AccountControls
          key={`${a.id}:${a.description}:${a.color}:${a.imap?.authservId}`}
          account={a}
          accounts={accounts}
          move={move}
          moving={moving}
        />
        <OptionalServices account={a} focus={optionalFocus} />
        <SyncHealthCheck accountId={a.id} />
      </div>
      <Alert
        open={confirming}
        onOpenChange={setConfirming}
        title={t`Remove ${email}?`}
        description={t`Remove this account and its local mail from openmail. Mail on the server is not affected.`}
      >
        <AlertCancel>
          <Trans>Cancel</Trans>
        </AlertCancel>
        <button
          type="button"
          disabled={remove.waiting}
          onClick={() => runRemove()}
          className={alertDanger}
        >
          <Trans>Confirm removal</Trans>
        </button>
      </Alert>
    </li>
  );
}

const MODES: { id: AgentWriteMode; label: MessageDescriptor; detail: MessageDescriptor }[] = [
  {
    id: "off",
    label: msg`Read only`,
    detail: msg`AI can read and search mail, but can't change anything.`,
  },
  {
    id: "propose",
    label: msg`Ask me first`,
    detail: msg`When AI wants to archive, label, or mark as read, it goes into AI suggestions first and runs only after you approve.`,
  },
  {
    id: "allow",
    label: msg`Organize directly`,
    detail: msg`Rules can archive, label, and mark as read directly. MCP always proposes changes for you to approve in the app.`,
  },
];

/** Language names stay in their own language so users can find them. */
const LANGUAGES: { id: Language; label: string | MessageDescriptor }[] = [
  { id: "system", label: msg`Follow system` },
  { id: "zh-CN", label: "中文" },
  { id: "en", label: "English" },
  { id: "cs", label: "Čeština" },
  { id: "nl", label: "Nederlands" },
  { id: "fr", label: "Français" },
  { id: "de", label: "Deutsch" },
  { id: "it", label: "Italiano" },
  { id: "ja", label: "日本語" },
  { id: "ru", label: "Русский" },
  { id: "es", label: "Español" },
];

function General() {
  const { t, i18n } = useLingui();
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => null);
  const setPrefs = useAtomSet(setPrefsAtom);
  return (
    <SettingsGroup>
      <SettingsRow label={<Trans>Language</Trans>}>
        <Select
          aria-label={t`Language`}
          variant="field"
          className="min-w-40"
          value={prefs?.language ?? "system"}
          options={LANGUAGES.map((l) => ({
            value: l.id,
            label: typeof l.label === "string" ? l.label : i18n._(l.label),
          }))}
          onValueChange={(language) =>
            setPrefs({
              payload: { patch: { language } },
              reactivityKeys: [Keys.prefs],
            })
          }
        />
      </SettingsRow>
      {isDesktop() && <DefaultMailClient />}
    </SettingsGroup>
  );
}

function AgentPolicy() {
  const { t, i18n } = useLingui();
  const readOnly = t`Read only`;
  const mode = AsyncResult.getOrElse(useAtomValue(agentModeAtom), () => null);
  const setMode = useAtomSet(setAgentModeAtom);

  return (
    <section id={WRITE_MODE_ANCHOR} className="scroll-mt-4">
      <h3 className={settingsHeading}>
        <Trans>AI permission to change mail</Trans>
      </h3>
      <p className={`mb-2 px-1 ${settingsHint}`}>
        <Trans>
          Applies to AI apps connected over MCP, such as Claude Code, and to your rules. It decides
          whether they can change your mail.
        </Trans>
      </p>
      <RadioGroup<AgentWriteMode | null>
        aria-label={t`AI permission to change mail`}
        value={mode}
        onValueChange={(next) => {
          if (next)
            setMode({ payload: { mode: next }, reactivityKeys: [Keys.agentMode, Keys.audit] });
        }}
        className="space-y-2"
      >
        {MODES.map((m) => (
          <Radio.Root<AgentWriteMode | null>
            key={m.id}
            value={m.id}
            aria-label={i18n._(m.label)}
            className={choiceRow}
          >
            <span className={`mt-0.5 ${radioDot}`}>
              <Radio.Indicator className="size-1.5 rounded-full bg-white" />
            </span>
            <span>
              <span className="block font-medium">{i18n._(m.label)}</span>
              <span className={`mt-0.5 block ${settingsHint}`}>{i18n._(m.detail)}</span>
            </span>
          </Radio.Root>
        ))}
      </RadioGroup>
      <p className={`mt-2 px-1 ${settingsHint}`}>
        <Trans comment="readOnly is the translated Read only write-mode label above.">
          MCP can propose drafts only when the write mode is not "{readOnly}". You review drafts and
          confirm sending in the app.
        </Trans>
      </p>
    </section>
  );
}

const ACTION_NAMES: Record<string, MessageDescriptor> = {
  read: msg`Mark read/unread`,
  star: msg`Star`,
  important: msg`Important`,
  archive: msg`Archive`,
  inbox: msg`Move to Inbox`,
  trash: msg`Delete`,
  spam: msg`Report spam`,
  label: msg`Label`,
  send: msg`Send`,
  send_failed: msg`Send failed`,
  draft: msg`New draft`,
  discard_draft: msg`Discard draft`,
  proposed: msg`Suggested`,
  approve: msg`Approve suggestion`,
  reject: msg`Reject suggestion`,
  denied: msg`Denied`,
  removeAccount: msg`Remove account`,
};

function actorName(i18n: I18n, actor: string): string {
  if (actor.startsWith("user:"))
    return actor === "user:cli" ? i18n._(msg`You (command line)`) : i18n._(msg`You`);
  const agent = actor.split(":").slice(2).join(":") || i18n._(msg`unknown`);
  return i18n._(msg`AI (${agent})`);
}

/** Log cells line up with the 12 px inset of setting rows. */
const logHead = "px-3 py-1.5";
const logCell = "px-3 py-1.5 align-top";

function AuditLog({ accounts }: { accounts: readonly Account[] }) {
  const { i18n } = useLingui();
  const log = AsyncResult.getOrElse(useAtomValue(auditAtom), () => []);
  const email = (id: string | null) => accounts.find((a) => a.id === id)?.email ?? "";
  if (!log.length)
    return (
      <p className={`px-1 ${settingsHint}`}>
        <Trans>No activity yet.</Trans>
      </p>
    );
  return (
    <div className={`overflow-hidden ${settingsGroup}`}>
      <table className="w-full text-left tabular-nums">
        <thead className="border-b border-separator text-footnote text-a11y-muted">
          <tr>
            <th className={`${logHead} font-medium`}>
              <Trans>Time</Trans>
            </th>
            <th className={`${logHead} font-medium`}>
              <Trans>Who</Trans>
            </th>
            <th className={`${logHead} font-medium`}>
              <Trans>Action</Trans>
            </th>
            <th className={`${logHead} font-medium @max-[480px]/log:hidden`}>
              <Trans>Account</Trans>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-separator">
          {log.map((e, i) => (
            <tr key={i}>
              <td className={`${logCell} whitespace-nowrap text-a11y-muted`}>
                {new Date(e.at).toLocaleString(i18n.locale, {
                  month: "numeric",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </td>
              <td className={`${logCell} whitespace-nowrap`}>{actorName(i18n, e.actor)}</td>
              <td className={logCell}>
                <span className="whitespace-nowrap">
                  {ACTION_NAMES[e.action] ? i18n._(ACTION_NAMES[e.action]!) : e.action}
                </span>
                <span className="hidden break-all text-footnote text-a11y-muted @max-[480px]/log:block">
                  {email(e.accountId)}
                </span>
              </td>
              <td className={`${logCell} text-a11y-muted @max-[480px]/log:hidden`}>
                <span className="block max-w-40 truncate">{email(e.accountId)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
