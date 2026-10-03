import { AsyncResult } from "effect/reactivity";
import { prefsAtom } from "../state/queries";
import { DEFAULT_PREFS, moveSourceLabel, type ToolbarAction } from "@openmail/core/schema";
import { Autocomplete } from "@base-ui/react/autocomplete";
import { Toggle } from "@base-ui/react/toggle";
import { Toolbar } from "@base-ui/react/toolbar";
import { useLingui } from "@lingui/react/macro";
import {
  Clock,
  FolderInput,
  MoreHorizontal,
  ListFilter,
  AppWindow,
  Archive,
  Bookmark,
  Forward,
  Inbox,
  MailPlus,
  MailOpen,
  Mail,
  Reply,
  ReplyAll,
  ShieldAlert,
  Star,
  Tag,
  Trash2,
} from "lucide-react";
import { useState, type ComponentType, type ReactElement, type ReactNode } from "react";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { createLabelAndApplyAtom } from "../state/mutations";
import { MAIL_KEYS } from "../state/keys";
import { resultError } from "../errors";
import { LabelEditor } from "./OrganizationSettings";

import type { Label, MailOp, Mailbox, Provider } from "../../../shared/api";
import { ContextSubmenu, DropdownMenu, MenuCheckboxItem, MenuItem, MenuSeparator } from "./ui/Menu";
import { PickerPopover, pickerInput, pickerItem, pickerList } from "./ui/Picker";
import { useShortcutText } from "../use-shortcut-text";
import { Tip } from "./ui/Tip";

import { MultiOrganization } from "./MultiOrganization";

type Icon = ComponentType<{ className?: string }>;
type ComposeMode = "reply" | "replyAll" | "forward";

export interface ThreadState {
  provider: Provider;
  isUnread: boolean;
  isStarred: boolean;
  isImportant: boolean;
  labels: string[];
}

interface Props {
  /** The reader collapses actions before there is too little room for search. */
  compact?: boolean;
  currentLabel?: string | undefined;
  onCreate?: ((move: boolean) => void) | undefined;
  pickerMode?: "label" | "move";
  organizationTarget?: { accountId: string; threads: readonly string[]; flat: boolean } | undefined;
  state: ThreadState;
  mailbox: Mailbox;
  /** User labels or folders of the thread's account. */
  labels: readonly Label[];
  onOp: (op: MailOp) => void;
  /** `asAttachment` forwards the original as an .eml file. Unset hides reply and forward. */
  onSendAgain?: (() => void) | undefined;
  onCompose?: ((mode: ComposeMode, asAttachment?: boolean) => void) | undefined;
  /** Opens the thread in a window of its own. Unset hides the button. */
  onOpenWindow?: (() => void) | undefined;
  onSnooze?: (() => void) | undefined;
  onPermanentDelete?: (() => void) | undefined;
  onFilter?: (() => void) | undefined;
  /** The label or folder picker; L or V opens it from the keyboard. */
  labelPicker: boolean;
  onLabelPicker: (open: boolean) => void;
}

/** Archive, or back to the inbox when the thread is already out of it. */
const moveBack = (state: ThreadState, mailbox: Mailbox) => {
  const out =
    mailbox === "snoozed" ||
    mailbox === "trash" ||
    mailbox === "spam" ||
    !state.labels.includes("INBOX");
  return (
    out &&
    (mailbox === "snoozed" ||
      mailbox === "trash" ||
      mailbox === "spam" ||
      state.provider !== "gmail")
  );
};

const button =
  "rounded-md p-1.5 text-a11y-muted outline-offset-0 outline-a11y-focus hover:bg-black/5 hover:text-neutral-800 focus-visible:outline-[3px] data-popup-open:bg-black/5 dark:hover:bg-white/10 dark:hover:text-neutral-100 dark:data-popup-open:bg-white/10";

/**
 * Mimestream-style toolbar above the reader. Arrow keys move between the
 * buttons; tooltips carry the keyboard shortcut.
 */
