import type { Prefs } from "@openmail/core/schema";
import { useDefaultLayout } from "react-resizable-panels";
import type { LayoutMode } from "../lib/responsive-layout";
import { OVERVIEW, type View } from "../lib/view";

/** Which panes the window docks, and the pane sizes saved for that arrangement. */
export function usePanelLayout({
  prefs,
  hasAccounts,
  view,
  mode,
}: {
  prefs: Prefs;
  hasAccounts: boolean;
  view: View;
  mode: LayoutMode;
}) {
  const docked = mode === "wide" && prefs.sidebarVisible;
  // Sidebar widths persist separately from the list/reader orientation.
  const paneMode = !hasAccounts ? "empty" : view.space === OVERVIEW ? "overview" : "mail";
  const savedLayout = useDefaultLayout({
    id: `openmail:panes:${paneMode}`,
    panelIds: [...(docked ? ["sidebar"] : []), paneMode === "mail" ? "mail" : "main"],
    storage: localStorage,
  });
  const mailOrientation: "vertical" | "horizontal" =
    prefs.readingPanePosition === "bottom" ? "vertical" : "horizontal";

  return { docked, paneMode, savedLayout, mailOrientation };
}
