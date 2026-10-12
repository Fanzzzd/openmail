import { expect, it } from "vitest";
import {
  desktopEventRoute,
  editCommandRoute,
  shouldBufferDesktopEvent,
  type DesktopEvent,
} from "./desktop";

it("busy editors keep links and never replay menu commands on becoming idle", () => {
  const deferred: DesktopEvent[] = [];
  const delivered: DesktopEvent[] = [];
  let busy = true;
  const receive = (event: DesktopEvent) => {
    const route = desktopEventRoute(event, busy);
    if (route === "defer") deferred.push(event);
    else if (route === "dispatch") delivered.push(event);
  };
  receive({ _tag: "Command", command: "compose" });
  receive({ _tag: "Command", command: "settings" });
  receive({ _tag: "Navigate", href: "/mail/all/all?thread=message" });
  receive({
    _tag: "Compose",
    draft: { to: "to@example.com", cc: "", bcc: "", subject: "", body: "" },
  });
  busy = false;
  delivered.push(...deferred.splice(0));
  expect(delivered.map((event) => event._tag)).toEqual(["Navigate", "Compose"]);
  receive({ _tag: "Command", command: "settings" });
  expect(delivered.at(-1)).toEqual({ _tag: "Command", command: "settings" });
});

it("native edit commands dispatch immediately and retain text editing in editors", () => {
  expect(desktopEventRoute({ _tag: "Edit", action: "selectAll" }, false)).toBe("dispatch");
  expect(desktopEventRoute({ _tag: "Edit", action: "undo" }, true)).toBe("dispatch");
  expect(editCommandRoute(false, false)).toBe("mail");
  expect(editCommandRoute(false, true)).toBe("text");
  expect(editCommandRoute(true, false)).toBe("text");
  expect(editCommandRoute(true, true)).toBe("text");
  expect(editCommandRoute(false, false, true)).toBe("text");
});

it("quit checks and Undo Send reach the renderer even while another editor is busy", () => {
  expect(desktopEventRoute({ _tag: "QuitCheck" }, true)).toBe("dispatch");
  expect(desktopEventRoute({ _tag: "UndoSend" }, true)).toBe("dispatch");
  expect(desktopEventRoute({ _tag: "AttachFiles" }, true)).toBe("dispatch");
});

it("send and quit commands are dropped when the renderer is missing, while navigation is buffered", () => {
  expect(shouldBufferDesktopEvent({ _tag: "UndoSend" })).toBe(false);
  expect(shouldBufferDesktopEvent({ _tag: "AttachFiles" })).toBe(false);
  expect(shouldBufferDesktopEvent({ _tag: "QuitCheck" })).toBe(false);
  expect(shouldBufferDesktopEvent({ _tag: "Edit", action: "undo" })).toBe(false);
  expect(shouldBufferDesktopEvent({ _tag: "Command", command: "compose" })).toBe(false);
  expect(shouldBufferDesktopEvent({ _tag: "Navigate", href: "/mail/all/inbox" })).toBe(true);
  expect(shouldBufferDesktopEvent({ _tag: "LinkError", reason: "missing" })).toBe(true);
  expect(
    shouldBufferDesktopEvent({
      _tag: "Compose",
      draft: { to: "to@example.com", cc: "", bcc: "", subject: "", body: "" },
    }),
  ).toBe(true);
});

it("notification settings expose platform capabilities and macOS menu indexes map to real buttons", async () => {
  const { notificationActionCapabilities } = await import("./desktop");
  const { notificationButtonActions, notificationAction } = await import("@openmail/core/schema");
  expect(notificationActionCapabilities("darwin")).toEqual({ buttons: true, selection: false });
  expect(notificationActionCapabilities("win32")).toEqual({ buttons: true, selection: true });
  expect(notificationActionCapabilities("linux")).toEqual({ buttons: false, selection: false });
  const mac = notificationButtonActions(["menu", "read"], "darwin");
  expect(mac).toEqual(["archive", "trash", "read"]);
  expect(mac.map((_, index) => notificationAction(mac, index, -1))).toEqual([
    { kind: "archive" },
    { kind: "trash" },
    { kind: "read", value: true },
  ]);
  expect(notificationButtonActions(["read", "menu"], "darwin")).toEqual([
    "read",
    "archive",
    "trash",
  ]);
  const windows = notificationButtonActions(["menu", "read"], "win32");
  expect(windows).toEqual(["menu", "read"]);
  expect(notificationAction(windows, 0, 2)).toEqual({ kind: "read", value: true });
});
