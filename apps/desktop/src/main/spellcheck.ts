import { app, BrowserWindow, Menu, session, type WebContents } from "electron";
import { constVoid } from "effect/Function";
import type { Prefs, PrefsPatch } from "@openmail/core";
import type { TextMenuCommand } from "../shared/window-ui";
import { sendWindowUi } from "./window-ui";

let current: Pick<Prefs, "spellcheck" | "spellcheckLanguages"> = {
  spellcheck: true,
  spellcheckLanguages: [],
};
const apply = (contents: WebContents) => {
  if (!("session" in contents) || contents.session !== session.defaultSession) return;
  const ses = contents.session;
  ses.setSpellCheckerEnabled(current.spellcheck);
  if (process.platform !== "darwin") {
    const languages = current.spellcheckLanguages.filter((language) =>
      ses.availableSpellCheckerLanguages.includes(language),
    );
    ses.setSpellCheckerLanguages(languages);
  }
};
export function configureSpelling(prefs: Pick<Prefs, "spellcheck" | "spellcheckLanguages">) {
  current = prefs;
  for (const win of BrowserWindow.getAllWindows()) apply(win.webContents);
}
interface MenuState {
  misspelledWord: string;
  suggestions: readonly string[];
  /** Set for the compose body on macOS, where the system Writing Tools menu applies. */
  frame?: Electron.WebFrameMain | null;
  x: number;
  y: number;
}
const menus = new Map<number, MenuState>();
let savePrefs: ((patch: PrefsPatch) => void) | undefined;

type CommandWindow = {
  webContents: Pick<
    WebContents,
    "id" | "replaceMisspelling" | "cut" | "copy" | "paste" | "selectAll" | "isDestroyed"
  > & {
    session: Pick<WebContents["session"], "addWordToSpellCheckerDictionary">;
  };
  isDestroyed(): boolean;
};

/**
 * Runs a choice from the renderer's text menu. Words come from the main
 * process's own record of the last right-click, never from the renderer.
 */
export function textMenuCommand(
  win: CommandWindow | null,
  command: TextMenuCommand,
  openWritingTools: (state: MenuState) => void = constVoid,
) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  const contents = win.webContents;
  const state = menus.get(contents.id);
  switch (command.kind) {
    case "replace":
      if (state?.suggestions.includes(command.word)) contents.replaceMisspelling(command.word);
      return;
    case "learn":
      if (state?.misspelledWord)
        contents.session.addWordToSpellCheckerDictionary(state.misspelledWord);
      return;
    case "toggleSpellcheck":
      savePrefs?.({ spellcheck: !current.spellcheck });
      return;
    case "cut":
      contents.cut();
      return;
    case "copy":
      contents.copy();
      return;
    case "paste":
      contents.paste();
      return;
    case "selectAll":
      contents.selectAll();
      return;
    case "writingTools":
      if (state?.frame) openWritingTools(state);
      return;
    case "dismiss":
      // The menu closed; a later command cannot act on this right-click.
      menus.delete(contents.id);
      return;
  }
}

/**
 * Electron adds Writing Tools, AutoFill and Services only to a native menu
 * that gets the frame of the right-click. The renderer's menu offers them as
 * one item that opens this small native menu; nothing else pops a native
 * menu inside a window.
 */
export function popupWritingTools(win: BrowserWindow, state: MenuState) {
  if (!state.frame || win.isDestroyed()) return;
  Menu.buildFromTemplate([{ role: "cut" }, { role: "copy" }, { role: "paste" }]).popup({
    window: win,
    frame: state.frame,
    x: Math.round(state.x),
    y: Math.round(state.y),
  });
}

/**
 * Uses Electron's session checker. macOS selects system languages and downloads
 * no dictionaries. Right-clicks in editable fields become a TextMenu event the
 * window's renderer draws.
 */
export function installSpellingMenu(save: (patch: PrefsPatch) => void) {
  savePrefs = save;
  const removers = new Set<() => void>();
  const wire = (win: BrowserWindow) => {
    apply(win.webContents);
    const id = win.webContents.id;
    const context = async (_event: Electron.Event, params: Electron.ContextMenuParams) => {
      if (!params.isEditable) return;
      // Apple's extensions stay in the compose body, away from address/search fields and untrusted message frames.
      const frame = params.frame;
      const compose =
        process.platform === "darwin" &&
        frame === win.webContents.mainFrame &&
        (await win.webContents
          .executeJavaScript(
            `Boolean(document.elementFromPoint(${params.x}, ${params.y})?.closest('[data-openmail-compose-body="true"]'))`,
          )
          .catch(() => false));
      if (win.isDestroyed() || win.webContents.isDestroyed()) return;
      menus.set(id, {
        misspelledWord: params.misspelledWord,
        suggestions: params.dictionarySuggestions,
        frame: compose ? frame : null,
        x: params.x,
        y: params.y,
      });
      sendWindowUi(id, {
        _tag: "TextMenu",
        menu: {
          x: params.x,
          y: params.y,
          misspelledWord: params.misspelledWord,
          suggestions: params.dictionarySuggestions,
          spellcheck: current.spellcheck,
          canCut: params.editFlags.canCut,
          canCopy: params.editFlags.canCopy,
          canPaste: params.editFlags.canPaste,
          writingTools: compose,
        },
      });
    };
    win.webContents.on("context-menu", context);
    const remove = () => {
      if (!win.isDestroyed()) win.webContents.off("context-menu", context);
      menus.delete(id);
      win.off("closed", remove);
      removers.delete(remove);
    };
    removers.add(remove);
    win.once("closed", remove);
  };
  const created = (_event: Electron.Event, win: BrowserWindow) => wire(win);
  app.on("browser-window-created", created);
  for (const win of BrowserWindow.getAllWindows()) wire(win);
  return () => {
    savePrefs = undefined;
    app.off("browser-window-created", created);
    for (const remove of removers) remove();
  };
}
