import { AttachmentFiles, type AttachmentFileCache } from "@openmail/core/portable";
import { Layer } from "effect";
import { Directory, File, Paths } from "expo-file-system";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const hash = (value: string) => bytesToHex(sha256(new TextEncoder().encode(value)));
const digest = /^[a-f0-9]{64}$/;
/** The OS may evict this directory; original mail and drafts remain in Documents. */
export class MobileAttachmentCache implements AttachmentFileCache {
  private readonly root = new Directory(Paths.cache, "openmail-attachments");
  private epoch = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly used = new Map<string, number>();
  version() {
    return this.epoch;
  }
  private serial<A>(work: () => Promise<A>): Promise<A> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => null);
    return next;
  }
  private entries() {
    this.root.create({ intermediates: true, idempotent: true });
    const out: { account: string; file: File; bytes: number; used: number }[] = [];
    for (const directory of this.root.list()) {
      if (!(directory instanceof Directory) || !digest.test(directory.name)) continue;
      for (const file of directory.list()) {
        if (!(file instanceof File) || !/^[a-f0-9]{64}\.bin$/.test(file.name)) continue;
        out.push({
          account: directory.name,
          file,
          bytes: file.size,
          used: this.used.get(file.uri) ?? file.modificationTime ?? 0,
        });
      }
    }
    return out;
  }
  get(accountId: string, key: string, maxBytes: number) {
    return this.serial(async () => {
      const file = new File(this.root, hash(accountId), `${hash(key)}.bin`);
      if (!file.exists || file.size > maxBytes) return null;
      try {
        const bytes = await file.bytes();
        this.used.set(file.uri, Date.now());
        return bytes;
      } catch {
        return null;
      }
    });
  }
  set(accountId: string, key: string, data: Uint8Array, maxBytes: number, version = this.epoch) {
    return this.serial(async () => {
      if (version !== this.epoch || data.byteLength > maxBytes || maxBytes === 0) return;
      const directory = new Directory(this.root, hash(accountId));
      directory.create({ intermediates: true, idempotent: true });
      const file = new File(directory, `${hash(key)}.bin`);
      file.write(data);
      this.used.set(file.uri, Date.now());
      this.evict(maxBytes);
    });
  }
  private evict(maxBytes: number) {
    const files = this.entries().sort(
      (a, b) => a.used - b.used || a.file.uri.localeCompare(b.file.uri),
    );
    let bytes = files.reduce((n, f) => n + f.bytes, 0);
    for (const item of files) {
      if (bytes <= maxBytes) break;
      item.file.delete();
      this.used.delete(item.file.uri);
      bytes -= item.bytes;
    }
  }
  trim(maxBytes: number) {
    this.epoch++;
    return this.serial(async () => this.evict(maxBytes));
  }
  size(accountId?: string) {
    return this.serial(async () =>
      this.entries()
        .filter((f) => accountId === undefined || f.account === hash(accountId))
        .reduce((n, f) => n + f.bytes, 0),
    );
  }
  clear(accountId?: string) {
    this.epoch++;
    return this.serial(async () => {
      const directory =
        accountId === undefined ? this.root : new Directory(this.root, hash(accountId));
      if (directory.exists) directory.delete();
      this.used.clear();
    });
  }
}
export const attachmentFilesLayer = Layer.succeed(AttachmentFiles, {
  open: () => new MobileAttachmentCache(),
});
