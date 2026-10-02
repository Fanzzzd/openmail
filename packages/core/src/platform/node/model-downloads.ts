import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { MediaError, type ModelsStatus } from "../../media.js";
import { MODEL_FILES, MODEL_BYTES } from "../../model-manifest.js";

export type ModelFile = {
  readonly model: string;
  readonly revision: string;
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
};
const size = async (file: string) => {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
};
async function verified(
  file: string,
  expected: ModelFile,
  signal: AbortSignal,
  cache?: Map<string, string>,
) {
  let metadata;
  try {
    metadata = await stat(file);
  } catch {
    return false;
  }
  if (metadata.size !== expected.bytes) return false;
  const key = `${file}:${expected.sha256}`;
  const fingerprint = `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`;
  if (cache?.get(key) === fingerprint) return true;
  const hash = createHash("sha256");
  for await (const block of createReadStream(file, { signal })) hash.update(block);
  const valid = hash.digest("hex") === expected.sha256;
  if (valid) cache?.set(key, fingerprint);
  return valid;
}
/** GET-only, fixed model URLs. Mail and query text never enter this module. */
export function modelFiles(
  root: string,
  download: boolean,
  progress: (state: ModelsStatus) => void,
  options: {
    files?: readonly ModelFile[];
    fetch?: typeof fetch;
    signal?: AbortSignal;
    cache?: Map<string, string>;
  } = {},
) {
  return Effect.tryPromise({
    try: async (effectSignal) => {
      const signal = AbortSignal.any([effectSignal, options.signal ?? effectSignal]);
      const files = options.files ?? MODEL_FILES;
      const total = files.reduce((sum, file) => sum + file.bytes, 0);
      let done = 0;
      const lock = join(root, ".download-lock");
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      if (download) {
        await mkdir(root, { recursive: true, mode: 0o700 });
        try {
          await mkdir(lock);
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST")
            throw error;
          if ((await stat(lock)).mtimeMs > Date.now() - 5 * 60_000)
            throw new Error("Model download already running", { cause: error });
          await rm(lock, { recursive: true, force: true });
          await mkdir(lock);
        }
        heartbeat = setInterval(() => {
          void utimes(lock, new Date(), new Date()).catch(() => false);
        }, 5000);
      }
      try {
        for (const item of files) {
          const file = join(root, item.model, item.file);
          if (await verified(file, item, signal, options.cache)) {
            done += item.bytes;
            continue;
          }
          if (!download) throw new Error("Models are not available locally");
          const part = `${file}.part`;
          await mkdir(join(root, item.model, item.file.includes("/") ? "onnx" : ""), {
            recursive: true,
            mode: 0o700,
          });
          let offset = await size(part);
          if (offset > item.bytes) {
            await rm(part, { force: true });
            offset = 0;
          }
          progress({
            kind: "downloading",
            bytes: done + offset,
            total,
            file: `${item.model}/${item.file}`,
          });
          if (offset < item.bytes) {
            const response = await (options.fetch ?? fetch)(
              `https://huggingface.co/${item.model}/resolve/${item.revision}/${item.file}`,
              {
                method: "GET",
                headers: offset ? { Range: `bytes=${offset}-` } : {},
                signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
              },
            );
            if (!response.ok || !response.body) throw new Error("Model download failed");
            if (response.status === 206) {
              const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
                response.headers.get("content-range") ?? "",
              );
              if (
                !range ||
                Number(range[1]) !== offset ||
                Number(range[3]) !== item.bytes ||
                Number(range[2]) < offset ||
                Number(range[2]) >= item.bytes
              )
                throw new Error("Invalid model range response");
            } else if (response.status === 200) offset = 0;
            else throw new Error("Invalid model response");
            const fd = await open(part, offset ? "a" : "w", 0o600);
            try {
              for await (const block of response.body) {
                if (offset + block.length > item.bytes) throw new Error("Model size mismatch");
                let written = 0;
                while (written < block.length) {
                  const result = await fd.write(block, written, block.length - written);
                  if (!result.bytesWritten) throw new Error("Model write failed");
                  written += result.bytesWritten;
                  offset += result.bytesWritten;
                }
                progress({
                  kind: "downloading",
                  bytes: done + offset,
                  total,
                  file: `${item.model}/${item.file}`,
                });
              }
            } finally {
              await fd.close();
            }
          }
          if (!(await verified(part, item, signal))) {
            // A transport interruption keeps its prefix; a complete corrupt file
            // must restart instead of repeatedly requesting bytes after EOF.
            if ((await size(part)) === item.bytes) await rm(part, { force: true });
            throw new Error("Model verification failed");
          }
          await rename(part, file);
          if (options.cache) {
            const m = await stat(file);
            options.cache.set(
              `${file}:${item.sha256}`,
              `${m.dev}:${m.ino}:${m.size}:${m.mtimeMs}:${m.ctimeMs}`,
            );
          }
          done += item.bytes;
        }
        return done;
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        if (download) await rm(lock, { recursive: true, force: true });
      }
    },
    catch: () =>
      new MediaError({ message: "On-device models are unavailable or failed verification" }),
  });
}
export { MODEL_BYTES };
