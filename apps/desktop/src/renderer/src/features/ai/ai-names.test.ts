import { setupI18n } from "@lingui/core";
import { MailToolkit } from "@openmail/core";
import { expect, it } from "vitest";
import { AI_TOOL_IDS, aiClientName, aiToolName, changeSource } from "./ai-names";

const i18n = setupI18n({ locale: "en", messages: { en: {} } });
i18n.activate("en");

it("names AI apps, change sources and tool calls the way people see them, not by their ids", () => {
  expect(aiClientName("claude-code")).toBe("Claude Code");
  expect(aiClientName("codex-mcp-client")).toBe("Codex");
  expect(aiClientName("my-own-client")).toBe("my-own-client");
  expect(changeSource(i18n, { kind: "agent", surface: "mcp", name: "claude-code" })).toBe(
    "AI app · Claude Code",
  );
  expect(changeSource(i18n, { kind: "agent", surface: "rule", name: "openmail-assistant" })).toBe(
    "Assistant",
  );
  expect(changeSource(i18n, { kind: "user", surface: "app" })).toBe("OpenMail");
  expect(changeSource(i18n, { kind: "user", surface: "cli" })).toBe("Command line");
  expect(aiToolName(i18n, "modify_threads")).toBe("Suggest changes to conversations");
  expect(aiToolName(i18n, "new_tool_name")).toBe("New tool name");
});

it("has a plain name for every MCP tool", () => {
  expect(AI_TOOL_IDS.toSorted()).toEqual(Object.keys(MailToolkit.tools).toSorted());
});
