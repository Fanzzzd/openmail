import { applyNativeMigration } from "./migrations.js";
import { expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "../../db.js";
import { prepareSmokeDatabase } from "./smoke.js";

it("smoke preparation upgrades only the copy, retains WAL messages and forces manual read in English", () => {
  const root = mkdtempSync(join(tmpdir(), "openmail-smoke-test-"));
  const target = mkdtempSync(join(tmpdir(), "openmail-smoke-copy-"));
  const file = join(root, "mail.db");
  const source = new DatabaseSync(file);
  try {
    for (const migration of MIGRATIONS.slice(0, 12)) applyNativeMigration(source, migration);
    source.exec("PRAGMA user_version=12; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
    source.exec(
      "INSERT INTO accounts(id,provider,email,created_at) VALUES('one','gmail','me@example.com',1)",
    );
    source.exec("INSERT INTO prefs(key,value_json) VALUES('markReadDelay','1')");
    const config = join(root, "config.json");
    const registration = JSON.stringify({
      google: { clientId: "fake-client", clientSecret: "fake-secret" },
      microsoft: { clientId: "fake-microsoft" },
    });
    writeFileSync(config, registration);
    const configBefore = statSync(config);
    const before = readFileSync(file),
      wal = readFileSync(`${file}-wal`);
    expect(prepareSmokeDatabase(file, target).accounts).toBe(1);
    expect(readFileSync(join(target, "config.json"), "utf8")).toBe(registration);
    expect(statSync(join(target, "config.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(config, "utf8")).toBe(registration);
    expect(statSync(config).mtimeMs).toBe(configBefore.mtimeMs);
    writeFileSync(join(target, "config.json"), "{}");
    expect(readFileSync(config, "utf8")).toBe(registration);
    expect(readFileSync(file)).toEqual(before);
    expect(readFileSync(`${file}-wal`)).toEqual(wal);
    expect(source.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(12);
    expect(
      source.prepare("SELECT value_json FROM prefs WHERE key='markReadDelay'").get()?.[
        "value_json"
      ],
    ).toBe("1");
    const copy = new DatabaseSync(join(target, "mail.db"));
    try {
      expect(copy.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(MIGRATIONS.length);
      expect(
        copy.prepare("SELECT value_json FROM prefs WHERE key='markReadDelay'").get()?.[
          "value_json"
        ],
      ).toBe('"manual"');
      expect(
        copy.prepare("SELECT value_json FROM prefs WHERE key='language'").get()?.["value_json"],
      ).toBe('"en"');
      // Stray input that reaches the smoke window cannot trash mail.
      expect(
        JSON.parse(
          String(
            copy.prepare("SELECT value_json FROM prefs WHERE key='swipeActions'").get()?.[
              "value_json"
            ],
          ),
        ),
      ).toEqual({ leftShort: "none", leftLong: "none", rightShort: "none", rightLong: "none" });
      expect(
        copy.prepare("SELECT value_json FROM prefs WHERE key='deleteKeyAction'").get()?.[
          "value_json"
        ],
      ).toBe('"ask"');
    } finally {
      copy.close();
    }
    expect(() => prepareSmokeDatabase(file, root)).toThrow("separate copy");
  } finally {
    source.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

it("smoke preparation without a source creates an isolated empty database", () => {
  const target = mkdtempSync(join(tmpdir(), "openmail-smoke-empty-"));
  try {
    expect(prepareSmokeDatabase(undefined, target)).toEqual({ accounts: 0, messages: 0 });
    expect(existsSync(join(target, "config.json"))).toBe(false);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

it("migration 37 with foreign keys enabled preserves all dependent projections", () => {
  const root = mkdtempSync(join(tmpdir(), "openmail-smoke-fk-"));
  const target = mkdtempSync(join(tmpdir(), "openmail-smoke-fk-copy-"));
  const file = join(root, "mail.db");
  const source = new DatabaseSync(file);
  try {
    for (const migration of MIGRATIONS.slice(0, 36)) applyNativeMigration(source, migration);
    source.exec("PRAGMA user_version=36; PRAGMA foreign_keys=ON");
    source.exec(
      "INSERT INTO accounts(id,provider,email,created_at) VALUES('a','gmail','test@example.com',0)",
    );
    source.exec(`INSERT INTO messages(id,account_id,provider_id,thread_id,subject,from_name,from_addr,to_json,cc_json,date,snippet,body_text,body_html,labels_json,attachments_json,is_unread,is_starred)
      VALUES('a/one','a','one','a/thread','searchneedle','Person','person@example.com','[]','[]',0,'','text','','["INBOX"]','[]',1,0)`);
    const tables = ["contact_candidates", "message_search_meta", "semantic_jobs", "message_badges"];
    // Later migrations add columns; compare the ones that existed at migration 37.
    const select = (table: string) =>
      table === "contact_candidates"
        ? "SELECT rowid,* FROM contact_candidates"
        : table === "message_search_meta"
          ? "SELECT row_id,message_id,account_id,thread_id,eligible FROM message_search_meta"
          : `SELECT * FROM ${table}`;
    const before = tables.map((table) => source.prepare(select(table)).all());
    expect(before.every((rows) => rows.length > 0)).toBe(true);
    prepareSmokeDatabase(file, target);
    const copy = new DatabaseSync(join(target, "mail.db"));
    try {
      expect(copy.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
      expect(tables.map((table) => copy.prepare(select(table)).all())).toEqual(before);
      expect(copy.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      copy.exec("INSERT INTO messages_fts(messages_fts,rank) VALUES('integrity-check',1)");
    } finally {
      copy.close();
    }
  } finally {
    source.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});
