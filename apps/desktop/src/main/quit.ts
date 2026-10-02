/** Prevent before-quit once, then resume through app.quit so normal teardown still runs. */
export function createQuitGuard(options: {
  pending: () => Promise<number>;
  confirm: () => Promise<boolean>;
  quit: () => void;
  fallbackPending: () => number;
  timeoutMs?: number;
}) {
  let approved = false;
  let checking = false;
  return (event: { preventDefault(): void }) => {
    if (approved) return Promise.resolve();
    event.preventDefault();
    if (checking) return Promise.resolve();
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
        if (pending > 0 && !(await options.confirm().catch(() => false))) return;
        approved = true;
        options.quit();
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
  const replies = new Map<number, () => void>();
  return {
    get: (id: number) => states.get(id),
    total: () => [...states.values()].reduce((sum, state) => sum + state.pending, 0),
    update(id: number, state: { pending: number; undoAvailable: boolean }) {
      states.set(id, state);
      replies.get(id)?.();
    },
    remove(id: number) {
      states.delete(id);
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
      return [...states.values()].reduce((sum, state) => sum + state.pending, 0);
    },
  };
}
