import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { Schema } from "effect";
import { mailHref, parseAppHref } from "../../shared/routes";
import { SavedWindow } from "../../shared/window-state";

export function visibleBounds(
  bounds: SavedWindow["bounds"],
  displays: readonly { workArea: SavedWindow["bounds"] }[],
  minimum: { width: number; height: number },
) {
  const valid =
    Object.values(bounds).every(Number.isFinite) && bounds.width > 0 && bounds.height > 0;
  const area =
    displays.find(
      ({ workArea: a }) =>
        valid &&
        bounds.x >= a.x &&
        bounds.y >= a.y &&
        bounds.x + 80 <= a.x + a.width &&
        bounds.y + 80 <= a.y + a.height,
    )?.workArea ?? displays[0]?.workArea;
  if (!area)
    return {
      ...bounds,
      width: Math.max(minimum.width, bounds.width),
      height: Math.max(minimum.height, bounds.height),
    };
  const width = Math.min(area.width, Math.max(minimum.width, valid ? bounds.width : minimum.width));
  const height = Math.min(
    area.height,
    Math.max(minimum.height, valid ? bounds.height : minimum.height),
  );
  return {
    x: Math.max(area.x, Math.min(valid ? bounds.x : area.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(valid ? bounds.y : area.y, area.y + area.height - height)),
    width,
    height,
  };
}

export function windowStateFile(file: string) {
  let saved: readonly SavedWindow[] = [];
  try {
    saved = Schema.decodeUnknownSync(Schema.Array(SavedWindow))(
      JSON.parse(readFileSync(file, "utf8")),
    ).map(withHref);
  } catch {
    /* Fresh installs and invalid snapshots start with one main window. */
  }
  return {
    read: () => saved,
    write: (windows: readonly SavedWindow[]) => {
      saved = windows;
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(`${file}.tmp`, JSON.stringify(windows), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    },
  };
}

/**
 * Drops hrefs that are not app routes, and main-window hrefs that are not mail
 * routes, so restore can load the href as is. Also moves an old `selection`
 * into `href`.
 */
function withHref({ selection, href, ...state }: SavedWindow): SavedWindow {
  const route = href ? parseAppHref(href) : null;
  if (route && (state.kind !== "main" || route.kind === "mail")) return { ...state, href };
  // TODO(after the release that ships routes): drop the `selection` migration and WindowSelection.
  if (!selection) return state;
  const { messageId, ...view } = selection;
  return { ...state, href: mailHref(view, messageId ? { thread: messageId } : {}) };
}

/**
 * A new window centred on `area`, the work area of the display its parent window is on, so a
 * pop-out opens next to the window it came from rather than on the primary display. A window
 * larger than the area is shrunk to fit it.
 */
export function centeredBounds(
  size: { width: number; height: number },
  area: SavedWindow["bounds"],
): SavedWindow["bounds"] {
  const width = Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height);
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  };
}
