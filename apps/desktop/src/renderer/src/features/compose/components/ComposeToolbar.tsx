import { useLingui } from "@lingui/react/macro";
import {
  COMPOSE_COLORS,
  COMPOSE_FONT_FAMILIES,
  COMPOSE_FONT_SIZES,
  composeStyleValue,
} from "@openmail/core/schema";
import {
  Baseline,
  Bold,
  Ellipsis,
  Italic,
  Link,
  List,
  ListOrdered,
  Strikethrough,
  TextAlignStart,
  TextQuote,
  Type,
  Underline,
} from "lucide-react";
import { type ComponentType, type ReactNode, useRef, useState } from "react";
import type { ShortcutAction } from "../../../../../shared/shortcuts";
import type { FormatAction } from "../compose-format-dom";
import { useElementWidth } from "../../../lib/use-element-width";
import { KeyboardToolbar } from "../../../ui/KeyboardToolbar";
import { DropdownMenu, MenuItem, MenuSeparator } from "../../../ui/Menu";
import { PickerPopover } from "../../../ui/Picker";
import { Select } from "../../../ui/Select";
import { Tip } from "../../../ui/Tip";

type Icon = ComponentType<{ className?: string }>;
type InlineCommand = "bold" | "italic" | "underline" | "strikeThrough" | "unlink";

/**
 * Toolbar widths, in px, from which each inline group shows. Narrower
 * composers move the group into "More formatting"; the rest always shows.
 */
const TOOLBAR_TIERS = { style: 400, lists: 460, align: 490, quote: 550 } as const;
type ToolbarTier = keyof typeof TOOLBAR_TIERS;

/** Which inline groups fit. An unmeasured toolbar (first paint, jsdom) shows them all. */
function visibleTiers(width: number): Record<ToolbarTier, boolean> {
  const fits = (tier: ToolbarTier) => width === 0 || width >= TOOLBAR_TIERS[tier];
  return { style: fits("style"), lists: fits("lists"), align: fits("align"), quote: fits("quote") };
}

const button =
  "flex size-7 shrink-0 items-center justify-center rounded-control text-a11y-muted hover:bg-fill-hover disabled:opacity-40 data-popup-open:bg-fill-pressed";

interface Props {
  /** The writing mode select and any one-off undo buttons, first in the row. */
  leading: ReactNode;
  /** Rich text with the format bar on: the formatting controls show. */
  formatting: boolean;
  disabled: boolean;
  onFormat: (action: FormatAction) => void;
  onStyle: (property: string, value: string) => void;
  onCommand: (name: InlineCommand) => void;
  onLink: () => void;
  /** Editor items after the formatting groups in "More formatting". */
  more: ReactNode;
  shortcut: (action: ShortcutAction) => string;
}

/** One formatting command, shown as a toolbar button when it fits and as a menu item otherwise. */
interface Command {
  label: string;
  icon?: Icon | undefined;
  run: () => void;
  shortcut?: ShortcutAction;
}

/**
 * The composer's one-row toolbar, as in Mimestream and Apple Mail: icon
 * buttons for common formatting, popovers for font, color and alignment, and
 * everything else in "More formatting". Groups that do not fit the composer's
 * width move into that menu.
 */
