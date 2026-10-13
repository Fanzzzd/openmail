// Audit production dependencies. An advisory reachable from what ships (the desktop app, the
// CLI, core or the root) fails; one reachable only through the mobile app or the docs site is
// printed as a warning. docs/testing.md has the policy.
import { spawnSync } from "node:child_process";

const shipped = new Set(["apps__desktop", "packages__cli", "packages__core", "."]);
const audit = spawnSync("pnpm", ["audit", "--prod", "--json"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
let report;
try {
  report = JSON.parse(audit.stdout);
} catch {
  process.stderr.write(audit.stderr || audit.stdout);
  console.error("pnpm audit did not return a JSON report.");
  process.exit(1);
}
if (report.error) {
  console.error(`pnpm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`);
  process.exit(1);
}

let failures = 0;
for (const advisory of Object.values(report.advisories ?? {})) {
  const paths = advisory.findings.flatMap((finding) => finding.paths);
  const importers = [...new Set(paths.map((path) => path.split(">")[0]))].toSorted((a, b) =>
    a.localeCompare(b),
  );
  const ships = importers.some((importer) => shipped.has(importer));
  const line = `${advisory.severity} ${advisory.module_name} ${advisory.vulnerable_versions} (${advisory.github_advisory_id}) via ${importers.join(", ")}: ${advisory.title}`;
  if (ships) {
    failures++;
    console.log(`::error::${line}`);
  } else {
    console.log(`::warning::${line}`);
  }
}
console.log(
  failures === 0
    ? "No advisories reach the desktop app, the CLI or core."
    : `${failures} advisor${failures === 1 ? "y reaches" : "ies reach"} the desktop app, the CLI or core.`,
);
process.exit(failures === 0 ? 0 : 1);
