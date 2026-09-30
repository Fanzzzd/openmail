import { expect, it } from "vitest";
import { desktopEventRoute, editCommandRoute, type DesktopEvent } from "./desktop";

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
  receive({ _tag: "OpenThread", id: "message" });
  receive({
    _tag: "Compose",
    draft: { to: "to@example.com", cc: "", bcc: "", subject: "", body: "" },
  });
  busy = false;
  delivered.push(...deferred.splice(0));
  expect(delivered.map((event) => event._tag)).toEqual(["OpenThread", "Compose"]);
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
