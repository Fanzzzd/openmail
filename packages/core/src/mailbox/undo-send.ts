/**
 * The undo window after Send: the message waits `delayMs`, then `send` runs,
 * unless the person took it back first. A plain timer, not a fiber to
 * interrupt: undo has to win for certain while the window is open, and
 * clearing a timer that has not fired is synchronous. No Node dependencies,
 * exported through `@openmail/core/schema` for the renderer.
 */
export interface HeldSend {
  /** Takes the message back. False once the window has closed and `send` ran. */
  undo(): boolean;
}

/** Runs `send` after `delayMs`; a delay of 0 or less sends right away with nothing to undo. */
export function holdSend(delayMs: number, send: () => void): HeldSend {
  if (delayMs <= 0) {
    send();
    return { undo: () => false };
  }
  let state: "waiting" | "sent" | "undone" = "waiting";
  const timer = setTimeout(() => {
    if (state !== "waiting") return;
    state = "sent";
    send();
  }, delayMs);
  return {
    undo() {
      if (state !== "waiting") return false;
      state = "undone";
      clearTimeout(timer);
      return true;
    },
  };
}
