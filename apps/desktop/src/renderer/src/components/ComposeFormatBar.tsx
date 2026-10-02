import { useLingui } from "@lingui/react/macro";
import {
  COMPOSE_FONT_FAMILIES,
  COMPOSE_FONT_SIZES,
  COMPOSE_COLORS,
  composeStyleValue,
} from "@openmail/core/schema";
import { useState } from "react";
import type { FormatAction } from "../compose-format-dom";
import { Select } from "./ui/Select";

interface Props {
  disabled: boolean;
  onFormat: (action: FormatAction) => void;
  onStyle: (property: string, value: string) => void;
}
export function ComposeFormatBar({ disabled, onFormat, onStyle }: Props) {
  const { t } = useLingui();
  const [family, setFamily] = useState<string>("Arial");
  const [size, setSize] = useState("14");
  const [color, setColor] = useState("#000000");
  const [background, setBackground] = useState("#ffffff");
  const [colorTarget, setColorTarget] = useState<"color" | "background-color">("color");
  const button =
    "rounded px-2 py-1 text-xs hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10";
  const actions: { action: FormatAction; label: string }[] = [
    { action: "superscript", label: t`Superscript` },
    { action: "subscript", label: t`Subscript` },
    { action: "alignLeft", label: t`Align left` },
    { action: "alignCenter", label: t`Align center` },
    { action: "alignRight", label: t`Align right` },
    { action: "alignJustify", label: t`Justify` },
    { action: "directionLtr", label: t`Left to right` },
    { action: "directionRtl", label: t`Right to left` },
    { action: "directionAuto", label: t`Automatic direction` },
    { action: "bulletList", label: t`Bulleted list` },
    { action: "numberList", label: t`Numbered list` },
    { action: "dashList", label: t`Dashed list` },
    { action: "indentList", label: t`Indent list` },
    { action: "outdentList", label: t`Outdent list` },
    { action: "inlineCode", label: t`Inline code` },
    { action: "blockCode", label: t`Code block` },
    { action: "indentParagraph", label: t`Increase indent` },
    { action: "outdentParagraph", label: t`Decrease indent` },
    { action: "quoteIncrease", label: t`Increase quote level` },
    { action: "quoteDecrease", label: t`Decrease quote level` },
    { action: "copyStyle", label: t`Copy style` },
    { action: "pasteStyle", label: t`Paste style` },
    { action: "clearFormatting", label: t`Clear formatting` },
  ];
  return (
    <div
      role="toolbar"
      aria-label={t`Formatting`}
      className="flex shrink-0 flex-wrap items-center gap-1 border-b px-4 py-1"
    >
      <Select
        aria-label={t`Font family`}
        disabled={disabled}
        value={family}
        options={COMPOSE_FONT_FAMILIES.map((value) => ({ value, label: value }))}
        onValueChange={(value) => {
          setFamily(value);
          onStyle("font-family", value);
        }}
      />
      <Select
        aria-label={t`Font size`}
        disabled={disabled}
        value={size}
        options={COMPOSE_FONT_SIZES.map((value) => ({ value: String(value), label: `${value}px` }))}
        onValueChange={(value) => {
          setSize(value);
          onStyle("font-size", `${value}px`);
        }}
      />
      <Select
        aria-label={t`Color target`}
        disabled={disabled}
        value={colorTarget}
        options={[
          { value: "color", label: t`Text color` },
          { value: "background-color", label: t`Background color` },
        ]}
        onValueChange={setColorTarget}
      />
      {COMPOSE_COLORS.map((value) => (
        <button
          key={value}
          type="button"
          disabled={disabled}
          aria-label={`${colorTarget === "color" ? t`Text color` : t`Background color`} ${value}`}
          className="size-5 rounded border border-neutral-400"
          style={{ backgroundColor: value }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (colorTarget === "color") setColor(value);
            else setBackground(value);
            onStyle(colorTarget, value);
          }}
        />
      ))}
      <input
        aria-label={t`Custom hex color`}
        disabled={disabled}
        className="w-20 rounded border px-1 text-xs"
        value={colorTarget === "color" ? color : background}
        onChange={(e) => {
          if (colorTarget === "color") setColor(e.target.value);
          else setBackground(e.target.value);
        }}
      />
      <button
        type="button"
        disabled={
          disabled ||
          !/^#(?:[a-f\d]{3}|[a-f\d]{6})$/i.test(colorTarget === "color" ? color : background)
        }
        className={button}
        onClick={() => {
          const value = composeStyleValue(
            colorTarget,
            colorTarget === "color" ? color : background,
          );
          if (value) onStyle(colorTarget, value);
        }}
      >{t`Apply color`}</button>
      {actions.map(({ action, label }) => (
        <button
          key={action}
          type="button"
          disabled={disabled}
          className={button}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onFormat(action)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
