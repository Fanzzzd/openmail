import type { ReactNode } from "react";
import { Group, Panel, useDefaultLayout } from "react-resizable-panels";

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
    <Panel id="mail" minSize={560}>
      <Group
        key={`${position}:${readerVisible}`}
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
