// The main process imports the workspace packages (@openmail/core, @openmail/cli) from their
// dist folders at runtime, and the bundle copies them as they are. A dist that was never built
// gives an app whose main entry cannot load, so packaging stops here instead. It also stops when
// Electron's license notices, which extraResources copies, are missing (electron-licenses.cjs).
const { existsSync } = require("node:fs");
const path = require("node:path");

/** Every file the exports of the app's @openmail/* dependencies point at. */
function workspaceEntries(desktopDir) {
  const { dependencies } = require(path.join(desktopDir, "package.json"));
  const entries = [];
  for (const name of Object.keys(dependencies).filter((dep) => dep.startsWith("@openmail/"))) {
    const dir = path.join(desktopDir, "node_modules", name);
    const { exports } = require(path.join(dir, "package.json"));
    for (const target of Object.values(exports ?? {})) {
      const file = typeof target === "string" ? target : target.default;
      if (file && !file.endsWith(".json")) entries.push(path.join(dir, file));
    }
  }
  return entries;
}

exports.beforePack = async () => {
  require("./electron-licenses.cjs").checkElectronLicenses();
  const missing = workspaceEntries(path.join(__dirname, "..")).filter((file) => !existsSync(file));
  if (missing.length)
    throw new Error(
      `Workspace package builds are missing. The dist script builds them first:\n${missing.join("\n")}`,
    );
};
