import { expect, it, vi } from "vitest";
import { batchNotice, createUndoController } from "./undo-state";
it("clears a failure when a new notice replaces it", async () => {
  const controller = createUndoController();
  controller.show("thread", {
    text: "first",
    until: 100,
    kind: "undo",
    undo: async () => {
      throw new Error("failed");
    },
  });
  await controller.undo("thread");
  expect(controller.snapshot().thread?.status).toBe("failed");
  controller.show("thread", { text: "new", until: 200, kind: "info" });
  expect(controller.snapshot().thread?.status).toBe("ready");
});
it("never offers undo for an empty core undoId", async () => {
  const undo = vi.fn();
  const notice = batchNotice({ text: "Done", until: 100, undoId: "", undo });
  expect(notice.kind).toBe("info");
  const controller = createUndoController();
  controller.show("thread", notice);
  await controller.undo("thread");
  expect(undo).not.toHaveBeenCalled();
});
it("keeps undo-send alive while thread notices change or expire", async () => {
  const controller = createUndoController();
  const undo = vi.fn();
  const send = { text: "send", until: 200, kind: "undo", undo } as const;
  controller.show("send", send);
  const thread = batchNotice({ text: "thread", until: 100, undoId: "t", undo: vi.fn() });
  controller.show("thread", thread);
  controller.dismiss("thread", thread);
  expect(controller.snapshot().send?.notice).toBe(send);
  await controller.undo("send");
  expect(undo).toHaveBeenCalledOnce();
});
it("ignores late failure from an undo belonging to a replaced notice", async () => {
  const controller = createUndoController();
  let reject: (error: Error) => void = () => {
    throw new Error("not started");
  };
  controller.show("thread", {
    text: "first",
    until: 100,
    kind: "undo",
    undo: () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  });
  const pending = controller.undo("thread");
  controller.show("thread", { text: "new", until: 200, kind: "info" });
  reject(new Error("late"));
  await pending;
  expect(controller.snapshot().thread?.status).toBe("ready");
  expect(controller.snapshot().thread?.notice.text).toBe("new");
});
