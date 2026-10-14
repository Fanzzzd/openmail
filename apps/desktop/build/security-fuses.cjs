const path = require("node:path");

/**
 * The fuse settings every packaged app ships with. scripts/smoke-dist.mjs reads the
 * packaged binary back and compares it with this list.
 */
const securityFuses = (FuseV1Options) => ({
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
});

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
  await flipFuses(executable, { version: FuseVersion.V1, ...securityFuses(FuseV1Options) });
}
module.exports = { afterPack, securityFuses };
