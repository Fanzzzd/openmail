import { expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    for (const migration of MIGRATIONS.slice(0, 12)) source.exec(migration);
    source.exec("PRAGMA user_version=12; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
    source.exec(
      "INSERT INTO accounts(id,provider,email,created_at) VALUES('one','gmail','me@example.com',1)",
    );
    source.exec("INSERT INTO prefs(key,value_json) VALUES('markReadDelay','1')");
    const before = readFileSync(file),
      wal = readFileSync(`${file}-wal`);
    expect(prepareSmokeDatabase(file, target).accounts).toBe(1);
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
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});
