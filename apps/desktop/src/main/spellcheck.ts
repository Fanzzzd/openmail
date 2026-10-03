import {
  app,
  BrowserWindow,
  Menu,
  session,
  type MenuItemConstructorOptions,
  type WebContents,
  type MenuItem,
} from "electron";
import type { Prefs } from "@openmail/core";
import type { DesktopLabels } from "../shared/desktop-labels";

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
type SpellingContents = Pick<WebContents, "replaceMisspelling"> & {
  session: Pick<WebContents["session"], "addWordToSpellCheckerDictionary">;
};
type SpellingMenuItem = Omit<MenuItemConstructorOptions, "click"> & {
  click?: (item: Pick<MenuItem, "checked">) => void;
};
export function spellingItems(
  contents: SpellingContents,
  params: Pick<Electron.ContextMenuParams, "dictionarySuggestions" | "misspelledWord">,
  labels: DesktopLabels["spelling"],
  save: (patch: Partial<Prefs>) => void,
): SpellingMenuItem[] {
  return [
    ...params.dictionarySuggestions.map((word) => ({
      label: word,
      click: () => contents.replaceMisspelling(word),
    })),
    ...(params.misspelledWord
      ? [
          ...(params.dictionarySuggestions.length
            ? []
            : [{ label: labels?.noSuggestions ?? "No suggestions", enabled: false }]),
          {
            label: labels?.add ?? "Add to Dictionary",
            click: () => {
              contents.session.addWordToSpellCheckerDictionary(params.misspelledWord);
            },
          },
          { type: "separator" as const },
        ]
      : []),
    {
      label: labels?.check ?? "Check spelling while typing",
      type: "checkbox",
      checked: current.spellcheck,
      click: (item) => save({ spellcheck: item.checked }),
    },
    { type: "separator" },
    { role: "cut" },
    { role: "copy" },
    { role: "paste" },
    { role: "selectAll" },
  ];
}
/** Uses Electron's session checker. macOS selects system languages and downloads no dictionaries. */
export function installSpellingMenu(
  labels: () => DesktopLabels["spelling"],
  save: (patch: Partial<Prefs>) => void,
) {
  const removers = new Set<() => void>();
  const wire = (win: BrowserWindow) => {
    apply(win.webContents);
    const context = async (_event: Electron.Event, params: Electron.ContextMenuParams) => {
      if (!params.isEditable) return;
      // Supplying a frame enables Apple's context-menu extensions. Keep them in the
      // compose body, away from address/search fields and untrusted message frames.
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
      Menu.buildFromTemplate(spellingItems(win.webContents, params, labels(), save)).popup({
        window: win,
        ...(compose ? { frame } : {}),
      });
    };
    win.webContents.on("context-menu", context);
    const remove = () => {
      if (!win.isDestroyed()) win.webContents.off("context-menu", context);
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
    app.off("browser-window-created", created);
    for (const remove of removers) remove();
  };
}
