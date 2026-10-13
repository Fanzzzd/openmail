import { describe, expect, it } from "vitest";
import { Cause } from "effect";
import { AsyncResult } from "effect/reactivity";

import type { Account } from "../../../../../shared/api";
import { activityClient, readableAccounts } from "./ai-clients-ui";

describe("AI app activity", () => {
  it("files MCP client names under the matching card", () => {
    expect(activityClient("claude-code")).toBe("claude-code");
    expect(activityClient("codex-mcp-client")).toBe("codex");
    expect(activityClient("claude-ai")).toBe("claude-desktop");
    expect(activityClient("cursor-vscode")).toBe("cursor");
    expect(activityClient("openmail-cli")).toBeNull();
  });
});

describe("accounts AI apps can read", () => {
  const account = (id: string, enabled = true): Account => ({
    id,
    provider: "gmail",
    email: id,
    createdAt: 0,
    lastSyncedAt: null,
    lastSyncError: null,
    profileId: null,
    needsReauth: false,
    enabled,
  });
  const accounts = [account("a"), account("b"), account("off", false)];

  it("never reports no consent while AI settings load or after they fail", () => {
    expect(readableAccounts(AsyncResult.initial(), accounts)).toEqual({ kind: "loading" });
    expect(readableAccounts(AsyncResult.failure(Cause.fail("keychain")), accounts)).toEqual({
      kind: "failed",
    });
  });

  it("lists enabled accounts with consent once settings load", () => {
    const settings = AsyncResult.success({
      keyConfigured: false,
      keyUnreadable: true,
      model: "claude-sonnet-5-5" as const,
      accounts: [
        { accountId: "a", allowed: true, autoSummaries: false },
        { accountId: "b", allowed: false, autoSummaries: false },
        { accountId: "off", allowed: true, autoSummaries: false },
      ],
    });
    expect(readableAccounts(settings, accounts)).toEqual({
      kind: "loaded",
      accounts: [accounts[0]],
    });
  });
});
