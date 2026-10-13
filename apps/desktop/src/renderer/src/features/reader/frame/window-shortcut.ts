import { shortcutAction, type ShortcutSet } from "../../../../../shared/shortcuts";
import { isTypingTarget } from "../../../lib/typing-target";
import { withMail, type useRunMail } from "../../../state/mail";

/**
 * Window, compose and settings shortcuts belong to the desktop app's own windows. A key in a
 * message frame never reaches the window, so the frame runs them itself.
 */
export function runWindowShortcut(
  e: KeyboardEvent,
  set: ShortcutSet,
  run: ReturnType<typeof useRunMail>,
) {
  const action = shortcutAction(set, e, isTypingTarget(e.target));
  if (
    action === "nextWindow" ||
    action === "previousWindow" ||
    action === "focusMainWindow" ||
    action === "toggleFullScreen" ||
    action === "nextTab" ||
    action === "previousTab"
  ) {
    e.preventDefault();
    run(withMail((call) => call("SwitchWindow", { action })));
  }
  if (action === "compose" || action === "newWindow" || action === "settings") {
    e.preventDefault();
    run(
      withMail((call) =>
        action === "compose"
          ? call("ComposeNew", undefined)
          : action === "newWindow"
            ? call("NewWindow", undefined)
            : call("OpenSettings", undefined),
      ),
    );
  }
}
