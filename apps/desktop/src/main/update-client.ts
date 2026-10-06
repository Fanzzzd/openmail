import { resolveUpdateFeed, updateVersionAllowed, type UpdateClient } from "@openmail/core";
import type { AppUpdater } from "electron-updater";
import { PrivateGitHubProvider } from "electron-updater/out/providers/PrivateGitHubProvider.js";
import {
  parseUpdateInfo,
  type ProviderRuntimeOptions,
} from "electron-updater/out/providers/Provider.js";

export interface ManagedUpdateClient extends UpdateClient {
  readonly downloadedVersion: string | null;
  reserveInstall(
    channel: "stable" | "latest",
    version: string,
  ): ((failed: () => void) => void) | null;
}
const UPDATE_INSTALL_TIMEOUT_MS = 90_000;
const clients = new WeakMap<AppUpdater, ManagedUpdateClient>();
/** SDK adapter only: core owns feed HTTP; the SDK still owns checksum/signature verification and package installation. */
export function updateClient(updater: AppUpdater): ManagedUpdateClient {
  const existing = clients.get(updater);
  if (existing) return existing;
  let configure: () => void = () => {
    updater.logger = null;
  };
  updater.autoInstallOnAppQuit = false;
  let downloadedVersion: string | null = null;
  let checking = 0;
  const downloading = new Map<Promise<string[]>, string>();
  let installing = false;
  let queued: Promise<unknown> = Promise.resolve();
  const client: ManagedUpdateClient = {
    get downloadedVersion() {
      return downloadedVersion;
    },
    reserveInstall(channel, version) {
      if (
        installing ||
        checking > 0 ||
        downloading.size > 0 ||
        downloadedVersion !== version ||
        !updateVersionAllowed(channel, version)
      )
        return null;
      installing = true;
      let started = false;
      return (failed) => {
        if (started) return;
        started = true;
        let finished = false;
        const fail = () => {
          if (finished) return;
          finished = true;
          clearTimeout(watchdog);
          updater.removeListener("error", fail);
          failed();
        };
        const watchdog = setTimeout(fail, UPDATE_INSTALL_TIMEOUT_MS);
        watchdog.unref();
        updater.once("error", fail);
        try {
          updater.quitAndInstall();
        } catch {
          fail();
        }
      };
    },
    get autoDownload() {
      return updater.autoDownload;
    },
    set autoDownload(value) {
      updater.autoDownload = value;
    },
    get autoInstallOnAppQuit() {
      return updater.autoInstallOnAppQuit;
    },
    set autoInstallOnAppQuit(_value) {
      updater.autoInstallOnAppQuit = false;
    },
    get allowPrerelease() {
      return updater.allowPrerelease;
    },
    set allowPrerelease(value) {
      updater.allowPrerelease = value;
    },
    get logger() {
      return updater.logger;
    },
    set logger(_value) {
      updater.logger = null;
    },
    setFeedURL(options) {
      const channel = updater.allowPrerelease ? "latest" : "stable";
      class ReleaseProvider extends PrivateGitHubProvider {
        constructor(
          _options: { provider: "custom" },
          appUpdater: AppUpdater,
          runtime: ProviderRuntimeOptions,
        ) {
          super(options, appUpdater, options.token, runtime);
        }
        override async getLatestVersion() {
          const feed = await resolveUpdateFeed(
            options.token,
            channel,
            `${this.getDefaultChannelName()}.yml`,
          );
          const info = parseUpdateInfo(
            feed.manifest,
            `${this.getDefaultChannelName()}.yml`,
            new URL(feed.manifestUrl),
          );
          if (info.version !== feed.version)
            throw new Error("Update manifest version does not match release");
          return { ...info, assets: feed.assets };
        }
      }
      configure = () => {
        updater.allowPrerelease = channel === "latest";
        updater.setFeedURL({ provider: "custom", updateProvider: ReleaseProvider });
      };
    },
    checkForUpdates() {
      if (installing) return Promise.resolve(null);
      const applyFeed = configure;
      const autoDownload = updater.autoDownload;
      checking++;
      const check = queued
        .then(async () => {
          updater.autoInstallOnAppQuit = false;
          applyFeed();
          updater.autoDownload = autoDownload;
          const result = await updater.checkForUpdates();
          if (result?.downloadPromise && !downloading.has(result.downloadPromise)) {
            const download = result.downloadPromise;
            const version = result.updateInfo.version;
            downloadedVersion = null;
            downloading.set(download, version);
            void download
              .then(
                () => {
                  downloadedVersion = version;
                  return null;
                },
                () => {
                  downloadedVersion = null;
                  return null;
                },
              )
              .finally(() => {
                downloading.delete(download);
              });
          }
          return result;
        })
        .finally(() => {
          checking--;
        });
      queued = check.catch(() => null);
      return check;
    },
    on: (event, listener) => updater.on(event, listener),
    removeListener: (event, listener) => updater.removeListener(event, listener),
  };
  clients.set(updater, client);
  return client;
}
