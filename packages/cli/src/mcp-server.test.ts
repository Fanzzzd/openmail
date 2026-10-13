import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, test, vi, type TestContext } from "vitest";
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
  structuredContent: Schema.optionalKey(Schema.Unknown),
  isError: Schema.optionalKey(Schema.Boolean),
});
const run = promisify(execFile);
// Tests and hooks start `node dist/cli.js` up to four times. Each start opens and migrates a
// database, about 1 s on a loaded machine, so the 5 s default fails without a real fault.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

// Each test waits on its own child processes, so tests run concurrently and only
// the slowest CLI start bounds the file. Cleanups belong to the test that made them.
async function home(onTestFinished: TestContext["onTestFinished"], prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function client(
  onTestFinished: TestContext["onTestFinished"],
  allowWrites = false,
  cli = false,
  seed: boolean | ((directory: string) => Promise<unknown>) = false,
  protocolVersion = "2024-11-05",
) {
  const directory = await mkdtemp(join(tmpdir(), "openmail-mcp-test-"));
  if (seed) await (seed === true ? seedAttachmentMail : seed)(directory);
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
  let output = "";
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
    output += data.toString();
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
  onTestFinished(async () => {
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
  const initialized = await request("initialize", {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "test-client", version: "1" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  /** Closes stdin as a client does and resolves with everything the server wrote to stdout. */
  const close = async () => {
    const exited =
      child.exitCode === null && child.signalCode === null
        ? new Promise<void>((resolve) => {
            child.once("exit", () => resolve());
          })
        : Promise.resolve();
    child.stdin.end();
    await exited;
    return { stdout: output, stderr };
  };
  return { request, directory, initialized, close };
}

const RpcFrame = Schema.fromJsonString(
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String, Schema.Null])),
    method: Schema.optionalKey(Schema.String),
    result: Schema.optionalKey(Schema.Unknown),
    error: Schema.optionalKey(Schema.Unknown),
  }),
);

// Clients read stdout as the protocol stream. A log line, banner or warning there breaks the
// session, so every byte the server writes, start to exit, must be a JSON-RPC 2.0 frame.
test.concurrent.for([
  ["openmail-mcp", false],
  ["openmail mcp", true],
] as const)(
  "%s writes only JSON-RPC frames to stdout from start to exit",
  async ([, cli], { expect, onTestFinished }) => {
    const { request, close } = await client(onTestFinished, false, cli, true);
    Schema.decodeUnknownSync(ToolList)(await request("tools/list"));
    Schema.decodeUnknownSync(CallResult)(
      await request("tools/call", { name: "access_status", arguments: {} }),
    );
    const { stdout } = await close();
    expect(stdout.endsWith("\n")).toBe(true);
    const lines = stdout.slice(0, -1).split("\n");
    for (const line of lines)
      expect(() => Schema.decodeUnknownSync(RpcFrame)(line), line).not.toThrow();
    // initialize, tools/list and access_status each got their reply.
    const ids = lines.map((line) => Schema.decodeUnknownSync(RpcFrame)(line).id);
    expect(ids).toEqual(expect.arrayContaining([1, 2, 3]));
  },
  30_000,
);

// Clients put tools/list in the model's context on every turn, so it has a byte budget.
test.concurrent("tools/list stays small and each description is two or three short sentences", async ({
  expect,
  onTestFinished,
}) => {
  const { request } = await client(onTestFinished);
  const listed = await request("tools/list");
  expect(Buffer.byteLength(JSON.stringify(listed))).toBeLessThanOrEqual(20 * 1024);
  const { tools } = Schema.decodeUnknownSync(
    Schema.Struct({
      tools: Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.String })),
    }),
  )(listed);
  for (const tool of tools) expect(tool.description.length, tool.name).toBeLessThanOrEqual(400);
}, 30_000);

