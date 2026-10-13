import type { DraftRemote } from "../domain/domain.js";
import type { DraftVersion } from "../services.js";

export function draftVersionMetadata(
  version: DraftVersion,
): Pick<DraftRemote, "changeKey" | "lastWrittenAt"> {
  const modified = Date.parse(version.lastModifiedDateTime ?? "");
  return {
    ...(version.changeKey ? { changeKey: version.changeKey } : {}),
    ...(Number.isFinite(modified) ? { lastWrittenAt: modified } : {}),
  };
}
