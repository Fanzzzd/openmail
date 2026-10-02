import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const digest = /^[a-f0-9]{64}$/;
/** No provider-controlled path or filename enters the filesystem. */
export class PersistentAttachments {
  private readonly root: string;
  private queue: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  version() {
    return this.epoch;
  }
  constructor(directory: string) {
    this.root = path.join(path.resolve(directory), "attachment-cache");
  }
  private serial<A>(work: () => Promise<A>): Promise<A> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => null);
    return next;
  }
  private async directory(folder: string) {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const info = await lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid cache directory");
    await chmod(folder, 0o700);
  }
  private async entries() {
    await this.directory(this.root);
    const files: { account: string; file: string; bytes: number; used: number }[] = [];
    for (const account of await readdir(this.root)) {
      if (!digest.test(account)) continue;
      const folder = path.join(this.root, account);
      const info = await lstat(folder);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      await chmod(folder, 0o700);
      for (const name of await readdir(folder)) {
        if (!/^[a-f0-9]{64}\.bin$/.test(name)) continue;
        const file = path.join(folder, name);
        const stat = await lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        files.push({ account, file, bytes: stat.size, used: stat.mtimeMs });
      }
    }
    return files;
  }
  get(accountId: string, key: string, maxBytes: number) {
    return this.serial(async () => {
      const folder = path.join(this.root, hash(accountId));
      await this.directory(this.root);
      const info = await lstat(folder).catch(() => null);
      if (!info?.isDirectory() || info.isSymbolicLink()) return null;
      const file = await open(
        path.join(folder, `${hash(key)}.bin`),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      ).catch(() => null);
      if (!file) return null;
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > maxBytes) return null;
        await file.chmod(0o600);
        const data = await file.readFile();
        await file.utimes(new Date(), new Date());
        return data;
      } finally {
        await file.close();
      }
    });
  }
  set(accountId: string, key: string, data: Uint8Array, maxBytes: number, version = this.epoch) {
    return this.serial(async () => {
      if (version !== this.epoch || data.byteLength > maxBytes || maxBytes === 0) return;
      await this.directory(this.root);
      const folder = path.join(this.root, hash(accountId));
      await this.directory(folder);
      const temporary = path.join(folder, `${randomUUID()}.tmp`);
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(data);
      } finally {
        await file.close();
      }
      try {
        await rename(temporary, path.join(folder, `${hash(key)}.bin`));
      } finally {
        await rm(temporary, { force: true });
      }
      await this.evict(maxBytes);
    });
  }
  private async evict(maxBytes: number) {
    const files = (await this.entries()).toSorted(
      (a, b) => a.used - b.used || a.file.localeCompare(b.file),
    );
    let bytes = files.reduce((n, f) => n + f.bytes, 0);
    for (const file of files) {
      if (bytes <= maxBytes) break;
      await rm(file.file, { force: true });
      bytes -= file.bytes;
    }
  }
  trim(maxBytes: number) {
    this.epoch++;
    return this.serial(() => this.evict(maxBytes));
  }
  size(accountId?: string) {
    return this.serial(async () =>
      (await this.entries())
        .filter((f) => accountId === undefined || f.account === hash(accountId))
        .reduce((n, f) => n + f.bytes, 0),
    );
  }
  clear(accountId?: string) {
    this.epoch++;
    return this.serial(async () => {
      await this.directory(this.root);
      if (accountId !== undefined)
        await rm(path.join(this.root, hash(accountId)), { force: true, recursive: true });
      else
        for (const entry of await readdir(this.root))
          await rm(path.join(this.root, entry), { force: true, recursive: true });
    });
  }
}
