/** Prevent before-quit once, then resume through app.quit so normal teardown still runs. */
export function createQuitGuard(options: {
  pending: () => Promise<number>;
  confirm: () => Promise<boolean>;
  quit: () => void;
  beforeQuit?: () => Promise<void>;
  fallbackPending: () => number;
  timeoutMs?: number;
}) {
  let approved = false;
  let checking = false;
  return (event: { preventDefault(): void }) => {
    if (approved) return Promise.resolve(true);
    event.preventDefault();
    if (checking) return Promise.resolve(false);
    checking = true;
    return (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const pending = await Promise.race([
          options.pending(),
          new Promise<number>((resolve) => {
            timer = setTimeout(() => resolve(options.fallbackPending()), options.timeoutMs ?? 2000);
          }),
        ]).catch(() => options.fallbackPending());
        clearTimeout(timer);
        if (pending > 0 && !(await options.confirm().catch(() => false))) return false;
        await options.beforeQuit?.();
        approved = true;
        options.quit();
        return true;
      } finally {
        clearTimeout(timer);
        checking = false;
      }
    })();
  };
}

/** Capture each renderer's latest undo/send state with a bounded reply wait. */
export function createSendState() {
  const states = new Map<number, { pending: number; undoAvailable: boolean }>();
  const lost = new Map<number, number>();
  const replies = new Map<number, () => void>();
  return {
    get: (id: number) => {
      const state = states.get(id);
      const pending = (state?.pending ?? 0) + (lost.get(id) ?? 0);
      return state || lost.has(id)
        ? { pending, undoAvailable: state?.undoAvailable ?? false }
        : undefined;
    },
    total: () =>
      [...states.values()].reduce((sum, state) => sum + state.pending, 0) +
      [...lost.values()].reduce((sum, n) => sum + n, 0),
    rendererGone(id: number) {
      lost.set(id, (lost.get(id) ?? 0) + (states.get(id)?.pending ?? 0));
      states.delete(id);
      replies.get(id)?.();
    },
    update(id: number, state: { pending: number; undoAvailable: boolean }) {
      states.set(id, state);
      replies.get(id)?.();
    },
    remove(id: number) {
      states.delete(id);
      lost.delete(id);
      replies.get(id)?.();
    },
    async snapshot(requests: readonly { id: number; request: () => void }[]) {
      await Promise.all(
        requests.map(
          ({ id, request }) =>
            new Promise<void>((resolve) => {
              const done = () => {
                clearTimeout(timer);
                replies.delete(id);
                resolve();
              };
              const timer = setTimeout(done, 1000);
              replies.set(id, done);
              request();
            }),
        ),
      );
      return (
        [...states.values()].reduce((sum, state) => sum + state.pending, 0) +
        [...lost.values()].reduce((sum, n) => sum + n, 0)
      );
    },
  };
}

export type QuitInstall = (failed: () => void) => void;
/** The before-quit send guard runs first. Only will-quit, after all window closes succeeded, may stage Squirrel. */
export function createShutdownHandler(options: {
  prepareInstall: () => Promise<QuitInstall | null>;
  stop: () => Promise<void>;
  exit: () => void;
}) {
  let phase: "idle" | "stopping" | "installing" | "exited" = "idle";
  return async (event: { preventDefault(): void }) => {
    // Native quitAndInstall resumes normal Electron teardown after the old core has stopped.
    if (phase === "installing") return;
    event.preventDefault();
    if (phase !== "idle") return;
    phase = "stopping";
    const exit = () => {
      if (phase !== "exited") {
        phase = "exited";
        options.exit();
      }
    };
    try {
      const install = await options.prepareInstall().catch(() => null);
      await options.stop();
      if (install) {
        phase = "installing";
        install(exit);
      } else exit();
    } catch {
      exit();
    }
  };
}
