import { useEffect, useRef, useState, type RefObject } from "react";
import type { Prefs, SwipeAction } from "@openmail/core/schema";
import { constVoid } from "effect/Function";
import { attachMessageSwipe } from "./message-swipe";

/** Keep the native gesture alive when the parent replaces its action callback. */
export function useMessageSwipe(
  row: RefObject<HTMLButtonElement | null>,
  actions: Prefs["swipeActions"],
  onSwipe: (action: SwipeAction) => void,
) {
  const handler = useRef(onSwipe);
  const [preview, setPreview] = useState<{ distance: number; action: SwipeAction }>({
    distance: 0,
    action: "none",
  });
  useEffect(() => {
    handler.current = onSwipe;
  }, [onSwipe]);
  useEffect(() => {
    const element = row.current;
    if (!element) return constVoid;
    return attachMessageSwipe(element, {
      actions,
      preview: (distance, action) => setPreview({ distance, action }),
      commit: (action) => handler.current(action),
    });
  }, [row, actions]);
  return preview;
}
