import { RegistryContext } from "@effect/atom-react";
import { useCallback, useContext, useEffect, useRef } from "react";
import type { Account } from "../../../shared/api";
import { ALL, OVERVIEW, spaceAccounts, type View } from "../lib/view";
import { prefetchView } from "../state/threads";
import { warmViews } from "../state/view-warming";

/** The mailboxes warmed in the open space, besides each account tile's target. */
const WARM_MAILBOXES = ["inbox", "starred", "sent", "drafts", "all"] as const;

const INPUT_EVENTS = ["pointerdown", "keydown", "click", "wheel", "scroll"] as const;
let lastInput = 0;
const remember = () => {
  lastInput = performance.now();
};

/** A sidebar target as the list opens it: the overview's mailboxes open in All. */
const shown = (view: View): View => (view.space === OVERVIEW ? { ...view, space: ALL } : view);

/** What a sidebar row calls on pointer enter or focus, before the click. */
export function usePrefetchView() {
  const registry = useContext(RegistryContext);
  return useCallback((view: View) => void prefetchView(registry, shown(view)), [registry]);
}

/**
 * After the list on screen has loaded, warms the views one click away in the sidebar: the main
 * mailboxes of the open space and each account tile's target. One list at a time, while idle and
 * after a quiet second without keys or clicks; a new view starts a new pass.
 */
export function useViewWarming(view: View, accounts: readonly Account[], ready: boolean) {
  const registry = useContext(RegistryContext);
  useEffect(() => {
    // Scrolling and clicks count too: a list scrolled to its end loads older pages, and a
    // keyboard or assistive click comes without a pointerdown.
    for (const type of INPUT_EVENTS) globalThis.addEventListener(type, remember, true);
    return () => {
      for (const type of INPUT_EVENTS) globalThis.removeEventListener(type, remember, true);
    };
  }, []);
  const current = shown(view);
  const members = spaceAccounts(current.space, accounts);
  const targets: View[] = [
    ...WARM_MAILBOXES.map((mailbox) => ({ ...current, mailbox, label: undefined })),
    ...(members.length > 1
      ? [
          { ...current, accountId: undefined, label: undefined },
          ...members.map((account) => ({ ...current, accountId: account.id, label: undefined })),
        ]
      : []),
  ].filter((target) => JSON.stringify(target) !== JSON.stringify(current));
  const key = JSON.stringify(targets);
  const latest = useRef(targets);
  useEffect(() => {
    latest.current = targets;
  });
  useEffect(() => {
    if (!ready) return undefined;
    return warmViews(registry, latest.current, () => lastInput);
  }, [registry, key, ready]);
}
