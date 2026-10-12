import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { desktopRoot } from "../../renderer/src/test-support/paths";

const entry = path.join(desktopRoot, "out/main/index.js");

/** The app as an AI client starts it: none of the runner's Node options, no Electron logging. */
const clientEnv = (home: string) => {
  const env: Record<string, string> = { OPENMAIL_HOME: home };
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !/^(NODE_|VITEST|ELECTRON_|OPENMAIL_)/.test(key)) env[key] = value;
  return env;
};

const requests = [
  {
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1" },
    },
  },
  { method: "notifications/initialized" },
  { id: 2, method: "tools/list", params: {} },
  { id: 3, method: "tools/call", params: { name: "access_status", arguments: {} } },
];

// Claude Code and Codex read `OpenMail --mcp`'s stdout as the protocol stream: a Chromium log
// line or a banner there ends the session. Runs the built app (`pnpm build` first) with a
// scratch OPENMAIL_HOME and profile, never the real ones.
it.skipIf(!existsSync(entry))(
  "OpenMail --mcp writes only JSON-RPC frames to stdout from start to exit",
  async () => {
    const work = mkdtempSync(path.join(tmpdir(), "openmail-mcp-mode-"));
    try {
      // The electron package resolves to the path of its binary.
      const electron = String(createRequire(import.meta.url)("electron"));
      const child = spawn(
        electron,
        [desktopRoot, "--mcp", `--user-data-dir=${path.join(work, "profile")}`],
        { env: clientEnv(path.join(work, "home")), stdio: ["pipe", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
        // Close stdin, as a client does, once the last reply is in.
        if (stdout.includes('"id":3')) child.stdin.end();
      });
      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });
      const exited = new Promise<number | null>((resolve) => {
        child.once("exit", resolve);
      });
      for (const request of requests)
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...request })}\n`);
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      const code = await exited;
      clearTimeout(timer);
      expect(code, stderr).toBe(0);
      expect(stdout.endsWith("\n"), stdout).toBe(true);
      const frames = stdout
        .slice(0, -1)
        .split("\n")
        .map((line) => {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON-RPC frame read off a pipe
          const frame = JSON.parse(line) as { jsonrpc?: unknown; id?: unknown };
          expect(frame.jsonrpc, line).toBe("2.0");
          return frame;
        });
      expect(frames.map((frame) => frame.id)).toEqual(expect.arrayContaining([1, 2, 3]));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
  30_000,
);
