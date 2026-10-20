import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ exit: vi.fn() }));
vi.mock("electron", () => ({ app: { exit: native.exit } }));
vi.mock("./main", () => {
  throw new Error("Cannot find module '@openmail/cli/mcp-server'");
});

const argv = process.argv;
beforeEach(() => {
  vi.resetModules();
  native.exit.mockClear();
});
afterEach(() => {
  process.argv = argv;
  vi.restoreAllMocks();
});

// A static import that fails goes to Electron's modal error dialog, which blocks a windowless
// `OpenMail --mcp` with no output. The entry turns it into stderr and exit code 1.
it("a main module that fails to load ends --mcp with the error on stderr and exit 1", async () => {
  process.argv = [...argv, "--mcp"];
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  await import("./index");
  expect(native.exit).toHaveBeenCalledWith(1);
  expect(String(stderr.mock.calls[0]?.[0])).toMatch(/^OpenMail could not load: /);
});

it("a main module that fails to load still throws in the GUI", async () => {
  process.argv = argv.filter((arg) => arg !== "--mcp");
  await expect(import("./index")).rejects.toThrow();
  expect(native.exit).not.toHaveBeenCalled();
});

it("a main module that fails to load ends a hidden run with the error on stderr and exit 1", async () => {
  process.argv = argv.filter((arg) => arg !== "--mcp");
  vi.stubEnv("OPENMAIL_HIDDEN_WINDOWS", "1");
  try {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await import("./index");
    expect(native.exit).toHaveBeenCalledWith(1);
    expect(String(stderr.mock.calls[0]?.[0])).toMatch(/^OpenMail could not load: /);
  } finally {
    vi.unstubAllEnvs();
  }
});
