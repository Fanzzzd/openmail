import { useAtom, useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { DEFAULT_CACHE_WINDOWS } from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import type { Account } from "../../../shared/api";
import { resultError } from "../errors";
import { Keys } from "../state/keys";
import { pauseBackfillAtom, setCacheWindowAtom } from "../state/mutations";
import { backfillStateAtom, cacheWindowsAtom, labelsAtom } from "../state/queries";
import { Select } from "./ui/Select";

/** Local subsection: does not change the Settings layout shared with slice 4. */
export function CacheSettings({ accounts }: { accounts: readonly Account[] }) {
  const { t, i18n } = useLingui();
  const states = AsyncResult.getOrElse(useAtomValue(backfillStateAtom), () => []);
  const windows = AsyncResult.getOrElse(useAtomValue(cacheWindowsAtom), () => []);
  const labels = AsyncResult.getOrElse(useAtomValue(labelsAtom()), () => []);
  const [pauseResult, pause] = useAtom(pauseBackfillAtom);
  const [saveResult, save] = useAtom(setCacheWindowAtom);
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
      <p className="text-neutral-500">
        <Trans>
          Older mail downloads in the background. Headers stay searchable when bodies expire.
          Opening a message downloads its body again.
        </Trans>
      </p>
      {accounts.map((account) => {
        const state = states.find((s) => s.accountId === account.id);
        const fetched = state?.fetched ?? 0;
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
            <div className="flex items-center gap-3">
              <output className="flex-1 text-neutral-500">
                {state?.done ? (
                  <Trans>Older mail is up to date</Trans>
                ) : state?.paused ? (
                  <Trans>Backfill paused</Trans>
                ) : (
                  <Trans>Backfill runs between syncs</Trans>
                )}
                . <Trans>{fetched} messages checked</Trans>
              </output>
              {!state?.done && (
                <button
                  type="button"
                  disabled={pauseResult.waiting}
                  className="rounded px-2 py-1 hover:bg-black/5 dark:hover:bg-white/5"
                  onClick={() =>
                    pause({
                      payload: { accountId: account.id, paused: !state?.paused },
                      reactivityKeys: [Keys.cache],
                    })
                  }
                >
                  {state?.paused ? <Trans>Resume</Trans> : <Trans>Pause</Trans>}
                </button>
              )}
            </div>
            {state?.lastError && <output className="text-orange-500">{state.lastError}</output>}
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
                        reactivityKeys: [Keys.cache, Keys.threads, Keys.thread],
                      })
                    }
                  />
                </div>
              );
            })}
          </div>
        );
      })}
      {(resultError(i18n, saveResult) || resultError(i18n, pauseResult)) && (
        <output className="text-red-500">
          {resultError(i18n, saveResult) || resultError(i18n, pauseResult)}
        </output>
      )}
    </section>
  );
}
