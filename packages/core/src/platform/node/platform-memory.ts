import { AttachmentFiles, ImageNetwork, PdfWorker } from "../runtime.js";
import { MailCodec } from "../mail-codec.js";
/**
 * An in-memory platform for tests: a fresh SQLite database per build (same
 * migrations as on disk), secrets in a Ref, config.json on an in-memory file
 * system, an OAuth that hands out canned tokens, and a browser that only
 * records what it was asked to open. Only an explicit database path touches disk;
 * configuration and secrets stay in memory, without reading process.env.
 */
import {
  ConfigProvider,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  PlatformError,
  Ref,
} from "effect";
import type { SqlClient } from "effect/sql";

import { NodeRuntime } from "./runtime.js";
import { appConfigFile } from "../../providers/config.js";
import { databaseLayer } from "./db.js";
import { OAuthIssuersSql } from "../../store/store-oauth-issuers.js";
import {
  type AppConfig,
  Browser,
  type OAuthIssuers,
  type ClientConfig,
  OAuth,
  Secrets,
  type TokenResponse,
} from "../../services.js";

/** URLs the memory Browser was asked to open, oldest first. */
class OpenedUrls extends Context.Service<OpenedUrls, Ref.Ref<string[]>>()(
  "openmail/test/OpenedUrls",
) {}

export interface MemoryFile {
  readonly data: string;
  readonly mode: number;
}

/** Files and directories of the memory FileSystem, by absolute path. */
export class MemoryFiles extends Context.Service<
  MemoryFiles,
  { readonly files: Ref.Ref<ReadonlyMap<string, MemoryFile>>; readonly dirs: Ref.Ref<Set<string>> }
>()("openmail/test/MemoryFiles") {}

const notFound = (method: string, path: string) =>
  PlatformError.systemError({
    _tag: "NotFound",
    module: "FileSystem",
    method,
    description: "No such file or directory",
    pathOrDescriptor: path,
  });

/**
 * A FileSystem over MemoryFiles with what config.json and the database need:
 * exists, readFileString, writeFileString, makeDirectory and chmod. Anything
 * else fails like FileSystem.makeNoop does.
 */
export const MemoryFileSystem = (
  initial: Record<string, string> = {},
): Layer.Layer<FileSystem.FileSystem | MemoryFiles> => {
  const files = Layer.effect(
    MemoryFiles,
    Effect.gen(function* () {
      return MemoryFiles.of({
        files: yield* Ref.make<ReadonlyMap<string, MemoryFile>>(
          new Map(Object.entries(initial).map(([p, data]) => [p, { data, mode: 0o644 }])),
        ),
        dirs: yield* Ref.make(new Set<string>()),
      });
    }),
  );
  const fs = Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const mem = yield* MemoryFiles;
      const read = (path: string) =>
        Effect.flatMap(Ref.get(mem.files), (all) => {
          const file = all.get(path);
          return file ? Effect.succeed(file) : Effect.fail(notFound("readFileString", path));
        });
      const update = (path: string, f: (file: MemoryFile | undefined) => MemoryFile) =>
        Ref.update(mem.files, (all) => new Map(all).set(path, f(all.get(path))));
      return FileSystem.makeNoop({
        exists: (path) =>
          Effect.map(
            Effect.all([Ref.get(mem.files), Ref.get(mem.dirs)]),
            ([all, dirs]) => all.has(path) || dirs.has(path),
          ),
        readFileString: (path) => Effect.map(read(path), (file) => file.data),
        // Like the OS: `mode` only applies when the write creates the file.
        writeFileString: (path, data, options) =>
          update(path, (file) => ({ data, mode: file?.mode ?? options?.mode ?? 0o644 })),
        chmod: (path, mode) =>
          Effect.flatMap(read(path), (file) => update(path, () => ({ ...file, mode }))),
        makeDirectory: (path) => Ref.update(mem.dirs, (dirs) => new Set(dirs).add(path)),
      });
    }),
  );
  return fs.pipe(Layer.provideMerge(files));
};

/** Where MemoryPlatform keeps config.json. */
const MEMORY_DATA_DIR = "/openmail";

export interface MemoryPlatformOptions {
  /** Isolated on-disk SQLite for integration tests; defaults to an ephemeral database. */
  database?: string;
  secrets?: Record<string, string>;
  /** Written to config.json before the platform builds. */
  config?: ClientConfig;
  /** Environment the platform's Config reads (client overrides). Empty by default. */
  env?: Record<string, string>;
  /** What authorize and refresh return. Defaults to "access-token" / "refresh-token". */
  tokens?: TokenResponse;
  /** openmail's own OAuth clients, as a desktop build would supply them. */
  builtInClients?: ClientConfig;
  /** Replaces the fake OAuth methods, e.g. to make refresh fail with AuthError. */
  oauth?: Partial<OAuth["Service"]>;
}

export type MemoryPlatformServices =
  | MailCodec
  | PdfWorker
  | AttachmentFiles
  | ImageNetwork
  | SqlClient.SqlClient
  | Secrets
  | AppConfig
  | OAuthIssuers
  | OAuth
  | Browser
  | OpenedUrls
  | FileSystem.FileSystem
  | MemoryFiles
  | Path.Path;

export function MemoryPlatform(
  opts: MemoryPlatformOptions = {},
): Layer.Layer<MemoryPlatformServices> {
  const tokens: TokenResponse = opts.tokens ?? {
    accessToken: "access-token",
    refreshToken: Option.some("refresh-token"),
    expiresIn: 3600,
  };

  const opened = Layer.effect(OpenedUrls, Ref.make<string[]>([]));

  const browser = Layer.effect(
    Browser,
    Effect.gen(function* () {
      const urls = yield* OpenedUrls;
      return Browser.of({ open: (url) => Ref.update(urls, (all) => [...all, url]) });
    }),
  );

  const secrets = Layer.effect(
    Secrets,
    Effect.gen(function* () {
      const store = yield* Ref.make(new Map(Object.entries(opts.secrets ?? {})));
      return Secrets.of({
        get: (key) => Effect.map(Ref.get(store), (m) => Option.fromNullishOr(m.get(key))),
        set: (key, value) => Ref.update(store, (m) => new Map(m).set(key, value)),
        remove: (key) =>
          Ref.update(store, (m) => {
            const next = new Map(m);
            next.delete(key);
            return next;
          }),
      });
    }),
  );

  const disk = Layer.mergeAll(
    MemoryFileSystem(
      opts.config ? { [`${MEMORY_DATA_DIR}/config.json`]: JSON.stringify(opts.config) } : {},
    ),
    Path.layer,
  );

  const config = appConfigFile(MEMORY_DATA_DIR, opts.builtInClients).pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(opts.env ?? {}))),
  );

  // Opens the consent URL like the real flow, so tests can see which one was asked for.
  const oauth = Layer.effect(
    OAuth,
    Effect.gen(function* () {
      const b = yield* Browser;
      return OAuth.of({
        authorize: (req) => Effect.as(b.open(req.authUrl), tokens),
        refresh: () => Effect.succeed(tokens),
        ...opts.oauth,
      });
    }),
  );

  const browserWithUrls = browser.pipe(Layer.provideMerge(opened));
  return Layer.mergeAll(
    OAuthIssuersSql.pipe(Layer.provideMerge(databaseLayer(opts.database ?? ":memory:"))),
    NodeRuntime,
    secrets,
    config,
    oauth.pipe(Layer.provideMerge(browserWithUrls)),
  ).pipe(Layer.provideMerge(disk));
}
