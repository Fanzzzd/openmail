import { createContext, use, useMemo, useRef, useState, type ComponentProps } from "react";
import {
  Group,
  Panel,
  type Layout,
  type LayoutChangedMeta,
  type PanelSize,
} from "react-resizable-panels";

/**
 * Pane sizes in pixels, as the person last set them by dragging a divider or with its arrow keys.
 *
 * A group remounts whenever the window crosses a layout breakpoint, near 960 px. A layout saved
 * in percent and applied there gave a sidebar of 232 px at 1321 px only 168 px, which its minimum
 * raised to 200, and each pane then kept that width as the window grew. Pixel sizes applied as
 * the panes' default sizes come back as they were. Only the person's own changes are saved:
 * window resizes and constraint clamps never overwrite them.
 */
type Sizes = Readonly<Record<string, number>>;

function readSizes(storage: Pick<Storage, "getItem">, key: string): Sizes {
  try {
    const value: unknown = JSON.parse(storage.getItem(key) ?? "null");
    if (typeof value !== "object" || value === null) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] > 0,
      ),
    );
  } catch {
    return {};
  }
}

/**
 * The pixel sizes of the saved panes in `layout`: each panel's percentage of the group, scaled by
 * the group's size, which a measured panel gives as its pixels over its percentage.
 */
export function pixelSizes(
  layout: Layout,
  measured: ReadonlyMap<string, PanelSize>,
): Record<string, number> {
  const sample = [...measured.values()].find((size) => size.asPercentage > 0);
  if (!sample) return {};
  const groupPixels = (sample.inPixels / sample.asPercentage) * 100;
  return Object.fromEntries(
    [...measured.keys()].flatMap((id) => {
      const percent = layout[id];
      return percent === undefined ? [] : [[id, Math.round((percent / 100) * groupPixels)]];
    }),
  );
}

const SizesContext = createContext<{
  saved: Sizes;
  measure: (size: PanelSize, id: string | number | undefined) => void;
} | null>(null);

/** A Group whose `SavedPanel`s open at the pixel sizes saved under `storageKey`. */
export function SavedGroup({
  storageKey,
  storage = localStorage,
  ...props
}: Omit<ComponentProps<typeof Group>, "defaultLayout" | "onLayoutChanged"> & {
  storageKey: string;
  storage?: Pick<Storage, "getItem" | "setItem">;
}) {
  // Read once per mount: the group remounts whenever its panes change.
  const [saved] = useState(() => readSizes(storage, storageKey));
  const measured = useRef(new Map<string, PanelSize>());
  const value = useMemo(
    () => ({
      saved,
      measure: (size: PanelSize, id: string | number | undefined) => {
        if (id !== undefined) measured.current.set(String(id), size);
      },
    }),
    [saved],
  );
  const save = (layout: Layout, meta: LayoutChangedMeta) => {
    if (!meta.isUserInteraction) return;
    const sizes = { ...readSizes(storage, storageKey), ...pixelSizes(layout, measured.current) };
    try {
      storage.setItem(storageKey, JSON.stringify(sizes));
    } catch {
      // Storage may be full or unavailable; the panes keep their sizes for this session.
    }
  };
  return (
    <SizesContext value={value}>
      <Group {...props} onLayoutChanged={save} />
    </SizesContext>
  );
}

/** A Panel that opens at its saved pixel size inside a `SavedGroup`, else at `defaultSize`. */
export function SavedPanel({
  defaultSize,
  ...props
}: Omit<ComponentProps<typeof Panel>, "onResize"> & { id: string }) {
  const sizes = use(SizesContext);
  return (
    <Panel
      {...props}
      defaultSize={sizes?.saved[props.id] ?? defaultSize}
      onResize={sizes?.measure}
    />
  );
}
