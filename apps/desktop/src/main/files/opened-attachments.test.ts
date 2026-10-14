import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  BACKUP_EXCLUDE_ATTRIBUTE,
  BACKUP_EXCLUDE_VALUE,
  excludeFromBackup,
  OpenedAttachments,
} from "./opened-attachments";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "om-opened-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );
const DAY = 24 * 60 * 60 * 1000;

// E9-3: opened attachments lived in the 30-minute temp batches, so edits saved in place were
// deleted with them, and on quit.
it("an opened attachment the user edited survives cleanup; untouched old copies go", async () => {
  const store = new OpenedAttachments(path.join(root, "Opened"), 7 * DAY);
  const edited = await store.write("m1/0", { filename: "contract.docx", data: Buffer.from("abc") });
  const untouched = await store.write("m1/1", { filename: "scan.pdf", data: Buffer.from("pdf") });
  expect(edited.created).toBe(true);
  // The default app saves the user's edits in place.
  await writeFile(edited.file, "user edits");
  await store.cleanup(Date.now() + 8 * DAY - 1000 * 60);
  expect(await readFile(edited.file, "utf8")).toBe("user edits");
  expect(await exists(untouched.file)).toBe(false);
  expect(await exists(path.dirname(untouched.file))).toBe(false);
  // Saving again to the same path still works.
  await writeFile(edited.file, "more edits");
  // Opened within the lifetime: kept.
  const recent = await store.write("m2/0", { filename: "notes.txt", data: Buffer.from("n") });
  await store.cleanup(Date.now() + 1000);
  expect(await exists(recent.file)).toBe(true);
});

it("reopening reuses an unchanged copy and never overwrites an edited one", async () => {
  const store = new OpenedAttachments(path.join(root, "Opened"));
  const part = { filename: "../report.pdf", data: Buffer.from("original") };
  const first = await store.write("m/0", part);
  const again = await store.write("m/0", part);
  expect(again).toEqual({ file: first.file, created: false });
  expect(path.basename(first.file)).toBe("report.pdf");
  expect((await stat(first.file)).mode & 0o777).toBe(0o600);
  expect((await stat(path.dirname(first.file))).mode & 0o777).toBe(0o700);
  await writeFile(first.file, "edited!!");
  // Same size, different time: still an edit.
  await utimes(first.file, new Date(), new Date(Date.now() + 5000));
  const fresh = await store.write("m/0", part);
  expect(fresh.created).toBe(true);
  expect(fresh.file).not.toBe(first.file);
  expect(await readFile(fresh.file, "utf8")).toBe("original");
  expect(await readFile(first.file, "utf8")).toBe("edited!!");
  expect((await store.write("m/0", part)).file).toBe(fresh.file);
});

// E9-4: Open went through the 128 MB temporary budget.
it("opens attachments larger than the temporary budget", async () => {
  const store = new OpenedAttachments(path.join(root, "Opened"));
  const big = new Uint8Array(130 * 1024 * 1024);
  const copy = await store.write("m/big", { filename: "video.mov", data: big });
  expect((await stat(copy.file)).size).toBe(big.byteLength);
});

it("discard removes only a copy inside the store; cleanup skips unknown folders", async () => {
  const store = new OpenedAttachments(path.join(root, "Opened"));
  const copy = await store.write("m/0", { filename: "a.txt", data: Buffer.from("a") });
  await store.discard(path.join(root, "elsewhere", "a.txt"));
  expect(await exists(copy.file)).toBe(true);
  await store.discard(copy.file);
  expect(await exists(copy.file)).toBe(false);
  const stranger = path.join(root, "Opened", "keep-me");
  await writeFile(stranger, "x");
  await store.cleanup(Date.now() + 365 * DAY);
  expect(await readdir(path.join(root, "Opened"))).toEqual(["keep-me"]);
});

