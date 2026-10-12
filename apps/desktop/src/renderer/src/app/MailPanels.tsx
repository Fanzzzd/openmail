import type { ReactNode } from "react";
import { Group, Panel, useDefaultLayout } from "react-resizable-panels";
import { PANE_MIN } from "../../../shared/layout";

export function MailPanels({
  position,
  readerVisible,
  children,
}: {
  position: "right" | "bottom";
  readerVisible: boolean;
  children?: ReactNode;
}) {
  const panes = useDefaultLayout({
    id: readerVisible ? `openmail:mail-panes:${position}` : `openmail:mail-panes:${position}:list`,
    panelIds: readerVisible ? ["list", "reader"] : ["list"],
    storage: localStorage,
  });
  return (
    <Panel id="mail" minSize={position === "bottom" ? 360 : PANE_MIN.list + PANE_MIN.reader}>
      <Group
        key={String(readerVisible)}
        orientation={position === "bottom" ? "vertical" : "horizontal"}
        defaultLayout={panes.defaultLayout}
        onLayoutChanged={panes.onLayoutChanged}
        className="h-full"
        resizeTargetMinimumSize={{ fine: 9, coarse: 24 }}
      >
        {children}
      </Group>
    </Panel>
  );
}
