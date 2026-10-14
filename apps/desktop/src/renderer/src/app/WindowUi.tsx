import { Menu } from "@base-ui/react/menu";
import { useLingui } from "@lingui/react/macro";
import { Effect, Fiber, Stream } from "effect";
import { constVoid } from "effect/Function";
import { Clipboard, Copy, Scissors, Sparkles, SpellCheck, TextSelect } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import type {
  PromptAnswer,
  TextMenu,
  TextMenuCommand,
  UpdateCheckResult,
  WindowUiEvent,
} from "../../../shared/window-ui";
import { useRunMail, withMail } from "../state/mail";
import { confirmDialog } from "../ui/Confirm";
import { Alert } from "../ui/Dialog";
import { MenuCheckboxItem, MenuItem, MenuSeparator } from "../ui/Menu";
import { buttonPrimary, popupMotion, popupSurface } from "../ui/styles";
import { AlertDialog } from "@base-ui/react/alert-dialog";

type Saved =
  | { kind: "field"; el: HTMLInputElement | HTMLTextAreaElement; start: number; end: number }
  | { kind: "range"; el: HTMLElement | null; range: Range | null };

/** The right-clicked field and its selection, so a command acts where the person clicked. */
export function saveTextSelection(): Saved {
  const el = document.activeElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
    return { kind: "field", el, start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 };
  const selection = window.getSelection();
  return {
    kind: "range",
    el: el instanceof HTMLElement ? el : null,
    range: selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null,
  };
}

export function restoreTextSelection(saved: Saved) {
  saved.el?.focus({ preventScroll: true });
  if (saved.kind === "field") {
    saved.el.setSelectionRange(saved.start, saved.end);
    return;
  }
  const selection = window.getSelection();
  if (!saved.range || !selection) return;
  selection.removeAllRanges();
  selection.addRange(saved.range);
}

const MOD = /Mac/i.test(navigator.platform) ? "⌘" : "Ctrl+";

/**
 * The context menu of an editable field: spelling suggestions, the clipboard
 * and, in the macOS compose body, the system Writing Tools. Main sends the
 * spelling data; commands go back over RPC and act on the restored selection.
 */
