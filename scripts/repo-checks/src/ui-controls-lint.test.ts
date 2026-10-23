import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";

const repo = resolve(fileURLToPath(new URL("./", import.meta.url)), "../../..");
const plugin = resolve(repo, "scripts/repo-checks/oxlint/ui-controls.mjs");
const oxlint = resolve(repo, "node_modules/.bin/oxlint");
const root = mkdtempSync(join(tmpdir(), "openmail-ui-lint-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

interface Diagnostic {
  code: string;
  message: string;
  filename: string;
  labels: { span: { line: number } }[];
}

/** Lints the given renderer files with only the ui-controls rule and returns its findings. */
function lint(files: Record<string, string>) {
  const dir = mkdtempSync(join(root, "case-"));
  for (const [path, source] of Object.entries(files)) {
    const file = join(dir, "apps/desktop/src/renderer/src", path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
  }
  const config = join(dir, ".oxlintrc.json");
  writeFileSync(
    config,
    JSON.stringify({
      plugins: [],
      jsPlugins: [plugin],
      categories: {},
      rules: { "openmail-ui/raw-controls": "error" },
    }),
  );
  let output: string;
  try {
    output = execFileSync(oxlint, ["-c", config, "-f", "json", dir], { encoding: "utf8" });
  } catch (error) {
    // oxlint exits with 1 when it finds errors; the report is still on stdout.
    if (error instanceof Error && "stdout" in error && typeof error.stdout === "string")
      output = error.stdout;
    else throw error;
  }
  // oxlint's JSON report is an IO boundary.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const report = JSON.parse(output) as { diagnostics: Diagnostic[] };
  // Only this rule: oxlint keeps its default correctness rules on in any config.
  return report.diagnostics
    .filter((d) => d.code.includes("raw-controls"))
    .map((d) => ({
      file: d.filename.replaceAll("\\", "/").split("/renderer/src/")[1],
      line: d.labels[0]?.span.line,
      message: d.message,
    }));
}

it("flags raw controls and Base UI control imports in features, naming the wrapper", () => {
  const found = lint({
    "features/a.tsx": [
      'import { Switch } from "@base-ui/react/switch";',
      'import { Tabs } from "@base-ui/react/tabs";',
      "export const A = () => (",
      "  <div>",
      '    <input type="checkbox" />',
      '    <input type="number" />',
      '    <input type="datetime-local" />',
      "    <select />",
      '    <input type="email" />',
      "    <Switch.Root />",
      "    <Tabs.Root />",
      "  </div>",
      ");",
      "",
    ].join("\n"),
  });
  expect(found.map(({ file, line }) => `${file}:${line}`)).toEqual([
    "features/a.tsx:1",
    "features/a.tsx:5",
    "features/a.tsx:6",
    "features/a.tsx:7",
    "features/a.tsx:8",
  ]);
  expect(found.map((f) => f.message)).toEqual([
    expect.stringContaining("Use Switch or SettingsSwitchRow"),
    expect.stringContaining("Use Checkbox from ui/Checkbox"),
    expect.stringContaining("Use NumberField from ui/NumberField"),
    expect.stringContaining("Use DateInput from ui/DateInput"),
    expect.stringContaining("Use Select from ui/Select"),
  ]);
});

it("accepts a same-line ui-ok exemption with a reason and rejects one without", () => {
  const found = lint({
    "features/b.tsx": [
      "export const B = () => (",
      "  <div>",
      '    <input type="checkbox" /> {/* ui-ok: a hidden form proxy for the native drag */}',
      '    <input type="radio" /> {/* ui-ok */}',
      '    <input type="range" /> {/* ui-ok:   */}',
      "  </div>",
      ");",
      "",
    ].join("\n"),
  });
  expect(found).toEqual([
    { file: "features/b.tsx", line: 4, message: expect.stringContaining("needs a reason") },
    { file: "features/b.tsx", line: 5, message: expect.stringContaining("needs a reason") },
  ]);
});

it("leaves ui/ and tests alone, where the wrappers are built and exercised", () => {
  const source = [
    'import { Checkbox } from "@base-ui/react/checkbox";',
    'export const C = () => <input type="checkbox" />;',
    "",
  ].join("\n");
  expect(lint({ "ui/Checkbox.tsx": source, "features/c.test.tsx": source })).toEqual([]);
});

it("is on in the repo config", () => {
  const config = readFileSync(resolve(repo, ".oxlintrc.json"), "utf8");
  expect(config).toContain('"./scripts/repo-checks/oxlint/ui-controls.mjs"');
  expect(config).toMatch(/"openmail-ui\/raw-controls":\s*"error"/);
});
