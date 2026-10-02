import { expect, it } from "vitest";
import { EXECUTABLE, safeFilename } from "./attachment-filenames";

it("blocks macOS launchers and configuration files alongside executables", () => {
  for (const ext of [
    "webloc",
    "inetloc",
    "fileloc",
    "url",
    "mobileconfig",
    "action",
    "definition",
    "prefPane",
    "saver",
    "osax",
    "shortcut",
    "appex",
    "workflow",
    "scpt",
    "scptd",
    "applescript",
    "terminal",
    "command",
    "tool",
    "jar",
    "exe",
    "sh",
  ])
    expect(EXECUTABLE.test(`file.${ext}`)).toBe(true);
});
it("replaces filename format characters and bounds UTF-8 length without losing the extension", () => {
  expect(safeFilename("report\u202E\u200F\u2066\u061C\uFEFF.pdf")).toBe("report_____.pdf");
  const name = safeFilename(`邮件😀${"邮件😀".repeat(699)}.mobileconfig`);
  expect(Buffer.byteLength(name)).toBeLessThanOrEqual(200);
  expect(name.endsWith(".mobileconfig")).toBe(true);
  expect(name).not.toContain("\uFFFD");
});
