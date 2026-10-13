import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useLingui } from "@lingui/react/macro";
import { DEFAULT_PREFS, READER_ZOOMS, type ReaderZoom } from "@openmail/core/schema";
import { Effect } from "effect";
import { AsyncResult } from "effect/reactivity";
import { ChevronsDownUp, ChevronsUpDown, FileDown, Minus, Plus, Printer, Type } from "lucide-react";
import type { Message } from "../../../../shared/api";
import { useShortcutText } from "../../i18n/use-shortcut-text";
import { causeText } from "../../lib/errors";
import { isDesktop } from "../../lib/platform";
import { Keys } from "../../state/keys";
import { useRunMail, withMail } from "../../state/mail";
import { setPrefsAtom } from "../../state/mutations";
import { accountsAtom, prefsAtom } from "../../state/queries";
import { MailClient } from "../../state/rpc";
import { MenuItem, MenuSeparator } from "../../ui/Menu";

/** Shows a one-line notice, the app's toast. */
type Notify = (toast: { text: string; tone?: "error" }) => void;

/**
 * Expand all and Collapse all from outside the thread: the toolbar's menu sends this event with
 * `true` or `false`, and the thread in the same window applies it.
 */
export const THREAD_EXPANSION_EVENT = "openmail:thread-expansion";

const expand = (expanded: boolean) =>
  window.dispatchEvent(new CustomEvent(THREAD_EXPANSION_EVENT, { detail: expanded }));

/** The next text size up (1) or down (-1), or normal size (0). */
export function stepZoom(zoom: ReaderZoom, step: -1 | 0 | 1): ReaderZoom {
  if (step === 0) return 100;
  const i = READER_ZOOMS.indexOf(zoom);
  return READER_ZOOMS[Math.max(0, Math.min(READER_ZOOMS.length - 1, i + step))] ?? zoom;
}

/**
 * The thread's own commands: expansion, links, printing and text size. They sit in the
 * toolbar's Conversation actions menu, so a thread has one "…" for the conversation; the
 * subject row shows them only while the toolbar is hidden.
 */
export function ThreadViewMenuItems({
  messages,
  selectedId,
  single,
  notify,
  print,
}: {
  messages: readonly Message[];
  selectedId: string;
  /** Only the selected message shows (conversation grouping off). */
  single: boolean;
  notify: Notify;
  print: (id: string, pdf: boolean, only?: string) => void;
}) {
  const { t, i18n } = useLingui();
  const run = useRunMail();
  const shortcut = useShortcutText();
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const setPrefs = useAtomSet(setPrefsAtom);
  const accounts = AsyncResult.getOrElse(useAtomValue(accountsAtom), () => []);
  const provider = accounts.find((account) => account.id === messages[0]?.accountId)?.provider;
  const canOpenWeb = provider === "gmail" || provider === "outlook";
  const canShare = AsyncResult.getOrElse(
    useAtomValue(MailClient.query("AttachmentCapabilities", undefined)),
    () => ({ share: false }),
  ).share;
  const zoom = prefs.readerZoom;
  const setZoom = (next: ReaderZoom) => {
    if (next !== zoom)
      setPrefs({ payload: { patch: { readerZoom: next } }, reactivityKeys: [Keys.prefs] });
  };
  const copyLink = (kind: "message" | "thread" | "web", done: string) =>
    run(
      withMail((call) =>
        call("CopyMessageLink", { id: selectedId, ...(kind === "message" ? {} : { kind }) }),
      ).pipe(
        Effect.matchCause({
          onSuccess: () => notify({ text: done }),
          onFailure: (cause) => notify({ text: causeText(i18n, cause), tone: "error" }),
        }),
      ),
    );
  const shareLink = (kind: "message" | "thread" | "web") =>
    run(
      withMail((call) => call("ShareMessageLink", { id: selectedId, kind })).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => notify({ text: causeText(i18n, cause), tone: "error" })),
        ),
      ),
    );
  const printOnly = single ? selectedId : undefined;
  const several = !single && messages.length > 1;
  return (
    <>
      {several && (
        <>
          <MenuItem
            icon={ChevronsUpDown}
            shortcut={shortcut("expandAll")}
            onClick={() => expand(true)}
          >
            {t`Expand all`}
          </MenuItem>
          <MenuItem
            icon={ChevronsDownUp}
            shortcut={shortcut("collapseAll")}
            onClick={() => expand(false)}
          >
            {t`Collapse all`}
          </MenuItem>
          <MenuSeparator />
        </>
      )}
      {isDesktop() && (
        <>
          {canOpenWeb && (
            <MenuItem onClick={() => copyLink("web", t`Webmail link copied`)}>
              {t`Copy webmail link`}
            </MenuItem>
          )}
          <MenuItem onClick={() => copyLink("message", t`Message link copied`)}>
            {t`Copy link to message`}
          </MenuItem>
          <MenuItem onClick={() => copyLink("thread", t`Thread link copied`)}>
            {t`Copy link to thread`}
          </MenuItem>
        </>
      )}
      {canShare && (
        <>
          <MenuItem onClick={() => shareLink("message")}>{t`Send message link to…`}</MenuItem>
          <MenuItem onClick={() => shareLink("thread")}>{t`Send thread link to…`}</MenuItem>
          {canOpenWeb && (
            <MenuItem onClick={() => shareLink("web")}>{t`Send web mail link to…`}</MenuItem>
          )}
        </>
      )}
      {isDesktop() && (
        <>
          <MenuItem
            icon={Printer}
            shortcut={shortcut("print")}
            onClick={() => print(selectedId, false, printOnly)}
          >
            {t`Print…`}
          </MenuItem>
          <MenuItem icon={FileDown} onClick={() => print(selectedId, true, printOnly)}>
            {t`Save as PDF…`}
          </MenuItem>
        </>
      )}
      <MenuSeparator />
      <MenuItem
        icon={Plus}
        shortcut={shortcut("zoomIn")}
        onClick={() => setZoom(stepZoom(zoom, 1))}
      >
        {t`Bigger text`}
      </MenuItem>
      <MenuItem
        icon={Minus}
        shortcut={shortcut("zoomOut")}
        onClick={() => setZoom(stepZoom(zoom, -1))}
      >
        {t`Smaller text`}
      </MenuItem>
      <MenuItem
        icon={Type}
        shortcut={shortcut("zoomReset")}
        onClick={() => setZoom(100)}
        disabled={zoom === 100}
      >
        {t`Actual size`}
      </MenuItem>
    </>
  );
}
