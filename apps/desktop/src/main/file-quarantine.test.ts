import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as unknown[][]);
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => {
    calls.push(args);
    const done = args.at(-1);
    if (typeof done === "function") done(null);
  },
}));

const platform = Object.getOwnPropertyDescriptor(process, "platform");
afterEach(() => {
  if (platform) Object.defineProperty(process, "platform", platform);
});

it("marks files with the system xattr binary, never a PATH lookup", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  const { quarantine } = await import("./file-quarantine");
  await Effect.runPromise(quarantine("/tmp/report.pdf"));
  expect(calls[0]?.[0]).toBe("/usr/bin/xattr");
  expect(calls[0]?.[1]).toEqual([
    "-w",
    "com.apple.quarantine",
    expect.stringMatching(/^0083;[0-9a-f]+;OpenMail;$/),
    "/tmp/report.pdf",
  ]);
});
