// `openmail corpus-check` through the built CLI. The scanner itself is tested in
// packages/core/src/platform/node/corpus-check.test.ts; these cases cover the command's
// output, its run-key handling and that it opens no Mailbox, network or keychain.
import { createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { corpusCheck } from "@openmail/core/node";
import { Schema } from "effect";
import { afterAll, beforeAll, describe, it } from "vitest";
import { writeMigratedDatabase } from "../../core/test-support/migrated-database.js";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const directories: string[] = [];
afterAll(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SECRETS = [
  "SecretSubjectZephyra",
  "PrivateSenderName",
  "SecretSender",
  "SecretSenderDomain",
  "PrivateRecipientName",
  "SecretRecipient",
  "SecretRecipientDomain",
  "SecretBodyCobalt",
  "SecretBodyNebula",
  "PrivateSnippetMarker",
  "PrivateFileMarker",
  "PrivateBoundaryMarker",
  "PrivateBadDateMarker",
  "PrivateDomainMarker",
  "PrivateAccountMarker",
];

/** A migrated database with one account; `add` inserts a message full of canary strings. */
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "openmail-cli-corpus-"));
  directories.push(directory);
  const file = join(directory, "fixture.db");
  writeMigratedDatabase(file);
  const db = new DatabaseSync(file);
  db.exec("PRAGMA synchronous=OFF");
  db.prepare(
    "INSERT INTO accounts(id,provider,email,created_at,settings_json) VALUES (?,?,?,?,?)",
  ).run(
    "PrivateAccountMarker",
    "gmail",
    "PrivateAccountAddress@PrivateAccountDomain.invalid",
    1,
    null,
  );
  const keyDirectory = mkdtempSync(join(tmpdir(), "openmail-cli-corpus-key-"));
  directories.push(keyDirectory);
  const runKeyFile = join(keyDirectory, "run.key");
  const rowids = new Map<string, number>();
  const add = (id: string, html: string, date = 10) => {
    const result = db
      .prepare(`INSERT INTO messages(id,account_id,provider_id,thread_id,subject,from_name,from_addr,to_json,cc_json,date,snippet,body_text,body_html,labels_json,attachments_json,is_unread,is_starred,body_cached,headers_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        id,
        "PrivateAccountMarker",
        `PrivateProviderMarker${id}`,
        "PrivateThreadMarker",
        "SecretSubjectZephyra",
        "PrivateSenderName",
        "SecretSender@SecretSenderDomain.invalid",
        JSON.stringify([
          {
            name: "PrivateRecipientName",
            address: "SecretRecipient@SecretRecipientDomain.invalid",
          },
        ]),
        "[]",
        date,
        "PrivateSnippetMarker",
        "SecretBodyCobalt SecretBodyNebula",
        html,
        "[]",
        JSON.stringify([
          { filename: "PrivateFileMarker.pdf", mimeType: "application/pdf", size: 123 },
        ]),
        0,
        0,
        1,
        JSON.stringify([
          { name: "Content-Type", value: "multipart/alternative; boundary=PrivateBoundaryMarker" },
          {
            name: "Authentication-Results",
            value: "mx.google.com; dmarc=fail; spf=fail; dkim=fail header.d=PrivateDomainMarker",
          },
          { name: "Date", value: "PrivateBadDateMarker" },
        ]),
      );
    rowids.set(id, Number(result.lastInsertRowid));
  };
  const hash = (id: string) => {
    const rowid = rowids.get(id);
    if (rowid === undefined) throw new Error("Unknown fixture ID");
    return createHmac("sha256", Buffer.from(readFileSync(runKeyFile, "utf8"), "hex"))
      .update(String(rowid))
      .digest("hex");
  };
  return { directory, file, db, add, runKeyFile, hash };
}

const node = ["--disable-warning=ExperimentalWarning"];
const options = (directory: string) => ({
  env: { ...process.env, OPENMAIL_HOME: join(directory, "must-not-exist") },
  timeout: 30_000,
});

// Each case waits on child processes; they run concurrently with each other.
it.concurrent("CLI JSON is content-free and bypasses Mailbox/network/keychain initialization", async ({
  expect,
}) => {
  const f = fixture();
  f.add("PrivateCliId", "<p>SecretHtmlOrion</p>");
  f.db.close();
  const guard = join(f.directory, "no-network.mjs");
  writeFileSync(
    guard,
    `import net from 'node:net'; import tls from 'node:tls';\nnet.Socket.prototype.connect = () => { throw new Error('Network forbidden'); };\ntls.connect = () => { throw new Error('Network forbidden'); };\nglobalThis.fetch = () => { throw new Error('Network forbidden'); };`,
  );
  const { stdout, stderr } = await run(
    process.execPath,
    [...node, "--import", guard, cli, "corpus-check", "--db", f.file, "--json"],
    options(f.directory),
  );
  const result = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ processed: Schema.Int })),
  )(stdout);
  expect(result.processed).toBe(1);
  expect(stderr).toBe("");
  expect(existsSync(join(f.directory, "must-not-exist"))).toBe(false);
  for (const word of [...SECRETS, "SecretHtmlOrion", "invalid", "PrivateCliId"])
    expect(stdout).not.toContain(word);
});

describe.concurrent("CLI explain", () => {
  let f: ReturnType<typeof fixture>;
  let target: string;
  beforeAll(() => {
    f = fixture();
    const html =
      '<html><head><style>@media screen {.PrivateSelectorCanary:not(#PrivateIdCanary){display:none}}</style><body><p class="PrivateSelectorCanary">PrivateBodyCanary</p><!--[if mso]><p>PrivateMsoCanary</p><![endif]--></body></html>';
    f.add("PrivateExplainId", html, 1);
    f.add("PrivateOtherId", "<p>PrivateOtherBodyCanary</p>", 2);
    f.db.close();
    writeFileSync(f.runKeyFile, "b".repeat(64), { mode: 0o600 });
    target = f.hash("PrivateExplainId");
  });

  it("matches the core explanation and keeps fixture content private", async ({ expect }) => {
    const explained = await corpusCheck({ db: f.file, explain: target, runKeyFile: f.runKeyFile });
    const { stdout, stderr } = await run(
      process.execPath,
      [
        ...node,
        cli,
        "corpus-check",
        "--db",
        f.file,
        "--explain",
        target,
        "--run-key",
        f.runKeyFile,
        "--json",
      ],
      options(f.directory),
    );
    expect(JSON.parse(stdout)).toEqual(explained);
    expect(stderr).toBe("");
    expect(existsSync(join(f.directory, "must-not-exist"))).toBe(false);
    for (const word of [
      ...SECRETS,
      "PrivateSelectorCanary",
      "PrivateIdCanary",
      "PrivateBodyCanary",
      "PrivateMsoCanary",
    ])
      expect(stdout.toLowerCase()).not.toContain(word.toLowerCase());
  });

  it("requires an explicit run key", async ({ expect }) => {
    await expect(
      run(
        process.execPath,
        [...node, cli, "corpus-check", "--db", f.file, "--explain", target],
        options(f.directory),
      ),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("Explain requires --run-key") });
  });
});

describe.concurrent("CLI explain-ready", () => {
  let f: ReturnType<typeof fixture>;
  let args: string[];
  let stdout: string;
  let stderr: string;
  let file: string;
  let key: string;
  let target: string;
  beforeAll(async () => {
    f = fixture();
    f.add("PrivateExplainReadyId", "<p>PrivateExplainReadyBody</p>");
    f.db.close();
    args = [...node, cli, "corpus-check", "--db", f.file, "--json"];
    ({ stdout, stderr } = await run(
      process.execPath,
      [...args, "--explain-ready"],
      options(f.directory),
    ));
    const path = /^Run key file: (.+)\n$/.exec(stderr)?.[1];
    if (!path) throw new Error("Missing run key file path");
    file = path;
    directories.push(join(file, ".."));
    key = readFileSync(file, "utf8");
    target = createHmac("sha256", Buffer.from(key, "hex")).update("1").digest("hex");
  });
  it("writes only its private key path to stderr", ({ expect }) => {
    expect(stdout).toContain(target);
    expect(stdout).not.toContain(file);
    expect(stdout).not.toContain(key);
    expect(stderr).not.toContain(key);
    expect(existsSync(join(f.directory, "must-not-exist"))).toBe(false);
    expect(readdirSync(f.directory)).toEqual(["fixture.db"]);
  });
  it("can explain a sample with the generated run key", async ({ expect }) => {
    const explained = await run(
      process.execPath,
      [...args, "--explain", target, "--run-key", file],
      options(f.directory),
    );
    expect(JSON.parse(explained.stdout)).toMatchObject({
      mode: "explain",
      status: "complete",
      sample: { hash: target },
    });
    expect(explained.stdout).not.toContain(key);
    expect(explained.stderr).toBe("");
    expect(existsSync(join(f.directory, "must-not-exist"))).toBe(false);
    expect(readdirSync(f.directory)).toEqual(["fixture.db"]);
  });
});
