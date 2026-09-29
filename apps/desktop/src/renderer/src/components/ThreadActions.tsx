import { Autocomplete } from "@base-ui/react/autocomplete";
import { Toggle } from "@base-ui/react/toggle";
import { Toolbar } from "@base-ui/react/toolbar";
import { useLingui } from "@lingui/react/macro";
import {
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
import type { ComponentType, ReactElement } from "react";

import type { Label, MailOp, Mailbox, Provider } from "../../../shared/api";
import { ContextSubmenu, MenuCheckboxItem, MenuItem, MenuSeparator } from "./ui/Menu";
import { PickerPopover, pickerInput, pickerItem, pickerList } from "./ui/Picker";
import { Tip } from "./ui/Tip";

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
  state: ThreadState;
  mailbox: Mailbox;
  /** User labels or folders of the thread's account. */
  labels: readonly Label[];
  onOp: (op: MailOp) => void;
  /** `asAttachment` forwards the original as an .eml file. */
  onCompose: (mode: ComposeMode, asAttachment?: boolean) => void;
  /** The label or folder picker; L or V opens it from the keyboard. */
  labelPicker: boolean;
  onLabelPicker: (open: boolean) => void;
}

/** Archive, or back to the inbox when the thread is already out of it. */
const moveBack = (state: ThreadState, mailbox: Mailbox) => {
  const out = mailbox === "trash" || mailbox === "spam" || !state.labels.includes("INBOX");
  return out && (mailbox === "trash" || mailbox === "spam" || state.provider !== "gmail");
};

const button =
  "rounded-md p-1.5 text-neutral-500 outline-offset-0 outline-blue-500/60 hover:bg-black/5 hover:text-neutral-800 focus-visible:outline-[3px] data-popup-open:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-neutral-100 dark:data-popup-open:bg-white/10";

/**
 * Mimestream-style toolbar above the reader. Arrow keys move between the
 * buttons; tooltips carry the keyboard shortcut.
 */
export function ThreadActions({
  state,
  mailbox,
  labels,
  onOp,
  onCompose,
  labelPicker,
  onLabelPicker,
}: Props) {
  const { t } = useLingui();
  const folders = state.provider !== "gmail";

  return (
    <Toolbar.Root aria-label={t`Conversation actions`} className="flex items-center gap-0.5">
      {moveBack(state, mailbox) ? (
        <Action
          icon={Inbox}
          label={t`Move to Inbox`}
          shortcut="⇧⌘I"
          onClick={() => onOp({ kind: "inbox" })}
        />
      ) : (
        <Action
          icon={Archive}
          label={t`Archive`}
          shortcut="E"
          onClick={() => onOp({ kind: "archive" })}
        />
      )}
      <Action
        icon={Trash2}
        label={t`Delete`}
        shortcut="#"
        onClick={() => onOp({ kind: "trash" })}
      />
      {mailbox !== "spam" && (
        <Action
          icon={ShieldAlert}
          label={t`Report spam`}
          shortcut="!"
          onClick={() => onOp({ kind: "spam" })}
        />
      )}
      <Divider />
      <Action
        icon={state.isUnread ? MailOpen : Mail}
        label={state.isUnread ? t`Mark as read` : t`Mark as unread`}
        shortcut="U"
        onClick={() => onOp({ kind: "read", value: state.isUnread })}
      />
      <Switch
        icon={Star}
        pressed={state.isStarred}
        pressedClass="fill-amber-400 text-amber-400"
        label={state.isStarred ? t`Unstar` : t`Star`}
        shortcut="S"
        onPressedChange={(value) => onOp({ kind: "star", value })}
      />
      {state.provider === "gmail" && (
        <Switch
          icon={Bookmark}
          pressed={state.isImportant}
          pressedClass="fill-orange-400 text-orange-400"
          label={state.isImportant ? t`Mark as not important` : t`Mark as important`}
          shortcut="="
          onPressedChange={(value) => onOp({ kind: "important", value })}
        />
      )}
      {labels.length > 0 && (
        <LabelPicker
          open={labelPicker}
          onOpenChange={onLabelPicker}
          labels={labels}
          current={state.labels}
          folders={folders}
          onPick={(label, value) => {
            onLabelPicker(false);
            onOp({ kind: "label", labelId: label.id, value });
          }}
          tip={{ label: folders ? t`Move to folder` : t`Labels`, shortcut: folders ? "V" : "L" }}
          trigger={
            <Toolbar.Button aria-label={folders ? t`Move to folder` : t`Labels`} className={button}>
              <Tag className="size-4" />
            </Toolbar.Button>
          }
        />
      )}
      <Divider />
      <Action icon={Reply} label={t`Reply`} shortcut="R" onClick={() => onCompose("reply")} />
      <Action
        icon={ReplyAll}
        label={t`Reply all`}
        shortcut="A"
        onClick={() => onCompose("replyAll")}
      />
      <Action icon={Forward} label={t`Forward`} shortcut="F" onClick={() => onCompose("forward")} />
      <Action
        icon={MailPlus}
        label={t`Forward as attachment`}
        shortcut="⇧F"
        onClick={() => onCompose("forward", true)}
      />
    </Toolbar.Root>
  );
}

