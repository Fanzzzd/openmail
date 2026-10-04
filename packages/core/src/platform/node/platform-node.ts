import { MailCodec } from "../mail-codec.js";
// Subpaths avoid loading unused Redis peers from the platform barrel in packaged apps.
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { Crypto, Effect, FileSystem, Layer, Path } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { SqlClient } from "effect/sql";

import { AttachmentFiles, ImageNetwork, PdfWorker } from "../runtime.js";
import { AppPaths } from "../paths.js";
import { NodeRuntime, NodePaths } from "./runtime.js";
import { appConfigFile } from "../../config.js";
import { databaseLayer } from "./db.js";
import { OAuthLoopback } from "./oauth.js";
import { dataDir } from "./paths.js";
import { makeSecretsKeyring } from "./secrets.js";
import { type AppConfig, Browser, type OAuth, type Secrets } from "../../services.js";

/** Everything below the Store and the providers: what a platform has to supply. */
export type PlatformServices =
  | SqlClient.SqlClient
  | Secrets
  | AppConfig
  | OAuth
  | Browser
  | MailCodec
  | PdfWorker
  | AttachmentFiles
  | ImageNetwork
  | HttpClient.HttpClient
  | AppPaths
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto
  | ChildProcessSpawner.ChildProcessSpawner;

export interface NodePlatformOptions {
  /** Electron passes `shell.openExternal`. Defaults to SystemBrowser. */
  openUrl?: (url: string) => Promise<void> | void;
  /** Replaces the browser outright, e.g. the CLI's, which also prints the URL. */
  browser?: Layer.Layer<Browser>;
  /** Defaults to dataDir: shared by the app, the CLI and the MCP server. */
  dataDir?: string;
  /** CLI notice before an OS keychain read, including during Layer acquisition. */
  beforeCredentialRead?: Effect.Effect<void>;
}

/** The OS command that opens `url` in the default browser. */
function opener(url: string): ChildProcess.Command {
  const quiet = { stdin: "ignore", stdout: "ignore", stderr: "ignore" } as const;
  switch (process.platform) {
    case "win32":
      // No cmd: `start` would split the URL at `&`, and Effect's spawner has no
      // verbatim-arguments option to quote around it.
      return ChildProcess.make("rundll32", ["url.dll,FileProtocolHandler", url], quiet);
    case "darwin":
      return ChildProcess.make("open", [url], quiet);
    default:
      return ChildProcess.make("xdg-open", [url], quiet);
  }
}

/**
 * Opens a URL with the OS default handler. The child is unreferenced, so the
 * spawner's scope leaves it (and a browser it started) running. No opener
 * (headless Linux) is logged, not raised: callers print the URL too.
 */
export const openInSystemBrowser = Effect.fn("openInSystemBrowser")(function* (url: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  yield* spawner.spawn(opener(url)).pipe(
    Effect.flatMap((handle) => handle.unref),
    Effect.scoped,
    Effect.catch((error) => Effect.logWarning("Could not open the browser", error)),
  );
});

/** Browser over the OS opener. */
export const SystemBrowser: Layer.Layer<Browser, never, ChildProcessSpawner.ChildProcessSpawner> =
  Layer.effect(
    Browser,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return Browser.of({
        open: (url) =>
          openInSystemBrowser(url).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
      });
    }),
  );

/** Browser over a callback such as Electron's `shell.openExternal`. A rejection is a defect. */
const callbackBrowser = (openUrl: (url: string) => Promise<void> | void) =>
  Layer.succeed(
    Browser,
    Browser.of({
      open: Effect.fn("Browser.open")((url: string) =>
        Effect.tryPromise(() => Promise.resolve(openUrl(url))).pipe(Effect.orDie),
      ),
    }),
  );

/** Node's FileSystem, Path, Crypto and process spawner. */
const NodeBase = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer)),
);

export const NodeSystem = Layer.mergeAll(
  NodeBase,
  NodeRuntime,
  NodePaths.pipe(Layer.provide(NodeBase)),
);
export const NodeLayer = NodePlatform;

/** Desktop and CLI: node:sqlite, the OS keychain, config.json, loopback OAuth, fetch. */
export function NodePlatform(opts: NodePlatformOptions = {}): Layer.Layer<PlatformServices> {
  const browser = opts.browser ?? (opts.openUrl ? callbackBrowser(opts.openUrl) : SystemBrowser);
  const http = FetchHttpClient.layer;
  const storage = Layer.unwrap(
    Effect.gen(function* () {
      const dir = opts.dataDir ?? (yield* dataDir);
      const path = yield* Path.Path;
      return Layer.mergeAll(
        databaseLayer(path.join(dir, "mail.db")),
        appConfigFile(dir),
        Layer.succeed(AppPaths, { dataDirectory: Effect.succeed(dir) }),
      );
    }),
  );
  return Layer.mergeAll(
    storage,
    makeSecretsKeyring(opts.beforeCredentialRead),
    OAuthLoopback.pipe(Layer.provide([browser, http])),
    browser,
    http,
  ).pipe(Layer.provideMerge(NodeSystem));
}
