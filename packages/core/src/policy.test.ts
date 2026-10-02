import { expect, it } from "vitest";
import type { Actor, Command } from "./domain.js";
import { decide } from "./policy.js";

const actor: Actor = { kind: "agent", surface: "mcp", name: "openmail-assistant" };
const message = { to: [], cc: [], bcc: [], subject: "s", text: "t", attachments: [] };

it("MCP only proposes supported commands when writes are enabled", () => {
  const supported: Command[] = [
    { kind: "modify", threads: ["m1"], op: { kind: "archive" } },
    { kind: "modify", threads: ["m1"], op: { kind: "read", value: false } },
    { kind: "modify", threads: ["m1"], op: { kind: "star", value: true } },
    { kind: "modify", threads: ["m1"], op: { kind: "label", labelId: "Label_1", value: true } },
    { kind: "snooze", threads: ["m1"], due: 1000 },
    { kind: "draft", accountId: "a", message },
  ];
  for (const command of supported) {
    expect(decide(command, actor, "off").status).toBe("denied");
    for (const mode of ["propose", "allow"] as const)
      expect(decide(command, actor, mode)).toEqual({ status: "proposed" });
  }
});

it("MCP denies send, account removal, unsupported operations and unknown future kinds", () => {
  const denied: Command[] = [
    { kind: "send", accountId: "a", message },
    { kind: "removeAccount", accountId: "a" },
    { kind: "modify", threads: ["m1"], op: { kind: "trash" } },
    {
      kind: "modify",
      threads: ["m1"],
      op: { kind: "move", labelId: "folder", removeLabelId: null },
    },
  ];
  for (const mode of ["off", "propose", "allow"] as const) {
    for (const command of denied) expect(decide(command, actor, mode).status).toBe("denied");
    // Exercise an untyped runtime caller without claiming a future command is a current Command.
    const future: unknown = Reflect.apply(decide, undefined, [
      { kind: "createCalendarEvent" },
      actor,
      mode,
    ]);
    expect(future).toMatchObject({ status: "denied" });
  }
});

it("non-MCP rules retain direct organization and proposed-send policy", () => {
  const rule: Actor = { kind: "agent", surface: "rule", name: "rule" };
  expect(
    decide({ kind: "modify", threads: ["m1"], op: { kind: "archive" } }, rule, "allow"),
  ).toEqual({ status: "applied" });
  expect(decide({ kind: "send", accountId: "a", message }, rule, "allow")).toEqual({
    status: "proposed",
  });
});
