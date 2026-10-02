import type { ReactNode } from "react";
import { Group, Panel, useDefaultLayout } from "react-resizable-panels";

export function MailPanels({
  position,
  children,
}: {
  position: "right" | "bottom";
  children: ReactNode;
}) {
  const panes = useDefaultLayout({
    id: `openmail:mail-panes:${position}`,
    panelIds: ["list", "reader"],
    storage: localStorage,
  });
  return (
    <Panel id="mail" minSize={560}>
      <Group
        key={position}
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
