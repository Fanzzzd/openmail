const path = require("node:path");

// electron-builder embeds ASAR integrity metadata and calls afterPack before signing.
async function afterPack(context) {
  const { flipFuses, FuseVersion, FuseV1Options } = await import("@electron/fuses");
  const filename = context.packager.appInfo.productFilename;
  const executable = path.join(
    context.appOutDir,
    context.electronPlatformName === "darwin"
      ? `${filename}.app`
      : context.electronPlatformName === "win32"
        ? `${filename}.exe`
        : context.packager.executableName,
  );
  await flipFuses(executable, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  });
}
module.exports = { afterPack };
