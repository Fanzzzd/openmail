import { OptionalServices } from "./OptionalServices";
import { AiSettings } from "./AiSettings";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { Tabs } from "@base-ui/react/tabs";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";

import type { Account, AgentWriteMode, Language } from "../../../shared/api";
import { resultError, OAUTH_CONFIGURATION_ERROR } from "../errors";
import { Keys, MAIL_KEYS } from "../state/keys";
import {
  reauthAtom,
  removeAccountAtom,
  setAgentModeAtom,
  setPrefsAtom,
  moveAccountAtom,
} from "../state/mutations";
import {
  agentModeAtom,
  auditAtom,
  prefsAtom,
  profilesAtom,
  clientSetupAtom,
} from "../state/queries";
import { runAccountMove } from "../account-settings";
import { AccountControls } from "./AccountControls";
import { accountName } from "../format";
import { InteractionSettings, LabsSettings } from "./InteractionSettings";
import { DefaultMailClient, NotificationsSettings, ShortcutsSettings } from "./SystemSettings";
import { ComposeSettings, Signatures } from "./ComposeSettings";
import { UpdateSettings } from "./UpdateSettings";
import { ProfileSettings } from "./ProfileSettings";
import { SpellcheckSettings } from "./SpellcheckSettings";
import { CacheSettings } from "./CacheSettings";
import { ProviderIcon } from "./ProviderIcon";
import { ReadingSettings } from "./ReadingSettings";
import { Alert, AlertCancel, alertDanger, Dialog } from "./ui/Dialog";
import { Select } from "./ui/Select";

import { OrganizationSettings } from "./OrganizationSettings";
import { ServerSettings } from "./ServerSettings";

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
  | "log";

const TABS: { id: Tab; label: MessageDescriptor }[] = [
  { id: "general", label: msg`General` },
  { id: "labs", label: msg`Labs` },
  { id: "interactions", label: msg`Gestures and toolbar` },
  { id: "accounts", label: msg`Accounts` },
  { id: "profiles", label: msg`Profiles` },
  { id: "cache", label: msg`Local cache` },
  { id: "notifications", label: msg`Notifications` },
  { id: "shortcuts", label: msg`Shortcuts` },
  { id: "signatures", label: msg`Signatures` },
  { id: "reading", label: msg`Reading` },
  { id: "compose", label: msg`Compose` },
  { id: "organize", label: msg`Organize` },
  { id: "server", label: msg`Server` },
  { id: "ai", label: msg`AI Access` },
  { id: "log", label: msg`Activity` },
];