export function ThreadActions({
  compact = false,
  currentLabel,
  pickerMode = "label",
  organizationTarget,
  state,
  mailbox,
  labels,
  onOp,
  onCompose,
  onSendAgain,
  onOpenWindow,
  onSnooze,
  onPermanentDelete,
  onFilter,
  labelPicker,
  onLabelPicker,
}: Props) {
  const { t } = useLingui();
  const shortcut = useShortcutText();
  const folders = state.provider !== "gmail";
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);

  const [moveOpen, setMoveOpen] = useState(false);
  const [labelOpen, setLabelOpen] = useState(false);
  const removeLabelId = moveSourceLabel(mailbox, currentLabel);
  const moveControl = (
    <LabelPicker
      open={moveOpen || (labelPicker && pickerMode === "move")}
      onOpenChange={(open) => {
        setMoveOpen(open);
        if (!open) onLabelPicker(false);
      }}
      labels={labels.filter((label) => !label.id.startsWith("category:"))}
      current={state.labels}
      folders
      onPick={(label) => {
        setMoveOpen(false);
        onLabelPicker(false);
        onOp({ kind: "move", labelId: label.id, removeLabelId });
      }}
      tip={{ label: t`Move To`, shortcut: shortcut("move") }}
      trigger={
        <Toolbar.Button aria-label={t`Move To`} className={button}>
          <FolderInput className="size-4" />
        </Toolbar.Button>
      }
      target={organizationTarget}
      move
      removeLabelId={removeLabelId}
    />
  );
  const labelControl =
    state.provider === "gmail" ? (
      <LabelPicker
        open={labelOpen || (labelPicker && pickerMode === "label")}
        onOpenChange={(open) => {
          setLabelOpen(open);
          if (!open) onLabelPicker(false);
        }}
        labels={labels}
        target={organizationTarget}
        current={state.labels}
        folders={folders}
        onPick={(label, value) => {
          onLabelPicker(false);
          setLabelOpen(false);
          onOp({ kind: "label", labelId: label.id, value });
        }}
        tip={{
          label: folders ? t`Move to folder` : t`Labels`,
          shortcut: shortcut(folders ? "move" : "label"),
        }}
        trigger={
          <Toolbar.Button aria-label={folders ? t`Move to folder` : t`Labels`} className={button}>
            <Tag className="size-4" />
          </Toolbar.Button>
        }
      />
    ) : (
      <MultiOrganization
        provider={state.provider}
        labels={labels}
        current={state.labels}
        onOp={onOp}
      />
    );
  const controls: Record<ToolbarAction, ReactNode> = {
    archive: (
      <Action
        icon={moveBack(state, mailbox) ? Inbox : Archive}
        label={moveBack(state, mailbox) ? t`Move to Inbox` : t`Archive`}
        shortcut={shortcut(moveBack(state, mailbox) ? "inbox" : "archive")}
        onClick={() => onOp({ kind: moveBack(state, mailbox) ? "inbox" : "archive" })}
      />
    ),
    trash: (
      <Action
        icon={Trash2}
        label={t`Delete`}
        shortcut={shortcut("trash")}
        onClick={() => onOp({ kind: "trash" })}
      />
    ),
    spam: mailbox !== "spam" && (
      <Action
        icon={ShieldAlert}
        label={t`Report spam`}
        shortcut={shortcut("spam")}
        onClick={() => onOp({ kind: "spam" })}
      />
    ),
    snooze: onSnooze && <Action icon={Clock} label={t`Snooze`} onClick={onSnooze} />,
    filter: onFilter && (
      <Action icon={ListFilter} label={t`Create filter from these messages`} onClick={onFilter} />
    ),
    read: (
      <Action
        icon={state.isUnread ? MailOpen : Mail}
        label={state.isUnread ? t`Mark as read` : t`Mark as unread`}
        shortcut={shortcut("read")}
        onClick={() => onOp({ kind: "read", value: state.isUnread })}
      />
    ),
    star: (
      <Switch
        icon={Star}
        pressed={state.isStarred}
        pressedClass="fill-amber-600 text-amber-600 dark:fill-amber-400 dark:text-amber-400"
        label={state.isStarred ? t`Unstar` : t`Star`}
        shortcut={shortcut("star")}
        onPressedChange={(value) => onOp({ kind: "star", value })}
      />
    ),
    important: state.provider !== "imap" && (
      <Switch
        icon={Bookmark}
        pressed={state.isImportant}
        pressedClass="fill-orange-600 text-orange-600 dark:fill-orange-400 dark:text-orange-400"
        label={state.isImportant ? t`Mark as not important` : t`Mark as important`}
        shortcut={shortcut("important")}
        onPressedChange={(value) => onOp({ kind: "important", value })}
      />
    ),
    move: moveControl,
    label: labelControl,
    removeLabel: currentLabel &&
      state.provider === "gmail" &&
      labels.some((l) => l.id === currentLabel) && (
        <Action
          icon={Tag}
          label={t`Remove Current Label`}
          onClick={() => onOp({ kind: "label", labelId: currentLabel, value: false })}
        />
      ),
    sendAgain: onSendAgain && (
      <Action icon={MailPlus} label={t`Send Again`} onClick={onSendAgain} />
    ),
    reply: onCompose && (
      <Action
        icon={Reply}
        label={t`Reply`}
        shortcut={shortcut("reply")}
        onClick={() => onCompose("reply")}
      />
    ),
    replyAll: onCompose && (
      <Action
        icon={ReplyAll}
        label={t`Reply all`}
        shortcut={shortcut("replyAll")}
        onClick={() => onCompose("replyAll")}
      />
    ),
    forward: onCompose && (
      <Action
        icon={Forward}
        label={t`Forward`}
        shortcut={shortcut("forward")}
        onClick={() => onCompose("forward")}
      />
    ),
    forwardAttachment: onCompose && (
      <Action
        icon={MailPlus}
        label={t`Forward as attachment`}
        shortcut={shortcut("forwardAttachment")}
        onClick={() => onCompose("forward", true)}
      />
    ),
    openWindow: onOpenWindow && (
      <Action
        icon={AppWindow}
        label={t`Open in New Window`}
        shortcut={shortcut("openThread")}
        onClick={onOpenWindow}
      />
    ),
  };
  const ordered = [...new Set(prefs.toolbarActions)].filter((action) => controls[action]);
  const visible = compact ? ordered.slice(0, 2) : ordered;
  const picker = pickerMode === "move" ? "move" : "label";
  if (labelPicker && !visible.includes(picker)) visible.push(picker);
  return (
    <Toolbar.Root
      aria-label={t`Conversation actions`}
      className="flex shrink-0 items-center gap-0.5"
    >
      {visible.map((action) => (
        <span key={action} className="contents">
          {controls[action]}
        </span>
      ))}
      <DropdownMenu
        trigger={
          <Toolbar.Button aria-label={t`Conversation actions`} className={button}>
            <MoreHorizontal className="size-4" />
          </Toolbar.Button>
        }
      >
        <ThreadMenuItems
          currentLabel={currentLabel}
          state={state}
          mailbox={mailbox}
          labels={labels}
          onOp={onOp}
          onCompose={onCompose}
          onSendAgain={onSendAgain}
          onOpenWindow={onOpenWindow}
          onSnooze={onSnooze}
          onPermanentDelete={onPermanentDelete}
          onFilter={onFilter}
        />
      </DropdownMenu>
    </Toolbar.Root>
  );
}

