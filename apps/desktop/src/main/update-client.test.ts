import { AppUpdater } from "electron-updater/out/AppUpdater.js";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { updateClient } from "./update-client";

class TestUpdater extends AppUpdater {
  constructor(directory: string) {
    super(null, {
      version: "1.0.0",
      name: "Test",
      isPackaged: true,
      appUpdateConfigPath: join(directory, "update.yml"),
      userDataPath: directory,
      baseCachePath: directory,
      whenReady: () => Promise.resolve(),
      relaunch: () => null,
      quit: () => null,
      onQuit: () => null,
    });
  }
  protected override async doDownloadUpdate() {
    return [];
  }
  override quitAndInstall() {
    throw new Error("Tests never install updates");
  }
  files() {
    const selected = this.updateInfoAndProvider;
    if (!selected) throw new Error("Missing update selection");
    return selected.provider.resolveFiles(selected.info);
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("the real SDK uses the greater stable release while preserving its private asset resolver", async () => {
  const directory = mkdtempSync(join(tmpdir(), "openmail-update-adapter-"));
  try {
    const manifest = `version: 2.0.0\nfiles:\n  - url: OpenMail.zip\n    sha512: verified-by-the-sdk\n`;
    const assets = [
      {
        name:
          process.platform === "darwin"
            ? "latest-mac.yml"
            : process.platform === "linux"
              ? "latest-linux.yml"
              : "latest.yml",
        url: "https://api.github.com/repos/Fanzzzd/openmail/releases/assets/1",
      },
      {
        name: "OpenMail.zip",
        url: "https://api.github.com/repos/Fanzzzd/openmail/releases/assets/2",
      },
    ];
    const request: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url.endsWith("/latest")
        ? Response.json({ tag_name: "v2.0.0", prerelease: false, draft: false, assets })
        : url.includes("?per_page")
          ? Response.json([{ tag_name: "v1.9.0-beta.10", prerelease: true, draft: false, assets }])
          : new Response(manifest);
    };
    vi.stubGlobal("fetch", request);
    const updater = new TestUpdater(directory),
      client = updateClient(updater);
    client.logger = null;
    client.autoDownload = false;
    client.allowPrerelease = true;
    client.setFeedURL({
      provider: "github",
      owner: "Fanzzzd",
      repo: "openmail",
      private: true,
      token: "fixture-token",
    });
    const result = await client.checkForUpdates();
    expect(result).toMatchObject({ isUpdateAvailable: true, updateInfo: { version: "2.0.0" } });
    expect(updater.files()[0]?.url.href).toBe(
      "https://api.github.com/repos/Fanzzzd/openmail/releases/assets/2",
    );
    expect(updater.files()[0]?.info.sha512).toBe("verified-by-the-sdk");
    expect(updateClient(updater)).toBe(client);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("a fake Mac download never feeds Squirrel until approved quit, and Stable rejects a downloaded beta", async () => {
  const directory = mkdtempSync(join(tmpdir(), "openmail-native-update-"));
  class NativeUpdater extends TestUpdater {
    readonly nativeFeeds: string[] = [];
    private packageVersion = "";
    protected override async doDownloadUpdate() {
      this.packageVersion = this.updateInfoAndProvider?.info.version ?? "";
      if (this.autoInstallOnAppQuit) this.nativeFeeds.push(this.packageVersion);
      return [];
    }
    override quitAndInstall() {
      this.nativeFeeds.push(this.packageVersion);
    }
  }
  try {
    let version = "2.1.0-beta.1";
    const assets = [
      {
        name:
          process.platform === "darwin"
            ? "latest-mac.yml"
            : process.platform === "linux"
              ? "latest-linux.yml"
              : "latest.yml",
        url: "https://api.github.com/repos/Fanzzzd/openmail/releases/assets/1",
      },
    ];
    const request: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url.endsWith("/latest")
        ? Response.json({ tag_name: "v2.0.0", prerelease: false, draft: false, assets })
        : url.includes("?per_page")
          ? Response.json([{ tag_name: `v${version}`, prerelease: true, draft: false, assets }])
          : new Response(
              `version: ${version}\nfiles:\n  - url: OpenMail.zip\n    sha512: fixture\n`,
            );
    };
    vi.stubGlobal("fetch", request);
    const updater = new NativeUpdater(directory),
      client = updateClient(updater);
    client.autoDownload = true;
    client.autoInstallOnAppQuit = true;
    client.allowPrerelease = true;
    client.logger = null;
    client.setFeedURL({
      provider: "github",
      owner: "Fanzzzd",
      repo: "openmail",
      private: true,
      token: "fixture",
    });
    await client.checkForUpdates();
    await microtasks();
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.nativeFeeds).toEqual([]);
    expect(client.downloadedVersion).toBe(version);
    expect(client.reserveInstall("stable", version)).toBeNull();
    expect(updater.nativeFeeds).toEqual([]);
    const plan = client.reserveInstall("latest", version);
    expect(plan).not.toBeNull();
    plan?.(vi.fn());
    expect(updater.nativeFeeds).toEqual([version]);
    expect(client.reserveInstall("latest", version)).toBeNull();
    updater.emit("error", new Error("fixture installer finished"));
    version = "2.0.0";
    const stableUpdater = new NativeUpdater(directory),
      stableClient = updateClient(stableUpdater);
    stableClient.logger = null;
    stableClient.allowPrerelease = false;
    stableClient.setFeedURL({
      provider: "github",
      owner: "Fanzzzd",
      repo: "openmail",
      private: true,
      token: "fixture",
    });
    await stableClient.checkForUpdates();
    await microtasks();
    expect(stableUpdater.nativeFeeds).toEqual([]);
    stableClient.reserveInstall("stable", version)?.(vi.fn());
    expect(stableUpdater.nativeFeeds).toEqual(["2.0.0"]);
    stableUpdater.emit("error", new Error("fixture installer finished"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

class ControlledUpdater extends TestUpdater {
  readonly exitInstall = vi.fn();
  readonly info = {
    version: "2.0.0",
    files: [],
    path: "fixture.zip",
    sha512: "fixture",
    releaseDate: "2026-10-02T00:00:00Z",
  };
  constructor(
    directory: string,
    readonly downloading: Promise<string[]>,
  ) {
    super(directory);
  }
  override async checkForUpdates() {
    return {
      isUpdateAvailable: true,
      versionInfo: this.info,
      updateInfo: this.info,
      downloadPromise: this.downloading,
    };
  }
  override quitAndInstall() {
    this.exitInstall();
  }
}
const microtasks = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

it("manual checks return updateInfo before download completes and only completed downloads can install", async () => {
  const directory = mkdtempSync(join(tmpdir(), "openmail-background-download-"));
  let finish: (paths: string[]) => void = () => null;
  const downloading = new Promise<string[]>((resolve) => {
    finish = resolve;
  });
  const updater = new ControlledUpdater(directory, downloading),
    client = updateClient(updater);
  let returned = false;
  const checked = client.checkForUpdates().then((result) => {
    returned = true;
    return result;
  });
  try {
    await microtasks();
    expect(returned).toBe(true);
    expect(await checked).toMatchObject({ updateInfo: { version: "2.0.0" } });
    expect(client.downloadedVersion).toBeNull();
    expect(client.reserveInstall("stable", "2.0.0")).toBeNull();
    finish(["verified-package"]);
    await microtasks();
    expect(client.downloadedVersion).toBe("2.0.0");
    expect(client.reserveInstall("stable", "2.0.0")).not.toBeNull();
  } finally {
    finish([]);
    await checked;
    rmSync(directory, { recursive: true, force: true });
  }
});

it("an unresponsive Squirrel install exits through its 90 second watchdog exactly once", async () => {
  vi.useFakeTimers();
  const directory = mkdtempSync(join(tmpdir(), "openmail-update-watchdog-"));
  try {
    const updater = new ControlledUpdater(directory, Promise.resolve(["verified-package"])),
      client = updateClient(updater);
    client.logger = null;
    await client.checkForUpdates();
    await microtasks();
    const exit = vi.fn(),
      plan = client.reserveInstall("stable", "2.0.0");
    expect(plan).not.toBeNull();
    plan?.(exit);
    expect(updater.exitInstall).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(89999);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledOnce();
    updater.emit("error", new Error("late native failure"));
    vi.advanceTimersByTime(90000);
    expect(exit).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("a reused SDK download promise retains its original version across later metadata checks", async () => {
  const directory = mkdtempSync(join(tmpdir(), "openmail-shared-download-"));
  let finish: (paths: string[]) => void = () => null;
  const downloading = new Promise<string[]>((resolve) => {
    finish = resolve;
  });
  const updater = new ControlledUpdater(directory, downloading),
    client = updateClient(updater);
  try {
    updater.info.version = "2.1.0-beta.1";
    await client.checkForUpdates();
    updater.info.version = "2.0.0";
    await client.checkForUpdates();
    finish(["beta-package"]);
    await microtasks();
    expect(client.downloadedVersion).toBe("2.1.0-beta.1");
    expect(client.reserveInstall("stable", "2.0.0")).toBeNull();
    expect(client.reserveInstall("stable", "2.1.0-beta.1")).toBeNull();
  } finally {
    finish([]);
    rmSync(directory, { recursive: true, force: true });
  }
});

it("an early native error cancels the install watchdog rather than exiting again later", async () => {
  vi.useFakeTimers();
  const directory = mkdtempSync(join(tmpdir(), "openmail-install-error-"));
  try {
    const updater = new ControlledUpdater(directory, Promise.resolve(["package"])),
      client = updateClient(updater);
    client.logger = null;
    await client.checkForUpdates();
    await microtasks();
    const exit = vi.fn();
    client.reserveInstall("stable", "2.0.0")?.(exit);
    updater.emit("error", new Error("native failure"));
    expect(exit).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(90000);
    expect(exit).toHaveBeenCalledOnce();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