export function ComposeToolbar({
  leading,
  formatting,
  disabled,
  onFormat,
  onStyle,
  onCommand,
  onLink,
  more,
  shortcut,
}: Props) {
  const { t } = useLingui();
  const ref = useRef<HTMLDivElement>(null);
  const shown = visibleTiers(useElementWidth(ref));

  const format = (label: string, action: FormatAction, icon?: Icon): Command => ({
    label,
    icon,
    run: () => onFormat(action),
    shortcut: action,
  });
  const bold: Command = {
    label: t`Bold`,
    icon: Bold,
    run: () => onCommand("bold"),
    shortcut: "bold",
  };
  const italic: Command = {
    label: t`Italic`,
    icon: Italic,
    run: () => onCommand("italic"),
    shortcut: "italic",
  };
  const link: Command = { label: t`Edit link`, icon: Link, run: onLink, shortcut: "link" };
  const style: Command[] = [
    {
      label: t`Underline`,
      icon: Underline,
      run: () => onCommand("underline"),
      shortcut: "underline",
    },
    {
      label: t`Strikethrough`,
      icon: Strikethrough,
      run: () => onCommand("strikeThrough"),
      shortcut: "strikethrough",
    },
  ];
  const align = [
    format(t`Align left`, "alignLeft"),
    format(t`Align center`, "alignCenter"),
    format(t`Align right`, "alignRight"),
    format(t`Justify`, "alignJustify"),
  ];
  const lists = [
    format(t`Bulleted list`, "bulletList", List),
    format(t`Numbered list`, "numberList", ListOrdered),
  ];
  const quote = format(t`Increase quote level`, "quoteIncrease", TextQuote);

  const toolButton = ({ label, icon: Icon, run, shortcut: action }: Command) => (
    <Tip key={label} label={label} shortcut={action && shortcut(action)}>
      <button
        type="button"
        disabled={disabled}
        aria-label={label}
        className={button}
        onMouseDown={(event) => event.preventDefault()}
        onClick={run}
      >
        {Icon && <Icon className="size-4" />}
      </button>
    </Tip>
  );
  const menuItem = ({ label, run, shortcut: action }: Command) => (
    <MenuItem key={label} disabled={disabled} shortcut={action && shortcut(action)} onClick={run}>
      {label}
    </MenuItem>
  );

  return (
    <KeyboardToolbar
      ref={ref}
      aria-label={t`Formatting`}
      className="flex shrink-0 items-center gap-0.5 overflow-hidden border-b border-separator px-4 py-1"
    >
      <div className="mr-1 flex min-w-0 shrink items-center gap-1">{leading}</div>
      {formatting && (
        <>
          <Separator />
          {toolButton(bold)}
          {toolButton(italic)}
          {shown.style && style.map(toolButton)}
          {toolButton(link)}
          <Separator />
          <FontPopover disabled={disabled} onStyle={onStyle} />
          <ColorPopover disabled={disabled} onStyle={onStyle} />
          {shown.align && (
            <DropdownMenu
              align="start"
              trigger={
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={t`Alignment`}
                  className={button}
                >
                  <TextAlignStart className="size-4" />
                </button>
              }
            >
              {align.map(menuItem)}
            </DropdownMenu>
          )}
          {shown.lists && (
            <>
              <Separator />
              {lists.map(toolButton)}
            </>
          )}
          {shown.quote && toolButton(quote)}
        </>
      )}
      <span className="flex-1" />
      <DropdownMenu
        trigger={
          <button type="button" aria-label={t`More formatting`} className={button}>
            <Ellipsis className="size-4" />
          </button>
        }
      >
        {formatting && (
          <>
            {!shown.style && (
              <>
                {style.map(menuItem)}
                <MenuSeparator />
              </>
            )}
            {!shown.align && (
              <>
                {align.map(menuItem)}
                <MenuSeparator />
              </>
            )}
            {!shown.lists && lists.map(menuItem)}
            {[
              format(t`Dashed list`, "dashList"),
              format(t`Indent list`, "indentList"),
              format(t`Outdent list`, "outdentList"),
              format(t`Increase indent`, "indentParagraph"),
              format(t`Decrease indent`, "outdentParagraph"),
              ...(shown.quote ? [] : [quote]),
              format(t`Decrease quote level`, "quoteDecrease"),
            ].map(menuItem)}
            <MenuSeparator />
            {[
              format(t`Left to right`, "directionLtr"),
              format(t`Right to left`, "directionRtl"),
              format(t`Automatic direction`, "directionAuto"),
            ].map(menuItem)}
            <MenuSeparator />
            {[
              format(t`Inline code`, "inlineCode"),
              format(t`Code block`, "blockCode"),
              format(t`Superscript`, "superscript"),
              format(t`Subscript`, "subscript"),
            ].map(menuItem)}
            <MenuSeparator />
            {[
              format(t`Copy style`, "copyStyle"),
              format(t`Paste style`, "pasteStyle"),
              format(t`Clear formatting`, "clearFormatting"),
              { label: t`Remove link`, run: () => onCommand("unlink") },
            ].map(menuItem)}
            <MenuSeparator />
          </>
        )}
        {more}
      </DropdownMenu>
    </KeyboardToolbar>
  );
}

