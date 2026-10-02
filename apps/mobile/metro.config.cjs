const { getDefaultConfig } = require("expo/metro-config");

// SDK 57 discovers the pnpm workspace and real symlink targets. Keep isolated
// installs; autolinkingModuleResolution selects the app's native React version.
const config = getDefaultConfig(__dirname);
// Core's compiled NodeNext files and TS sources use .js local specifiers.
const defaultResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "@openmail/core" || moduleName === "@openmail/core/node") {
    throw new Error("Mobile must import @openmail/core/portable");
  }
  return defaultResolve
    ? defaultResolve(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};
module.exports = config;
