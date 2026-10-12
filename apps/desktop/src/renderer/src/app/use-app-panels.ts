import { useAtomValue } from "@effect/atom-react";
import { type Prefs } from "@openmail/core/schema";
import { useRef, useState } from "react";
import { useDefaultLayout } from "react-resizable-panels";
import type { Profile } from "../../../shared/api";
import { type LabelApplyTarget } from "../features/organize/CreateLabelDialog";
import { type LayoutMode, useMailLayout } from "../lib/responsive-layout";
import { syncProgressAtom, syncStateAtom } from "../state/events";
import { OVERVIEW, type View } from "../lib/view";

export function useAppPanels() {
  const [editing, setEditing] = useState<Profile | "new" | null>(null);
  const syncState = useAtomValue(syncStateAtom);
  const progress = useAtomValue(syncProgressAtom);
  const [dialog, setDialog] = useState<AppDialog>(null);

  const [labelPicker, setLabelPicker] = useState(false);
  const [pickerMode, setPickerMode] = useState<"label" | "move">("label");
  const [goToFolder, setGoToFolder] = useState(false);
  const [labelCreation, setLabelCreation] = useState<LabelApplyTarget | null>(null);
  const [snoozeIds, setSnoozeIds] = useState<readonly string[] | null>(null);
  const [filterSeed, setFilterSeed] = useState<{ accountId: string; from: string } | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const layout = useMailLayout();

  return {
    layout,
    editing,
    setEditing,
    syncState,
    progress,
    dialog,
    setDialog,
    labelPicker,
    setLabelPicker,
    pickerMode,
    setPickerMode,
    goToFolder,
    setGoToFolder,
    labelCreation,
    setLabelCreation,
    snoozeIds,
    setSnoozeIds,
    filterSeed,
    setFilterSeed,
    searchRef,
  };
}

type AppDialog = "add" | "settings" | "proposals" | "help" | "feedback" | null;
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
