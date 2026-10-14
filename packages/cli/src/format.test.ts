import { describe, expect, it } from "vitest";
import { auditTable, proposalTable } from "./format.js";

const ESC = "\u001b";

describe("CLI tables", () => {
  it("print control characters in agent names and rationales as escapes", () => {
    const text = proposalTable([
      {
        id: 4,
        createdAt: 0,
        status: "pending",
        actor: {
          kind: "agent",
          surface: "mcp",
          name: `claude-code\n${ESC}[31mAPPROVED BY USER`,
          rationale: `tidy\n${ESC}[2J‮`,
        },
        command: { kind: "modify", threads: ["m1"], op: { kind: "archive" } },
      },
    ]);
    expect(text).not.toContain(ESC);
    expect(text).not.toContain("‮");
    expect(text).toContain("agent:mcp:claude-code\\u{a}\\u{1b}[31mAPPROVED BY USER");
    expect(text).toContain("why: tidy \\u{1b}[2J\\u{202e}");
    // Two lines per proposal, whatever the agent sent.
    expect(text.split("\n")).toHaveLength(3);
  });

  it("escape the actor column of the audit log", () => {
    const text = auditTable([
      {
        at: 0,
        actor: `agent:mcp:x${ESC}]0;title\u0007`,
        accountId: null,
        action: "proposed",
        detail: undefined,
      },
    ]);
    expect(text).not.toContain(ESC);
    expect(text).not.toContain("\u0007");
    expect(text).toContain("agent:mcp:x\\u{1b}]0;title\\u{7}");
  });
});
