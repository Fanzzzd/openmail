import { describe, expect, it } from "vitest";

import { activityClient } from "./AiClientsSettings";

describe("AI app activity", () => {
  it("files MCP client names under the matching card", () => {
    expect(activityClient("claude-code")).toBe("claude-code");
    expect(activityClient("codex-mcp-client")).toBe("codex");
    expect(activityClient("claude-ai")).toBe("claude-desktop");
    expect(activityClient("cursor-vscode")).toBe("cursor");
    expect(activityClient("openmail-cli")).toBeNull();
  });
});
