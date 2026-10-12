import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

/** Path of a bundled native helper: Resources/native when packaged, out/native in development. */
export const nativeBinary = (name: string): string =>
  app.isPackaged
    ? path.join(process.resourcesPath, "native", name)
    : fileURLToPath(new URL(`../native/${name}`, import.meta.url));
