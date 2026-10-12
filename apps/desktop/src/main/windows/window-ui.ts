/** Menus and prompts the main process asks a window's renderer to draw in React. */
import { randomUUID } from "node:crypto";
import { Effect, Queue, Stream } from "effect";
import { BrowserWindow } from "electron";

import type { PromptAnswer, WindowUiEvent } from "../../shared/window-ui";
import { withDeadline } from "../app/deadline";

type Listener = (event: WindowUiEvent) => void;
const listeners = new Map<number, Listener>();

interface Pending {
  owner: number;
  answer: (answer: PromptAnswer) => void;
}
const prompts = new Map<string, Pending>();

/** The stream behind the WindowUiEvents RPC. A newer subscription replaces an older one. */
export const windowUiEvents = (id: number) =>
  Stream.callback<WindowUiEvent>((queue) => {
    const listener: Listener = (event) => {
      Queue.offerUnsafe(queue, event);
    };
    return Effect.gen(function* () {
      listeners.set(id, listener);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (listeners.get(id) !== listener) return;
          listeners.delete(id);
          // A renderer that reloads or crashes can no longer answer what it was showing.
          for (const pending of prompts.values())
            if (pending.owner === id) pending.answer("cancel");
        }),
      );
      yield* Effect.never;
    });
  });

export const hasWindowUi = (id: number) => listeners.has(id);

/** False when the window's renderer is not listening. */
export function sendWindowUi(id: number, event: WindowUiEvent): boolean {
  const listener = listeners.get(id);
  listener?.(event);
  return Boolean(listener);
}

/** The preferred window, else the focused one, else any window whose live renderer listens. */
export function listeningWindow(preferred?: BrowserWindow | null): BrowserWindow | null {
  return (
    [preferred, BrowserWindow.getFocusedWindow(), ...BrowserWindow.getAllWindows()].find(
      (win): win is BrowserWindow =>
        !!win &&
        !win.isDestroyed() &&
        !win.webContents.isCrashed() &&
        hasWindowUi(win.webContents.id),
    ) ?? null
  );
}

export function answerPrompt(owner: number, id: string, answer: PromptAnswer) {
  const pending = prompts.get(id);
  if (pending?.owner === owner) pending.answer(answer);
}

/** What `askWindow` needs of a BrowserWindow. */
export interface PromptTarget {
  webContents: { id: number };
  isDestroyed(): boolean;
  once(event: "closed", listener: () => void): unknown;
  off(event: "closed", listener: () => void): unknown;
}

/**
 * Shows a prompt in the window's renderer and resolves with its answer.
 * The renderer answers "shown" once the prompt has painted; until then the
 * native `fallback` takes over after `shownMs`, so quitting never hangs on a
 * broken renderer. Closing the window, or its renderer going away, answers
 * "cancel".
 */
export async function askWindow(
  target: PromptTarget | null,
  event: (id: string) => WindowUiEvent,
  fallback: () => Promise<PromptAnswer>,
  shownMs = 10_000,
): Promise<PromptAnswer> {
  if (!target || target.isDestroyed() || !hasWindowUi(target.webContents.id)) return fallback();
  const owner = target.webContents.id;
  const id = randomUUID();
  let shown!: () => void;
  let answered!: (answer: PromptAnswer) => void;
  const painted = new Promise<void>((resolve) => {
    shown = resolve;
  });
  const answer = new Promise<PromptAnswer>((resolve) => {
    answered = resolve;
  });
  const reply = (value: PromptAnswer) => {
    shown();
    if (value !== "shown") answered(value);
  };
  const cancel = () => reply("cancel");
  prompts.set(id, { owner, answer: reply });
  target.once("closed", cancel);
  const done = () => {
    prompts.delete(id);
    if (!target.isDestroyed()) target.off("closed", cancel);
  };
  if (!sendWindowUi(owner, event(id))) {
    done();
    return fallback();
  }
  if ((await withDeadline(painted, shownMs)) === "timeout") {
    done();
    sendWindowUi(owner, { _tag: "PromptDone", id });
    return fallback();
  }
  const result = await answer;
  done();
  return result;
}
