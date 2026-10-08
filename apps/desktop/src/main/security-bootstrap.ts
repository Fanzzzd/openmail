import { app, protocol, session } from "electron";
import { fileURLToPath } from "node:url";
import { appResourceHandler } from "./app-protocol";
import { APP_SCHEME } from "./security-policy";
import { configurePermissions } from "./security";

/** Called during entry evaluation, before Electron emits ready. */
export function registerSecuritySchemes() {
  app.enableSandbox();
  app.on("session-created", (ses) => configurePermissions(ses));
  app.commandLine.appendSwitch("disable-breakpad");
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, corsEnabled: true, codeCache: true },
    },
  ]);
}

export function prepareSessionSecurity() {
  configurePermissions(session.defaultSession, true);
  session.defaultSession.protocol.handle(
    APP_SCHEME,
    appResourceHandler(fileURLToPath(new URL("../renderer/", import.meta.url))),
  );
}
