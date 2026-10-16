// The command layer through its real interface: `node dist/cli.js` against a temp
// OPENMAIL_HOME seeded by scripts/demo-data.mjs. Flag names, --json shapes and exit codes
// are a contract for scripts and agents, so these tests read stdout, stderr and the code.
import { execFile, spawn } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Schema } from "effect";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { scaledMs } from "../../core/test-support/test-time.js";
import { REMOVE_NEEDS_YES } from "./commands/accounts.js";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const demoData = fileURLToPath(new URL("../../../scripts/demo-data.mjs", import.meta.url));
// Every test starts node and opens the database, about 1 s on a loaded machine and slower on
// a CI runner, so the budgets scale with testTimeScale.
vi.setConfig({ testTimeout: scaledMs(20_000), hookTimeout: scaledMs(60_000) });

/**
 * The keys scripts read from each --json output, snake_case at any depth like MCP. When a shape changes on purpose,
 * update it here; the tests below only compare against these lists.
 */
const KEYS = {
  thread: [
    "id",
    "account_id",
    "thread_id",
    "subject",
    "from",
    "date",
    "snippet",
    "labels",
    "is_unread",
    "is_starred",
    "has_attachments",
    "thread_count",
    "participants",
  ],
  message: [
    "id",
    "account_id",
    "thread_id",
    "subject",
    "from",
    "date",
    "snippet",
    "labels",
    "is_unread",
    "is_starred",
    "has_attachments",
    "to",
    "cc",
    "bcc",
    "rfc_message_id",
    "reply_to",
    "body_text",
    "security",
    "body_cached",
    "attachments",
    "has_calendar",
  ],
  account: ["id", "provider", "email", "created_at", "enabled"],
  proposal: ["id", "created_at", "actor", "command", "status"],
  space: ["id", "name", "icon", "color", "position", "accounts"],
};
/** Keys a thread carries only when they apply. */
const OPTIONAL_THREAD = ["attachment_names"];
/** Every required key is present, and nothing outside required and optional. */
function expectKeys(value: object, required: string[], optional: string[] = []) {
  const keys = Object.keys(value);
  expect(keys).toEqual(expect.arrayContaining(required));
  expect(keys.filter((key) => !required.includes(key) && !optional.includes(key))).toEqual([]);
}
/** The key `list --json` and `search --json` print the next page's cursor under. */
const CURSOR = "next_cursor";
/** Seeded by demo-data.mjs: the four-message launch thread in the Gmail demo account. */
const LAUNCH = "gmail:alex@example.com/demo-4";

let seeded = "";
beforeAll(async () => {
  seeded = await mkdtemp(join(tmpdir(), "openmail-cli-test-"));
  await run(process.execPath, [demoData, join(seeded, "home")]);
});
afterAll(() => rm(seeded, { recursive: true, force: true }));

function openmail(args: string[], home = join(seeded, "home"), env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, failed) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", cli, ...args], {
      env: { ...process.env, ...env, OPENMAIL_HOME: home },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", failed);
    child.once("close", (code) => done({ code, stdout, stderr }));
  });
}

const Row = Schema.Record(Schema.String, Schema.Unknown);
const row = Schema.decodeUnknownSync(Row);
const rows = Schema.decodeUnknownSync(Schema.Array(Row));

async function json(args: string[], home?: string): Promise<unknown> {
  const result = await openmail([...args, "--json"], home);
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}
/** A --json output that is one object. */
const object = async (args: string[], home?: string) => row(await json(args, home));
/** A --json output that is a list of objects. */
const list = async (args: string[], home?: string) => rows(await json(args, home));