// R10 A-1: removing an account left its copies; Settings had no way to clear them.
it("removing an account deletes its unchanged copies and keeps edited ones", async () => {
  const store = new OpenedAttachments(path.join(root, "Opened"));
  const kept = await store.write("a/0", { filename: "a.txt", data: Buffer.from("a") }, "gmail:a");
  const gone = await store.write("a/1", { filename: "b.txt", data: Buffer.from("b") }, "gmail:a");
  const other = await store.write("b/0", { filename: "c.txt", data: Buffer.from("c") }, "imap:b");
  const legacy = await store.write("c/0", { filename: "d.txt", data: Buffer.from("d") });
  await writeFile(kept.file, "edited");
  expect(await store.removeAccount("gmail:a")).toBe(1);
  expect(await readFile(kept.file, "utf8")).toBe("edited");
  expect(await exists(path.dirname(gone.file))).toBe(false);
  expect(await exists(other.file)).toBe(true);
  expect(await exists(legacy.file)).toBe(true);
  // The record holds a hash of the account ID, not the address.
  const record = await readFile(
    path.join(path.dirname(other.file), ".openmail-opened.json"),
    "utf8",
  );
  expect(record).not.toContain("imap:b");
});

it("reports usage and clears every copy, edited ones included", async () => {
  const store = new OpenedAttachments(path.join(root, "Opened"));
  expect(await store.usage()).toEqual({ bytes: 0, copies: 0, edited: 0 });
  const edited = await store.write("m/0", { filename: "a.txt", data: Buffer.from("abc") });
  await store.write("m/1", { filename: "b.txt", data: Buffer.from("de") });
  await writeFile(edited.file, "abcdef");
  const usage = await store.usage();
  expect(usage).toMatchObject({ copies: 2, edited: 1 });
  // Both files plus their records.
  expect(usage.bytes).toBeGreaterThan(8);
  const stranger = path.join(root, "Opened", "keep-me");
  await writeFile(stranger, "x");
  expect(await store.clear()).toEqual({ bytes: 0, copies: 0, edited: 0 });
  expect(await readdir(path.join(root, "Opened"))).toEqual(["keep-me"]);
});

it("cleanup removes an hour-old folder whose write stopped before its record", async () => {
  const store = new OpenedAttachments(path.join(root, "Opened"));
  const copy = await store.write("m/0", { filename: "a.txt", data: Buffer.from("a") });
  const damaged = await store.write("m/1", { filename: "b.txt", data: Buffer.from("b") });
  await rm(path.join(path.dirname(copy.file), ".openmail-opened.json"));
  await writeFile(path.join(path.dirname(damaged.file), ".openmail-opened.json"), "{");
  await store.cleanup(Date.now() + 1000);
  expect(await exists(copy.file)).toBe(true);
  await store.cleanup(Date.now() + 2 * 60 * 60 * 1000);
  expect(await exists(path.dirname(copy.file))).toBe(false);
  expect(await exists(damaged.file)).toBe(true);
});

it("marks the root for Time Machine to skip, once per instance", async () => {
  const excluded: string[] = [];
  const store = new OpenedAttachments(path.join(root, "Opened"), DAY, async (folder) => {
    excluded.push(folder);
  });
  await store.write("m/0", { filename: "a.txt", data: Buffer.from("a") });
  await store.write("m/1", { filename: "b.txt", data: Buffer.from("b") });
  await store.cleanup();
  expect(excluded).toEqual([path.join(root, "Opened")]);
  // No root yet: cleanup creates nothing.
  const empty = new OpenedAttachments(path.join(root, "Missing"), DAY, async (folder) => {
    excluded.push(folder);
  });
  await empty.cleanup();
  expect(await exists(path.join(root, "Missing"))).toBe(false);
});

it.runIf(process.platform === "darwin")(
  "writes the attribute tmutil addexclusion writes, and tmutil reports the folder excluded",
  async () => {
    const folder = path.join(root, "Excluded");
    await mkdir(folder);
    await excludeFromBackup(folder);
    const run = promisify(execFile);
    const { stdout: value } = await run("/usr/bin/xattr", [
      "-px",
      BACKUP_EXCLUDE_ATTRIBUTE,
      folder,
    ]);
    expect(value.replace(/\s/g, "")).toBe(BACKUP_EXCLUDE_VALUE);
    const { stdout } = await run("/usr/bin/tmutil", ["isexcluded", folder]);
    expect(stdout).toContain("[Excluded]");
  },
);
