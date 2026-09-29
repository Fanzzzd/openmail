import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Tabs } from "@base-ui/react/tabs";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";

import type { Account, AgentWriteMode, Language } from "../../../shared/api";
import { resultError } from "../errors";
import { Keys } from "../state/keys";
import { reauthAtom, removeAccountAtom, setAgentModeAtom, setPrefsAtom } from "../state/mutations";
import { agentModeAtom, auditAtom, prefsAtom } from "../state/queries";
import { ComposeSettings } from "./ComposeSettings";
import { ProviderIcon } from "./ProviderIcon";
import { SegmentedControl } from "./SegmentedControl";

type Tab = "accounts" | "general" | "compose" | "ai" | "log";

const TABS: { id: Tab; label: MessageDescriptor }[] = [
  { id: "accounts", label: msg`Accounts` },
  { id: "general", label: msg`General` },
  { id: "compose", label: msg`Compose` },
  { id: "ai", label: msg`AI Access` },
  { id: "log", label: msg`Activity` },
];

const panel = "min-h-0 flex-1 overflow-y-auto p-5 outline-none";

interface Props {
  accounts: readonly Account[];
  initialTab?: Tab;
  onClose: () => void;
  onAddAccount: () => void;
}

export function Settings({ accounts, initialTab = "accounts", onClose, onAddAccount }: Props) {
  const { t, i18n } = useLingui();
  const [tab, setTab] = useState<Tab>(initialTab);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="presentation"
      className="no-drag fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        aria-label={t`Settings`}
        className="flex h-[520px] w-[640px] flex-col overflow-hidden rounded-xl bg-white text-[13px] shadow-2xl dark:bg-neutral-800"
      >
        <Tabs.Root
          value={tab}
          onValueChange={(value) => {
            const next = TABS.find((item) => item.id === value);
            if (next) setTab(next.id);
          }}
          className="flex min-h-0 flex-1 flex-col"
        >
          <Tabs.List className="flex shrink-0 justify-center gap-1 border-b border-black/[0.07] py-2 dark:border-white/[0.08]">
            {TABS.map((item) => (
              <Tabs.Tab
                key={item.id}
                value={item.id}
                className="h-7 rounded-md px-3 font-medium text-neutral-500 outline-none hover:bg-black/[0.04] focus-visible:ring-2 focus-visible:ring-blue-500/60 data-active:bg-black/[0.07] data-active:text-inherit dark:text-neutral-400 dark:hover:bg-white/5 dark:data-active:bg-white/10"
              >
                {i18n._(item.label)}
              </Tabs.Tab>
            ))}
          </Tabs.List>
          <Tabs.Panel value="accounts" className={panel}>
            <Accounts accounts={accounts} onAddAccount={onAddAccount} />
          </Tabs.Panel>
          <Tabs.Panel value="general" className={panel}>
            <General />
          </Tabs.Panel>
          <Tabs.Panel value="compose" className={panel}>
            <ComposeSettings accounts={accounts} />
          </Tabs.Panel>
          <Tabs.Panel value="ai" className={panel}>
            <AgentPolicy />
          </Tabs.Panel>
          <Tabs.Panel value="log" className={panel}>
            <AuditLog accounts={accounts} />
          </Tabs.Panel>
        </Tabs.Root>
      </section>
    </div>
  );
}

function Accounts({
  accounts,
  onAddAccount,
}: {
  accounts: readonly Account[];
  onAddAccount: () => void;
}) {
  return (
    <div>
      <ul className="divide-y divide-black/[0.07] rounded-lg border border-black/10 dark:divide-white/[0.08] dark:border-white/10">
        {accounts.map((a) => (
          <AccountRow key={a.id} account={a} onAddAccount={onAddAccount} />
        ))}
      </ul>
      <button
        type="button"
        onClick={onAddAccount}
        className="mt-3 h-7 rounded-md border border-black/10 px-3 font-medium hover:bg-black/[0.04] dark:border-white/15 dark:hover:bg-white/5"
      >
        <Trans>Add email account</Trans>
      </button>
    </div>
  );
}

