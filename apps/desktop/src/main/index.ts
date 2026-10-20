// The electron-vite entry. It loads main.ts dynamically so a module that fails to load (for
// example a workspace package whose dist was never built) reaches the catch below. With a
// static import the failure would go to Electron's default handler, a modal dialog that
// blocks `OpenMail --mcp` forever: it has no window and its client sees no output. A hidden
// run (OPENMAIL_HIDDEN_WINDOWS=1) takes the same path, so no error box appears on screen.
// Awaiting the import keeps `ready` until main.ts has registered its handlers.
import { app } from "electron";
import { hiddenWindows } from "./windows/reveal";

try {
  await import("./main");
} catch (error) {
  if (!process.argv.includes("--mcp") && !hiddenWindows()) throw error;
  process.stderr.write(
    `OpenMail could not load: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  app.exit(1);
}