/**
 * The same actions as the toolbar, for a message row's context menu. Labels
 * toggle on Gmail; folder providers move the thread.
 */
export function ThreadMenuItems({
  state,
  mailbox,
  labels,
  onOp,
  onCompose,
}: Omit<Props, "labelPicker" | "onLabelPicker">) {
  const { t } = useLingui();
  const folders = state.provider !== "gmail";
  return (
    <>
      <MenuItem icon={Reply} shortcut="R" onClick={() => onCompose("reply")}>
        {t`Reply`}
      </MenuItem>
      <MenuItem icon={ReplyAll} shortcut="A" onClick={() => onCompose("replyAll")}>
        {t`Reply all`}
      </MenuItem>
      <MenuItem icon={Forward} shortcut="F" onClick={() => onCompose("forward")}>
        {t`Forward`}
      </MenuItem>
      <MenuSeparator />
      {moveBack(state, mailbox) ? (
        <MenuItem icon={Inbox} shortcut="⇧⌘I" onClick={() => onOp({ kind: "inbox" })}>
          {t`Move to Inbox`}
        </MenuItem>
      ) : (
        <MenuItem icon={Archive} shortcut="E" onClick={() => onOp({ kind: "archive" })}>
          {t`Archive`}
        </MenuItem>
      )}
      <MenuItem icon={Trash2} shortcut="#" onClick={() => onOp({ kind: "trash" })}>
        {t`Delete`}
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        icon={state.isUnread ? MailOpen : Mail}
        shortcut="U"
        onClick={() => onOp({ kind: "read", value: state.isUnread })}
      >
        {state.isUnread ? t`Mark as read` : t`Mark as unread`}
      </MenuItem>
      <MenuItem
        icon={Star}
        shortcut="S"
        onClick={() => onOp({ kind: "star", value: !state.isStarred })}
      >
        {state.isStarred ? t`Unstar` : t`Star`}
      </MenuItem>
      {labels.length > 0 && (
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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactElement;
  tip: { label: string; shortcut: string };
  labels: readonly Label[];
  current: string[];
  folders: boolean;
  onPick: (label: Label, value: boolean) => void;
}) {
  const { t } = useLingui();
  return (
    <PickerPopover open={open} onOpenChange={onOpenChange} trigger={trigger} tip={tip}>
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
                  <span className="text-blue-600 group-data-highlighted:text-white dark:text-blue-400">
                    ✓
                  </span>
                )}
              </Autocomplete.Item>
            );
          }}
        </Autocomplete.List>
      </Autocomplete.Root>
    </PickerPopover>
  );
}

function Divider() {
  return <Toolbar.Separator className="mx-1.5 h-4 w-px bg-black/10 dark:bg-white/10" />;
}

function Action({
  icon: Icon,
  label,
  shortcut,
  onClick,
}: {
  icon: Icon;
  label: string;
  shortcut: string;
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
  shortcut: string;
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
