# macOS build and verification

The configuration is in [electron-builder.config.cjs](../apps/desktop/electron-builder.config.cjs). The app uses the Flap o icon. Its sources and the commands that generate it are in the [icon notes](design/icons.md). With Xcode 26, packaging compiles the Icon Composer assets. Without it, packaging uses the committed `build/icon.icns`. `build/mac-icon.cjs` reads `xcodebuild -version` to choose. The release and package workflows require Xcode 26.

## Local build

```sh
pnpm install
pnpm --filter @openmail/desktop dist
```

The script first builds the workspace packages the app imports at runtime (`@openmail/core`, `@openmail/cli`) through `turbo run build --filter=@openmail/desktop^...`, then the app. Before packaging, `build/workspace-builds.cjs` checks that every export of those packages exists in their `dist` folders and stops the build otherwise. Without this, a clean checkout produced an app whose main entry could not load. The output goes to `apps/desktop/release/`: a DMG and a ZIP for each of arm64 and x64. The command always passes `--publish never`, so it never creates a release, pushes a tag or uploads anything. A local build is only ad-hoc signed to repair Electron's seal. It needs no Apple Developer account and does not enable auto-update.

Local builds also turn on CookieEncryption. On first launch, or after an ad-hoc re-sign, macOS may ask for keychain access to the cookie encryption key, and repeated builds can ask again. That keychain item is separate from the OAuth tokens and API keys OpenMail stores. Check the prompt and the signing behaviour at release time; see [desktop security](security.md). Do not silence the prompt by turning the fuse off, because existing cookie storage can then become unreadable.

`node:sqlite` ships with Electron. The two macOS N-API prebuilds of `@napi-rs/keyring` are installed through `supportedArchitectures` in `pnpm-workspace.yaml`, so no ABI rebuild is needed. `.node` files, `.dylib` files, keyring and sqlite-vec all sit outside the ASAR. Media phase two has landed, and the unpack rules for sqlite-vec, ONNX and the image decoding libraries stay. A Developer ID signed build still has to confirm that the native libraries load. The Vision helper is a universal arm64/x64 binary.

Isolated launch:

```sh
OPENMAIL_TEST_DATA="$(mktemp -d /tmp/openmail-release.XXXXXX)"
apps/desktop/release/mac-arm64/OpenMail.app/Contents/MacOS/OpenMail \
  --user-data-dir="$OPENMAIL_TEST_DATA"
```

A repeatable launch check, which the release and package workflows also run, uses new temporary directories for every launch. It checks that `Contents/Resources/licenses/electron/` holds Electron's `LICENSE` and `LICENSES.chromium.html`, reads the fuses back from the binary and compares them with `build/security-fuses.cjs`, checks that `ELECTRON_RUN_AS_NODE=1` does not run a script, runs `OpenMail --mcp` with `initialize` and `tools/list` and expects exactly the read-only tool set on a clean stdout and exit code 0, then verifies that the renderer, preload and core start and saves a screenshot and logs. It needs `packages/core/dist` (the dist script builds it). When a launch hangs, the error includes `ps` and a `sample` of the process and its children. The workflows upload the report folder as the `dist-smoke` artifact, also on failure. Add `--no-gui` to skip the window:

```sh
node scripts/smoke-dist.mjs apps/desktop/release/mac-arm64/OpenMail.app
node scripts/smoke-dist.mjs apps/desktop/release/mac/OpenMail.app
```

The x64 build is in `release/mac/`. The `--user-data-dir` flag isolates Chromium, core's database and the OAuth client configuration together, and it takes precedence over `OPENMAIL_HOME`. Verify only with fake accounts or an empty database.

## Built-in OAuth clients

The desktop build compiles OpenMail's own registered OAuth clients into the main process. They are the default clients for adding Gmail and Outlook accounts. The client values never go into git. The build reads them in this order, separately for each provider:

1. The environment variables `OPENMAIL_GOOGLE_CLIENT_ID` and `OPENMAIL_GOOGLE_CLIENT_SECRET` (both are required), and `OPENMAIL_MICROSOFT_CLIENT_ID`. Release builds use this source:

   ```sh
   OPENMAIL_GOOGLE_CLIENT_ID=… OPENMAIL_GOOGLE_CLIENT_SECRET=… OPENMAIL_MICROSOFT_CLIENT_ID=… \
     pnpm --filter @openmail/desktop dist
   ```

