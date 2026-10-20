import type { ReactNode } from "react";
import { Panel } from "react-resizable-panels";
import { PANE_MIN } from "../../../shared/layout";
import { SavedGroup } from "./SavedPanes";

export function MailPanels({
  position,
  readerVisible,
  wide,
  children,
}: {
  position: "right" | "bottom";
  readerVisible: boolean;
  /** The window has the wide layout, where an earlier build's saved widths may be converted. */
  wide: boolean;
  children?: ReactNode;
}) {
  return (
    <Panel id="mail" minSize={position === "bottom" ? 360 : PANE_MIN.list + PANE_MIN.reader}>
      <SavedGroup
        key={String(readerVisible)}
        storageKey={
          readerVisible
            ? `openmail:mail-pane-sizes:${position}`
            : `openmail:mail-pane-sizes:${position}:list`
        }
        legacy={
          readerVisible
            ? {
                keys: [
                  `react-resizable-panels:openmail:mail-panes:${position}:list:reader`,
                  `react-resizable-panels:openmail:mail-panes:${position}:reader:list`,
                ],
                wide,
              }
            : undefined
        }
        orientation={position === "bottom" ? "vertical" : "horizontal"}
        className="h-full"
        resizeTargetMinimumSize={{ fine: 9, coarse: 24 }}
      >
        {children}
      </SavedGroup>
    </Panel>
  );
}
