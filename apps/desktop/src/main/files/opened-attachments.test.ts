import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { OpenedAttachments } from "./opened-attachments";

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
