import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_PREFS } from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import type { Draft } from "../draft";
import { prefsAtom } from "../state/queries";
export function useComposeDraft(initial: Draft) {
  const prefsResult = useAtomValue(prefsAtom);
  const prefs = AsyncResult.getOrElse(prefsResult, () => DEFAULT_PREFS);
  const [draft, setDraft] = useState(() =>
    initial.mode === "new" &&
    initial.synced === undefined &&
    prefsResult._tag === "Success" &&
    initial.body.kind === "rich" &&
    !initial.body.originalHtml &&
    !initial.body.font
      ? { ...initial, body: { ...initial.body, font: prefs.composeFont } }
      : initial,
  );
  if (
    prefsResult._tag === "Success" &&
    initial.mode === "new" &&
    initial.synced === undefined &&
    draft.body.kind === "rich" &&
    !draft.body.originalHtml &&
    !draft.body.font
  )
    setDraft({ ...draft, body: { ...draft.body, font: prefsResult.value.composeFont } });

  return { draft, setDraft, prefs };
}
