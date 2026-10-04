import { useLingui } from "@lingui/react/macro";
import { constVoid } from "effect/Function";
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
import { type ComponentType, type ReactNode, useRef, useState, useSyncExternalStore } from "react";
import type { ShortcutAction } from "../../../shared/shortcuts";
import type { FormatAction } from "../compose-format-dom";
import { useShortcutText } from "../use-shortcut-text";
import { KeyboardToolbar } from "./ui/KeyboardToolbar";
import { DropdownMenu, MenuItem, MenuSeparator } from "./ui/Menu";
import { PickerPopover } from "./ui/Picker";
import { Select } from "./ui/Select";
import { Tip } from "./ui/Tip";

type Icon = ComponentType<{ className?: string }>;
export type InlineCommand = "bold" | "italic" | "underline" | "strikeThrough" | "unlink";

/**
 * Toolbar widths, in px, from which each inline group shows. Narrower
 * composers move the group into "More formatting"; the rest always shows.
 */
export const TOOLBAR_TIERS = { style: 400, lists: 460, align: 490, quote: 550 } as const;
export type ToolbarTier = keyof typeof TOOLBAR_TIERS;

/** Which inline groups fit. An unmeasured toolbar (first paint, jsdom) shows them all. */
export function visibleTiers(width: number): Record<ToolbarTier, boolean> {
  const fits = (tier: ToolbarTier) => width === 0 || width >= TOOLBAR_TIERS[tier];
  return { style: fits("style"), lists: fits("lists"), align: fits("align"), quote: fits("quote") };
}

const button =
  "flex size-7 shrink-0 items-center justify-center rounded-md text-a11y-muted hover:bg-black/5 disabled:opacity-40 data-popup-open:bg-black/5 dark:hover:bg-white/10 dark:data-popup-open:bg-white/10";

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
}: Props) {
  const { t } = useLingui();
  const shortcut = useShortcutText();
  const ref = useRef<HTMLDivElement>(null);
  const width = useSyncExternalStore(
    (changed) => {
      const element = ref.current;
      if (!element) return constVoid;
      const observer = new ResizeObserver(changed);
      observer.observe(element);
      return () => observer.disconnect();
    },
    () => ref.current?.clientWidth ?? 0,
  );
  const shown = visibleTiers(width);

  const iconButton = (label: string, Icon: Icon, onClick: () => void, action?: ShortcutAction) => (
    <Tip label={label} shortcut={action && shortcut(action)}>
      <button
        type="button"
        disabled={disabled}
        aria-label={label}
        className={button}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClick}
      >
        <Icon className="size-4" />
      </button>
    </Tip>
  );
  const item = (label: string, action: FormatAction) => (
    <MenuItem
      key={action}
      disabled={disabled}
      shortcut={shortcut(action)}
      onClick={() => onFormat(action)}
    >
      {label}
    </MenuItem>
  );
  const labels = {
    bulletList: t`Bulleted list`,
    numberList: t`Numbered list`,
    quoteIncrease: t`Increase quote level`,
    alignLeft: t`Align left`,
    alignCenter: t`Align center`,
    alignRight: t`Align right`,
    alignJustify: t`Justify`,
  };
  const alignItems = (["alignLeft", "alignCenter", "alignRight", "alignJustify"] as const).map(
    (action) => item(labels[action], action),
  );

  return (
    <KeyboardToolbar
      ref={ref}
      aria-label={t`Formatting`}
      className="flex shrink-0 items-center gap-0.5 overflow-hidden border-b border-black/[0.07] px-4 py-1 dark:border-white/[0.08]"
    >
      <div className="mr-1 flex min-w-0 shrink items-center gap-1">{leading}</div>
      {formatting && (
        <>
          <Separator />
          {iconButton(t`Bold`, Bold, () => onCommand("bold"), "bold")}
          {iconButton(t`Italic`, Italic, () => onCommand("italic"), "italic")}
          {shown.style && (
            <>
              {iconButton(t`Underline`, Underline, () => onCommand("underline"), "underline")}
              {iconButton(
                t`Strikethrough`,
                Strikethrough,
                () => onCommand("strikeThrough"),
                "strikethrough",
              )}
            </>
          )}
          {iconButton(t`Edit link`, Link, onLink, "link")}
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
              {alignItems}
            </DropdownMenu>
          )}
          {shown.lists && (
            <>
              <Separator />
              {iconButton(labels.bulletList, List, () => onFormat("bulletList"), "bulletList")}
              {iconButton(
                labels.numberList,
                ListOrdered,
                () => onFormat("numberList"),
                "numberList",
              )}
            </>
          )}
          {shown.quote &&
            iconButton(
              labels.quoteIncrease,
              TextQuote,
              () => onFormat("quoteIncrease"),
              "quoteIncrease",
            )}
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
                <MenuItem
                  disabled={disabled}
                  shortcut={shortcut("underline")}
                  onClick={() => onCommand("underline")}
                >{t`Underline`}</MenuItem>
                <MenuItem
                  disabled={disabled}
                  shortcut={shortcut("strikethrough")}
                  onClick={() => onCommand("strikeThrough")}
                >{t`Strikethrough`}</MenuItem>
                <MenuSeparator />
              </>
            )}
            {!shown.align && (
              <>
                {alignItems}
                <MenuSeparator />
              </>
            )}
            {!shown.lists && item(labels.bulletList, "bulletList")}
            {!shown.lists && item(labels.numberList, "numberList")}
            {item(t`Dashed list`, "dashList")}
            {item(t`Indent list`, "indentList")}
            {item(t`Outdent list`, "outdentList")}
            {item(t`Increase indent`, "indentParagraph")}
            {item(t`Decrease indent`, "outdentParagraph")}
            {!shown.quote && item(labels.quoteIncrease, "quoteIncrease")}
            {item(t`Decrease quote level`, "quoteDecrease")}
            <MenuSeparator />
            {item(t`Left to right`, "directionLtr")}
            {item(t`Right to left`, "directionRtl")}
            {item(t`Automatic direction`, "directionAuto")}
            <MenuSeparator />
            {item(t`Inline code`, "inlineCode")}
            {item(t`Code block`, "blockCode")}
            {item(t`Superscript`, "superscript")}
            {item(t`Subscript`, "subscript")}
            <MenuSeparator />
            {item(t`Copy style`, "copyStyle")}
            {item(t`Paste style`, "pasteStyle")}
            {item(t`Clear formatting`, "clearFormatting")}
            <MenuItem disabled={disabled} onClick={() => onCommand("unlink")}>
              {t`Remove link`}
            </MenuItem>
            <MenuSeparator />
          </>
        )}
        {more}
      </DropdownMenu>
    </KeyboardToolbar>
  );
}

function Separator() {
  return <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-black/10 dark:bg-white/10" />;
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
          className="min-w-0 flex-1 rounded border px-1.5 py-0.5 text-xs"
          value={hex[target]}
          onChange={(event) => setHex((current) => ({ ...current, [target]: event.target.value }))}
        />
        <button
          type="button"
          disabled={!/^#(?:[a-f\d]{3}|[a-f\d]{6})$/i.test(hex[target])}
          className="rounded px-2 py-1 text-xs hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10"
          onClick={() => {
            const value = composeStyleValue(target, hex[target]);
            if (value) onStyle(target, value);
          }}
        >{t`Apply color`}</button>
      </div>
    </PickerPopover>
  );
}