const panel = "min-h-0 flex-1 overflow-y-auto p-5 outline-none";

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
  const [tab, setTab] = useState<Tab>(initialTab);

  return (
    <Dialog
      aria-label={t`Settings`}
      onClose={onClose}
      className="flex h-[560px] max-h-[90vh] w-[880px] max-w-[95vw] flex-col overflow-hidden"
    >
      <h2 className="border-b border-black/[0.07] px-5 py-3 text-[15px] font-semibold dark:border-white/[0.08]">
        <Trans>Settings</Trans>
      </h2>
      <Tabs.Root
        orientation="vertical"
        value={tab}
        onValueChange={(value) => {
          const next = TABS.find((item) => item.id === value);
          if (next) setTab(next.id);
        }}
        className="flex min-h-0 flex-1"
      >
        <Tabs.List className="flex w-40 shrink-0 flex-col overflow-y-auto gap-1 border-r border-black/[0.07] p-3 dark:border-white/[0.08]">
          {TABS.map((item) => (
            <Tabs.Tab
              key={item.id}
              value={item.id}
              className="min-h-8 shrink-0 rounded-md px-3 text-left font-medium text-a11y-muted outline-none hover:bg-black/[0.04] focus-visible:ring-2 focus-visible:ring-a11y-focus data-active:bg-black/[0.07] data-active:text-inherit dark:hover:bg-white/5 dark:data-active:bg-white/10"
            >
              {i18n._(item.label)}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        <Tabs.Panel value="accounts" className={panel}>
          <Accounts
            optionalAccountId={optionalAccountId}
            accounts={accounts}
            onAddAccount={onAddAccount}
          />
        </Tabs.Panel>
        <Tabs.Panel value="organize" className={panel}>
          <OrganizationSettings accounts={accounts} />
        </Tabs.Panel>
        <Tabs.Panel value="server" className={panel}>
          <ServerSettings accounts={accounts} />
        </Tabs.Panel>
        <Tabs.Panel value="profiles" className={panel}>
          <ProfileSettings accounts={accounts} />
        </Tabs.Panel>
        <Tabs.Panel value="cache" className={panel}>
          <CacheSettings accounts={accounts} />
        </Tabs.Panel>
        <Tabs.Panel value="notifications" className={panel}>
          <NotificationsSettings accounts={accounts} />
        </Tabs.Panel>
        <Tabs.Panel value="shortcuts" className={panel}>
          <ShortcutsSettings />
        </Tabs.Panel>
        <Tabs.Panel value="signatures" className={panel}>
          <Signatures accounts={accounts} />
        </Tabs.Panel>
        <Tabs.Panel value="general" className={panel}>
          <General />

          <UpdateSettings />
        </Tabs.Panel>
        <Tabs.Panel value="labs" className={panel}>
          <LabsSettings />
        </Tabs.Panel>
        <Tabs.Panel value="interactions" className={panel}>
          <InteractionSettings />
        </Tabs.Panel>
        <Tabs.Panel value="reading" className={panel}>
          <ReadingSettings />
        </Tabs.Panel>
        <Tabs.Panel value="compose" className={panel}>
          <ComposeSettings />
          <SpellcheckSettings />
        </Tabs.Panel>
        <Tabs.Panel value="ai" className={panel}>
          <AiSettings accounts={accounts} />
          <AgentPolicy />
        </Tabs.Panel>
        <Tabs.Panel value="log" className={panel}>
          <AuditLog accounts={accounts} />
        </Tabs.Panel>
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
    <div className="space-y-4">
      <p className="text-a11y-muted">
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
          className="min-h-16 rounded-lg border border-black/10 p-2 dark:border-white/10"
        >
          <h3 className="px-3 py-2 font-semibold">{profile.name}</h3>
          <ul className="divide-y divide-black/[0.07] dark:divide-white/[0.08]">
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
      <button
        type="button"
        onClick={onAddAccount}
        className="h-7 rounded-md border border-black/10 px-3 font-medium dark:border-white/15"
      >
        <Trans>Add email account</Trans>
      </button>
    </div>
  );
}

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
    ((a.provider === "gmail" && !setup.googleConfigured) ||
      (a.provider === "outlook" && !setup.microsoftConfigured));

  const status =
    a.enabled === false
      ? { text: t`Disabled`, className: "text-a11y-muted" }
      : missingClient
        ? {
            text: i18n._(OAUTH_CONFIGURATION_ERROR),
            className: "text-orange-700 dark:text-orange-400",
          }
        : a.needsReauth
          ? { text: t`Needs sign-in`, className: "text-a11y-danger" }
          : a.lastSyncError
            ? { text: t`Last sync failed`, className: "text-orange-700 dark:text-orange-400" }
            : { text: t`Syncing normally`, className: "text-a11y-muted" };

  return (
    <li
      {...dragProps}
      draggable={!moving}
      className="flex flex-wrap items-center gap-3 px-3 py-2.5"
    >
      <ProviderIcon provider={a.imap?.preset ?? a.provider} className="size-5 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium" title={a.email}>
          {accountName(a)}
        </span>
        <span
          className={`block truncate text-[12px] ${status.className}`}
          title={a.lastSyncError ?? undefined}
        >
          {reauth.waiting
            ? t`Finish signing in in your browser`
            : (resultError(i18n, reauth) ?? status.text)}
        </span>
      </span>
      <button
        type="button"
        disabled={reauth.waiting}
        // IMAP signs in again by adding the same address with a new password.
        onClick={() => (a.provider === "imap" ? onAddAccount() : runReauth(undefined))}
        className="h-7 shrink-0 rounded-md px-2.5 text-a11y-accent hover:bg-blue-500/10 disabled:opacity-50 dark:text-blue-400"
      >
        <Trans>Sign in again</Trans>
      </button>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="h-7 shrink-0 rounded-md px-2.5 text-a11y-danger hover:bg-red-500/10 dark:text-red-400"
      >
        <Trans>Remove</Trans>
      </button>
      <AccountControls
        key={`${a.id}:${a.description}:${a.color}:${a.imap?.authservId}`}
        account={a}
        accounts={accounts}
        move={move}
        moving={moving}
      />
      <OptionalServices account={a} focus={optionalFocus} />
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
    <section>
      <h3 className="mb-2 text-[12px] font-semibold text-a11y-muted">
        <Trans>Language</Trans>
      </h3>
      <Select
        aria-label={t`Language`}
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
      <DefaultMailClient />
    </section>
  );
}

function AgentPolicy() {
  const { t, i18n } = useLingui();
  const readOnly = t`Read only`;
  const mode = AsyncResult.getOrElse(useAtomValue(agentModeAtom), () => null);
  const setMode = useAtomSet(setAgentModeAtom);

  return (
    <div>
      <p className="text-a11y-muted">
        <Trans>
          AI connects to openmail over MCP, for example Claude Code. This decides whether it can
          change your mail.
        </Trans>
      </p>
      <RadioGroup<AgentWriteMode | null>
        aria-label={t`AI permission to change mail`}
        value={mode}
        onValueChange={(next) => {
          if (next)
            setMode({ payload: { mode: next }, reactivityKeys: [Keys.agentMode, Keys.audit] });
        }}
        className="mt-4 space-y-2"
      >
        {MODES.map((m) => (
          <Radio.Root<AgentWriteMode | null>
            key={m.id}
            value={m.id}
            aria-label={i18n._(m.label)}
            className="group flex cursor-pointer gap-3 rounded-lg border border-black/10 p-3 outline-offset-1 outline-a11y-focus focus-visible:outline-[3px] data-checked:border-blue-500 data-checked:bg-blue-600/5 dark:border-white/10 dark:data-checked:border-blue-500"
          >
            <span className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full bg-white shadow-[0_0.5px_1px_rgb(0_0_0/0.15)] ring-1 ring-black/20 group-data-checked:bg-blue-600 group-data-checked:ring-blue-600 dark:bg-white/10 dark:ring-white/20 dark:group-data-checked:bg-blue-600 dark:group-data-checked:ring-blue-500">
              <Radio.Indicator className="size-1.5 rounded-full bg-white" />
            </span>
            <span>
              <span className="block font-medium">{i18n._(m.label)}</span>
              <span className="block text-a11y-muted">{i18n._(m.detail)}</span>
            </span>
          </Radio.Root>
        ))}
      </RadioGroup>
      <p className="mt-4 text-a11y-muted">
        <Trans comment="readOnly is the translated Read only write-mode label above.">
          MCP can propose drafts only when the write mode is not "{readOnly}". You review drafts and
          confirm sending in the app.
        </Trans>
      </p>
    </div>
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

function AuditLog({ accounts }: { accounts: readonly Account[] }) {
  const { i18n } = useLingui();
  const log = AsyncResult.getOrElse(useAtomValue(auditAtom), () => []);
  const email = (id: string | null) => accounts.find((a) => a.id === id)?.email ?? "";
  if (!log.length)
    return (
      <p className="text-a11y-muted">
        <Trans>No activity yet.</Trans>
      </p>
    );
  return (
    <table className="w-full text-left">
      <thead className="text-[12px] text-a11y-muted">
        <tr>
          <th className="pb-2 font-medium">
            <Trans>Time</Trans>
          </th>
          <th className="pb-2 font-medium">
            <Trans>Who</Trans>
          </th>
          <th className="pb-2 font-medium">
            <Trans>Action</Trans>
          </th>
          <th className="pb-2 font-medium">
            <Trans>Account</Trans>
          </th>
        </tr>
      </thead>
      <tbody>
        {log.map((e, i) => (
          <tr key={i} className="border-t border-black/[0.06] dark:border-white/[0.06]">
            <td className="py-1.5 pr-3 whitespace-nowrap text-a11y-muted tabular-nums">
              {new Date(e.at).toLocaleString(i18n.locale, {
                month: "numeric",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </td>
            <td className="py-1.5 pr-3 whitespace-nowrap">{actorName(i18n, e.actor)}</td>
            <td className="py-1.5 pr-3">
              {ACTION_NAMES[e.action] ? i18n._(ACTION_NAMES[e.action]!) : e.action}
            </td>
            <td className="max-w-40 truncate py-1.5 text-a11y-muted">{email(e.accountId)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