/**
 * The same actions as the toolbar, for a message row's context menu. Labels
 * toggle on Gmail; folder providers move the thread.
 */
export function ThreadMenuItems({
  currentLabel,
  onCreate,
  state,
  mailbox,
  labels,
  onOp,
  onCompose,
  onSendAgain,
  onOpenWindow,
  onSnooze,
  onPermanentDelete,
  onFilter,
}: Omit<Props, "labelPicker" | "onLabelPicker" | "compact">) {
  const { t } = useLingui();
  const shortcut = useShortcutText();
  const folders = state.provider !== "gmail";
  return (
    <>
      {onOpenWindow && (
        <>
          <MenuItem icon={AppWindow} shortcut={shortcut("openThread")} onClick={onOpenWindow}>
            {t`Open in New Window`}
          </MenuItem>
          <MenuSeparator />
        </>
      )}
      {onSnooze && <MenuItem icon={Clock} onClick={onSnooze}>{t`Snooze`}</MenuItem>}
      {onFilter && (
        <MenuItem
          icon={ListFilter}
          onClick={onFilter}
        >{t`Create filter from these messages`}</MenuItem>
      )}
      {onSendAgain && <MenuItem icon={MailPlus} onClick={onSendAgain}>{t`Send Again`}</MenuItem>}
      {onCompose && (
        <>
          <MenuItem icon={Reply} shortcut={shortcut("reply")} onClick={() => onCompose("reply")}>
            {t`Reply`}
          </MenuItem>
          <MenuItem
            icon={ReplyAll}
            shortcut={shortcut("replyAll")}
            onClick={() => onCompose("replyAll")}
          >
            {t`Reply all`}
          </MenuItem>
          <MenuItem
            icon={Forward}
            shortcut={shortcut("forward")}
            onClick={() => onCompose("forward")}
          >
            {t`Forward`}
          </MenuItem>
          <MenuItem
            icon={MailPlus}
            shortcut={shortcut("forwardAttachment")}
            onClick={() => onCompose("forward", true)}
          >{t`Forward as attachment`}</MenuItem>
          <MenuSeparator />
        </>
      )}
      {moveBack(state, mailbox) ? (
        <MenuItem icon={Inbox} shortcut={shortcut("inbox")} onClick={() => onOp({ kind: "inbox" })}>
          {t`Move to Inbox`}
        </MenuItem>
      ) : (
        <MenuItem
          icon={Archive}
          shortcut={shortcut("archive")}
          onClick={() => onOp({ kind: "archive" })}
        >
          {t`Archive`}
        </MenuItem>
      )}
      <MenuItem icon={Trash2} shortcut={shortcut("trash")} onClick={() => onOp({ kind: "trash" })}>
        {t`Delete`}
      </MenuItem>
      {onPermanentDelete && (
        <MenuItem icon={Trash2} onClick={onPermanentDelete}>{t`Permanently delete`}</MenuItem>
      )}
      {mailbox !== "spam" && (
        <MenuItem
          icon={ShieldAlert}
          shortcut={shortcut("spam")}
          onClick={() => onOp({ kind: "spam" })}
        >{t`Report spam`}</MenuItem>
      )}
      <MenuSeparator />
      <MenuItem
        icon={state.isUnread ? MailOpen : Mail}
        shortcut={shortcut("read")}
        onClick={() => onOp({ kind: "read", value: state.isUnread })}
      >
        {state.isUnread ? t`Mark as read` : t`Mark as unread`}
      </MenuItem>
      <MenuItem
        icon={Star}
        shortcut={shortcut("star")}
        onClick={() => onOp({ kind: "star", value: !state.isStarred })}
      >
        {state.isStarred ? t`Unstar` : t`Star`}
      </MenuItem>
      {state.provider !== "imap" && (
        <MenuItem
          icon={Bookmark}
          shortcut={shortcut("important")}
          onClick={() => onOp({ kind: "important", value: !state.isImportant })}
        >
          {state.isImportant ? t`Mark as not important` : t`Mark as important`}
        </MenuItem>
      )}
      {currentLabel && state.provider === "gmail" && labels.some((l) => l.id === currentLabel) && (
        <MenuItem
          icon={Tag}
          onClick={() => onOp({ kind: "label", labelId: currentLabel, value: false })}
        >{t`Remove Current Label`}</MenuItem>
      )}
      {(labels.length > 0 || onCreate) && (
        <ContextSubmenu icon={FolderInput} label={t`Move To`}>
          {labels
            .filter((label) => !label.id.startsWith("category:"))
            .map((l) => (
              <MenuItem
                key={l.id}
                onClick={() =>
                  onOp({
                    kind: "move",
                    labelId: l.id,
                    removeLabelId: moveSourceLabel(mailbox, currentLabel),
                  })
                }
              >
                {l.name}
              </MenuItem>
            ))}
          {onCreate && <MenuItem onClick={() => onCreate(true)}>{t`New label or folder`}</MenuItem>}
        </ContextSubmenu>
      )}
      {onCreate && state.provider === "gmail" && (
        <MenuItem onClick={() => onCreate(false)}>{t`New label or folder`}</MenuItem>
      )}
      {state.provider !== "gmail" && (
        <MultiOrganization
          provider={state.provider}
          labels={labels}
          current={state.labels}
          onOp={onOp}
        />
      )}
      {labels.length > 0 && state.provider === "gmail" && (
        <ContextSubmenu icon={Tag} label={folders ? t`Move to folder` : t`Labels`}>
          {labels.map((l) => (
            <MenuCheckboxItem
              key={l.id}
              checked={state.labels.includes(l.id)}
              onCheckedChange={(value) => onOp({ kind: "label", labelId: l.id, value })}
            >
              <LabelDot label={l} />
              <span className="min-w-0 flex-1 truncate">{l.name}</span>
            </MenuCheckboxItem>
          ))}
        </ContextSubmenu>
      )}
    </>
  );
}

