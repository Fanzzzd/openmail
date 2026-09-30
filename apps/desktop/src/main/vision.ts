import { execFile } from "node:child_process";
import { accessSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { MediaError, VisionResult, unavailableVision, type Vision } from "@openmail/core";

const execute = (binary: string, args: string[], signal?: AbortSignal) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      binary,
      args,
      { timeout: 120_000, maxBuffer: 8 * 1024 * 1024, signal },
      (error, stdout) => {
        if (error) reject(new Error("Vision process failed"));
        else resolve(stdout);
      },
    );
  });
/** The executable sees only an owner-readable temporary file, deleted after every run. */
export async function desktopVision(binary: string): Promise<Vision> {
  if (process.platform !== "darwin") return unavailableVision;
  let revision: number;
  try {
    accessSync(binary);
    revision = Number((await execute(binary, ["--version"])).trim());
  } catch {
    return unavailableVision;
  }
  if (!Number.isInteger(revision) || revision < 1) return unavailableVision;
  return {
    available: true,
    version: `vision-${revision}:swift2-orientation`,
    recognize: (data) =>
      Effect.tryPromise({
        try: async (signal) => {
          const dir = await mkdtemp(join(tmpdir(), "openmail-vision-"));
          try {
            const file = join(dir, "image");
            await writeFile(file, data, { mode: 0o600 });
            const output = await execute(binary, [file], signal);
            return Schema.decodeUnknownSync(Schema.fromJsonString(VisionResult))(output);
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        },
        catch: () => new MediaError({ message: "On-device image recognition failed" }),
      }),
  };
}
