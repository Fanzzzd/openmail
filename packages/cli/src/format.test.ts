import { describe, expect, it } from "vitest";
import type { Account, Message } from "@openmail/core";
import type { ThreadSummary } from "@openmail/core/schema";
import {
  accountTable,
  auditTable,
  messageText,
  proposalTable,
  stamp,
  signInCommand,
  syncFailedHint,
  syncTable,
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

  it("show prints escape and bidi sequences from mail as escapes, keeping line breaks", () => {
    const OSC = `${ESC}]8;;https://evil.example${ESC}\\`;
    const message: Message = {
      id: "gmail:a/m1",
      accountId: "gmail:a",
      threadId: "t1",
      subject: `Invoice ${ESC}[2J\u202eFDP.exe`,
      from: { name: `Bank${ESC}[31m`, address: "bank@example.com" },
      to: [{ name: "", address: `me@example.com${ESC}[8m` }],
      cc: [],
      date: 0,
      snippet: "",
      labels: [],
      isUnread: false,
      isStarred: false,
      hasAttachments: true,
      bodyText: `Hello\r\n\t${OSC}click${ESC}]8;;${ESC}\\\n\u2067hidden\u2069 ${ESC}[1A\u0007end 👩‍💻`,
      bodyHtml: "",
      attachments: [{ filename: `a${ESC}[0m.pdf`, mimeType: "application/pdf", size: 1 }],
    };
    const text = messageText(message);
    expect(text).not.toContain(ESC);
    expect(text).not.toContain("\u0007");
    expect(text).not.toMatch(/[\u202a-\u202e\u2066-\u2069\r]/u);
    expect(text).toContain("Subject: Invoice \\u{1b}[2J\\u{202e}FDP.exe");
    expect(text).toContain("From:    Bank\\u{1b}[31m <bank@example.com>");
    expect(text).toContain("Attach:  a\\u{1b}[0m.pdf");
    expect(text).toContain("Hello\n\t\\u{1b}]8;;https://evil.example\\u{1b}\\click");
    expect(text).toContain("\\u{2067}hidden\\u{2069} \\u{1b}[1A\\u{7}end 👩‍💻");
  });
});

// The hint said to run sync again with --log-level warn even when every failed account only
// needed a new sign-in, which a rerun never fixes.
describe("syncFailedHint", () => {
  const ok = { accountId: "gmail:a@example.com", changed: 0, deleted: 0 };
  const signIn = {
    ...ok,
    accountId: "gmail:b@example.com",
    error: "Sign in again",
    needsReauth: true,
  };
  const broken = { ...ok, accountId: "imap:c@example.org", error: "Sync could not finish." };
  const terminal = { json: false, verbose: false };

  it("names sign-in when every failed account needs it", () => {
    expect(syncFailedHint([ok, signIn], terminal)).toBe("Sign in again with the commands above.");
    expect(syncFailedHint([signIn], { json: true, verbose: false })).toBe(
      "Sign in again with `openmail accounts reauth <account_id>` for each result with needs_reauth.",
    );
  });

  it("keeps the rerun hint when no failed account needs sign-in", () => {
    expect(syncFailedHint([ok, broken], terminal)).toBe(
      "Run it again, or add --log-level warn to see why.",
    );
  });

  it("covers both when some need sign-in and others failed", () => {
    expect(syncFailedHint([signIn, broken], terminal)).toBe(
      "Sign in again with the commands above. Run sync again for the other accounts, or add --log-level warn to see why.",
    );
  });
});

// Every sign-in line said `openmail accounts reauth <id>`, which refuses IMAP accounts.
describe("sign-in commands", () => {
  const imap = {
    preset: "custom",
    username: "login name",
    imapHost: "mail.example.org",
    imapPort: 993,
    smtpHost: "smtp.example.org",
    smtpPort: 587,
    smtpSecure: false,
  };
  const account: Account = {
    id: "imap:c@example.org",
    provider: "imap",
    email: "c@example.org",
    createdAt: 0,
    lastSyncedAt: null,
    lastSyncError: null,
    profileId: null,
    needsReauth: true,
    imap,
  };

  it("adds an IMAP address again with its stored server settings", () => {
    expect(signInCommand("gmail:a@example.com")).toBe(
      "openmail accounts reauth gmail:a@example.com",
    );
    expect(
      signInCommand(account.id, { ...imap, preset: "icloud", username: "c@example.org" }),
    ).toBe("openmail accounts add imap --preset icloud --email c@example.org");
    expect(signInCommand(account.id)).toBe(
      "openmail accounts add imap --preset <preset> --email c@example.org",
    );
    const custom =
      "openmail accounts add imap --preset custom --email c@example.org --username 'login name' --imap-host mail.example.org --imap-port 993 --smtp-host smtp.example.org --smtp-port 587 --no-smtp-secure";
    expect(signInCommand(account.id, imap)).toBe(custom);
    expect(accountTable([account])).toBe(
      `imap:c@example.org  last sync: never  needs sign-in: ${custom}`,
    );
    const result = { accountId: account.id, changed: 0, deleted: 0, error: "x", needsReauth: true };
    expect(syncTable([result], [account])).toBe(`imap:c@example.org  needs sign-in: ${custom}`);
    expect(syncFailedHint([result], { json: true, verbose: false })).toBe(
      "Sign in again with `openmail accounts add imap --preset <preset> --email <address>` for each result with needs_reauth.",
    );
    const gmail = { ...result, accountId: "gmail:a@example.com" };
    expect(syncFailedHint([result, gmail], { json: true, verbose: false })).toContain(
      "`openmail accounts reauth <account_id>`, or for an imap account `openmail accounts add imap",
    );
  });
});
