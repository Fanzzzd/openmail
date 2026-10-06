import { useEffect } from "react";
import { formatBytes } from "../format";
import { useAtom, useAtomValue, useAtomRefresh } from "@effect/atom-react";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  type CacheCompactionResult,
  DEFAULT_CACHE_WINDOWS,
  DEFAULT_PREFS,
} from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import type { Account } from "../../../shared/api";
import { resultError } from "../errors";
import { Keys } from "../state/keys";
import { MailClient } from "../rpc";
import { pauseBackfillAtom, setCacheWindowAtom, setPrefsAtom } from "../state/mutations";
import { backfillStateAtom, cacheWindowsAtom, labelsAtom, prefsAtom } from "../state/queries";
import { alertButton } from "./ui/Dialog";
import { Select } from "./ui/Select";

const sizesAtom = MailClient.query("CacheSize", undefined, {
  reactivityKeys: [Keys.storage],
});
const databaseSizeAtom = MailClient.query("CacheDatabaseSize", undefined, {
  reactivityKeys: [Keys.storage],
});
const clearAtom = MailClient.mutation("ClearCache");
const compactAtom = MailClient.mutation("CompactCache");
const actionButton = `${alertButton} shrink-0 disabled:opacity-50`;
const MEGABYTE_LIMITS = [128, 512, 1024, 2048].map((mb) => mb * 1024 ** 2);
const GIGABYTE_LIMITS = [1, 2, 5, 10, 20].map((gb) => gb * 1024 ** 3);

function limitOptions(disabled: string, limits: readonly number[], locale: string) {
  return [
    { value: "0", label: disabled },
    ...limits.map((bytes) => ({ value: String(bytes), label: formatBytes(bytes, locale) })),
  ];
}

function CompactionStatus({ status }: { status: CacheCompactionResult | null }) {
  switch (status) {
    case "done":
      return <Trans>Compaction finished.</Trans>;
    case "busy":
      return <Trans>Wait for syncing and queued changes to finish before compacting.</Trans>;
    case "read-only":
      return <Trans>Compaction is unavailable in a read-only session.</Trans>;
    case "unsafe":
      return (
        <Trans>
          Compaction was refused because search index alignment could not be guaranteed.
        </Trans>
      );
    case "low-disk":
      return <Trans>There is not enough free disk space to compact safely.</Trans>;
    case "unavailable":
      return <Trans>Compaction is unavailable on this platform.</Trans>;
    case "failed":
      return <Trans>Compaction failed. The database may be busy or need repair.</Trans>;
    default:
      return null;
  }
}

