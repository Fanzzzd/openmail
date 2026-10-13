import { useLingui } from "@lingui/react/macro";
import type { InlineImageSize } from "@openmail/core/schema";
import type { ShortcutAction } from "../../../../../shared/shortcuts";
import { MenuCheckboxItem, MenuItem, MenuRadioGroup, MenuSeparator } from "../../../ui/Menu";
import type { useComposeGrammar } from "./ComposeGrammar";

/** The editor toolbar's More menu: find, paste variants, format options and grammar. */
export function EditorMoreMenu({
  locked,
  rich,
  shortcut,
  onFind,
  onPaste,
  formatBar,
  onToggleFormatBar,
  smartLists,
  onSmartLists,
  markdownReplacement,
  onMarkdownReplacement,
  imageSize,
  onImageSize,
  grammar,
}: {
  locked: boolean;
  rich: boolean;
  shortcut: (action: ShortcutAction) => string;
  onFind: () => void;
  onPaste: (mode: "matchStyle" | "quotation") => void;
  formatBar: boolean;
  onToggleFormatBar: () => void;
  smartLists: boolean;
  onSmartLists: (next: boolean) => void;
  markdownReplacement: boolean;
  onMarkdownReplacement: (next: boolean) => void;
  imageSize: InlineImageSize;
  onImageSize: (size: InlineImageSize) => void;
  grammar: ReturnType<typeof useComposeGrammar>;
}) {
  const { t } = useLingui();
  return (
    <>
      <MenuItem disabled={locked} onClick={onFind}>
        {t`Find and replace`}
      </MenuItem>
      <MenuItem
        disabled={locked}
        shortcut={shortcut("pasteMatchStyle")}
        onClick={() => onPaste("matchStyle")}
      >{t`Paste and match style`}</MenuItem>
      <MenuItem
        disabled={locked}
        shortcut={shortcut("pasteQuotation")}
        onClick={() => onPaste("quotation")}
      >{t`Paste as quotation`}</MenuItem>
      {rich && (
        <>
          <MenuSeparator />
          <MenuItem shortcut={shortcut("toggleFormatBar")} onClick={onToggleFormatBar}>
            {formatBar ? t`Hide format bar` : t`Show format bar`}
          </MenuItem>
          <MenuCheckboxItem
            checked={smartLists}
            onCheckedChange={onSmartLists}
          >{t`Smart lists`}</MenuCheckboxItem>
          <MenuCheckboxItem
            checked={markdownReplacement}
            onCheckedChange={onMarkdownReplacement}
          >{t`Markdown replacements`}</MenuCheckboxItem>
          <MenuSeparator />
          <MenuRadioGroup
            label={t`Image size`}
            value={imageSize}
            disabled={locked}
            options={[
              { value: "small", label: t`Small` },
              { value: "medium", label: t`Medium` },
              { value: "large", label: t`Large` },
              { value: "original", label: t`Original` },
            ]}
            onValueChange={onImageSize}
          />
        </>
      )}
      {grammar.available && (
        <>
          <MenuSeparator />
          <MenuItem disabled={grammar.disabled} onClick={grammar.check}>
            {grammar.checking ? t`Checking grammar…` : t`Check grammar on this Mac`}
          </MenuItem>
        </>
      )}
    </>
  );
}
