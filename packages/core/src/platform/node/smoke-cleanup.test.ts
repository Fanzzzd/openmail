import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

for (const [signal, expected, keep] of [
  ["SIGINT", 130, false],
  ["SIGTERM", 143, false],
  ["SIGHUP", 129, false],
  ["normal", 0, false],
  ["normal", 37, false],
  ["SIGTERM", 37, false],
  ["normal", 0, true],
  ["SIGTERM", 143, true],
] as const) {
  it(`smoke ${signal} ${keep ? "keeps" : "removes"} temp data, closes CDP, kills its child and preserves exit ${expected}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "openmail-signal-test-"));
    const worker = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./fixtures/smoke-signals.mjs", import.meta.url)),
        directory,
        signal,
        expected === 37 ? "37" : "",
        keep ? "keep" : "",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "",
      errors = "";
    worker.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    worker.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString();
    });
    const finished = new Promise<number | null>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("close", resolve);
    });
    try {
      await expect.poll(() => output, { timeout: 5000 }).toContain("child:");
      if (signal !== "normal") worker.kill(signal);
      expect(await finished, errors).toBe(expected);
      expect(output.match(/socket-closed/g)).toHaveLength(1);
      await (keep
        ? expect(access(directory)).resolves.toBeUndefined()
        : expect(access(directory)).rejects.toThrow());
      const pid = Number(/child:(\d+)/.exec(output)?.[1]);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
      await finished;
      await rm(directory, { recursive: true, force: true });
    }
  });
}