/** Local subsection: does not change the Settings layout shared with slice 4. */
export function CacheSettings({ accounts }: { accounts: readonly Account[] }) {
  const { t, i18n } = useLingui();
  const refreshSize = useAtomRefresh(databaseSizeAtom);
  const refreshAccounts = useAtomRefresh(sizesAtom);
  useEffect(() => {
    const refresh = () => {
      refreshSize();
      refreshAccounts();
    };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [refreshSize, refreshAccounts]);
  const states = AsyncResult.getOrElse(useAtomValue(backfillStateAtom), () => []);
  const windows = AsyncResult.getOrElse(useAtomValue(cacheWindowsAtom), () => []);
  const labels = AsyncResult.getOrElse(useAtomValue(labelsAtom()), () => []);
  const databaseSize = AsyncResult.getOrElse(useAtomValue(databaseSizeAtom), () => null);
  const sizes = AsyncResult.getOrElse(useAtomValue(sizesAtom), () => []);
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const [clearResult, clear] = useAtom(clearAtom);
  const [compactResult, compact] = useAtom(compactAtom);
  const compactStatus = AsyncResult.getOrElse(compactResult, () => null);
  const [limitResult, setLimit] = useAtom(setPrefsAtom);
  const [pauseResult, pause] = useAtom(pauseBackfillAtom);
  const [saveResult, save] = useAtom(setCacheWindowAtom);
  const storageError =
    resultError(i18n, clearResult) ||
    resultError(i18n, limitResult) ||
    resultError(i18n, compactResult);
  const backfillError = resultError(i18n, saveResult) || resultError(i18n, pauseResult);
  const total = formatBytes(databaseSize?.footprintBytes ?? 0, i18n.locale);
  const options = [
    { value: "inherit", label: t`Use default` },
    { value: "all", label: t`All mail` },
    { value: "365", label: t`1 year` },
    { value: "90", label: t`90 days` },
    { value: "30", label: t`30 days` },
  ];
  const names = new Map([
    ["ALL", t`All Mail`],
    ["INBOX", t`Inbox`],
    ["SPAM", t`Spam`],
    ["TRASH", t`Trash`],
  ]);
  return (
    <section className="mt-6 space-y-3 border-t border-black/10 pt-4 dark:border-white/10">
      <h2 className="font-semibold">
        <Trans>Older mail and cache</Trans>
      </h2>
      <p className="text-a11y-muted">
        <Trans>
          Older mail downloads in the background. Headers stay searchable when bodies expire.
          Opening a message downloads its body again.
        </Trans>
      </p>
      <div className="flex items-center justify-between gap-3">
        <span>
          <Trans
            context="cached message text"
            comment="Storage budget for downloaded email message text."
          >
            Message text cache limit
          </Trans>
        </span>
        <Select
          aria-label={t({
            message: "Message text cache limit",
            context: "cached message text",
            comment: "Storage budget for downloaded email message text.",
          })}
          value={String(prefs.bodyCacheBytes)}
          options={limitOptions(t`Disabled`, MEGABYTE_LIMITS, i18n.locale)}
          disabled={limitResult.waiting}
          onValueChange={(value) =>
            setLimit({
              payload: { patch: { bodyCacheBytes: Number(value) } },
              reactivityKeys: [Keys.storage, Keys.cache, Keys.prefs, Keys.threads, Keys.thread],
            })
          }
        />
      </div>
      <p className="text-xs text-a11y-muted">
        <Trans>
          Retention windows take precedence. Starred messages, retained message texts, drafts and
          outbox messages are kept even when the limit is exceeded. Zero disables the budget.
        </Trans>
      </p>
      <div className="flex items-center justify-between gap-3">
        <span>
          <Trans>Keep openmail under</Trans>
        </span>
        <Select
          aria-label={t`Keep openmail under`}
          value={String(prefs.totalCacheBytes)}
          options={limitOptions(t`Disabled`, GIGABYTE_LIMITS, i18n.locale)}
          disabled={limitResult.waiting}
          onValueChange={(value) =>
            setLimit({
              payload: { patch: { totalCacheBytes: Number(value) } },
              reactivityKeys: [Keys.storage, Keys.cache, Keys.prefs, Keys.threads, Keys.thread],
            })
          }
        />
      </div>
      <p className="text-xs text-a11y-muted">
        <Trans>
          The limit includes the database, attachments, WAL and recovery copies. Protected content
          may exceed it.
        </Trans>
      </p>
      {databaseSize?.lowDisk && databaseSize.canReclaim && (
        <output className="block text-orange-700 dark:text-orange-400">
          <Trans>
            Disk space is low. The cache budget has tightened automatically. Protected content is
            kept.
          </Trans>
        </output>
      )}
      {databaseSize?.lowDisk && !databaseSize.canReclaim && (
        <p className="text-a11y-muted">
          <Trans>Disk space is low. Compact now to enable automatic disk space reclamation.</Trans>
        </p>
      )}
      <div className="flex items-center justify-between gap-3">
        <span>
          <Trans>Attachment cache limit</Trans>
        </span>
        <Select
          aria-label={t`Attachment cache limit`}
          value={String(prefs.attachmentCacheBytes)}
          options={limitOptions(t`Disabled`, MEGABYTE_LIMITS, i18n.locale)}
          disabled={limitResult.waiting}
          onValueChange={(value) =>
            setLimit({
              payload: { patch: { attachmentCacheBytes: Number(value) } },
              reactivityKeys: [Keys.storage, Keys.cache, Keys.prefs],
            })
          }
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <output>
          <Trans>Total cache: {total}</Trans>
        </output>
        <button
          type="button"
          className={actionButton}
          disabled={clearResult.waiting}
          onClick={() =>
            clear({
              payload: {},
              reactivityKeys: [Keys.storage, Keys.cache, Keys.threads, Keys.thread],
            })
          }
        >
          <Trans>Clear all caches</Trans>
        </button>
      </div>
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm">
        <dt>
          <Trans
            context="cached message text"
            comment="Storage occupied by downloaded email message text."
          >
            Message text
          </Trans>
        </dt>
        <dd className="text-right tabular-nums">
          {formatBytes(databaseSize?.bodyBytes ?? 0, i18n.locale)}
        </dd>
        <dt>
          <Trans>Attachments</Trans>
        </dt>
        <dd className="text-right tabular-nums">
          {formatBytes(databaseSize?.attachmentBytes ?? 0, i18n.locale)}
        </dd>
        <dt>
          <Trans>Indexes and other data</Trans>
        </dt>
        <dd className="text-right tabular-nums">
          {formatBytes(databaseSize?.otherBytes ?? 0, i18n.locale)}
        </dd>
        <dt>
          <Trans>Free database pages</Trans>
        </dt>
        <dd className="text-right tabular-nums">
          {formatBytes(databaseSize?.reusableBytes ?? 0, i18n.locale)}
        </dd>
        <dt>
          <Trans>WAL</Trans>
        </dt>
        <dd className="text-right tabular-nums">
          {formatBytes(databaseSize?.walBytes ?? 0, i18n.locale)}
        </dd>
        <dt>
          <Trans>Recovery copies</Trans>
        </dt>
        <dd className="text-right tabular-nums">
          {formatBytes(databaseSize?.recoveryBytes ?? 0, i18n.locale)}
        </dd>
      </dl>
      <button
        type="button"
        className={actionButton}
        disabled={compactResult.waiting}
        onClick={() => compact({ payload: undefined, reactivityKeys: [Keys.storage, Keys.cache] })}
      >
        {compactResult.waiting ? <Trans>Compacting…</Trans> : <Trans>Compact now</Trans>}
      </button>
      <output className="block text-a11y-muted">
        <CompactionStatus status={compactStatus} />
      </output>
      <p className="text-a11y-muted">
        <Trans>
          Clearing removes downloaded bodies and attachments. Headers and drafts stay. Opening
          uncached content requires a connection.
        </Trans>
      </p>
      {accounts.map((account) => {
        const state = states.find((s) => s.accountId === account.id);
        const checked = state?.fetched ?? 0;
        const size = sizes.find((s) => s.accountId === account.id);
        const bodies = formatBytes(size?.bodyBytes ?? 0, i18n.locale);
        const attachments = formatBytes(size?.attachmentBytes ?? 0, i18n.locale);
        const rows = [
          ...DEFAULT_CACHE_WINDOWS.map((w) => ({
            id: w.label,
            name: names.get(w.label) ?? w.label,
          })),
          ...labels
            .filter((l) => l.accountId === account.id)
            .map((l) => ({ id: l.id, name: l.name })),
        ];
        return (
          <div key={account.id} className="space-y-2">
            <h3 className="font-medium">{account.email}</h3>
            <div className="flex items-center justify-between gap-3">
              <output>
                <Trans
                  context="cached message text"
                  comment="Cached texts of email messages, never anatomical bodies, then the size of cached attachments."
                >
                  Bodies: {bodies} · Attachments: {attachments}
                </Trans>
              </output>
              <button
                type="button"
                className={actionButton}
                disabled={clearResult.waiting}
                onClick={() =>
                  clear({
                    payload: { accountId: account.id },
                    reactivityKeys: [Keys.storage, Keys.cache, Keys.threads, Keys.thread],
                  })
                }
              >
                <Trans>Clear account cache</Trans>
              </button>
            </div>
            <div className="flex items-center gap-3">
              <output className="flex-1 text-a11y-muted">
                {state?.done
                  ? t`${plural(checked, {
                      one: "Older mail is up to date. # message checked.",
                      other: "Older mail is up to date. # messages checked.",
                    })}`
                  : state?.paused
                    ? t`${plural(checked, {
                        one: "Backfill paused. # message checked.",
                        other: "Backfill paused. # messages checked.",
                      })}`
                    : t`${plural(checked, {
                        one: "Backfill runs between syncs. # message checked.",
                        other: "Backfill runs between syncs. # messages checked.",
                      })}`}
              </output>
              {!state?.done && (
                <button
                  type="button"
                  disabled={pauseResult.waiting}
                  className={actionButton}
                  onClick={() =>
                    pause({
                      payload: { accountId: account.id, paused: !state?.paused },
                      reactivityKeys: [Keys.storage, Keys.cache],
                    })
                  }
                >
                  {state?.paused ? <Trans>Resume</Trans> : <Trans>Pause</Trans>}
                </button>
              )}
            </div>
            {state?.lastError && (
              <output role="alert" className="text-orange-700 dark:text-orange-400">
                {state.lastError}
              </output>
            )}
            {rows.map((label) => {
              const custom = windows.find(
                (w) => w.accountId === account.id && w.label === label.id,
              );
              const defaultWindow = DEFAULT_CACHE_WINDOWS.find((w) => w.label === label.id);
              const days = custom ? custom.days : defaultWindow?.days;
              const currentValue =
                days === undefined ? "inherit" : days === null ? "all" : String(days);
              return (
                <div key={label.id} className="flex items-center justify-between gap-3">
                  <span className="truncate">{label.name}</span>
                  <Select
                    aria-label={t`Keep bodies in ${label.name}`}
                    value={currentValue}
                    options={options}
                    disabled={saveResult.waiting}
                    onValueChange={(value) =>
                      save({
                        payload: {
                          input: {
                            accountId: account.id,
                            label: label.id,
                            ...(value === "inherit"
                              ? {}
                              : { days: value === "all" ? null : Number(value) }),
                          },
                        },
                        reactivityKeys: [Keys.storage, Keys.cache, Keys.threads, Keys.thread],
                      })
                    }
                  />
                </div>
              );
            })}
          </div>
        );
      })}
      {storageError && (
        <output role="alert" className="text-a11y-danger">
          {storageError}
        </output>
      )}
      {backfillError && (
        <output role="alert" className="text-a11y-danger">
          {backfillError}
        </output>
      )}
    </section>
  );
}