describe("help", () => {
  test("lists every subcommand and exits 0", async () => {
    const { code, stdout, stderr } = await openmail(["--help"]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    for (const name of [
      "accounts",
      "spaces",
      "sync",
      "list",
      "search",
      "show",
      "proposals",
      "agents",
      "audit",
      "mcp",
      "tools",
      "tool",
    ])
      expect(stdout).toMatch(new RegExp(`^  ${name}\\s`, "m"));
  });

  test("--version prints the version from package.json", async () => {
    const { version } = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
    )(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const { code, stdout } = await openmail(["--version"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(`openmail v${version}`);
  });

  test(
    "every positional argument says what it takes",
    async () => {
      const commands = [
        [["accounts", "remove"], "account-id"],
        [["accounts", "reauth"], "account-id"],
        [["spaces", "add"], "name"],
        [["spaces", "assign"], "account-id"],
        [["proposals", "reject"], "proposal-id"],
        [["sync"], "account"],
        [["search"], "query"],
        [["show"], "message-id"],
      ] as const;
      // Eight CLI starts in a row take over 20 s on a CI runner; run them side by side.
      const outputs = await Promise.all(
        commands.map(([command]) => openmail([...command, "--help"])),
      );
      for (const [index, [command, argument]] of commands.entries())
        expect(outputs[index]?.stdout, command.join(" ")).toMatch(
          new RegExp(`^  ${argument}(\\.\\.\\.)? \\w+ +\\S`, "m"),
        );
    },
    scaledMs(60_000),
  );

  test("list --help names its paging and filter flags", async () => {
    const { code, stdout } = await openmail(["list", "--help"]);
    expect(code).toBe(0);
    for (const flag of [
      "--mailbox",
      "--account",
      "--space",
      "--label",
      "--unread",
      "--limit",
      "--before",
      "--cursor",
      "--json",
    ])
      expect(stdout).toContain(flag);
  });
});

describe("accounts add", () => {
  // The fake opener exits 1, as on a machine with no browser. Nothing reaches Google: the
  // client is fake and the test stops the process once the URL is on stderr.
  test.skipIf(process.platform === "win32")(
    "prints the consent URL on stderr even when no browser opens",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "openmail-cli-browser-"));
      try {
        const bin = join(dir, "bin");
        await mkdir(bin);
        for (const name of ["open", "xdg-open"]) {
          await writeFile(join(bin, name), "#!/bin/sh\nexit 1\n");
          await chmod(join(bin, name), 0o755);
        }
        const child = spawn(
          process.execPath,
          ["--disable-warning=ExperimentalWarning", cli, "accounts", "add", "gmail"],
          {
            env: {
              ...process.env,
              HOME: dir,
              OPENMAIL_HOME: join(dir, "home"),
              OPENMAIL_GOOGLE_CLIENT_ID: "fake-client",
              OPENMAIL_GOOGLE_CLIENT_SECRET: "fake-secret",
              PATH: `${bin}:${process.env.PATH ?? ""}`,
            },
          },
        );
        const stderr = await new Promise<string>((done, failed) => {
          let text = "";
          child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
            text += chunk;
            if (/^https:\/\/accounts\.google\.com\/\S+$/m.test(text)) done(text);
          });
          child.once("error", failed);
          child.once("close", () => done(text));
        });
        child.kill();
        expect(stderr).toContain("If nothing opens, visit:");
        const url = new URL(/^https:\/\/accounts\.google\.com\/\S+$/m.exec(stderr)?.[0] ?? "");
        expect(url.searchParams.get("client_id")).toBe("fake-client");
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("accounts remove", () => {
  // Removing for real would delete the account's keychain item, so these tests stop before it.
  test("without a terminal and --yes it removes nothing and exits 1", async () => {
    const { code, stdout, stderr } = await openmail([
      "accounts",
      "remove",
      "gmail:alex@example.com",
    ]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(`error: ${REMOVE_NEEDS_YES}\n`);
    const db = new DatabaseSync(join(seeded, "home", "mail.db"), { readOnly: true });
    try {
      expect(
        db.prepare("SELECT id FROM accounts WHERE id = ?").get("gmail:alex@example.com"),
      ).toEqual({ id: "gmail:alex@example.com" });
    } finally {
      db.close();
    }
  });

  test("an unknown id fails before asking", async () => {
    const { code, stderr } = await openmail(["accounts", "remove", "gmail:nobody@example.com"]);
    expect(code).toBe(1);
    expect(stderr).toBe(
      "error: No account with id gmail:nobody@example.com. Run `openmail accounts list` to see them.\n",
    );
  });

  test("--help names --yes", async () => {
    const { stdout } = await openmail(["accounts", "remove", "--help"]);
    expect(stdout).toMatch(/--yes, -y +Remove without asking/);
  });
});

describe("reading", () => {
  test("list prints one line per thread and a cursor for the next page", async () => {
    const { code, stdout } = await openmail(["list", "--limit", "2"]);
    expect(code).toBe(0);
    const lines = stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(LAUNCH);
    expect(lines[0]).toContain("Re: Q4 launch plan: final review (4)");
    expect(lines[2]).toMatch(/^More: add --cursor \S+$/);
  });

  test("list --json pages with the cursor it prints", async () => {
    const first = await object(["list", "--limit", "2"]);
    expect(Object.keys(first)).toEqual(["threads", CURSOR]);
    const threads = rows(first.threads);
    expect(threads).toHaveLength(2);
    for (const thread of threads) expectKeys(thread, KEYS.thread, OPTIONAL_THREAD);
    const cursor = first[CURSOR];
    expect(typeof cursor).toBe("string");
    const second = rows(
      (await object(["list", "--limit", "2", "--cursor", String(cursor)])).threads,
    );
    expect(second).toHaveLength(2);
    expect(second.map((thread) => thread.id)).not.toContain(threads[0]?.id);
  });

  test("list --unread --mailbox inbox returns only unread inbox threads", async () => {
    const threads = rows((await object(["list", "--unread", "--mailbox", "inbox"])).threads);
    expect(threads.length).toBeGreaterThan(0);
    for (const thread of threads) {
      expect(thread.is_unread).toBe(true);
      expect(thread.labels).toContain("INBOX");
    }
  });

  test("show prints headers and the message text", async () => {
    const { code, stdout } = await openmail(["show", LAUNCH]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/^From:\s+Priya Shah <priya@example\.org>$/m);
    expect(stdout).toMatch(/^Subject: Re: Q4 launch plan: final review$/m);
    expect(stdout).toContain(`Id:      ${LAUNCH}`);
    expect(stdout).toContain("the embargo lifts on the 21st");
  });

  test("show --json is one message, show --thread --json the whole thread", async () => {
    expect(Object.keys(await object(["show", LAUNCH]))).toEqual(KEYS.message);
    const thread = await list(["show", "--thread", LAUNCH]);
    expect(thread).toHaveLength(4);
    for (const entry of thread) expect(Object.keys(entry)).toEqual(KEYS.message);
  });

  test("search finds by body words and prints the thread", async () => {
    const { code, stdout } = await openmail(["search", "embargo"]);
    expect(code).toBe(0);
    expect(stdout.trimEnd().split("\n")).toEqual([expect.stringContaining(LAUNCH)]);
    const result = await object(["search", "embargo"]);
    expect(Object.keys(result)).toEqual(["threads", "truncated", "errors"]);
    const threads = rows(result.threads);
    expect(threads.map((thread) => thread.id)).toEqual([LAUNCH]);
    for (const thread of threads)
      expectKeys(thread, [...KEYS.thread, "search_matches"], OPTIONAL_THREAD);
  });

  test("a query negation is query text, not a cluster of short flags", async () => {
    // -newsletter used to fail with "Unrecognized flag: -n", -has:attachment printed the help
    // (-h) and -vip the version (-v).
    const negated = await object(["search", "embargo", "-newsletter"]);
    expect(rows(negated.threads).map((thread) => thread.id)).toEqual([LAUNCH]);
    const plain = await object(["search", "-has:attachment", "--limit", "100"]);
    const threads = rows(plain.threads);
    expect(threads.length).toBeGreaterThan(0);
    for (const thread of threads) expect(thread.has_attachments).toBe(false);
    const vip = await openmail(["search", "-vip", "--limit", "1"]);
    expect(vip.code, vip.stderr).toBe(0);
    expect(vip.stdout).not.toContain("openmail v");
    expect(vip.stdout.split("\n")[0]).toMatch(/^\d{4}-\d\d-\d\d /);
    // `--` still ends the flags, and -h still asks for help.
    const after = await openmail(["search", "--", "embargo", "-newsletter"]);
    expect(after.stdout.trimEnd().split("\n")).toEqual([expect.stringContaining(LAUNCH)]);
    const help = await openmail(["search", "-h"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("USAGE");
  });

  test("a date or size operator without a valid value is listed under ignored", async () => {
    const result = await openmail(["search", "newer:foo", "larger:xyz", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toMatch(
      /^note: no valid value, searched as plain text: newer:foo, larger:xyz\. Dates are YYYY-MM-DD/,
    );
    const found = row(JSON.parse(result.stdout));
    expect(rows(found.ignored).map((note) => note.operators)).toEqual([
      ["newer:foo", "larger:xyz"],
      ["newer:foo", "larger:xyz"],
    ]);
    const valid = await openmail(["search", "after:2026-01-31", "--json"]);
    expect(valid.stderr).toBe("");
    expect(Object.keys(row(JSON.parse(valid.stdout)))).not.toContain("ignored");
  });

  test("accounts list --json carries the account fields scripts read", async () => {
    const accounts = await list(["accounts", "list"]);
    expect(accounts.map((account) => account.provider)).toEqual(["gmail", "imap"]);
    for (const account of accounts)
      expect(Object.keys(account)).toEqual(expect.arrayContaining(KEYS.account));
  });
});

/**
 * A copy of the seeded home for a describe block that changes it in `beforeAll`, removed after
 * the block. Setup starts go in `beforeAll`, so each test waits on at most one CLI start.
 */
function sharedHome() {
  const directory = { path: "" };
  beforeAll(async () => {
    directory.path = await mkdtemp(join(tmpdir(), "openmail-cli-write-"));
    await cp(join(seeded, "home"), directory.path, { recursive: true });
  });
  afterAll(() => rm(directory.path, { recursive: true, force: true }));
  return directory;
}

// A failed sync logged a multi-line SyncFailedDiagnostic per account on stderr, and health
// over a hundred lines, on top of the one-line outcome. OPENMAIL_OFFLINE fails every provider
// call without the network or the keychain.
describe("expected sync failures", () => {
  const home = sharedHome();
  const offline = { OPENMAIL_OFFLINE: "1" };

  test("print the one-line outcome without structured diagnostics", async () => {
    const sync = await openmail(["sync"], home.path, offline);
    expect(sync.code).toBe(1);
    expect(sync.stderr).not.toContain("Diagnostic");
    expect(sync.stderr.split("\n").filter((line) => line.trim() !== "")).toEqual([
      "Syncing mail…",
      "error: Some accounts did not sync.",
      "hint: Run it again, or add --log-level warn to see why.",
    ]);
    // openmail sync runs once, so nothing retries, and errors are all it logs by default.
    expect(sync.stdout).toContain(
      "error: Sync could not finish. Run it again, or add --log-level warn to see why.",
    );
    expect(sync.stdout).not.toContain("retry");
    const health = await openmail(["health"], home.path, offline);
    expect(health.code, health.stderr).toBe(0);
    expect(health.stderr).toBe("");
  });

  test("--json names the same next step and promises no retry", async () => {
    const sync = await openmail(["sync", "--json"], home.path, offline);
    expect(sync.code).toBe(1);
    expect(sync.stdout).not.toContain("retry");
    expect(sync.stdout).not.toContain("openmail --help");
    expect(sync.stdout).toContain('"hint": "Run it again, or add --log-level warn to see why."');
  });

  test("--log-level warn still shows them", async () => {
    const sync = await openmail(["--log-level", "warn", "sync"], home.path, offline);
    expect(sync.code).toBe(1);
    expect(sync.stderr).toContain("SyncFailedDiagnostic");
  });
});

describe("spaces", () => {
  test("list starts empty", async () => {
    const [text, listed] = await Promise.all([
      openmail(["spaces", "list"]),
      json(["spaces", "list"]),
    ]);
    expect(text.stdout).toContain("no spaces");
    expect(listed).toEqual([]);
  });

  describe("after add and assign", () => {
    const home = sharedHome();
    let added: Awaited<ReturnType<typeof openmail>>;
    let assigned: Awaited<ReturnType<typeof openmail>>;
    let space: Record<string, unknown> = {};
    beforeAll(async () => {
      added = await openmail(["spaces", "add", "Work"], home.path);
      space = (await list(["spaces", "list"], home.path))[0] ?? {};
      assigned = await openmail(
        ["spaces", "assign", "gmail:alex@example.com", String(space.id)],
        home.path,
      );
    });

    test("add creates the space with the keys scripts read", () => {
      expect(added.code, added.stderr).toBe(0);
      expect(added.stdout).toMatch(/^Added space Work \(.+\)\.$/m);
      expect(space.name).toBe("Work");
      expect(Object.keys(space)).toEqual(KEYS.space);
    });

    test("add refuses a name that is taken in any letter case", async () => {
      const again = await openmail(["spaces", "add", " work "], home.path);
      expect(again.code).toBe(1);
      expect(again.stdout).toBe("");
      expect(again.stderr).toMatch(
        /^error: A space with this name already exists\. Choose another name\.\nhint: /,
      );
      expect(await list(["spaces", "list"], home.path)).toHaveLength(1);
    });

    test("add refuses an empty name and stores a padded one trimmed", async () => {
      // Control, format and blank characters alone show as nothing.
      for (const name of ["", "   ", "\u200b", "\u2068\u2069", "\t\n"]) {
        const empty = await openmail(["spaces", "add", name], home.path);
        expect(empty.code).toBe(1);
        expect(empty.stderr).toMatch(/^error: Enter a space name with letters or other visible/);
      }
      const control = await openmail(["spaces", "add", "Deep\twork"], home.path);
      expect(control.code).toBe(1);
      expect(control.stderr).toMatch(/^error: A space name can't contain line breaks or tabs\./);
      // `--space` takes a name or an id, so a name can't be another space's id.
      const [work] = await list(["spaces", "list"], home.path);
      const id = await openmail(["spaces", "add", String(work.id)], home.path);
      expect(id.code).toBe(1);
      expect(id.stderr).toMatch(/^error: That is another space's id\. Choose another name\./);
      // `spaces assign <account> none` ungroups, so no space can be found by that name.
      const none = await openmail(["spaces", "add", "None"], home.path);
      expect(none.code).toBe(1);
      expect(none.stderr).toMatch(/^error: The name none is reserved\./);
      const padded = await openmail(["spaces", "add", "  Play  "], home.path);
      expect(padded.code, padded.stderr).toBe(0);
      expect(padded.stdout).toMatch(/^Added space Play \(.+\)\.$/m);
      const names = (await list(["spaces", "list"], home.path)).map((s) => s.name);
      expect(names).toEqual(["Work", "Play"]);
      const removed = await openmail(["spaces", "remove", " play "], home.path);
      expect(removed.code, removed.stderr).toBe(0);
    });

    test("assign puts an account in it", async () => {
      expect(assigned.code, assigned.stderr).toBe(0);
      const after = (await list(["spaces", "list"], home.path))[0] ?? {};
      expect(JSON.stringify(after.accounts)).toContain("gmail:alex@example.com");
    });

    test("list --space takes the space name in any letter case", async () => {
      const [byName, byId] = await Promise.all([
        json(["list", "--space", "work"], home.path),
        json(["list", "--space", String(space.id)], home.path),
      ]);
      expect(JSON.stringify(byName)).toContain("gmail:alex@example.com");
      expect(byName).toEqual(byId);
      const unknown = await openmail(["list", "--space", "Nowhere"], home.path);
      expect(unknown.code).toBe(1);
      expect(unknown.stderr).toMatch(/^error: No space with id or name Nowhere\./);
    });

    test("spaces list escapes control and bidi characters in a name", async () => {
      // A line break is refused now; a space saved by an older version can still have one.
      const refused = await openmail(["spaces", "add", "Line\nbreak\u202e"], home.path);
      expect(refused.code).toBe(1);
      const db = new DatabaseSync(join(home.path, "mail.db"));
      try {
        db.prepare(
          "INSERT INTO profiles (id, name, icon, color, position) VALUES ('old', ?, 'L', 'blue', 99)",
        ).run("Line\nbreak\u202e");
      } finally {
        db.close();
      }
      const text = await openmail(["spaces", "list"], home.path);
      expect(text.stdout).toContain("Line\\u{a}break\\u{202e}");
      expect(text.stdout).not.toMatch(/[\u202e]|Line\n/);
      const removed = await openmail(["spaces", "remove", "Line\nbreak\u202e"], home.path);
      expect(removed.code, removed.stderr).toBe(0);
    });
  });
});

// Migration 53 rebuilds the word index; one-shot commands exited before the background rebuild
// finished, so search kept matching AROUND as AND and "view" inside "review".
describe("search after an upgrade rebuilds the word index", () => {
  const home = sharedHome();
  const index = () => {
    const db = new DatabaseSync(join(home.path, "mail.db"), { readOnly: true });
    try {
      return db.prepare("SELECT kind, ready FROM search_word_index ORDER BY kind").all();
    } finally {
      db.close();
    }
  };
  const exec = (statement: string) => {
    const db = new DatabaseSync(join(home.path, "mail.db"));
    try {
      db.exec(statement);
    } finally {
      db.close();
    }
  };
  const rebuild = () =>
    exec(
      "UPDATE search_word_index SET ready=0, cursor=0, end_rowid=(SELECT COALESCE(MAX(rowid),0) FROM messages) WHERE kind='messages'",
    );

  test("search finishes the index before it searches", async () => {
    rebuild();
    const result = await openmail(["search", "invoice", "--json"], home.path);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(index()).toEqual([
      { kind: "derived", ready: 1 },
      { kind: "messages", ready: 1 },
    ]);
  });

  test("tool search and sync finish it too", async () => {
    rebuild();
    const tool = await openmail(
      ["tool", "search", "--input-json", '{"query":"invoice"}', "--json"],
      home.path,
    );
    expect(tool.code, tool.stderr).toBe(0);
    expect(tool.stdout).not.toContain("search_notice");
    expect(index()).toEqual([
      { kind: "derived", ready: 1 },
      { kind: "messages", ready: 1 },
    ]);
    // With every account turned off, sync reaches no server and only finishes local work.
    rebuild();
    exec("UPDATE accounts SET enabled=0");
    try {
      const sync = await openmail(["sync", "--json"], home.path);
      expect(sync.code, sync.stderr).toBe(0);
    } finally {
      exec("UPDATE accounts SET enabled=1");
    }
    expect(index()).toEqual([
      { kind: "derived", ready: 1 },
      { kind: "messages", ready: 1 },
    ]);
  });

  test(
    "search says its results are approximate while another process holds the write lock",
    async () => {
      rebuild();
      const writer = new DatabaseSync(join(home.path, "mail.db"));
      writer.exec("BEGIN IMMEDIATE");
      try {
        const result = await openmail(["search", "invoice"], home.path);
        expect(result.code, result.stderr).toBe(0);
        expect(result.stderr).toMatch(/^note: the search index is still being rebuilt/m);
      } finally {
        writer.exec("ROLLBACK");
        writer.close();
      }
    },
    scaledMs(60_000),
  );
});

describe("proposals", () => {
  test("list shows the pending agent proposal", async () => {
    const [text, listed] = await Promise.all([
      openmail(["proposals", "list"]),
      list(["proposals", "list"]),
    ]);
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/^#1 .* pending +agent:mcp:claude-code$/m);
    expect(text.stdout).toContain("archive: 3 thread(s)");
    const proposal = listed[0] ?? {};
    expect(Object.keys(proposal)).toEqual(KEYS.proposal);
    expect(proposal.status).toBe("pending");
  });

  test("the demo suggestion came through the MCP server as Claude Code", () => {
    // Only a tool call through `openmail mcp` records agent activity.
    const db = new DatabaseSync(join(seeded, "home", "mail.db"), { readOnly: true });
    try {
      expect(db.prepare("SELECT client, tool, ok FROM agent_activity").all()).toEqual([
        { client: "claude-code", tool: "modify_threads", ok: 1 },
      ]);
    } finally {
      db.close();
    }
  });

  describe("after reject", () => {
    const home = sharedHome();
    let rejected: Awaited<ReturnType<typeof openmail>>;
    beforeAll(async () => {
      rejected = await openmail(["proposals", "reject", "1"], home.path);
    });

    test("reject settles it and the audit log records who rejected it", async () => {
      expect(rejected.code, rejected.stderr).toBe(0);
      expect(rejected.stdout).toBe("Rejected proposal 1.\n");
      const [pending, audit] = await Promise.all([
        json(["proposals", "list"], home.path),
        openmail(["audit", "--limit", "1"], home.path),
      ]);
      expect(pending).toEqual([]);
      expect(audit.stdout).toMatch(/user:cli +reject/);
    });
  });

  test("approving points to the app and exits 1", async () => {
    const { code, stdout, stderr } = await openmail(["proposals", "approve", "1"]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(
      "error: Approve proposals in OpenMail, under AI suggestions. The CLI and MCP cannot approve them.\n",
    );
  });
});

describe("errors", () => {
  test("an unknown subcommand is a usage error: exit 2, short usage on stderr", async () => {
    const { code, stdout, stderr } = await openmail(["bogus"]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toBe(
      'error: Unknown subcommand "bogus" for "openmail"\nUsage: openmail <subcommand> [flags]\nRun `openmail --help` for details.\n',
    );
  });

  test("an unknown subcommand with --help is a usage error, not the parent's help", async () => {
    const root = await openmail(["bogus", "--help"]);
    expect(root.code).toBe(2);
    expect(root.stdout).toBe("");
    expect(root.stderr).toBe(
      'error: Unknown subcommand "bogus" for "openmail"\nUsage: openmail <subcommand> [flags]\nRun `openmail --help` for details.\n',
    );
    const group = await openmail(["accounts", "bogus", "--help"]);
    expect(group.code).toBe(2);
    expect(group.stdout).toBe("");
    expect(group.stderr).toContain('Unknown subcommand "bogus" for "openmail accounts"');
    const known = await openmail(["accounts", "list", "--help"]);
    expect(known.code).toBe(0);
    expect(known.stdout).toContain("USAGE");
  });

  test("a bad flag value is a usage error that names the flag", async () => {
    const { code, stdout, stderr } = await openmail(["list", "--limit", "abc"]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/^error: Invalid value for flag --limit: "abc"/);
    expect(stderr).toContain("Run `openmail list --help` for details.");
  });

  test("a missing message is exit 1 with one line on stderr", async () => {
    const { code, stdout, stderr } = await openmail(["show", "gmail:alex@example.com/nope"]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("error: No message with id gmail:alex@example.com/nope.\n");
  });

  test("a missing proposal is exit 1", async () => {
    const { code, stderr } = await openmail(["proposals", "reject", "99"]);
    expect(code).toBe(1);
    expect(stderr).toBe("error: No proposal with id 99.\n");
  });

  const ErrorObject = Schema.Struct({
    message: Schema.String,
    code: Schema.String,
    hint: Schema.String,
  });
  const errorObject = (stdout: string) => Schema.decodeUnknownSync(ErrorObject)(JSON.parse(stdout));

  test("--input-json that is not JSON names the flag", async () => {
    const { code, stdout, stderr } = await openmail([
      "tool",
      "list_threads",
      "--input-json",
      "notjson",
    ]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toMatch(
      /^error: --input-json is not valid JSON: .+\nhint: Pass one JSON object/,
    );
  });

  test("under --json every failure prints {message, code, hint} on stdout and exits non-zero", async () => {
    const cases = [
      [["show", "gmail:alex@example.com/nope"], 1, "not_found", "error: No message with id"],
      [
        ["tool", "list_threads", "--input-json", "notjson"],
        1,
        "invalid_input",
        "error: --input-json",
      ],
      [["list", "--limit", "abc"], 2, "usage", "error: Invalid value for flag --limit"],
      [["agents", "write-mode", "allow"], 1, "app_only", "error: Changes by AI apps"],
    ] as const;
    await Promise.all(
      cases.map(async ([args, exit, kind, human]) => {
        const { code, stdout, stderr } = await openmail([...args, "--json"]);
        expect(code, stderr).toBe(exit);
        const error = errorObject(stdout);
        expect(error.code).toBe(kind);
        expect(error.message.length).toBeGreaterThan(0);
        expect(error.hint.length).toBeGreaterThan(0);
        // People still read the same line on stderr.
        expect(stderr.startsWith(human), stderr).toBe(true);
      }),
    );
  });

  test("agent write mode cannot be changed from the CLI", async () => {
    const { code, stderr } = await openmail(["agents", "write-mode", "allow"]);
    expect(code).toBe(1);
    expect(stderr).toContain("can only be changed in the app");
  });
});