// MCP 2025-06-18 and later: a tool with an outputSchema returns structuredContent, and SHOULD
// also return the same JSON as text for clients that only read content.
test.concurrent("results carry structuredContent and the same JSON once as text", async ({
  expect,
  onTestFinished,
}) => {
  const { request } = await client(onTestFinished, false, false, true, "2025-06-18");
  const called = Schema.decodeUnknownSync(CallResult)(
    await request("tools/call", { name: "list_accounts", arguments: {} }),
  );
  expect(called.structuredContent).toMatchObject({ untrusted_mail: { accounts: [{}] } });
  expect(called.content).toHaveLength(1);
  expect(JSON.parse(called.content[0]?.text ?? "")).toEqual(called.structuredContent);
}, 30_000);

test.concurrent("CLI help lists each tool by its first sentence and shows the rest in its own help", async ({
  expect,
  onTestFinished,
}) => {
  const directory = await home(onTestFinished, "openmail-cli-help-test-");
  const options = { env: { ...process.env, OPENMAIL_HOME: directory } };
  const [top, own] = await Promise.all([
    run(process.execPath, ["dist/cli.js", "--help"], options),
    run(process.execPath, ["dist/cli.js", "read-thread", "--help"], options),
  ]);
  const first =
    "Read a conversation as plain text, oldest message first, without quoted history, signatures or attachments";
  expect(top.stdout).toContain(first);
  expect(top.stdout).not.toContain("Use a message id from list_threads or search.");
  expect(own.stdout).toContain("Use a message id from list_threads or search.");
});