2. The gitignored `apps/desktop/oauth-clients.local.json`, for development builds. Its format matches the client part of `config.json`:

   ```json
   {
     "google": { "clientId": "…", "clientSecret": "…" },
     "microsoft": { "clientId": "…" }
   }
   ```

If neither source is present, that provider has no built-in client, and the add-account screen falls back to asking the user for their own client. A malformed local file fails the desktop build.

The build prints one line naming the sources, never the values, for example `Built-in OAuth clients: Google from env vars, Microsoft from oauth-clients.local.json.`. In `turbo.json`, `@openmail/desktop#build` includes the three environment variables and the local file in its cache key, so changing them never reuses an old build.

`electron.vite.config.ts` defines `__OPENMAIL_OAUTH_CLIENTS__` only for the main build, so the renderer and preload never see the values. Through the `ClientSetup` RPC the renderer learns only whether each provider is configured, whether new sign-ins use the built-in or the user's own client, and whether a built-in client exists. `src/main/security/oauth-clients.test.ts` reads the build output and checks that the values appear only in `out/main`. Google treats an installed app's client secret as non-confidential, but OpenMail still keeps it out of source and logs.

There is one parser for the environment variables and the local file: core's [oauth-client-sources.ts](../packages/core/src/providers/oauth-client-sources.ts), shared by the desktop build and the CLI. The CLI and the MCP server use the same local file in the source checkout as their built-in client. A malformed local file prints a warning and is ignored. The environment variables above are also read at runtime as a separate source, after the user's client and before the built-in one. In all three entry points, a client the user saved in `config.json` comes first. The Google project's publishing status is in [Google setup](setup-google.md#release-status-of-the-built-in-client). The mobile app needs its own iOS and Android clients and does not use these values.

## Developer ID signing and notarization

With your own Apple Developer credentials, run:

```sh
pnpm --filter @openmail/desktop dist:signed
```

