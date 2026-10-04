import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { promisify } from "node:util";
import { Schema } from "effect";

const Frame = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Unknown),
});
const ToolList = Schema.Struct({
  tools: Schema.Array(Schema.Struct({ name: Schema.String, inputSchema: Schema.Unknown })),
});
const CallResult = Schema.Struct({
  content: Schema.Array(
    Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) }),
  ),
  isError: Schema.optionalKey(Schema.Boolean),
});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function client(allowWrites = false, cli = false) {
  const directory = await mkdtemp(join(tmpdir(), "openmail-mcp-test-"));
  const child = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      cli ? "dist/cli.js" : "dist/mcp.js",
      ...(cli ? ["mcp"] : []),
      ...(allowWrites ? ["--allow-writes"] : []),
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, OPENMAIL_HOME: directory },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let buffer = "";
  let stderr = "";
  let id = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  child.stderr.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  child.stdout.on("data", (data: Buffer) => {
    buffer += data.toString();
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const frame = Schema.decodeUnknownSync(Schema.fromJsonString(Frame))(line);
        if (typeof frame.id === "number") {
          const handler = pending.get(frame.id);
          pending.delete(frame.id);
          if (frame.error) handler?.reject(new Error(JSON.stringify(frame.error)));
          else handler?.resolve(frame.result);
        }
      } catch (error) {
        for (const handler of pending.values())
          handler.reject(new Error(`Non-protocol stdout: ${line}`, { cause: error }));
        pending.clear();
      }
    }
  });
  child.once("exit", (code) => {
    for (const handler of pending.values())
      handler.reject(new Error(`MCP exited ${code}: ${stderr}`));
    pending.clear();
  });
  cleanups.push(async () => {
    child.kill();
    if (child.exitCode === null && child.signalCode === null)
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
    await rm(directory, { recursive: true, force: true });
  });
  const request = (method: string, params: unknown = {}) =>
    new Promise<unknown>((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`Timeout in ${method}: ${stderr}`));
      }, 15_000);
      pending.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
    });
  await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-client", version: "1" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return { request };
}

test("stdio MCP defaults to read-only tools, calls the shared Toolkit and rejects hidden writes", async () => {
  const { request } = await client();
  const list = Schema.decodeUnknownSync(ToolList)(await request("tools/list"));
  expect(list.tools.map((tool) => tool.name)).toContain("attachment_text");
  expect(list.tools.map((tool) => tool.name)).not.toContain("modify_threads");
  const called = Schema.decodeUnknownSync(CallResult)(
    await request("tools/call", { name: "list_accounts", arguments: {} }),
  );
  expect(called.isError).not.toBe(true);
  expect(called.content[0]?.text).toContain('"accounts":[]');
  await expect(
    request("tools/call", {
      name: "modify_threads",
      arguments: { thread_ids: ["missing"], action: "archive", rationale: "test" },
    }),
  ).rejects.toThrow();
}, 30_000);

test("openmail mcp --allow-writes exposes only supported proposals and still checks app policy", async () => {
  const { request } = await client(true, true);
  const list = Schema.decodeUnknownSync(ToolList)(await request("tools/list"));
  expect(list.tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(["modify_threads", "snooze_threads", "draft_message"]),
  );
  expect(list.tools.some((tool) => /send|delete|approve|settings|rule|oauth/.test(tool.name))).toBe(
    false,
  );
  const called = Schema.decodeUnknownSync(CallResult)(
    await request("tools/call", {
      name: "draft_message",
      arguments: {
        account_id: "missing",
        to: ["a@example.com"],
        subject: "s",
        body: "b",
        rationale: "test",
      },
    }),
  );
  expect(called.content[0]?.text).toContain("enabled account with AI consent");
}, 30_000);

test("write-mode help and status distinguish MCP proposals from direct rule writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmail-cli-policy-test-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const run = promisify(execFile);
  const options = { env: { ...process.env, OPENMAIL_HOME: directory } };
  const help = await run(
    process.execPath,
    ["dist/cli.js", "agents", "write-mode", "--help"],
    options,
  );
  expect(help.stdout).toContain("Show agent write permissions");
  expect(help.stdout).not.toMatch(/<mode>|\[mode\]/);
  const status = await run(process.execPath, ["dist/cli.js", "agents", "write-mode"], options);
  expect(status.stdout).toContain("The mode can only be changed in the app");
  expect(status.stdout).toContain("Sending requires confirmation in the app");
});

test("CLI write-mode cannot enable writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmail-cli-app-policy-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const run = promisify(execFile);
  const options = { env: { ...process.env, OPENMAIL_HOME: directory } };
  for (const mode of ["allow", "propose"]) {
    await expect(
      run(process.execPath, ["dist/cli.js", "agents", "write-mode", mode], options),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Agent write mode can only be changed in the app"),
    });
    const status = await run(process.execPath, ["dist/cli.js", "agents", "write-mode"], options);
    expect(status.stdout).toContain("Agent write mode: off.");
  }
});
