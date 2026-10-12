import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { Schema } from "effect";
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
    );
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