Signing uses the Developer ID in the keychain, or `CSC_LINK` and `CSC_KEY_PASSWORD`. `forceCodeSigning` fails a signed build that has no signing identity. The hardened runtime is on. The signing and helper entitlement rules are in [Apple Contacts](apple-contacts.md#打包与权限). Ad-hoc builds use a separate unsigned plist that allows loading Electron's libraries, which are pre-signed by a different team.

Notarization accepts any one complete set of credentials and is skipped when none is set:

- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.
- `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.
- `APPLE_KEYCHAIN_PROFILE`, plus `APPLE_KEYCHAIN` when needed.

The builder's credential rules are in the [electron-builder 26 macOS docs](https://www.electron.build/v26/docs/mac/). The signing and inherited plists are in `apps/desktop/build/`. The Apple Contacts helper uses its own entitlements; the rules are in [Apple Contacts](apple-contacts.md#打包与权限).

## Release workflow (GitHub Actions)

`.github/workflows/release.yml` runs when a tag matching `v*` is pushed. Its first two jobs run on the tagged commit. `check` calls `check.yml`, the same build, type, test, lint and format checks that run on main. `perf` calls `perf.yml`, the 100k-message query and insert budgets in [performance.md](performance.md), which take up to about 60 minutes. The release job needs both, so a failing check or a perf failure stops the release before any secret is read. After a perf failure caused by a noisy runner, click Re-run failed jobs on the tag's run. To find out before tagging, run the Performance workflow on the commit from the Actions page. The release job has `contents: write`; the check job only reads. Actions are pinned by commit SHA with the version in a comment, and Dependabot updates the pins. The tag must equal `v` plus the `version` in `apps/desktop/package.json`, or the job stops. It runs on `macos-latest`, selects Xcode 26 for Icon Composer, installs with `pnpm install --frozen-lockfile`, builds the arm64 and x64 DMG and ZIP, installs Rosetta when the runner lacks it, launches both packaged apps with `scripts/smoke-dist.mjs`, writes `SHA256SUMS` for every artifact, attests build provenance for them with `actions/attest-build-provenance`, and attaches the artifacts, the blockmaps, `latest-mac.yml` and `SHA256SUMS` to a GitHub Release. The release notes are the version's section of `CHANGELOG.md` (the heading is `## <version>` or `## [<version>]`, matching the tag without `v`). If that section is missing, the job warns and uses GitHub's generated notes. The release job alone also has `id-token: write` and `attestations: write` for the attestation. To check a download, run `shasum -a 256 -c SHA256SUMS` next to it, or `gh attestation verify OpenMail-<version>-mac-arm64.dmg --repo Fanzzzd/openmail`. Both build scripts keep `--publish never`; the workflow uploads with `gh release create`.

The launch step runs before the upload. Each launch gets a new temporary profile with no accounts, so it reads no real data and starts no sign-in. If a check fails, the job fails and nothing is published. The job runs on an arm64 runner and launches both builds; the x64 app runs under Rosetta.

`.github/workflows/package.yml` runs the same unsigned `pnpm --filter @openmail/desktop dist` with no secrets on every push to main, on pull requests that touch packaging (`apps/desktop/build/`, the builder config, native helpers, package manifests, the lockfile, patches or `scripts/smoke-dist.mjs`) and on demand, then runs `scripts/smoke-dist.mjs` on the arm64 app.

Repository secrets:

| Secret                                                       | Use                                                                                           |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `CSC_LINK`                                                   | Developer ID Application certificate as a base64 `.p12` or an HTTPS URL to it                 |
| `CSC_KEY_PASSWORD`                                           | Password of that `.p12`                                                                       |
| `APPLE_ID`                                                   | Apple ID that submits for notarization                                                        |
| `APPLE_APP_SPECIFIC_PASSWORD`                                | App-specific password of that Apple ID                                                        |
| `APPLE_TEAM_ID`                                              | Team ID of the Developer ID certificate                                                       |
| `OPENMAIL_GOOGLE_CLIENT_ID`, `OPENMAIL_GOOGLE_CLIENT_SECRET` | Optional. Built-in Google OAuth client, see [Built-in OAuth clients](#built-in-oauth-clients) |
| `OPENMAIL_MICROSOFT_CLIENT_ID`                               | Optional. Built-in Microsoft OAuth client                                                     |

With all five Apple secrets set, the job runs `pnpm --filter @openmail/desktop dist:signed`: Developer ID signing, hardened runtime and notarization, and a normal release. If any of them is missing, it runs `pnpm --filter @openmail/desktop dist` instead: an ad-hoc signed build, a release marked as prerelease, and a note telling users how to get past Gatekeeper. Without the OAuth secrets the build has no built-in clients, and users register their own as in [Google](setup-google.md) and [Microsoft](setup-microsoft.md).

To cut a release:

```sh
# 1. In CHANGELOG.md, move the Unreleased entries under a new "## 0.2.0" heading
# 2. Bump "version" in apps/desktop/package.json, commit, then
git tag v0.2.0
git push origin v0.2.0
```

## 自动更新

core 接受 Electron updater 适配器，统一配置和发起网络检查。窗口显示后，core 用 `codesign --verify --deep --strict` 验证 app，并确认 Developer ID Application Authority 和 TeamIdentifier。开发环境和 ad-hoc 包不开启更新。

已签名 app 从公开仓库 `Fanzzzd/openmail` 的 GitHub Releases 获取更新，不需要 GitHub 账户或令牌。更新源由 `electron-builder.config.cjs` 的 `publish` 决定，构建时写进 app 的 `Resources/app-update.yml`，内容只有 `provider`、`owner` 和 `repo`。

core 的 `resolveUpdateFeed`（[update-feed.ts](../packages/core/src/app/update-feed.ts)）不带凭证请求 GitHub API 选出 release。Stable 只取最新正式版；Latest 在正式版和预发布版中取 semver 最大的一个。清单只从该 release 的 `https://github.com/Fanzzzd/openmail/releases/download/<tag>/` 读取，重定向只接受 `release-assets.githubusercontent.com` 和 `objects.githubusercontent.com`。桌面适配器把 tag 交给 electron-updater 的 `GitHubProvider`，安装包从同一个 tag 下载，SDK 校验 sha512 和签名。未认证的 GitHub API 每个 IP 每小时限 60 次。Stable 每次检查调用 1 次，Latest 调用 2 次，release 超过 100 个时每多 100 个再加 1 次。

「设置 → 常规 → 软件更新」显示更新版本和检查／下载状态。每 6 小时检查一次，主窗口显示可用更新。自动下载默认开启，可在设置中关闭并显式下载；下载完成后，退出时先检查待处理草稿，再重新核对签名和渠道资格后安装。网络失败不影响收发。macOS 更新需要 ZIP 和签名，见 [electron-builder 26 自动更新文档](https://www.electron.build/v26/docs/features/auto-update/)。

仓库公开前的构建把 GitHub 令牌存在钥匙串项 `updates:github-release-token`。升级后第一次启动更新时，core 删除这一项。项不存在或删除失败都不提示；`prefs` 表的 `updates:legacy-token-removed` 记录已执行，之后的启动不再访问该项。

首次真实发布前还要验证：

- Developer ID 签名、公证、staple 和 Gatekeeper。
- 用一个测试预发布 release 验证发现、下载、退出安装和签名拒绝。
- 在 Intel Mac 上启动 x64 包，并在两种架构验证钥匙串读写。Apple Silicon 的 Rosetta 启动只作为补充。
- 用正式签名包实际加载 sqlite-vec 和 ONNX。

## Old mail and cache

The Local cache page in Settings shows, per account, how many messages have been checked, whether the scan is done and the latest error. It can pause and resume the scan. Checkpoints live in the `backfill` table from migration 13. The page also shows the bytes cached for message text and attachments, and can clear the cache for one account or all of them. The figures leave out the database space used by headers and indexes.

Each page holds at most 50 messages. In the background, one account is processed every 20 seconds in turn, at least 10 seconds apart. A failure waits 5 minutes before retrying, and one page times out after 90 seconds. Normal sync holds the same network lock, so backfill runs between syncs. A page that has started either finishes or times out before sync takes over. Pausing blocks the next page; the current page is written and its checkpoint saved. Quitting interrupts an unfinished page, and the next launch retries from the previous page.

Gmail uses `messages.list` with a fixed upper time bound and `pageToken`. Graph sorts by `receivedDateTime` descending and saves `@odata.nextLink`. IMAP saves the folder, UIDVALIDITY and a descending UID range. These cursors are separate from the normal sync cursors, and the history scan starts from the oldest local message date. After listing IDs, backfill first drops those already cached locally or waiting in pending operations, then downloads the bodies. It checks once more before writing, so a draft deleted during the download does not come back. Backfilled IMAP UIDs join normal flag and deletion tracking but do not advance the new-mail or MODSEQ checkpoints. A UIDVALIDITY change or a newly found folder restarts the history backfill.

Scrolling to the bottom first loads the next local page. When local pages run out, it requests a backfill. Search first uses the existing server search to find matches outside the cache, then requests a history backfill. Background progress refreshes only the cache status and counts. Paging by hand appends older mail that has already been written. Normal mail changes refresh all loaded rows in one query and keep the scroll position and the selected message.

Cache defaults: Inbox keeps everything, All Mail one year, Spam and Trash 30 days. Label settings override All Mail. A message with several labels uses the longest matching period, and drafts are always kept. A custom label set to "Use default" inherits the account rule.

When a message expires, its text and HTML are cleared. Headers, the preview and the attachment names, sizes and types stay. Attachments download on demand into a persistent file cache with a default global limit of 512 MiB, evicted LRU by access time. The Local cache page can change the limit or turn the cache off. Clearing the cache keeps headers and drafts. Files the user saved are not part of the cache. The in-memory attachment LRU is a separate limit; see [performance](performance.md#memory-and-startup).

A daily pass uses the date index to check only message text that may have expired. Changing a cache rule can force a cleanup. Messages opened in the last 24 hours are skipped. The FTS triggers react to changes in indexed content, and clearing content keeps the rowid and the header terms. The media and semantic update triggers skip `body_cached` state changes, so OCR and PDF text and vectors are kept. The `thread` and model reads in the CLI and MCP read only local data. Only an explicit desktop `readerThread` fetches missing content. If one message fails, it returns the headers with `bodyCached: false`, and the other messages stay readable.

## Semantic search on Intel

This release keeps ONNX Runtime 1.30.0 on the main line. Its npm package has no macOS x64 binding, and its postinstall does not download one; [upstream has an open issue](https://github.com/microsoft/onnxruntime/issues/27961). In the x64 build, mail, contacts, calendar and the universal Vision helper work. Loading the semantic model has to wait until upstream ships the binding or someone supplies a build of the same version. Until then core gates it: `onDeviceModelsSupported` in `platform/host.ts` reads the OS and architecture from `PlatformHost`, so on macOS x64 `NodeMailbox` builds no model runtime, nothing downloads the 226 MB of models or loads the binding, and Settings shows the model switch off with one line saying semantic search needs Apple silicon. No native binding from another version is mixed in, and the main-line runtime is not downgraded.
