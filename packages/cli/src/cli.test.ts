// The command layer through its real interface: `node dist/cli.js` against a temp
// OPENMAIL_HOME seeded by scripts/demo-data.mjs. Flag names, --json shapes and exit codes
// are a contract for scripts and agents, so these tests read stdout, stderr and the code.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Schema } from "effect";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { scaledMs } from "../../core/test-support/test-time.js";
import { REMOVE_NEEDS_YES } from "./commands/accounts.js";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const demoData = fileURLToPath(new URL("../../../scripts/demo-data.mjs", import.meta.url));

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
      env: { ...process.env, OPENMAIL_OFFLINE: "1", ...env, OPENMAIL_HOME: home },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", failed);
    child.once("close", (code) => done({ code, stdout, stderr }));
  });
}

const ErrorObject = Schema.Struct({
  message: Schema.String,
  code: Schema.String,
  hint: Schema.String,
});
const errorObject = (stdout: string) => Schema.decodeUnknownSync(ErrorObject)(JSON.parse(stdout));

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
  test("an unknown preset is invalid_input and lists the presets", async () => {
    const { code, stdout, stderr } = await openmail([
      "accounts",
      "add",
      "imap",
      "--preset",
      "nope",
    ]);
    expect(code, stderr).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/^error: Unknown preset nope\.\nhint: Use one of .*\bcustom\./);
  });

  test("a host with whitespace is invalid_input before any prompt", async () => {
    const { code, stdout, stderr } = await openmail([
      "accounts",
      "add",
      "imap",
      "--preset",
      "custom",
      "--imap-host",
      "mail example.com",
      "--smtp-host",
      "smtp.example.com",
      "--email",
      "a@example.com",
    ]);
    expect(code, stderr).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/^error: --imap-host mail example\.com is not a hostname\.\nhint: /);
  });

  test("a host with a port is invalid_input and the hint names the port flag", async () => {
    for (const [hostFlag, portFlag] of [
      ["--imap-host", "--imap-port"],
      ["--smtp-host", "--smtp-port"],
    ]) {
      const { code, stderr } = await openmail([
        "accounts",
        "add",
        "imap",
        "--preset",
        "custom",
        "--imap-host",
        hostFlag === "--imap-host" ? "mail.example.com:993" : "mail.example.com",
        "--smtp-host",
        hostFlag === "--smtp-host" ? "smtp.example.com:465" : "smtp.example.com",
        "--email",
        "a@example.com",
      ]);
      expect(code, stderr).toBe(1);
      expect(stderr).toMatch(
        new RegExp(
          `^error: ${hostFlag} \\S+:\\d+ is not a hostname\\.\\nhint: Pass the port with ${portFlag}\\.\\n`,
        ),
      );
    }
  });

  // No client is configured and the openers exit 1, so a run that got past validation would
  // fail with a different error and never reach a real browser.
  test.skipIf(process.platform === "win32")(
    "imap-only flags are invalid_input for gmail and outlook",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "openmail-cli-oauth-flags-"));
      try {
        const bin = join(dir, "bin");
        await mkdir(bin);
        for (const name of ["open", "xdg-open"]) {
          await writeFile(join(bin, name), "#!/bin/sh\nexit 1\n");
          await chmod(join(bin, name), 0o755);
        }
        const env = { HOME: dir, PATH: `${bin}:${process.env.PATH ?? ""}` };
        for (const provider of ["gmail", "outlook"]) {
          const { code, stderr } = await openmail(
            ["accounts", "add", provider, "--preset", "icloud", "--imap-port", "993"],
            join(dir, "home"),
            env,
          );
          expect(code, provider).toBe(1);
          expect(stderr).toMatch(
            new RegExp(
              `^error: --preset, --imap-port only apply to imap, not ${provider}\\.\\nhint: .*signs in through the browser`,
            ),
          );
          const one = await openmail(
            ["accounts", "add", provider, "--imap-port", "993"],
            join(dir, "home"),
            env,
          );
          expect(one.stderr).toMatch(
            new RegExp(`^error: --imap-port only applies to imap, not ${provider}\\.\\n`),
          );
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  test("a named preset prints its English note and the app password page", async () => {
    const { stderr } = await openmail(
      ["accounts", "add", "imap", "--preset", "icloud", "--email", "a@icloud.com"],
      join(seeded, "home"),
      { OPENMAIL_IMAP_PASSWORD: undefined },
    );
    expect(stderr).toContain("Create an app-specific password under Sign-In and Security");
    expect(stderr).not.toMatch(/[\u4e00-\u9fff]/);
  });

  test("without a password or a terminal, fails before prompting", async () => {
    const { code, stdout, stderr } = await openmail(
      ["accounts", "add", "imap", "--preset", "custom", "--email", "a@b.c"].concat([
        "--imap-host",
        "imap.b.c",
        "--smtp-host",
        "smtp.b.c",
      ]),
      join(seeded, "home"),
      { OPENMAIL_IMAP_PASSWORD: undefined },
    );
    expect(code, stderr).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain(
      "hint: Set OPENMAIL_IMAP_PASSWORD, pass --password or run in a terminal.",
    );
    expect(stderr).not.toContain("\u001b");
    expect(stderr).not.toMatch(/App password/);
  });

  test("bad --email and ports fail with invalid_input before any prompt", async () => {
    const base = ["accounts", "add", "imap", "--preset", "icloud"];
    for (const [flags, message] of [
      [["--email", "nobody"], "--email nobody is not an email address."],
      [["--email", "a@b.c", "--imap-port", "70000"], "--imap-port 70000 is not a port"],
      [["--email", "a@b.c", "--smtp-port", "0"], "--smtp-port 0 is not a port"],
    ] as const) {
      const { code, stdout, stderr } = await openmail([...base, ...flags]);
      expect(code, stderr).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain(message);
      expect(stderr).not.toContain("Create an app-specific password");
      expect(stderr).not.toMatch(/App password/);
    }
  });

  test("without --email or a terminal, fails instead of asking", async () => {
    const { code, stderr } = await openmail(["accounts", "add", "imap", "--preset", "icloud"]);
    expect(code, stderr).toBe(1);
    expect(stderr).toContain("hint: Pass --email or run in a terminal.");
  });

  test("custom without hosts fails before any password prompt, even with stdin closed", async () => {
    const { code, stdout, stderr } = await openmail([
      "accounts",
      "add",
      "imap",
      "--preset",
      "custom",
      "--email",
      "a@b.c",
    ]);
    expect(code, stderr).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/^error: --preset custom needs --imap-host and --smtp-host\.\nhint: /);
    expect(stderr).not.toMatch(/password/i);
  });

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
        // The child owns its database files, so wait for it to exit before the directory goes.
        const exited =
          child.exitCode === null && child.signalCode === null
            ? new Promise<void>((done) => {
                child.once("close", () => {
                  done();
                });
              })
            : Promise.resolve();
        child.kill();
        await exited;
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

  test("an unknown id is not_found with the command that lists accounts", async () => {
    const { code, stderr } = await openmail(["accounts", "remove", "gmail:nobody@example.com"]);
    expect(code).toBe(1);
    expect(stderr).toContain("hint: Run `openmail accounts list`");
    const listed = await openmail(["list", "--account", "gmail:nobody@example.com", "--json"]);
    expect(listed.code, listed.stderr).toBe(1);
    expect(errorObject(listed.stdout)).toMatchObject({
      code: "not_found",
      hint: expect.stringContaining("openmail accounts list"),
    });
  });

  test("an unknown id fails before asking", async () => {
    const { code, stderr } = await openmail(["accounts", "remove", "gmail:nobody@example.com"]);
    expect(code).toBe(1);
    expect(stderr).toBe(
      "error: No account with id gmail:nobody@example.com.\nhint: Run `openmail accounts list` to see them.\n",
    );
  });

  test("reauth with an unknown id is not_found with the hint", async () => {
    const { code, stderr } = await openmail(["accounts", "reauth", "gmail:nobody@example.com"]);
    expect(code).toBe(1);
    expect(stderr).toBe(
      "error: No account with id gmail:nobody@example.com.\nhint: Run `openmail accounts list` to see them.\n",
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

  test("list rejects an unknown space and a bad cursor with documented codes", async () => {
    const space = await openmail(["list", "--space", "nope", "--json"]);
    expect(space.code, space.stderr).toBe(1);
    expect(errorObject(space.stdout)).toMatchObject({
      code: "not_found",
      hint: expect.stringContaining("openmail spaces list"),
    });
    const cursor = await openmail(["list", "--cursor", "garbage", "--json"]);
    expect(cursor.code, cursor.stderr).toBe(1);
    expect(errorObject(cursor.stdout)).toMatchObject({
      code: "invalid_input",
      hint: expect.stringContaining("Omit --cursor"),
    });
    // A real cursor from one query must not page another.
    const page = await object(["list", "--limit", "2"]);
    const foreign = [
      ["list", "--limit", "2", "--unread"],
      ["search", "launch", "--limit", "1"],
    ];
    for (const args of foreign) {
      const first =
        args[0] === "list"
          ? String(page[CURSOR])
          : String((await object(["search", "e", "--limit", "1"]))[CURSOR]);
      const mismatch = await openmail([...args, "--cursor", first, "--json"]);
      expect(mismatch.code, mismatch.stderr).toBe(1);
      expect(errorObject(mismatch.stdout).code).toBe("invalid_input");
    }
  });

  test("a list cursor works with the label in another case or with spaces", async () => {
    const first = await object(["list", "--label", "inbox", "--limit", "1"]);
    const cursor = String(first[CURSOR]);
    for (const label of ["INBOX", " inbox "]) {
      const next = await openmail([
        "list",
        "--label",
        label,
        "--limit",
        "1",
        "--cursor",
        cursor,
        "--json",
      ]);
      expect(next.code, `${label}: ${next.stderr}`).toBe(0);
    }
  });

  test("list refuses --before together with --cursor", async () => {
    const page = await object(["list", "--limit", "2"]);
    const { code, stdout } = await openmail([
      "list",
      "--before",
      "1",
      "--cursor",
      String(page[CURSOR]),
      "--json",
    ]);
    expect(code).toBe(1);
    expect(errorObject(stdout)).toMatchObject({
      code: "invalid_input",
      hint: expect.stringContaining("Drop --before"),
    });
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

  test("list --label and label: take a label name in any case; a typo is not_found", async () => {
    const ids = async (args: string[]) =>
      rows((await object([...args, "--limit", "100"])).threads).map((thread) => thread.id);
    const byId = await ids(["list", "--label", "Label_projects"]);
    expect(byId.length).toBeGreaterThan(0);
    expect(await ids(["list", "--label", "Projects"])).toEqual(byId);
    expect(await ids(["list", "--label", "projects"])).toEqual(byId);
    const search = await ids(["search", "label:Projects"]);
    expect(search.length).toBeGreaterThan(0);
    expect(await ids(["search", "label:projects"])).toEqual(search);
    const typo = await openmail(["list", "--label", "nope", "--json"]);
    expect(typo.code, typo.stderr).toBe(1);
    expect(errorObject(typo.stdout)).toMatchObject({
      code: "not_found",
      hint: expect.stringContaining("list_labels"),
    });
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

  test("a trailing * on from:, to: or filename: reads as the prefix", async () => {
    const ids = async (query: string) =>
      rows((await object(["search", query, "--limit", "100"])).threads).map((t) => t.id);
    for (const [prefix, bare] of [
      ["from:pri*", "from:pri"],
      ["to:pri*", "to:pri"],
      ["filename:Q4*", "filename:Q4"],
    ]) {
      const found = await ids(prefix);
      expect(found.length, prefix).toBeGreaterThan(0);
      expect(found, prefix).toEqual(await ids(bare));
    }
    const label = await openmail(["search", "label:Label_n*", "--json"]);
    expect(label.code, label.stderr).toBe(0);
    expect(label.stderr).toMatch(/searched as plain text: label:Label_n\*\./);
    expect(rows(row(JSON.parse(label.stdout)).ignored)[0]?.operators).toEqual(["label:Label_n*"]);
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

// search --cursor kept an offset, so a thread that went away between pages (archived
// elsewhere, then synced) shifted the rest and the next page skipped one.
describe("search pages after a thread disappears", () => {
  const home = sharedHome();
  test("the next page continues after the last thread shown", async () => {
    const page = (cursor?: string) =>
      object(["search", "the", "--limit", "3", ...(cursor ? ["--cursor", cursor] : [])], home.path);
    const all = rows((await object(["search", "the", "--limit", "100"], home.path)).threads);
    expect(all.length).toBeGreaterThan(6);
    const first = await page();
    const shown = rows(first.threads);
    const gone = shown[1];
    expect(gone).toBeDefined();
    const db = new DatabaseSync(join(home.path, "mail.db"));
    try {
      db.prepare("DELETE FROM messages WHERE account_id=? AND thread_id=?").run(
        String(gone.account_id),
        String(gone.thread_id),
      );
    } finally {
      db.close();
    }
    const ids = shown.map((thread) => thread.id);
    let cursor = first[CURSOR];
    while (typeof cursor === "string") {
      const next = await page(cursor);
      ids.push(...rows(next.threads).map((thread) => thread.id));
      cursor = next[CURSOR];
    }
    expect(ids).toEqual(all.map((thread) => thread.id));
  });
});

// list --cursor carries the last thread's date and id, so threads that share a date stay apart
// across a page boundary. A cursor with only the date skipped the rest of the tie.
describe("list pages through threads that share a date", () => {
  const home = sharedHome();
  test("a page boundary inside a tie loses and repeats nothing", async () => {
    const all = rows((await object(["list", "--limit", "100"], home.path)).threads);
    const [first, second] = all;
    expect(second).toBeDefined();
    const db = new DatabaseSync(join(home.path, "mail.db"));
    try {
      const newest = db.prepare("SELECT MAX(date) AS date FROM messages").get()?.["date"];
      const move = db.prepare(
        "UPDATE messages SET date=?1, list_date=?1 WHERE account_id=?2 AND thread_id=?3",
      );
      for (const thread of [first, second])
        move.run(Number(newest), String(thread.account_id), String(thread.thread_id));
    } finally {
      db.close();
    }
    const expected = rows((await object(["list", "--limit", "100"], home.path)).threads);
    expect(expected.filter((thread) => thread.date === expected[0]?.date).length).toBe(2);
    const ids: unknown[] = [];
    let cursor: unknown;
    do {
      const page = await object(
        ["list", "--limit", "1", ...(typeof cursor === "string" ? ["--cursor", cursor] : [])],
        home.path,
      );
      ids.push(...rows(page.threads).map((thread) => thread.id));
      cursor = page[CURSOR];
    } while (typeof cursor === "string");
    expect(ids).toEqual(expected.map((thread) => thread.id));
  });
});

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

  // stdout held the results and then a second JSON object for the error, so JSON.parse failed.
  test("--json prints one document with the results and the error, and promises no retry", async () => {
    const sync = await openmail(["sync", "--json"], home.path, offline);
    expect(sync.code).toBe(1);
    expect(sync.stdout).not.toContain("retry");
    expect(sync.stdout).not.toContain("openmail --help");
    const output = row(JSON.parse(sync.stdout));
    expect(Object.keys(output)).toEqual(["results", "error"]);
    expect(rows(output.results).map((result) => result.account_id)).toEqual([
      "gmail:alex@example.com",
      "imap:alex.rivera@example.org",
    ]);
    expect(output.error).toEqual({
      message: "Some accounts did not sync.",
      code: "failed",
      hint: "Run it again, or add --log-level warn to see why.",
    });
  });

  test("say to sign in again when every failed account needs it", async () => {
    const signIn = await mkdtemp(join(tmpdir(), "openmail-cli-reauth-"));
    try {
      await cp(join(seeded, "home"), signIn, { recursive: true });
      const db = new DatabaseSync(join(signIn, "mail.db"));
      db.exec("UPDATE accounts SET needs_reauth = 1");
      db.close();
      const sync = await openmail(["sync"], signIn, offline);
      expect(sync.code).toBe(1);
      expect(sync.stdout).toContain(
        "gmail:alex@example.com  needs sign-in: openmail accounts reauth gmail:alex@example.com",
      );
      expect(sync.stderr).toContain(
        "error: Some accounts did not sync.\nhint: Sign in again with the commands above.\n",
      );
    } finally {
      await rm(signIn, { recursive: true, force: true });
    }
  });

  // --log-level warn showed only fixed diagnostic fields, so no line named the error, and the
  // hint still said to add the flag that was already there.
  // It also printed a multi-line SyncFailedDiagnostic per account, while the troubleshooting
  // page promises one line for each account that failed.
  test("--log-level warn names each error in one line per account and stops pointing at itself", async () => {
    const sync = await openmail(["--log-level", "warn", "sync"], home.path, offline);
    expect(sync.code).toBe(1);
    expect(sync.stderr).not.toContain("Diagnostic");
    const lines = sync.stderr.split("\n").filter((line) => line.trim() !== "");
    const error =
      ": ProviderError: Network calls are disabled in this offline session { logCode: 'sync-failed' }";
    expect(lines).toEqual([
      "Syncing mail…",
      expect.stringMatching(/^\[\d\d:\d\d:\d\d\.\d{3}\] WARN \(#\d+\): gmail sync failed \(full\)/),
      expect.stringMatching(/^\[\d\d:\d\d:\d\d\.\d{3}\] WARN \(#\d+\): imap sync failed \(full\)/),
      "error: Some accounts did not sync.",
      "hint: Run it again.",
    ]);
    for (const provider of ["gmail", "imap"])
      expect(
        lines.filter((line) => line.endsWith(`${provider} sync failed (full)${error}`)),
      ).toHaveLength(1);
    expect(sync.stderr).not.toContain("alex@example.com");
    expect(sync.stderr).toContain("error: Some accounts did not sync.\nhint: Run it again.\n");
    expect(sync.stdout).toContain("error: Sync could not finish. Run it again.");
    expect(`${sync.stdout}${sync.stderr}`).not.toContain("--log-level");
  });
});

/**
 * `openmail mcp` after initialize and one `sync` call: the stderr the AI app keeps as the
 * server's log.
 */
function mcpSyncStderr(home: string) {
  return new Promise<string>((done, failed) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "mcp"], {
      env: { ...process.env, OPENMAIL_OFFLINE: "1", OPENMAIL_HOME: home },
    });
    let stdout = "";
    let stderr = "";
    const send = (frame: object) => child.stdin.write(`${JSON.stringify(frame)}\n`);
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        const { id } = Schema.decodeUnknownSync(
          Schema.Struct({ id: Schema.optionalKey(Schema.Number) }),
        )(JSON.parse(line));
        if (id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "sync", arguments: {} },
          });
        }
        if (id === 2) child.stdin.end();
      }
    });
    child.once("error", failed);
    child.once("close", () => done(stderr));
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1" },
      },
    });
  });
}

