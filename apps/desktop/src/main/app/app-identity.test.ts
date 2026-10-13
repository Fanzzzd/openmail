import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { desktopRoot } from "../../renderer/src/test-support/paths";

const electron = vi.hoisted(() => ({
  isPackaged: false,
  dock: { setIcon: vi.fn() },
  setName: vi.fn(),
  setPath: vi.fn(),
  setAboutPanelOptions: vi.fn(),
  getVersion: () => "0.1.0",
}));
vi.mock("electron", () => ({ app: electron }));

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

it("uses the DEV icon and title only when unpackaged", async () => {
  const { appIdentity } = await import("./app-identity");
  expect(appIdentity(true, "/build")).toEqual({ title: "OpenMail", icon: undefined });
  expect(appIdentity(false, "/build")).toEqual({
    title: "OpenMail Dev",
    icon: path.join("/build", "icon-dev.png"),
  });
});

it("points the dev run at the committed icon-dev.png", async () => {
  electron.isPackaged = false;
  const { APP_TITLE, DEV_ICON } = await import("./app-identity");
  expect(APP_TITLE).toBe("OpenMail Dev");
  expect(DEV_ICON && path.basename(DEV_ICON)).toBe("icon-dev.png");
  // The path resolves against the bundle in out/main/, not against this source file,
  // so re-anchor the module-relative path there before checking the icon exists.
  const source = path.dirname(fileURLToPath(import.meta.url));
  if (!DEV_ICON) throw new Error("no dev icon");
  expect(existsSync(path.resolve(desktopRoot, "out/main", path.relative(source, DEV_ICON)))).toBe(
    true,
  );
});

it("shows the dev identity without renaming the app, so userData stays put", async () => {
  electron.isPackaged = false;
  const { showAppIdentity, DEV_ICON, ABOUT_CREDITS } = await import("./app-identity");
  showAppIdentity();
  if (process.platform === "darwin") expect(electron.dock.setIcon).toHaveBeenCalledWith(DEV_ICON);
  expect(electron.setAboutPanelOptions).toHaveBeenCalledWith({
    applicationName: "OpenMail Dev",
    applicationVersion: "0.1.0",
    credits: ABOUT_CREDITS,
  });
  expect(electron.setName).not.toHaveBeenCalled();
  expect(electron.setPath).not.toHaveBeenCalled();
});

it("gives the packaged app only the icon credits", async () => {
  electron.isPackaged = true;
  const { showAppIdentity, APP_TITLE, DEV_ICON, ABOUT_CREDITS } = await import("./app-identity");
  showAppIdentity();
  expect([APP_TITLE, DEV_ICON]).toEqual(["OpenMail", undefined]);
  expect(electron.dock.setIcon).not.toHaveBeenCalled();
  expect(electron.setAboutPanelOptions).toHaveBeenCalledWith({ credits: ABOUT_CREDITS });
});
