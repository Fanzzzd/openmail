import type { Prefs } from "@openmail/core/schema";
import type { LayoutMode } from "../lib/responsive-layout";
import { OVERVIEW, type View } from "../lib/view";

/** Which panes the window docks, and where the sizes of its panes are saved (see SavedGroup). */
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
  const paneMode = !hasAccounts ? "empty" : view.space === OVERVIEW ? "overview" : "mail";
  // Sidebar widths persist per pane mode, separately from the list/reader orientation.
  const sizesKey = `openmail:pane-sizes:${paneMode}`;
  const mailOrientation: "vertical" | "horizontal" =
    prefs.readingPanePosition === "bottom" ? "vertical" : "horizontal";

  return { docked, paneMode, sizesKey, mailOrientation };
}