// stderr printed accountHash, the plain SHA-256 prefix of the account ID, so anyone could check
// a guessed address against a log pasted into a public issue.
describe("logs on stderr", () => {
  const home = sharedHome();
  const ids = ["gmail:alex@example.com", "imap:alex.rivera@example.org"];
  const hashes = ids.flatMap((id) => {
    const address = id.slice(id.indexOf(":") + 1);
    return [id, address].map((value) =>
      createHash("sha256").update(value).digest("hex").slice(0, 16),
    );
  });

  test.for([["warn"], ["debug"]])(
    "openmail --log-level %s sync prints no account hash",
    async ([level = "warn"]) => {
      const sync = await openmail(["--log-level", level, "sync"], home.path);
      expect(sync.code).toBe(1);
      expect(sync.stderr).toContain("sync failed (full)");
      expect(sync.stderr).not.toContain("accountHash");
      for (const hash of hashes) expect(sync.stderr).not.toContain(hash);
    },
  );

  // A failed MCP sync logged only SyncFailedDiagnostic's fixed fields, so no line said why.
  test("openmail mcp logs why a sync failed in one line per account, with no hash or address", async () => {
    const stderr = await mcpSyncStderr(home.path);
    // Only the Gmail account lets AI read it, so the sync tool syncs only that one.
    expect(stderr.split("\n").filter((line) => line.trim() !== "")).toEqual([
      expect.stringMatching(
        /^\[\d\d:\d\d:\d\d\.\d{3}\] WARN \(#\d+\): gmail sync failed \(full\): ProviderError: Network calls are disabled in this offline session \{ logCode: 'sync-failed' \}$/,
      ),
    ]);
    expect(stderr).not.toContain("Diagnostic");
    expect(stderr).not.toContain("accountHash");
    expect(stderr).not.toContain("alex@example.com");
    expect(stderr).not.toContain("alex.rivera@example.org");
    for (const hash of hashes) expect(stderr).not.toContain(hash);
  });

  // `openmail tool sync` runs the MCP tool from the command line but logged the bare diagnostic.
  test("openmail tool sync logs why a sync failed in one line, like MCP", async () => {
    const tool = await openmail(["--log-level", "warn", "tool", "sync"], home.path);
    expect(tool.stderr.split("\n").filter((line) => line.includes("WARN"))).toEqual([
      expect.stringMatching(
        /WARN \(#\d+\): gmail sync failed \(full\): ProviderError: Network calls are disabled in this offline session \{ logCode: 'sync-failed' \}$/,
      ),
    ]);
    expect(tool.stderr).not.toContain("Diagnostic");
    for (const hash of hashes) expect(tool.stderr).not.toContain(hash);
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

    // One failed test must not leave rows that fail the next one.
    afterEach(() => {
      const db = new DatabaseSync(join(home.path, "mail.db"));
      try {
        db.prepare("DELETE FROM profiles WHERE name != 'Work'").run();
      } finally {
        db.close();
      }
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
      // An older space to remove by a padded name in another letter case.
      const seed = new DatabaseSync(join(home.path, "mail.db"));
      try {
        seed
          .prepare(
            "INSERT INTO profiles (id, name, icon, color, position) VALUES ('rest', 'Rest', 'R', 'blue', 98)",
          )
          .run();
      } finally {
        seed.close();
      }
      const add = (name: string) => openmail(["spaces", "add", name], home.path);
      // The two commands that write run together, then the ones that only refuse a name.
      const [padded, removed] = await Promise.all([
        add("  Play  "),
        openmail(["spaces", "remove", " rest "], home.path),
      ]);
      const [control, id, none, ...empty] = await Promise.all([
        add("Deep\twork"),
        // `--space` takes a name or an id, so a name can't be another space's id.
        add(String(space.id)),
        // `spaces assign <account> none` ungroups, so no space can be found by that name.
        add("None"),
        // Control, format and blank characters alone show as nothing.
        ...["", "   ", "\u200b", "\u2068\u2069", "\t\n"].map(add),
      ]);
      for (const result of empty) {
        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/^error: Enter a space name with letters or other visible/);
      }
      expect(control.code).toBe(1);
      expect(control.stderr).toMatch(/^error: A space name can't contain line breaks or tabs\./);
      expect(id.code).toBe(1);
      expect(id.stderr).toMatch(/^error: That is another space's id\. Choose another name\./);
      expect(none.code).toBe(1);
      expect(none.stderr).toMatch(/^error: The name none is reserved\./);
      expect(removed.code, removed.stderr).toBe(0);
      expect(padded.code, padded.stderr).toBe(0);
      expect(padded.stdout).toMatch(/^Added space Play \(.+\)\.$/m);
      const db = new DatabaseSync(join(home.path, "mail.db"));
      try {
        expect(db.prepare("SELECT name FROM profiles ORDER BY position").all()).toEqual([
          { name: "Work" },
          { name: "Play" },
        ]);
      } finally {
        db.close();
      }
    });

    // The app names the swatches Purple, Red, Brown, Green and Gray, but --color took only the
    // stored keys, so `--color brown` was a usage error. space-colors.test.ts checks every word.
    test("add takes the app's color words", async () => {
      const [brown, pink, help] = await Promise.all([
        openmail(["spaces", "add", "Brown", "--color", "brown"], home.path),
        openmail(["spaces", "add", "Pink", "--color", "pink"], home.path),
        openmail(["spaces", "add", "--help"], home.path),
      ]);
      expect(brown.code, brown.stderr).toBe(0);
      expect(pink.code).toBe(2);
      expect(pink.stderr).toContain(
        "must be one of blue, purple, red, orange, brown, green, teal, gray",
      );
      expect(help.stdout).toContain(
        "Color on the switcher: blue, purple, red, orange, brown, green, teal, gray",
      );
      const db = new DatabaseSync(join(home.path, "mail.db"));
      try {
        expect(db.prepare("SELECT name, color FROM profiles WHERE name != 'Work'").all()).toEqual([
          { name: "Brown", color: "amber" },
        ]);
      } finally {
        db.close();
      }
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
      expect(unknown.stderr).toMatch(/^error: No space with id or name Nowhere\.\nhint: /);
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
  // demo-data leaves mail.db in rollback-journal mode, and the first open switches it to WAL.
  // Run alone, the lock test below would block that switch, so the copy starts in WAL mode.
  beforeAll(() => exec("PRAGMA journal_mode=WAL"));

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
    expect(stderr).toBe(
      "error: No message with id gmail:alex@example.com/nope.\nhint: `openmail list` and `openmail search` print message ids.\n",
    );
  });

  test("a missing proposal is exit 1", async () => {
    const { code, stderr } = await openmail(["proposals", "reject", "99"]);
    expect(code).toBe(1);
    expect(stderr).toBe(
      "error: No proposal with id 99.\nhint: Run `openmail proposals list` to see the pending ones.\n",
    );
  });

  test("a missing account on health prints the hint on stderr", async () => {
    const { code, stderr } = await openmail(["health", "--account", "nobody"]);
    expect(code).toBe(1);
    expect(stderr).toContain("hint: Run `openmail accounts list` to see them.");
  });

  test("audit --limit outside 1 to 100 is a usage error like list", async () => {
    for (const limit of ["0", "-3", "101"]) {
      const { code, stderr } = await openmail(["audit", "--limit", limit]);
      expect(code, limit).toBe(2);
      expect(stderr).toContain("must be between 1 and 100");
    }
  });

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

  // Another process holding the write lock printed `error: Failed to configure database` (or
  // `Failed to execute statement`) after the 5 s busy timeout, with code internal and a hint to
  // report a bug. In rollback-journal mode, as demo-data leaves mail.db, the switch to WAL on
  // open needs the lock.
  test("a write lock another process keeps is code busy with a retry hint", async () => {
    const home = join(seeded, "busy");
    await cp(join(seeded, "home"), home, { recursive: true });
    const holder = new DatabaseSync(join(home, "mail.db"));
    holder.exec("PRAGMA journal_mode=DELETE");
    holder.exec("BEGIN IMMEDIATE");
    try {
      const { code, stdout, stderr } = await openmail(["list", "--json"], home);
      expect(code).toBe(1);
      expect(errorObject(stdout)).toEqual({
        message: "Another OpenMail process is writing to the local database.",
        code: "busy",
        hint: "Run the command again in a few seconds.",
      });
      expect(stderr).toBe(
        "error: Another OpenMail process is writing to the local database.\nhint: Run the command again in a few seconds.\n",
      );
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
  });

  test("agent write mode cannot be changed from the CLI", async () => {
    const { code, stderr } = await openmail(["agents", "write-mode", "allow"]);
    expect(code).toBe(1);
    expect(stderr).toContain("can only be changed in the app");
  });
});

// Sync turned the lock timeout into an error row per account: under a held write lock
// `openmail sync` waited the 5 s busy timeout for every account, logged an ERROR
// SyncCrashDiagnostic for each, and reported code failed.
test("sync under a write lock another process keeps stops at the first busy account", async () => {
  const home = await mkdtemp(join(tmpdir(), "openmail-cli-sync-busy-"));
  try {
    await cp(join(seeded, "home"), home, { recursive: true });
    const holder = new DatabaseSync(join(home, "mail.db"));
    holder.exec("PRAGMA journal_mode=WAL");
    holder.exec("BEGIN IMMEDIATE");
    try {
      const { code, stdout, stderr } = await openmail(["sync", "--json"], home, {
        OPENMAIL_OFFLINE: "1",
      });
      expect(code).toBe(1);
      expect(JSON.parse(stdout)).toEqual({
        message: "Another OpenMail process is writing to the local database.",
        code: "busy",
        hint: "Run the command again in a few seconds.",
      });
      expect(stderr).not.toContain("Diagnostic");
      expect(stderr.match(/^error: /gm)).toHaveLength(1);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// reauth refused an IMAP account with no next step; IMAP signs in again through `accounts add`.
test("accounts reauth names the add command for an IMAP account", async () => {
  const { code, stderr } = await openmail(["accounts", "reauth", "imap:alex.rivera@example.org"]);
  expect(code).toBe(1);
  expect(stderr).toBe(
    "error: IMAP accounts sign in again by adding the address with a new password.\nhint: Run `openmail accounts add imap --preset <preset> --email alex.rivera@example.org`.\n",
  );
});

// effect/cli matched --log-level case-sensitively and logged a bad value as an InvalidValue
// stack trace with exit 1.
test("--log-level takes any letter case and a bad value is a usage error", async () => {
  const listed = await openmail(["--log-level=Warn", "accounts", "list"]);
  expect(listed.code, listed.stderr).toBe(0);
  expect((await openmail(["accounts", "list", "--log-level", "ERROR"])).code).toBe(0);
  const bad = await openmail(["list", "--log-level", "bogus"]);
  expect(bad.code).toBe(2);
  expect(bad.stderr).toBe(
    'error: Invalid value for flag --log-level: "bogus". Expected one of all, trace, debug, info, warn, warning, error, fatal, none.\nUsage: openmail <command> [flags] --log-level <level>\nRun `openmail --help` for details.\n',
  );
});

// openmail-mcp --log-level bogus said "Unknown option" and exited 1; openmail mcp names the value
// and the valid ones and exits 2.
test("openmail-mcp refuses a bad --log-level the way openmail mcp does", async () => {
  const mcp = fileURLToPath(new URL("../dist/mcp.js", import.meta.url));
  const home = join(seeded, "home");
  const bin = (args: string[]) =>
    new Promise<{ code: number | null; stderr: string }>((done, failed) => {
      const child = spawn(
        process.execPath,
        ["--disable-warning=ExperimentalWarning", mcp, ...args],
        {
          env: { ...process.env, OPENMAIL_HOME: home },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.once("error", failed);
      child.once("close", (code) => done({ code, stderr }));
    });
  for (const args of [
    ["--log-level", "bogus"],
    ["--log-level=bogus"],
    ["--allow-writes", "--log-level"],
  ]) {
    const direct = await bin(args);
    const viaCli = await openmail(["mcp", ...args]);
    expect(direct.code, args.join(" ")).toBe(2);
    expect(viaCli.code).toBe(2);
    expect(direct.stderr.split("\n")[0]).toBe(viaCli.stderr.split("\n")[0]);
  }
  expect((await bin(["--bogus"])).code).toBe(1);
});

// A --server search that reached no server printed "(no conversations)" and exited 0.
test("search --server fails when the server search failed for every account", async () => {
  const offline = { OPENMAIL_OFFLINE: "1" };
  const text = await openmail(["search", "zzzqqq", "--server"], undefined, offline);
  expect(text.code).toBe(1);
  expect(text.stdout).toContain("(no conversations)");
  expect(text.stderr).toContain(
    "error: The server search failed for every account.\nhint: Check the connection and try again, or search without --server.",
  );
  const json = await openmail(["search", "launch", "--server", "--json"], undefined, offline);
  expect(json.code).toBe(1);
  const output = row(JSON.parse(json.stdout));
  expect(rows(output.threads).length).toBeGreaterThan(0);
  expect(output.error).toMatchObject({ code: "provider_unavailable" });
  const local = await openmail(["search", "launch"], undefined, offline);
  expect(local.code, local.stderr).toBe(0);
});
