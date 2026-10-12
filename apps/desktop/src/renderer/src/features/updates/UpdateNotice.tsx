import { useAtomValue } from "@effect/atom-react";
import { Trans } from "@lingui/react/macro";
import { AsyncResult } from "effect/reactivity";
import { updateStateAtom } from "../../state/queries";

export function UpdateNotice({ onSettings }: { onSettings: () => void }) {
  const state = AsyncResult.getOrElse(useAtomValue(updateStateAtom), () => null);
  if (
    !state ||
    !["available", "downloading", "downloaded"].includes(state.status) ||
    !("version" in state)
  )
    return null;
  const version = state.version;
  return (
    <output className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2">
      <span>
        {state.status === "downloaded" ? (
          <Trans>Update {version} is ready. It will install when you quit.</Trans>
        ) : state.status === "downloading" ? (
          <Trans>Downloading update {version}…</Trans>
        ) : (
          <Trans>Update {version} is available.</Trans>
        )}
      </span>
      <button type="button" onClick={onSettings}>
        <Trans>Software updates</Trans>
      </button>
    </output>
  );
}
