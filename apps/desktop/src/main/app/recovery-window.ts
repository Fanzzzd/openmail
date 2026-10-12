/** Crash and database recovery prompts: a small React window, with the native box as fallback. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, type IpcMainEvent } from "electron";
import { constVoid } from "effect/Function";

import {
  RECOVERY_ANSWER_CHANNEL,
  RECOVERY_PROMPT_CHANNEL,
  type RecoveryPrompt,
} from "../../shared/recovery";
import { withDeadline } from "./deadline";
import { denyNavigation } from "../security/security";
import { revealWindow } from "../windows/reveal";
import { APP_PAGE, developmentPage, WINDOW_SECURITY } from "../security/security-policy";

export interface RecoverySurface {
  /** Resolves once the renderer reports its first paint. */
  painted: Promise<void>;
  /** The chosen button. Rejects when the renderer fails; closing the window answers cancelId. */
  answer: Promise<number>;
  close(): void;
}

export interface RecoveryDeps {
  open: (prompt: RecoveryPrompt) => RecoverySurface;
  fallback: (prompt: RecoveryPrompt) => Promise<number>;
  paintMs?: number;
}

export async function recoveryPrompt(prompt: RecoveryPrompt, deps: RecoveryDeps): Promise<number> {
  let surface: RecoverySurface;
  try {
    surface = deps.open(prompt);
  } catch {
    return deps.fallback(prompt);
  }
  const painted = await withDeadline(
    surface.painted.then(
      () => true,
      () => false,
    ),
    deps.paintMs ?? 4000,
  );
  if (painted !== true) {
    surface.close();
    return deps.fallback(prompt);
  }
  try {
    return await surface.answer;
  } catch {
    surface.close();
    return deps.fallback(prompt);
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
function keepAlive() {
  // Without a listener Electron quits when the last window closes; no main window exists yet.
}

/** The window has no RPC: one prompt in, one button index out, both checked against its own frame. */
export function openRecoveryWindow(prompt: RecoveryPrompt): RecoverySurface {
  const win = new BrowserWindow({
    width: 480,
    height: 280,
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: prompt.message,
    webPreferences: {
      preload: path.join(here, "../preload/recovery.cjs"),
      ...WINDOW_SECURITY,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  app.on("window-all-closed", keepAlive);
  denyNavigation(win.webContents);
  const contents = win.webContents;
  const fromWindow = (event: { sender: unknown; senderFrame: unknown }) =>
    !win.isDestroyed() && event.sender === contents && event.senderFrame === contents.mainFrame;

  let paint!: { resolve: () => void; reject: (error: Error) => void };
  let settle!: { resolve: (index: number) => void; reject: (error: Error) => void };
  const painted = new Promise<void>((resolve, reject) => {
    paint = { resolve, reject };
  });
  const answer = new Promise<number>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // The caller may never await one of them.
  painted.catch(constVoid);
  answer.catch(constVoid);

  ipcMain.removeHandler(RECOVERY_PROMPT_CHANNEL);
  ipcMain.handle(RECOVERY_PROMPT_CHANNEL, (event) => {
    if (!fromWindow(event)) throw new Error("Unknown sender");
    return prompt;
  });
  const onAnswer = (event: IpcMainEvent, index: unknown) => {
    if (!fromWindow(event) || typeof index !== "number" || !Number.isInteger(index)) return;
    if (index === -1) {
      revealWindow(win);
      paint.resolve();
    } else if (index >= 0 && index < prompt.buttons.length) {
      settle.resolve(index);
      win.destroy();
    }
  };
  ipcMain.on(RECOVERY_ANSWER_CHANNEL, onAnswer);
  const failed = () => {
    const error = new Error("Recovery window failed");
    paint.reject(error);
    settle.reject(error);
  };
  contents.on("did-fail-load", failed);
  contents.on("render-process-gone", failed);
  win.once("closed", () => {
    ipcMain.off(RECOVERY_ANSWER_CHANNEL, onAnswer);
    ipcMain.removeHandler(RECOVERY_PROMPT_CHANNEL);
    paint.reject(new Error("Recovery window closed"));
    settle.resolve(prompt.cancelId);
    setTimeout(() => app.off("window-all-closed", keepAlive), 0);
  });
  const page = new URL(
    "recovery.html",
    developmentPage(app.isPackaged, process.env.ELECTRON_RENDERER_URL) ?? APP_PAGE,
  );
  void win.loadURL(page.href).catch(failed);
  return {
    painted,
    answer,
    close: () => {
      if (!win.isDestroyed()) win.destroy();
    },
  };
}
