import type { useMailLayout } from "../lib/responsive-layout";

/** Wrappers for actions picked in the sidebar drawer or the rail, which move focus or close the drawer. */
export function drawerActions(
  layout: Pick<ReturnType<typeof useMailLayout>, "drawerOpen" | "setDrawerOpen">,
  focusList: (focus: null) => void,
) {
  /** Sidebar actions also close the drawer the sidebar sits in when it is not docked. */
  const fromDrawer =
    <A extends unknown[]>(action: (...args: A) => void) =>
    (...args: A) => {
      layout.setDrawerOpen(false);
      action(...args);
    };
  /** A view picked in the drawer hands focus to its list, not back to the drawer toggle. */
  const viewFromDrawer =
    <A extends unknown[]>(action: (...args: A) => void) =>
    (...args: A) => {
      const fromOpenDrawer = layout.drawerOpen;
      fromDrawer(action)(...args);
      if (fromOpenDrawer) focusList(null);
    };
  /** A view or space picked in the rail hands focus to its list. */
  const fromRail =
    <A extends unknown[]>(action: (...args: A) => void) =>
    (...args: A) => {
      action(...args);
      focusList(null);
    };
  return { fromDrawer, viewFromDrawer, fromRail };
}
