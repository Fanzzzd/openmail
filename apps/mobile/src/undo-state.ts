type Notice = { text: string; until: number } & (
  | { kind: "info" }
  | { kind: "undo"; undo: () => Promise<unknown> }
);
export type NoticeChannel = "thread" | "send";
type Toast = { notice: Notice; status: "ready" | "busy" | "failed" };
type State = Record<NoticeChannel, Toast | null>;
export function batchNotice(input: {
  text: string;
  until: number;
  undoId: string;
  undo: () => Promise<unknown>;
}): Notice {
  const { text, until, undoId, undo } = input;
  return undoId ? { text, until, kind: "undo", undo } : { text, until, kind: "info" };
}
export function createUndoController() {
  let state: State = { thread: null, send: null };
  const listeners = new Set<() => void>();
  const update = (channel: NoticeChannel, toast: Toast | null) => {
    state = { ...state, [channel]: toast };
    for (const listener of listeners) listener();
  };
  return {
    snapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    show: (channel: NoticeChannel, notice: Notice) => update(channel, { notice, status: "ready" }),
    dismiss: (channel: NoticeChannel, notice: Notice) => {
      if (state[channel]?.notice === notice) update(channel, null);
    },
    undo: async (channel: NoticeChannel) => {
      const toast = state[channel];
      if (!toast || toast.status === "busy" || toast.notice.kind !== "undo") return;
      update(channel, { ...toast, status: "busy" });
      try {
        await toast.notice.undo();
        if (state[channel]?.notice === toast.notice) update(channel, null);
      } catch {
        if (state[channel]?.notice === toast.notice)
          update(channel, { ...toast, status: "failed" });
      }
    },
  };
}
