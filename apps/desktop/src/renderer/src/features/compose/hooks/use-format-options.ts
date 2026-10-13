import type { Prefs, PrefsPatch } from "@openmail/core/schema";
import { Reactivity } from "effect/reactivity";
import { useState } from "react";
import { Keys } from "../../../state/keys";
import { useRunMail, withMail } from "../../../state/mail";

/**
 * The editor's format bar, smart lists and Markdown replacements. Each starts from preferences;
 * a change applies at once and is saved as the new preference.
 */
export function useFormatOptions(prefs: Prefs) {
  const run = useRunMail();
  const [formatBar, setFormatBar] = useState(prefs.composeFormatBar);
  const [smartLists, setSmartListsState] = useState(prefs.composeSmartLists);
  const [markdownReplacement, setMarkdownReplacementState] = useState(
    prefs.composeMarkdownReplacement,
  );
  const saveFormatPrefs = (patch: PrefsPatch) =>
    run(withMail((call) => call("SetPrefs", { patch })).pipe(Reactivity.mutation([Keys.prefs])));
  const toggleFormatBar = () => {
    setFormatBar(!formatBar);
    saveFormatPrefs({ composeFormatBar: !formatBar });
  };
  const setSmartLists = (next: boolean) => {
    setSmartListsState(next);
    saveFormatPrefs({ composeSmartLists: next });
  };
  const setMarkdownReplacement = (next: boolean) => {
    setMarkdownReplacementState(next);
    saveFormatPrefs({ composeMarkdownReplacement: next });
  };
  return {
    formatBar,
    toggleFormatBar,
    smartLists,
    setSmartLists,
    markdownReplacement,
    setMarkdownReplacement,
  };
}
