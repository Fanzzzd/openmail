import type { MailOp, Prefs, SwipeAction } from "@openmail/core/schema";

const SHORT_SWIPE = 60;
const LONG_SWIPE = 180;
export function swipeAction(distance: number, actions: Prefs["swipeActions"]): SwipeAction {
  if (Math.abs(distance) < SHORT_SWIPE) return "none";
  return distance < 0
    ? actions[Math.abs(distance) >= LONG_SWIPE ? "leftLong" : "leftShort"]
    : actions[distance >= LONG_SWIPE ? "rightLong" : "rightShort"];
}
export function swipeMailOp(
  action: SwipeAction,
  state: { isUnread: boolean; isStarred: boolean },
): MailOp | null {
  switch (action) {
    case "archive":
      return { kind: "archive" };
    case "trash":
      return { kind: "trash" };
    case "read":
      return { kind: "read", value: state.isUnread };
    case "star":
      return { kind: "star", value: !state.isStarred };
    case "none":
    case "snooze":
      return null;
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}
/** One action when the wheel gesture settles; vertical scroll and pinch zoom remain native. */
export function attachMessageSwipe(
  element: HTMLElement,
  options: {
    actions: Prefs["swipeActions"];
    preview: (distance: number, action: SwipeAction) => void;
    commit: (action: SwipeAction) => void;
  },
) {
  let distance = 0;
  let vertical = 0;
  let axis: "horizontal" | "vertical" | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let suppressUntil = 0;
  const reset = () => {
    distance = 0;
    axis = null;
    vertical = 0;
    options.preview(0, "none");
  };
  // A trackpad swipe over a window in the background must never act on mail.
  const focused = () => {
    const doc = element.ownerDocument;
    return typeof doc.hasFocus === "function" ? doc.hasFocus() : true;
  };
  const wheel = (event: WheelEvent) => {
    if (!focused()) {
      clearTimeout(timer);
      if (axis || distance) reset();
      return;
    }
    if (
      event.deltaMode !== 0 ||
      event.shiftKey ||
      event.ctrlKey ||
      event.metaKey ||
      !Number.isFinite(event.deltaX) ||
      !Number.isFinite(event.deltaY)
    )
      return;
    if (!axis) {
      distance -= event.deltaX;
      vertical += event.deltaY;
      if (Math.abs(distance) >= 10 && Math.abs(distance) > Math.abs(vertical) * 1.5)
        axis = "horizontal";
      else if (Math.abs(vertical) >= 10 && Math.abs(vertical) > Math.abs(distance) * 1.5)
        axis = "vertical";
    } else if (axis === "horizontal") {
      distance -= event.deltaX;
    }
    if (axis === "horizontal") {
      event.preventDefault();
      options.preview(distance, swipeAction(distance, options.actions));
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      const action =
        axis === "horizontal" && focused() ? swipeAction(distance, options.actions) : "none";
      reset();
      if (action !== "none") {
        suppressUntil = Date.now() + 300;
        options.commit(action);
      }
    }, 180);
  };
  const click = (event: MouseEvent) => {
    if (Date.now() < suppressUntil) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  element.addEventListener("wheel", wheel, { passive: false });
  element.addEventListener("click", click, true);
  return () => {
    clearTimeout(timer);
    element.removeEventListener("wheel", wheel);
    element.removeEventListener("click", click, true);
    reset();
  };
}