function LabelDot({ label }: { label: Label }) {
  return (
    <span
      className="size-2.5 shrink-0 rounded-full bg-neutral-300 ring-1 ring-white/0 group-data-highlighted:ring-white/70 dark:bg-neutral-600"
      style={label.color ? { backgroundColor: label.color } : undefined}
    />
  );
}

/** Type to filter, arrows to move, Return picks. A check marks labels the thread has. */
function LabelPicker({
  open,
  onOpenChange,
  trigger,
  tip,
  labels,
  current,
  folders,
  onPick,
  target,
  move = false,
  removeLabelId = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactElement;
  tip: { label: string; shortcut: string };
  labels: readonly Label[];
  current: string[];
  folders: boolean;
  onPick: (label: Label, value: boolean) => void;
  target?: Props["organizationTarget"];
  move?: boolean;
  removeLabelId?: string | null;
}) {
  const { t, i18n } = useLingui();
  const [creating, setCreating] = useState(false);
  const [result, create] = useAtom(createLabelAndApplyAtom, { mode: "promiseExit" });
  return (
    <>
      {creating && target && (
        <LabelEditor
          label="new"
          labels={labels}
          busy={result.waiting}
          error={resultError(i18n, result)}
          onClose={() => setCreating(false)}
          onSave={async (change) => {
            if (change.kind !== "create") return;
            const exit = await create({
              payload: {
                ...target,
                name: change.name,
                parentId: change.parentId ?? null,
                move: move || folders,
                removeLabelId,
              },
              reactivityKeys: MAIL_KEYS,
            });
            if (exit._tag === "Success") {
              setCreating(false);
              onOpenChange(false);
            }
          }}
        />
      )}
      <PickerPopover
        aria-label={folders ? t`Move to folder` : t`Labels`}
        open={open}
        onOpenChange={onOpenChange}
        trigger={trigger}
        tip={tip}
      >
        <Autocomplete.Root
          inline
          open
          items={labels}
          itemToStringValue={(l: Label) => l.name}
          autoHighlight="always"
          keepHighlight
        >
          <Autocomplete.Input
            aria-label={folders ? t`Move to folder` : t`Labels`}
            placeholder={folders ? t`Move to folder…` : t`Labels…`}
            className={pickerInput}
          />
          <Autocomplete.List className={pickerList}>
            {(l: Label) => {
              const on = current.includes(l.id);
              return (
                <Autocomplete.Item
                  key={l.id}
                  value={l}
                  onClick={() => onPick(l, !on)}
                  className={`h-7 ${pickerItem}`}
                >
                  <LabelDot label={l} />
                  <span className="min-w-0 flex-1 truncate">{l.name}</span>
                  {on && (
                    <span className="text-a11y-accent group-data-highlighted:text-white dark:text-blue-400">
                      ✓
                    </span>
                  )}
                </Autocomplete.Item>
              );
            }}
          </Autocomplete.List>
        </Autocomplete.Root>
        {target && (
          <button
            type="button"
            className="w-full p-2 text-left text-a11y-accent"
            onClick={() => {
              setCreating(true);
              onOpenChange(false);
            }}
          >{t`New label or folder`}</button>
        )}
      </PickerPopover>
    </>
  );
}

function Action({
  icon: Icon,
  label,
  shortcut,
  onClick,
}: {
  icon: Icon;
  label: string;
  shortcut?: string;
  onClick: () => void;
}) {
  return (
    <Tip label={label} shortcut={shortcut}>
      <Toolbar.Button aria-label={label} onClick={onClick} className={button}>
        <Icon className="size-4" />
      </Toolbar.Button>
    </Tip>
  );
}

/** A toolbar button with an on state, like Star. */
function Switch({
  icon: Icon,
  label,
  shortcut,
  pressed,
  pressedClass,
  onPressedChange,
}: {
  icon: Icon;
  label: string;
  shortcut?: string;
  pressed: boolean;
  pressedClass: string;
  onPressedChange: (pressed: boolean) => void;
}) {
  return (
    <Tip label={label} shortcut={shortcut}>
      <Toolbar.Button
        aria-label={label}
        render={<Toggle pressed={pressed} onPressedChange={onPressedChange} />}
        className={button}
      >
        <Icon className={`size-4 ${pressed ? pressedClass : ""}`} />
      </Toolbar.Button>
    </Tip>
  );
}