function Separator() {
  return <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-fill-pressed" />;
}

function FontPopover({ disabled, onStyle }: { disabled: boolean; onStyle: Props["onStyle"] }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [family, setFamily] = useState<string>("Arial");
  const [size, setSize] = useState("14");
  return (
    <PickerPopover
      aria-label={t`Font`}
      open={open}
      onOpenChange={setOpen}
      tip={{ label: t`Font` }}
      className="w-56 gap-2 p-3"
      trigger={
        <button type="button" disabled={disabled} aria-label={t`Font`} className={button}>
          <Type className="size-4" />
        </button>
      }
    >
      <Select
        aria-label={t`Font family`}
        value={family}
        options={COMPOSE_FONT_FAMILIES.map((value) => ({ value, label: value }))}
        onValueChange={(value) => {
          setFamily(value);
          onStyle("font-family", value);
        }}
      />
      <Select
        aria-label={t`Font size`}
        value={size}
        options={COMPOSE_FONT_SIZES.map((value) => ({ value: String(value), label: `${value}px` }))}
        onValueChange={(value) => {
          setSize(value);
          onStyle("font-size", `${value}px`);
        }}
      />
    </PickerPopover>
  );
}

function ColorPopover({ disabled, onStyle }: { disabled: boolean; onStyle: Props["onStyle"] }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<"color" | "background-color">("color");
  const [hex, setHex] = useState({ color: "#000000", "background-color": "#ffffff" });
  const targetLabel = target === "color" ? t`Text color` : t`Background color`;
  const apply = (value: string) => {
    setHex((current) => ({ ...current, [target]: value }));
    onStyle(target, value);
  };
  return (
    <PickerPopover
      aria-label={t`Color`}
      open={open}
      onOpenChange={setOpen}
      tip={{ label: t`Color` }}
      className="w-60 gap-3 p-3"
      trigger={
        <button type="button" disabled={disabled} aria-label={t`Color`} className={button}>
          <Baseline className="size-4" />
        </button>
      }
    >
      <Select
        aria-label={t`Color target`}
        value={target}
        options={[
          { value: "color", label: t`Text color` },
          { value: "background-color", label: t`Background color` },
        ]}
        onValueChange={setTarget}
      />
      <div className="grid grid-cols-5 gap-1.5">
        {COMPOSE_COLORS.map((value) => (
          <button
            key={value}
            type="button"
            aria-label={`${targetLabel} ${value}`}
            className="h-6 rounded border border-neutral-400"
            style={{ backgroundColor: value }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => apply(value)}
          />
        ))}
      </div>
      <div className="flex items-center gap-2">
        <input
          aria-label={t`Custom hex color`}
          className="min-w-0 flex-1 rounded border px-1.5 py-0.5 text-xs border-separator"
          value={hex[target]}
          onChange={(event) => setHex((current) => ({ ...current, [target]: event.target.value }))}
        />
        <button
          type="button"
          disabled={!/^#(?:[a-f\d]{3}|[a-f\d]{6})$/i.test(hex[target])}
          className="rounded px-2 py-1 text-xs hover:bg-fill-hover disabled:opacity-40"
          onClick={() => {
            const value = composeStyleValue(target, hex[target]);
            if (value) onStyle(target, value);
          }}
        >{t`Apply color`}</button>
      </div>
    </PickerPopover>
  );
}