export function TextContextMenu({
  menu,
  onCommand,
  onClosed,
}: {
  menu: TextMenu;
  onCommand: (command: TextMenuCommand) => void;
  onClosed: () => void;
}) {
  const { t } = useLingui();
  const saved = useRef<Saved | null>(null);
  saved.current ??= saveTextSelection();
  const chosen = useRef<TextMenuCommand | null>(null);
  const choose = (command: TextMenuCommand) => () => {
    chosen.current = command;
  };
  const anchor = {
    getBoundingClientRect: () => DOMRect.fromRect({ x: menu.x, y: menu.y, width: 0, height: 0 }),
  };
  return (
    <Menu.Root
      open
      onOpenChange={(open) => {
        if (open) return;
        if (saved.current) restoreTextSelection(saved.current);
        if (chosen.current) onCommand(chosen.current);
        onClosed();
      }}
    >
      <Menu.Portal>
        <Menu.Positioner
          anchor={anchor}
          side="bottom"
          align="start"
          sideOffset={2}
          className="z-[70] outline-none"
          render={<section aria-label={t`Text actions`} />}
        >
          <Menu.Popup
            finalFocus={false}
            className={`min-w-52 overflow-y-auto p-[5px] ${popupSurface} ${popupMotion}`}
          >
            {menu.suggestions.map((word) => (
              <MenuItem key={word} onClick={choose({ kind: "replace", word })}>
                <span className="font-semibold">{word}</span>
              </MenuItem>
            ))}
            {menu.misspelledWord && (
              <>
                {menu.suggestions.length === 0 && (
                  <MenuItem disabled onClick={constVoid}>
                    {t`No suggestions`}
                  </MenuItem>
                )}
                <MenuItem icon={SpellCheck} onClick={choose({ kind: "learn" })}>
                  {t`Add to dictionary`}
                </MenuItem>
                <MenuSeparator />
              </>
            )}
            <MenuItem
              icon={Scissors}
              shortcut={`${MOD}X`}
              disabled={!menu.canCut}
              onClick={choose({ kind: "cut" })}
            >
              {t`Cut`}
            </MenuItem>
            <MenuItem
              icon={Copy}
              shortcut={`${MOD}C`}
              disabled={!menu.canCopy}
              onClick={choose({ kind: "copy" })}
            >
              {t`Copy`}
            </MenuItem>
            <MenuItem
              icon={Clipboard}
              shortcut={`${MOD}V`}
              disabled={!menu.canPaste}
              onClick={choose({ kind: "paste" })}
            >
              {t`Paste`}
            </MenuItem>
            <MenuItem
              icon={TextSelect}
              shortcut={`${MOD}A`}
              onClick={choose({ kind: "selectAll" })}
            >
              {t`Select all`}
            </MenuItem>
            <MenuSeparator />
            <MenuCheckboxItem
              checked={menu.spellcheck}
              onCheckedChange={() => {
                chosen.current = { kind: "toggleSpellcheck" };
              }}
            >
              {t`Check spelling while typing`}
            </MenuCheckboxItem>
            {menu.writingTools && (
              <>
                <MenuSeparator />
                <MenuItem icon={Sparkles} onClick={choose({ kind: "writingTools" })}>
                  {t`Writing Tools and Services…`}
                </MenuItem>
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function UpdateResultAlert({
  result,
  onShown,
  onClose,
}: {
  result: UpdateCheckResult;
  onShown: () => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const shown = useEffectEvent(onShown);
  useEffect(() => {
    // After the commit that mounts the alert, the next frame has painted it.
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => shown()));
    return () => cancelAnimationFrame(frame);
  }, []);
  const version = result.version ?? "";
  const title =
    result.status === "disabled"
      ? t`Update checks require a signed, installed macOS app.`
      : result.status === "upToDate"
        ? t`OpenMail is up to date.`
        : result.status === "available"
          ? t`Update ${version} is available.`
          : t`Could not check for updates. Try again later.`;
  return (
    <Alert
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={title}
    >
      <AlertDialog.Close className={buttonPrimary}>{t`OK`}</AlertDialog.Close>
    </Alert>
  );
}

/**
 * Draws what the main process asks of this window: text menus, the quit
 * confirmation and update check results. Mount once per window.
 */
export function WindowUi() {
  const { t } = useLingui();
  const run = useRunMail();
  const [menu, setMenu] = useState<{ key: number; menu: TextMenu } | null>(null);
  const [update, setUpdate] = useState<{ id: string; result: UpdateCheckResult } | null>(null);
  /** Quit prompts the main process may withdraw when its native fallback takes over. */
  const prompts = useRef(new Map<string, AbortController>());
  const updateId = useRef<string | null>(null);
  const answer = (id: string, value: PromptAnswer) => {
    run(withMail((call) => call("AnswerPrompt", { id, answer: value })));
  };
  const receive = useEffectEvent((event: WindowUiEvent) => {
    switch (event._tag) {
      case "TextMenu":
        setMenu({ key: Date.now(), menu: event.menu });
        return;
      case "UpdateResult":
        // A newer result replaces one still on screen.
        if (updateId.current) answer(updateId.current, "accept");
        updateId.current = event.id;
        setUpdate({ id: event.id, result: event.result });
        return;
      case "PromptDone":
        prompts.current.get(event.id)?.abort();
        if (updateId.current === event.id) {
          updateId.current = null;
          setUpdate(null);
        }
        return;
      case "QuitPrompt": {
        const controller = new AbortController();
        prompts.current.set(event.id, controller);
        void (async () => {
          const confirmed = await confirmDialog({
            title: t`Quit with messages waiting to send?`,
            description: t`Messages in the undo window will remain drafts. A send already in progress may finish.`,
            confirmLabel: t`Quit`,
            destructive: true,
            signal: controller.signal,
            onShown: () => answer(event.id, "shown"),
          });
          prompts.current.delete(event.id);
          if (!controller.signal.aborted) answer(event.id, confirmed ? "accept" : "cancel");
        })();
        return;
      }
    }
  });
  useEffect(() => {
    const fiber = run(
      withMail((call) =>
        call("WindowUiEvents", undefined).pipe(
          Stream.runForEach((event) => Effect.sync(() => receive(event))),
        ),
      ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [run]);
  return (
    <>
      {menu && (
        <TextContextMenu
          key={menu.key}
          menu={menu.menu}
          onCommand={(command) => run(withMail((call) => call("TextMenuCommand", { command })))}
          onClosed={() => {
            setMenu(null);
            run(withMail((call) => call("TextMenuCommand", { command: { kind: "dismiss" } })));
          }}
        />
      )}
      {update && (
        <UpdateResultAlert
          key={update.id}
          result={update.result}
          onShown={() => answer(update.id, "shown")}
          onClose={() => {
            answer(update.id, "accept");
            updateId.current = null;
            setUpdate(null);
          }}
        />
      )}
    </>
  );
}
