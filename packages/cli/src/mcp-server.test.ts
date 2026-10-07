import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { promisify } from "node:util";
import { Effect, Option, Schema } from "effect";
import { ThreadSummary } from "@openmail/core/schema";
import { Store, TestMailbox, incoming } from "@openmail/core/testing/node";

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
const run = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function client(allowWrites = false, cli = false, seed = false) {
  const directory = await mkdtemp(join(tmpdir(), "openmail-mcp-test-"));
  if (seed) await seedAttachmentMail(directory);
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
  return { request, directory };
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

test("write-mode help describes app-only permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmail-cli-policy-test-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const help = await run(process.execPath, ["dist/cli.js", "agents", "write-mode", "--help"], {
    env: { ...process.env, OPENMAIL_HOME: directory },
  });
  expect(help.stdout).toContain("Show agent write permissions");
  expect(help.stdout).not.toMatch(/<mode>|\[mode\]/);
});

test("write-mode status distinguishes MCP proposals from direct rule writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmail-cli-policy-test-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const status = await run(process.execPath, ["dist/cli.js", "agents", "write-mode"], {
    env: { ...process.env, OPENMAIL_HOME: directory },
  });
  expect(status.stdout).toContain("The mode can only be changed in the app");
  expect(status.stdout).toContain("Sending requires confirmation in the app");
});

describe.each(["allow", "propose"])("CLI write-mode %s", (mode) => {
  let directory: string;
  let options: { env: NodeJS.ProcessEnv };
  let failure: unknown;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "openmail-cli-app-policy-"));
    options = { env: { ...process.env, OPENMAIL_HOME: directory } };
    try {
      await run(process.execPath, ["dist/cli.js", "agents", "write-mode", mode], options);
    } catch (error) {
      failure = error;
    }
  });
  afterAll(() => rm(directory, { recursive: true, force: true }));

  test("rejects enabling writes", () => {
    expect(failure).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Agent write mode can only be changed in the app"),
    });
  });

  test("keeps the persisted write mode off after rejection", async () => {
    const status = await run(process.execPath, ["dist/cli.js", "agents", "write-mode"], options);
    expect(status.stdout).toContain("Agent write mode: off.");
  });
});

async function seedAttachmentMail(directory: string) {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* Store;
        const account = yield* store.upsertAccount("gmail", "ocr@example.com");
        yield* store.ai.setAccount({ accountId: account.id, allowed: true, autoSummaries: false });
        yield* store.upsertMessage(
          account.id,
          incoming("ocr", {
            subject: "Receipt",
            bodyText: "unrelated",
            attachments: [{ filename: "invoice.pdf", mimeType: "application/pdf", size: 10 }],
          }),
        );
        const job = yield* store.media.claim("test", 0, true);
        if (Option.isNone(job)) throw new Error("Missing OCR job");
        yield* store.media.complete(
          job.value,
          [
            {
              messageId: `${account.id}/ocr`,
              text: "total amount due",
              source: {
                kind: "attachment",
                index: 0,
                name: "invoice.pdf",
                mimeType: "application/pdf",
              },
              page: 1,
              region: null,
              pipelineVersion: "test",
              visionRevision: null,
            },
          ],
          null,
        );
        while (!(yield* store.backfillWordIndex(500)).ready) {
          /* finish actual indexes */
        }
      }).pipe(
        Effect.provide(
          TestMailbox({}, { backgroundFlush: false }, {}, undefined, {
            database: join(directory, "mail.db"),
          }),
        ),
      ),
    ),
  );
}

test("MCP and CLI search expose attachment snippets only inside the untrusted envelope", async () => {
  const { request, directory } = await client(false, false, true);
  const called = Schema.decodeUnknownSync(CallResult)(
    await request("tools/call", {
      name: "search",
      arguments: { query: "amount" },
    }),
  );
  expect(called.isError).not.toBe(true);
  const envelope = Schema.fromJsonString(
    Schema.Struct({
      notice: Schema.String,
      untrusted_mail: Schema.Struct({ threads: Schema.Array(ThreadSummary) }),
    }),
  );
  const fromMcp = Schema.decodeUnknownSync(envelope)(called.content[0]?.text);
  expect(fromMcp.notice).toContain("untrusted");
  expect(fromMcp.untrusted_mail.threads[0]?.searchMatches).toEqual([
    {
      source: "attachment",
      messageId: "gmail:ocr@example.com/ocr",
      attachmentName: "invoice.pdf",
      attachmentIndex: 0,
      snippet: "total amount due",
      highlights: [{ start: 6, end: 12 }],
    },
  ]);
  const { stdout } = await run(process.execPath, ["dist/cli.js", "search", "amount", "--json"], {
    env: { ...process.env, OPENMAIL_HOME: directory },
  });
  const fromCli = Schema.decodeUnknownSync(envelope)(stdout);
  expect(fromCli.untrusted_mail.threads[0]?.searchMatches).toEqual(
    fromMcp.untrusted_mail.threads[0]?.searchMatches,
  );
}, 30_000);
