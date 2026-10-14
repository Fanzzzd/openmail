import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, test, vi, type TestContext } from "vitest";
import { promisify } from "node:util";
import { Effect, Option, Schema } from "effect";
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

test.concurrent("CLI help keeps tools under `tool`, lists each by its first sentence and stays stable", async ({
  expect,
  onTestFinished,
}) => {
  const directory = await home(onTestFinished, "openmail-cli-help-test-");
  const options = { env: { ...process.env, OPENMAIL_HOME: directory } };
  const help = (...args: string[]) =>
    run(process.execPath, ["dist/cli.js", ...args, "--help"], options).then((r) => r.stdout);
  const [top, tool, own, proposal, list] = await Promise.all([
    help(),
    help("tool"),
    help("tool", "read_thread"),
    help("tool", "draft_message"),
    help("list"),
  ]);
  // --space is documented; the old --profile still parses but is hidden.
  expect(list).toContain("--space");
  expect(list).not.toContain("--profile");
  const first =
    "Read a conversation as plain text, oldest message first, without quoted history, signatures or attachments";
  // The top level lists commands for people; agent tools sit under `openmail tool`.
  expect(top).not.toContain("read-thread");
  expect(top).not.toContain(first);
  expect(top).not.toContain("--profile");
  expect(top).toMatchSnapshot();
  expect(tool).toContain(`read_thread         ${first}`);
  expect(tool).not.toContain("Use a message id from list_threads or search.");
  expect(tool).toMatchSnapshot();
  expect(own).toContain("Use a message id from list_threads or search.");
  // --allow-writes appears only where it does something.
  expect(own).not.toContain("--allow-writes");
  expect(proposal).toContain("--allow-writes");
  // Usage errors exit 2 with a short message on stderr and nothing on stdout.
  await expect(
    run(process.execPath, ["dist/cli.js", "read-thread", "--input-json", "{}"], options),
  ).rejects.toMatchObject({ code: 2, stdout: "" });
  await expect(
    run(
      process.execPath,
      ["dist/cli.js", "tool", "read_thread", "--allow-writes", "--input-json", "{}"],
      options,
    ),
  ).rejects.toMatchObject({
    code: 2,
    stdout: "",
    stderr:
      "error: Unrecognized flag: --allow-writes in command openmail tool read_thread\nUsage: openmail tool read_thread [flags]\nRun `openmail tool read_thread --help` for details.\n",
  });
  await expect(
    run(process.execPath, ["dist/cli.js", "spaces", "assign"], options),
  ).rejects.toMatchObject({
    code: 2,
    stdout: "",
    stderr: expect.stringMatching(/^error: Missing required argument: account-id\nUsage: /),
  });
  // Every flag says what it takes.
  const google = await help("config", "google");
  expect(google).toContain("--client-id string        Client ID of your Desktop app OAuth client");
  expect(google).toContain("--client-secret string    Client secret");
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
    message: "No readable account with id missing.",
    code: "not_found",
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
  expect(failure.message).toContain("Changes by AI apps is Read only, so nothing changed.");
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

test.concurrent("MCP and CLI tool search expose attachment snippets only inside the untrusted envelope", async ({
  expect,
  onTestFinished,
}) => {
  const { request, directory } = await client(onTestFinished, false, false, true);
  // The CLI reads the same seeded database while the MCP server answers.
  const cli = run(
    process.execPath,
    ["dist/cli.js", "tool", "search", "--input-json", '{"query":"amount"}', "--json"],
    { env: { ...process.env, OPENMAIL_HOME: directory } },
  );
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
      untrusted_mail: Schema.Struct({
        threads: Schema.Array(Schema.Struct({ search_matches: Schema.Unknown })),
      }),
    }),
  );
  const fromMcp = Schema.decodeUnknownSync(envelope)(called.content[0]?.text);
  expect(fromMcp.notice).toContain("untrusted");
  expect(fromMcp.untrusted_mail.threads[0]?.search_matches).toEqual([
    {
      source: "attachment",
      message_id: "gmail:ocr@example.com/ocr",
      attachment_name: "invoice.pdf",
      attachment_index: 0,
      snippet: "total amount due",
      highlights: [{ start: 6, end: 12 }],
    },
  ]);
  const { stdout } = await cli;
  const fromCli = Schema.decodeUnknownSync(envelope)(stdout);
  expect(fromCli.untrusted_mail.threads[0]?.search_matches).toEqual(
    fromMcp.untrusted_mail.threads[0]?.search_matches,
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

test.concurrent("list, search and show read as the person; agent tools still need AI consent", async ({
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
  const [list, json, search, show, typo, tool, toolJson, read, mcpList, mcpTypo, extraKey] =
    await Promise.all([
      cli("list"),
      cli("list", "--json"),
      cli("search", "Hello"),
      cli("show", "gmail:plain@example.com/m1"),
      cli("list", "--account", "gmail:typo@example.com"),
      cli("tool", "list_threads"),
      cli("tool", "list_threads", "--json"),
      cli("tool", "read_thread", "--input-json", '{"id":"missing"}'),
      request("tools/call", { name: "list_threads", arguments: {} }),
      request("tools/call", {
        name: "list_threads",
        arguments: { account_id: "gmail:typo@example.com" },
      }),
      cli("tool", "list_threads", "--input-json", '{"acount_id":"zzz"}', "--json"),
    ]);
  // People see a table: date, sender, subject and the id `show` takes. No JSON envelope.
  expect(list.code).toBe(0);
  expect(list.stdout).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d .*Hello.*gmail:plain@example\.com\/m1$/m);
  expect(list.stdout).not.toContain("untrusted_mail");
  // CLI JSON uses snake_case keys like MCP and next_cursor, at any depth.
  expect(JSON.parse(json.stdout)).toMatchObject({
    threads: [
      {
        id: "gmail:plain@example.com/m1",
        subject: "Hello",
        account_id: "gmail:plain@example.com",
        is_unread: expect.any(Boolean),
      },
    ],
  });
  expect(json.stdout).not.toMatch(/"[a-z]+[A-Z]\w*":/);
  expect(search.code).toBe(0);
  expect(search.stdout).toContain("gmail:plain@example.com/m1");
  expect(show.code).toBe(0);
  expect(show.stdout).toContain("Subject: Hello");
  expect(typo.code).toBe(1);
  expect(typo.stderr).toContain("No account with id gmail:typo@example.com.");
  // `openmail tool` runs as an agent, so consent applies and the error says where to turn it on.
  expect(tool.code).toBe(1);
  expect(tool.stderr).toContain(
    "No accounts allow agent reads. Turn on 'Allow AI to read this account' in Settings → AI Access.",
  );
  expect(JSON.parse(toolJson.stdout)).toEqual({
    message: expect.stringContaining("No accounts allow agent reads."),
    code: "no_ai_consent",
    hint: expect.stringContaining("openmail tool access_status"),
  });
  // A tool error prints its message, not the encoded failure.
  expect(read).toMatchObject({ code: 1, stdout: "" });
  expect(read.stderr).toContain("error: No message with id missing.");
  expect(read.stderr).not.toContain("_tag");
  // --input-json rejects keys the tool does not declare, like MCP.
  expect(extraKey.code).toBe(1);
  expect(extraKey.stderr).toContain(
    'error: Unknown parameter: "acount_id" (did you mean "account_id"?).',
  );
  expect(JSON.parse(extraKey.stdout)).toMatchObject({ code: "invalid_input" });
  // MCP: no readable account is an empty list (access_status explains); a bad id is not_found.
  const empty = Schema.decodeUnknownSync(CallResult)(mcpList);
  expect(empty.isError).not.toBe(true);
  expect(empty.content[0]?.text).toContain('"threads":[]');
  const missing = Schema.decodeUnknownSync(CallResult)(mcpTypo);
  expect(missing.isError).toBe(true);
  expect(JSON.parse(missing.content[0]?.text ?? "")).toMatchObject({
    code: "not_found",
    hint: expect.stringContaining("list_accounts"),
  });
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

test.concurrent("CLI list --space reads as the person; tool list_threads checks consent per space", async ({
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
  const tool = (input: object) =>
    cli("tool", "list_threads", "--input-json", JSON.stringify(input));
  const [inSpace, oldFlag, unknown, outside, agentAll, agentSpace, agentUnknown] =
    await Promise.all([
      cli("list", "--space", profile),
      cli("list", "--profile", profile),
      cli("list", "--space", "nope"),
      cli("list", "--space", profile, "--account", homeAccount),
      tool({}),
      tool({ profile_id: profile }),
      tool({ profile_id: "nope" }),
    ]);
  expect(inSpace.code).toBe(0);
  expect(inSpace.stdout).toContain("Standup");
  expect(inSpace.stdout).not.toContain("Hello");
  // The hidden --profile alias keeps older scripts working.
  expect(oldFlag.stdout).toBe(inSpace.stdout);
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain("No space with id nope.");
  expect(outside.code).toBe(1);
  expect(outside.stderr).toContain(`Account ${homeAccount} is not in space ${profile}.`);
  // Another account has consent, so the unscoped agent list works.
  expect(agentAll.code).toBe(0);
  expect(agentSpace.code).toBe(1);
  expect(agentSpace.stderr).toContain(
    `No accounts in space ${profile} allow agent reads. Turn on 'Allow AI to read this account' in Settings → AI Access.`,
  );
  expect(agentUnknown.code).toBe(1);
  expect(agentUnknown.stderr).toContain("No space with id nope.");
}, 30_000);

/** MCP 2025-11-25: input validation errors are tool results the model can read and correct. */
test.concurrent("MCP returns invalid tool arguments as an isError result, not a protocol error", async ({
  expect,
  onTestFinished,
}) => {
  const { request } = await client(onTestFinished, false, false, false, "2025-11-25");
  const called = Schema.decodeUnknownSync(CallResult)(
    await request("tools/call", { name: "read_thread", arguments: { max_chars: 5 } }),
  );
  expect(called.isError).toBe(true);
  const failure = JSON.parse(called.content[0]?.text ?? "");
  expect(failure).toMatchObject({ code: "invalid_input", hint: expect.any(String) });
  expect(failure.message).toContain("input schema");
  // A misspelled key fails and names the key it meant, instead of running with defaults.
  const typo = Schema.decodeUnknownSync(CallResult)(
    await request("tools/call", {
      name: "list_threads",
      arguments: { acount_id: "zzz", mailboxx: "spam" },
    }),
  );
  expect(typo.isError).toBe(true);
  expect(JSON.parse(typo.content[0]?.text ?? "")).toEqual({
    message:
      'Unknown parameters: "acount_id" (did you mean "account_id"?), "mailboxx" (did you mean "mailbox"?).',
    code: "invalid_input",
    hint: expect.stringContaining("Valid parameters: mailbox, account_id"),
  });
  const { tools } = Schema.decodeUnknownSync(ToolList)(await request("tools/list"));
  for (const tool of tools)
    expect(tool.inputSchema, tool.name).toMatchObject({ additionalProperties: false });
  // An unknown tool is still a protocol error.
  await expect(request("tools/call", { name: "no_such_tool", arguments: {} })).rejects.toThrow();
}, 30_000);

test.concurrent("CLI and MCP exit 1 with one stderr line on a database from a newer OpenMail", async ({
  expect,
  onTestFinished,
}) => {
  const directory = await home(onTestFinished, "openmail-cli-newer-");
  const db = new DatabaseSync(join(directory, "mail.db"));
  // Far past any MIGRATIONS length this build ships.
  db.exec("PRAGMA user_version = 100000");
  db.close();
  const options = { env: { ...process.env, OPENMAIL_HOME: directory } };
  const start = (script: string, ...args: string[]) =>
    run(process.execPath, [script, ...args], options).then(
      (done) => ({ code: 0, ...done }),
      (error: unknown) => Schema.decodeUnknownSync(Failure)(error),
    );
  const message = "This library was opened by a newer OpenMail. Update OpenMail to open it.";
  for (const result of await Promise.all([start("dist/cli.js", "list"), start("dist/mcp.js")])) {
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`error: ${message}`);
    expect(result.stdout).toBe("");
  }
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

test.concurrent("the CLI lists and rejects proposals but never approves one", async ({
  expect,
  onTestFinished,
}) => {
  const directory = await home(onTestFinished, "openmail-cli-approve-test-");
  const { archive, send } = await seedProposals(directory);
  const options = { env: { ...process.env, OPENMAIL_HOME: directory } };
  const cli = (...args: string[]) =>
    run(process.execPath, ["dist/cli.js", ...args], options).then(
      (done) => ({ code: 0, ...done }),
      (error: unknown) => Schema.decodeUnknownSync(Failure)(error),
    );
  const message =
    "error: Approve proposals in OpenMail, under AI suggestions. The CLI and MCP cannot approve them.\n";
  for (const args of [[String(archive)], [String(send), "--yes"], []])
    expect(await cli("proposals", "approve", ...args)).toMatchObject({
      code: 1,
      stdout: "",
      stderr: message,
    });
  const help = await cli("proposals", "--help");
  expect(help.stdout).not.toMatch(/^\s+approve/m);
  expect(help.stdout).toContain("reject");
  expect(await cli("proposals", "reject", String(archive))).toMatchObject({ code: 0 });
  const list = await cli("proposals", "list");
  expect(list.stdout.match(/pending/g)).toHaveLength(1);
});

/** Two spaces named Work, one named Home, and one account outside any space. */
async function seedSpaces(directory: string) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* Store;
        const account = yield* store.upsertAccount("gmail", "me@example.com");
        const home = yield* store.createProfile({ name: "Home", icon: "🏠", color: "blue" });
        for (let i = 0; i < 2; i++)
          yield* store.createProfile({ name: "Work", icon: "💼", color: "blue" });
        return { account: account.id, home: home.id };
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

test.concurrent("spaces assign and remove fail on unknown ids and take an unambiguous name", async ({
  expect,
  onTestFinished,
}) => {
  const directory = await home(onTestFinished, "openmail-cli-spaces-test-");
  const empty = await home(onTestFinished, "openmail-cli-empty-test-");
  const { account, home: homeSpace } = await seedSpaces(directory);
  const cli = (dir: string, ...args: string[]) =>
    run(process.execPath, ["dist/cli.js", ...args], {
      env: { ...process.env, OPENMAIL_HOME: dir },
    }).then(
      (done) => ({ code: 0, ...done }),
      (error: unknown) => Schema.decodeUnknownSync(Failure)(error),
    );
  expect(await cli(directory, "spaces", "assign", "1", "x")).toMatchObject({
    code: 1,
    stderr: "error: No account with id 1. Run `openmail accounts list` to see them.\n",
  });
  expect(await cli(directory, "spaces", "remove", "Nope")).toMatchObject({
    code: 1,
    stderr: "error: No space with id or name Nope. Run `openmail spaces list` to see them.\n",
  });
  expect(await cli(directory, "spaces", "assign", account, "work")).toMatchObject({
    code: 1,
    stderr: expect.stringContaining("2 spaces are named work. Pass the space id"),
  });
  expect(await cli(directory, "spaces", "assign", account, "home")).toMatchObject({
    code: 0,
    stdout: `Moved ${account} to Home.\n`,
  });
  expect((await cli(directory, "spaces", "list")).stdout).toContain(
    `${homeSpace}\n      ${account}`,
  );
  expect(await cli(directory, "spaces", "remove", "Home")).toMatchObject({
    code: 0,
    stdout: `Removed space Home (${homeSpace}).\n`,
  });
  // health with no accounts says so, like accounts list.
  expect(await cli(empty, "health")).toMatchObject({
    code: 0,
    stdout: "(no accounts; run `openmail accounts add gmail`)\n",
  });
});