test.concurrent("stdio MCP defaults to read-only tools, calls the shared Toolkit and rejects hidden writes", async ({
  expect,
  onTestFinished,
}) => {
  const { request } = await client(onTestFinished);
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

test.concurrent("openmail mcp --allow-writes exposes only supported proposals and still checks app policy", async ({
  expect,
  onTestFinished,
}) => {
  const { request } = await client(onTestFinished, true, true);
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
  expect(called.isError).toBe(true);
  expect(JSON.parse(called.content[0]?.text ?? "")).toEqual({
    message: "Account missing is unknown, turned off, or does not allow AI access.",
    code: "no_ai_consent",
    hint: expect.stringContaining("access_status"),
  });
}, 30_000);

const Initialized = Schema.Struct({ instructions: Schema.String });
// access_status reads no mail, so its fields sit at the top level, not under untrusted_mail.
const AccessStatus = Schema.fromJsonString(
  Schema.Struct({
    client: Schema.String,
    readable_accounts: Schema.Array(Schema.Struct({ id: Schema.String })),
    proposal_tools: Schema.Boolean,
    write_mode: Schema.String,
    read_only_session: Schema.Boolean,
    next_steps: Schema.Array(Schema.String),
  }),
);

test.concurrent("MCP points the model at access_status and explains a refused proposal", async ({
  expect,
  onTestFinished,
}) => {
  const { request, initialized } = await client(onTestFinished, true, false, true);
  const { instructions } = Schema.decodeUnknownSync(Initialized)(initialized);
  expect(instructions).toContain("Start with access_status");
  expect(instructions).toContain("modify_threads, snooze_threads and draft_message");
  const called = Schema.decodeUnknownSync(CallResult)(
    await request("tools/call", { name: "access_status", arguments: {} }),
  );
  const status = Schema.decodeUnknownSync(AccessStatus)(called.content[0]?.text);
  expect(status.client).toBe("test-client");
  expect(status.readable_accounts.map((a) => a.id)).toEqual(["gmail:ocr@example.com"]);
  expect(status.proposal_tools).toBe(true);
  expect(status.write_mode).toBe("off");
  // Proposal tools are listed, but write_mode off means this session cannot change mail.
  expect(status.read_only_session).toBe(true);
  expect(status.next_steps.join(" ")).toContain("Read only");
  const refused = Schema.decodeUnknownSync(CallResult)(
    await request("tools/call", {
      name: "modify_threads",
      arguments: { thread_ids: ["gmail:ocr@example.com/ocr"], action: "archive", rationale: "t" },
    }),
  );
  // A refused change is a tool error, so the model does not report it as done.
  expect(refused.isError).toBe(true);
  const failure = JSON.parse(refused.content[0]?.text ?? "");
  expect(failure).toMatchObject({ code: "denied" });
  expect(failure).not.toHaveProperty("_tag");
  expect(failure.message).toContain(
    "The AI permission to change mail is Read only, so nothing changed.",
  );
  expect(failure.hint).toContain("Settings → AI Access");
}, 30_000);

test.concurrent("write-mode help describes app-only permissions", async ({
  expect,
  onTestFinished,
}) => {
  const directory = await home(onTestFinished, "openmail-cli-policy-test-");
  const help = await run(process.execPath, ["dist/cli.js", "agents", "write-mode", "--help"], {
    env: { ...process.env, OPENMAIL_HOME: directory },
  });
  expect(help.stdout).toContain("Show agent write permissions");
  expect(help.stdout).not.toMatch(/<mode>|\[mode\]/);
});

test.concurrent("write-mode status distinguishes MCP proposals from direct rule writes", async ({
  expect,
  onTestFinished,
}) => {
  const directory = await home(onTestFinished, "openmail-cli-policy-test-");
  const status = await run(process.execPath, ["dist/cli.js", "agents", "write-mode"], {
    env: { ...process.env, OPENMAIL_HOME: directory },
  });
  expect(status.stdout).toContain("The mode can only be changed in the app");
  expect(status.stdout).toContain("Sending requires confirmation in the app");
});

// The rejection runs under the hook timeout; each test then waits on at most one CLI start.
describe.concurrent.each(["allow", "propose"])("CLI write-mode %s", (mode) => {
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

  test("rejects enabling writes", ({ expect }) => {
    expect(failure).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Agent write mode can only be changed in the app"),
    });
  });

  test("keeps the persisted write mode off after rejection", async ({ expect }) => {
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

test.concurrent("MCP and CLI search expose attachment snippets only inside the untrusted envelope", async ({
  expect,
  onTestFinished,
}) => {
  const { request, directory } = await client(onTestFinished, false, false, true);
  // The CLI reads the same seeded database while the MCP server answers.
  const cli = run(process.execPath, ["dist/cli.js", "search", "amount", "--json"], {
    env: { ...process.env, OPENMAIL_HOME: directory },
  });
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
  const { stdout } = await cli;
  const fromCli = Schema.decodeUnknownSync(envelope)(stdout);
  expect(fromCli.untrusted_mail.threads[0]?.searchMatches).toEqual(
    fromMcp.untrusted_mail.threads[0]?.searchMatches,
  );
}, 30_000);

/** One account with a message and no AI consent. */
async function seedWithoutConsent(directory: string) {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* Store;
        const account = yield* store.upsertAccount("gmail", "plain@example.com");
        yield* store.upsertMessage(account.id, incoming("m1", { subject: "Hello" }));
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

const Failure = Schema.Struct({
  code: Schema.Number,
  stdout: Schema.String,
  stderr: Schema.String,
});

test.concurrent("CLI mail tools explain a missing account or AI consent; MCP keeps empty results", async ({
  expect,
  onTestFinished,
}) => {
  const { request, directory } = await client(onTestFinished, false, false, seedWithoutConsent);
  const options = { env: { ...process.env, OPENMAIL_HOME: directory } };
  const cli = (...args: string[]) =>
    run(process.execPath, ["dist/cli.js", ...args], options).then(
      (done) => ({ code: 0, ...done }),
      (error: unknown) => Schema.decodeUnknownSync(Failure)(error),
    );
  const [list, typo, json, read, mcpList, mcpTypo] = await Promise.all([
    cli("list"),
    cli("list", "--account", "gmail:typo@example.com"),
    cli("list", "--json"),
    cli("read-thread", "--input-json", '{"id":"missing"}'),
    request("tools/call", { name: "list_threads", arguments: {} }),
    request("tools/call", {
      name: "list_threads",
      arguments: { account_id: "gmail:typo@example.com" },
    }),
  ]);
  expect(list.code).toBe(1);
  expect(list.stderr).toContain(
    "No accounts allow agent reads. Turn on 'Allow sending mail text to the model' in Settings → AI Access.",
  );
  expect(typo.code).toBe(1);
  expect(typo.stderr).toContain("No account with id gmail:typo@example.com.");
  expect(json.code).toBe(1);
  expect(JSON.parse(json.stdout)).toEqual({
    message: expect.stringContaining("No accounts allow agent reads."),
    code: "no_ai_consent",
    hint: expect.stringContaining("access-status"),
  });
  // A tool error prints its message, not the encoded failure.
  expect(read).toMatchObject({ code: 1, stdout: "" });
  expect(read.stderr).toContain("error: No message with id missing.");
  expect(read.stderr).not.toContain("_tag");
  for (const result of [mcpList, mcpTypo]) {
    const called = Schema.decodeUnknownSync(CallResult)(result);
    expect(called.isError).not.toBe(true);
    expect(called.content[0]?.text).toContain('"threads":[]');
  }
}, 30_000);

/** A consenting account outside any profile and a Work profile whose one account has no consent. */
async function seedProfileWithoutConsent(directory: string) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* Store;
        const home = yield* store.upsertAccount("gmail", "home@example.com");
        yield* store.ai.setAccount({ accountId: home.id, allowed: true, autoSummaries: false });
        yield* store.upsertMessage(home.id, incoming("m1", { subject: "Hello" }));
        const work = yield* store.upsertAccount("gmail", "work@example.com");
        yield* store.upsertMessage(work.id, incoming("m2", { subject: "Standup" }));
        const profile = yield* store.createProfile({ name: "Work", icon: "💼", color: "blue" });
        yield* store.setAccountProfile(work.id, profile.id);
        return { profile: profile.id, home: home.id };
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

test.concurrent("CLI list --profile explains a profile without AI consent", async ({
  expect,
  onTestFinished,
}) => {
  const directory = await home(onTestFinished, "openmail-cli-profile-");
  const { profile, home: homeAccount } = await seedProfileWithoutConsent(directory);
  const options = { env: { ...process.env, OPENMAIL_HOME: directory } };
  const cli = (...args: string[]) =>
    run(process.execPath, ["dist/cli.js", ...args], options).then(
      (done) => ({ code: 0, ...done }),
      (error: unknown) => Schema.decodeUnknownSync(Failure)(error),
    );
  const [all, inProfile, unknown, outside] = await Promise.all([
    cli("list"),
    cli("list", "--profile", profile),
    cli("list", "--profile", "nope"),
    cli("list", "--profile", profile, "--account", homeAccount),
  ]);
  // Another account has consent, so the unscoped list works.
  expect(all.code).toBe(0);
  expect(inProfile.code).toBe(1);
  expect(inProfile.stderr).toContain(
    `No accounts in profile ${profile} allow agent reads. Turn on 'Allow sending mail text to the model' in Settings → AI Access.`,
  );
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain("No profile with id nope.");
  expect(outside.code).toBe(1);
  expect(outside.stderr).toContain(`Account ${homeAccount} is not in profile ${profile}.`);
}, 30_000);

async function seedProposals(directory: string) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* Store;
        const rule = { kind: "agent", surface: "rule", name: "rule", rationale: "auto" } as const;
        const archive = yield* store.insertProposal(rule, {
          kind: "modify",
          threads: ["gmail:a@example.com/t1"],
          op: { kind: "archive" },
        });
        const send = yield* store.insertProposal(rule, {
          kind: "send",
          accountId: "gmail:a@example.com",
          message: { to: [], cc: [], bcc: [], subject: "Re", text: "ok", attachments: [] },
        });
        return { archive, send };
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

test.concurrent("proposals approve needs a terminal or --yes, and never approves a message", async ({
  expect,
  onTestFinished,
}) => {
  const directory = await home(onTestFinished, "openmail-cli-approve-test-");
  const { archive, send } = await seedProposals(directory);
  const options = { env: { ...process.env, OPENMAIL_HOME: directory } };
  const approve = (...args: string[]) =>
    run(process.execPath, ["dist/cli.js", "proposals", "approve", ...args], options);
  // execFile gives the child a pipe for stdin, not a terminal.
  await expect(approve(String(archive))).rejects.toMatchObject({
    stderr: expect.stringContaining("interactive terminal"),
  });
  await expect(approve(String(send), "--yes")).rejects.toMatchObject({
    stderr: expect.stringContaining("does not approve or send mail"),
  });
  const list = await run(process.execPath, ["dist/cli.js", "proposals", "list"], options);
  expect(list.stdout.match(/pending/g)).toHaveLength(2);
});
