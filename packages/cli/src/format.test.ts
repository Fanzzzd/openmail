import { describe, expect, it } from "vitest";
import type { Account, Message } from "@openmail/core";
import type { ThreadSummary } from "@openmail/core/schema";
import {
  accountTable,
  auditTable,
  messageText,
  proposalTable,
  stamp,
  threadTable,
} from "./format.js";

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

describe("CLI dates", () => {
  const at = new Date(2026, 9, 4, 7, 5).getTime();

  it("print local time as YYYY-MM-DD HH:MM whatever the system locale", () => {
    expect(stamp(at)).toBe("2026-10-04 07:05");
  });

  it("list, show and accounts list use the same format", () => {
    const summary = {
      id: "a/m1",
      accountId: "a",
      threadId: "t1",
      subject: "Plan",
      from: { name: "Priya", address: "priya@example.org" },
      date: at,
      snippet: "",
      labels: [],
      isUnread: false,
      isStarred: false,
      hasAttachments: false,
    };
    const thread: ThreadSummary = { ...summary, threadCount: 1, participants: [] };
    const message: Message = {
      ...summary,
      to: [],
      cc: [],
      bodyText: "",
      bodyHtml: "",
      attachments: [],
    };
    const account: Account = {
      id: "a",
      provider: "gmail",
      email: "a@example.com",
      createdAt: at,
      lastSyncedAt: at,
      lastSyncError: null,
      profileId: null,
      needsReauth: false,
    };
    expect(threadTable([thread])).toMatch(/^2026-10-04 07:05 /);
    expect(messageText(message)).toContain("Date:    2026-10-04 07:05\n");
    expect(accountTable([account])).toBe("a  last sync: 2026-10-04 07:05");
  });
});