function AccountRow({ account: a, onAddAccount }: { account: Account; onAddAccount: () => void }) {
  const { t, i18n } = useLingui();
  const [confirming, setConfirming] = useState(false);
  const [reauth, runReauth] = useAtom(reauthAtom(a.id));
  const [remove, runRemove] = useAtom(removeAccountAtom(a.id));

  const status = a.needsReauth
    ? { text: t`Needs sign-in`, className: "text-red-500" }
    : a.lastSyncError
      ? { text: t`Last sync failed`, className: "text-orange-500" }
      : { text: t`Syncing normally`, className: "text-neutral-400" };

  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <ProviderIcon provider={a.imap?.preset ?? a.provider} className="size-5 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{a.email}</span>
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
        onClick={() => (a.provider === "imap" ? onAddAccount() : runReauth())}
        className="h-7 shrink-0 rounded-md px-2.5 text-blue-600 hover:bg-blue-500/10 disabled:opacity-50 dark:text-blue-400"
      >
        <Trans>Sign in again</Trans>
      </button>
      {confirming ? (
        <button
          type="button"
          disabled={remove.waiting}
          onClick={() => runRemove()}
          onBlur={() => setConfirming(false)}
          className="h-7 shrink-0 rounded-md bg-red-600 px-2.5 font-medium text-white hover:bg-red-700"
        >
          <Trans>Confirm removal</Trans>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          title={t`Remove this account and its local mail from openmail. Mail on the server is not affected.`}
          className="h-7 shrink-0 rounded-md px-2.5 text-red-600 hover:bg-red-500/10 dark:text-red-400"
        >
          <Trans>Remove</Trans>
        </button>
      )}
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
    detail: msg`AI can archive, label, and mark as read directly. Every change is recorded in Activity and can be undone.`,
  },
];

/** "中文" and "English" are shown in their own language, whatever the UI language is. */
const LANGUAGES: { id: Language; label: string | MessageDescriptor }[] = [
  { id: "system", label: msg`Follow system` },
  { id: "zh-CN", label: "中文" },
  { id: "en", label: "English" },
];

function General() {
  const { t, i18n } = useLingui();
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => null);
  const setPrefs = useAtomSet(setPrefsAtom);
  return (
    <section>
      <h3 className="mb-2 text-[12px] font-semibold text-neutral-500 dark:text-neutral-400">
        <Trans>Language</Trans>
      </h3>
      <SegmentedControl
        aria-label={t`Language`}
        value={prefs?.language ?? null}
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
    </section>
  );
}

function AgentPolicy() {
  const { i18n } = useLingui();
  const mode = AsyncResult.getOrElse(useAtomValue(agentModeAtom), () => null);
  const setMode = useAtomSet(setAgentModeAtom);

  return (
    <div>
      <p className="text-neutral-500 dark:text-neutral-400">
        <Trans>
          AI connects to openmail over MCP, for example Claude Code. This decides whether it can
          change your mail.
        </Trans>
      </p>
      <fieldset className="mt-4 space-y-2">
        <legend className="sr-only">
          <Trans>AI permission to change mail</Trans>
        </legend>
        {MODES.map((m) => (
          <label
            key={m.id}
            aria-label={i18n._(m.label)}
            className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${
              mode === m.id
                ? "border-blue-500 bg-blue-500/5"
                : "border-black/10 dark:border-white/10"
            }`}
          >
            <input
              type="radio"
              name="agent-mode"
              checked={mode === m.id}
              onChange={() =>
                setMode({ payload: { mode: m.id }, reactivityKeys: [Keys.agentMode, Keys.audit] })
              }
              className="mt-0.5 accent-blue-600"
            />
            <span>
              <span className="block font-medium">{i18n._(m.label)}</span>
              <span className="block text-neutral-500 dark:text-neutral-400">
                {i18n._(m.detail)}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <p className="mt-4 text-neutral-500 dark:text-neutral-400">
        <Trans>
          Sending is not affected by this setting. Every message AI writes goes into AI suggestions,
          and you review and send it from the compose window.
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
      <p className="text-neutral-400">
        <Trans>No activity yet.</Trans>
      </p>
    );
  return (
    <table className="w-full text-left">
      <thead className="text-[12px] text-neutral-400">
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
            <td className="py-1.5 pr-3 whitespace-nowrap text-neutral-500 tabular-nums">
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
            <td className="max-w-40 truncate py-1.5 text-neutral-500">{email(e.accountId)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
