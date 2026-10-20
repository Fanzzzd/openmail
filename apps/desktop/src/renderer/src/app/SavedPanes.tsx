import { createContext, use, useMemo, useRef, useState, type ComponentProps } from "react";
import {
  Group,
  Panel,
  usePanelRef,
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

/**
 * The first layout saved by earlier builds, in percent, under any of `keys`. Builds before pixel
 * sizes saved one through react-resizable-panels' useDefaultLayout.
 */
function readLegacyLayout(storage: Pick<Storage, "getItem">, keys: readonly string[]) {
  for (const key of keys) {
    const sizes = readSizes(storage, key);
    if (Object.keys(sizes).length > 0) return sizes;
  }
  return null;
}

type Measure = (size: PanelSize, id: string, resize: (pixels: number) => void) => void;
/**
 * Runs `then` once this group's own percent conversion is done. `moved` says whether it resized a
 * pane, so a group nested in another pane has a new size to measure in the next frame.
 */
type AfterConversion = (then: (moved: boolean) => void) => void;
const SizesContext = createContext<{
  saved: Sizes;
  measure: Measure;
  afterConversion: AfterConversion;
} | null>(null);

/**
 * A Group whose `SavedPanel`s open at the pixel sizes saved under `storageKey`.
 *
 * `legacy` names the keys an earlier build saved this group's layout under, in percent. Once,
 * on the first mount in the wide layout, a pane with no saved pixel size takes its old percentage
 * of the group's measured size, which is saved in pixels; the old keys are then removed. Once the
 * group has pixel sizes saved, the old keys are not read. A narrower window would clamp the
 * panes, so there the old keys are neither read nor removed. A group inside another SavedGroup's
 * pane converts after the outer one: the outer conversion resizes the pane this group fills.
 */
export function SavedGroup({
  storageKey,
  storage = localStorage,
  legacy,
  ...props
}: Omit<ComponentProps<typeof Group>, "defaultLayout" | "onLayoutChanged"> & {
  storageKey: string;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  legacy?: { keys: readonly string[]; wide: boolean };
}) {
  // The group this one sits in. Its panes take their converted sizes first: a pane of this group
  // measured before that holds a share of the old size.
  const parent = use(SizesContext);
  // Read once per mount: the group remounts whenever its panes change.
  const [saved] = useState(() => readSizes(storage, storageKey));
  // Pixel sizes saved for this group, by a drag or a conversion, mean the old keys are done with.
  const [legacyKeys] = useState(() =>
    legacy?.wide && Object.keys(saved).length === 0 ? legacy.keys : [],
  );
  const [legacyLayout] = useState(() => readLegacyLayout(storage, legacyKeys));
  const measured = useRef(new Map<string, PanelSize>());
  const legacyPending = useRef(legacyLayout !== null);
  // Waiting for this group's conversion: null once it is done, with whether it moved a pane.
  const waiting = useRef<((moved: boolean) => void)[] | null>(legacyLayout ? [] : null);
  const moved = useRef(false);
  const value = useMemo(() => {
    const write = (sizes: Sizes) => {
      try {
        storage.setItem(
          storageKey,
          JSON.stringify({ ...readSizes(storage, storageKey), ...sizes }),
        );
      } catch {
        // Storage may be full or unavailable; the panes keep their sizes for this session.
      }
    };
    const finish = (resized: boolean) => {
      const callbacks = waiting.current ?? [];
      waiting.current = null;
      moved.current = resized;
      for (const callback of callbacks) callback(resized);
    };
    const afterConversion: AfterConversion = (then) => {
      if (waiting.current) waiting.current.push(then);
      else then(moved.current);
    };
    const convert = (id: string, resize: (pixels: number) => void) => {
      const size = measured.current.get(id);
      const percent = legacyLayout?.[id];
      if (
        !size ||
        saved[id] !== undefined ||
        percent === undefined ||
        size.asPercentage <= 0 ||
        size.inPixels <= 0
      ) {
        finish(false);
        return;
      }
      const pixels = Math.round((percent / 100) * ((size.inPixels / size.asPercentage) * 100));
      write({ [id]: pixels });
      // Resizing from inside the library's resize notice would nest layout updates.
      queueMicrotask(() => {
        resize(pixels);
        finish(true);
      });
    };
    const measure: Measure = (size, id, resize) => {
      measured.current.set(id, size);
      if (!legacyPending.current || !legacyLayout || size.inPixels <= 0) return;
      legacyPending.current = false;
      for (const key of legacyKeys) storage.removeItem(key);
      // A parent conversion that resized its panes changes this group's size: the pane's share
      // of the group is measured again in the next frame, after the library lays it out.
      const run = () => convert(id, resize);
      if (!parent) run();
      else
        parent.afterConversion((parentMoved) => {
          if (parentMoved) requestAnimationFrame(run);
          else run();
        });
    };
    return { saved, measure, afterConversion };
  }, [saved, legacyLayout, legacyKeys, storage, storageKey, parent]);
  const save = (layout: Layout, meta: LayoutChangedMeta) => {
    if (!meta.isUserInteraction) return;
    const sizes = pixelSizes(layout, measured.current);
    try {
      storage.setItem(storageKey, JSON.stringify({ ...readSizes(storage, storageKey), ...sizes }));
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
}: Omit<ComponentProps<typeof Panel>, "onResize" | "panelRef"> & { id: string }) {
  const sizes = use(SizesContext);
  const panel = usePanelRef();
  return (
    <Panel
      {...props}
      panelRef={panel}
      defaultSize={sizes?.saved[props.id] ?? defaultSize}
      onResize={
        sizes
          ? (size) => sizes.measure(size, props.id, (px) => panel.current?.resize(px))
          : undefined
      }
    />
  );
}
