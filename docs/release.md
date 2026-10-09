# macOS 构建与验证

配置在 [electron-builder.config.cjs](../apps/desktop/electron-builder.config.cjs)。当前使用 Flap o 图标，源文件和生成命令见[图标说明](design/icons.md)。打包需要 Xcode 26 编译 Icon Composer 资源。

## 本地构建

```sh
pnpm install
pnpm --filter @openmail/desktop dist
```

产物在 `apps/desktop/release/`，arm64、x64 各有 DMG 和 ZIP。命令固定 `--publish never`，不会创建 release、推标签或上传产物。本地包只用 ad-hoc 签名修复 Electron 的 seal，不需要 Apple Developer 账号，不启用自动更新。

本地包也启用 CookieEncryption。macOS 首次启动或 ad-hoc 重签名后可能询问 cookie 加密密钥的钥匙串访问权限，反复构建可能重复提示；该项与 OpenMail 保存的 OAuth/API key 不同。发布时验证提示和签名行为，说明见 [桌面安全](security.md)。不要通过关闭 fuse 消除提示，已有 cookie 存储可能因此失效。

`node:sqlite` 随 Electron 发行。`@napi-rs/keyring` 的两种 macOS N-API 预编译包由 `pnpm-workspace.yaml` 的 `supportedArchitectures` 安装，无需 ABI 重编。`.node`、`.dylib`、keyring、sqlite-vec 都在 ASAR 外；已合入媒体二期，保留 sqlite-vec、ONNX 和图像解码库的解包规则。正式签名包仍需验证原生库加载；Vision helper 为 arm64/x64 通用二进制。

隔离启动：

```sh
OPENMAIL_TEST_DATA="$(mktemp -d /tmp/openmail-release.XXXXXX)"
apps/desktop/release/mac-arm64/OpenMail.app/Contents/MacOS/OpenMail \
  --user-data-dir="$OPENMAIL_TEST_DATA"
```

可重复的启动检查会自动创建临时目录、验证 renderer/preload/core 启动，并保存截图和日志：

```sh
node scripts/smoke-dist.mjs apps/desktop/release/mac-arm64/OpenMail.app
node scripts/smoke-dist.mjs apps/desktop/release/mac/OpenMail.app
```

x64 的目录是 `release/mac/`。该参数同时隔离 Chromium、core 的数据库和 OAuth client 配置，优先于 `OPENMAIL_HOME`。验证时只用假账户或空数据库。

## 内置 OAuth 客户端

桌面构建把 openmail 自己注册的 OAuth 客户端编进主进程，作为添加 Gmail 和 Outlook 的默认客户端。客户端值不进 git，构建时按以下顺序读取，每个服务商单独判断：

1. 环境变量 `OPENMAIL_GOOGLE_CLIENT_ID` 和 `OPENMAIL_GOOGLE_CLIENT_SECRET`（两个都要有），`OPENMAIL_MICROSOFT_CLIENT_ID`。正式构建用这一项：

   ```sh
   OPENMAIL_GOOGLE_CLIENT_ID=… OPENMAIL_GOOGLE_CLIENT_SECRET=… OPENMAIL_MICROSOFT_CLIENT_ID=… \
     pnpm --filter @openmail/desktop dist
   ```

2. gitignore 的 `apps/desktop/oauth-clients.local.json`，开发构建用。格式与 `config.json` 的客户端部分相同：

   ```json
   {
     "google": { "clientId": "…", "clientSecret": "…" },
     "microsoft": { "clientId": "…" }
   }
   ```

两项都没有时，该服务商没有内置客户端，添加账户页回到让用户填写自己客户端的流程。格式错误的本地文件让桌面构建失败。

构建时输出一行来源说明，只写来源，不写值，例如 `Built-in OAuth clients: Google from env vars, Microsoft from oauth-clients.local.json.`。`turbo.json` 的 `@openmail/desktop#build` 把这三个环境变量和本地文件计入缓存键，改动后不会复用旧构建。

`electron.vite.config.ts` 只给 main 构建定义 `__OPENMAIL_OAUTH_CLIENTS__`，renderer 和 preload 拿不到这些值；renderer 通过 `ClientSetup` RPC 只收到每个服务商是否已配置、新登录用内置还是自己的客户端、是否有内置客户端。`src/main/oauth-clients.test.ts` 读取构建产物，确认值只出现在 `out/main`。Google 把 installed app 的 client secret 视为非机密，这里仍不把它写进源码或日志。

环境变量和本地文件的解析只有一份，在 core 的 [oauth-client-sources.ts](../packages/core/src/oauth-client-sources.ts)，桌面构建和 CLI 共用。CLI 和 MCP 把源码目录里的同一个本地文件作为内置客户端；本地文件格式错误时打印警告并忽略。运行时的上述环境变量是另一个来源，排在用户客户端之后、内置客户端之前。三个入口里，用户在 `config.json` 保存的客户端都优先。Google 项目的发布状态和 7 天过期见 [Google 设置](setup-google.md#内置客户端的发布状态)。手机端需要自己的 iOS 和 Android 客户端，不使用这里的值。

## Developer ID 签名与公证

提供自己的 Apple Developer 凭证后运行：

```sh
pnpm --filter @openmail/desktop dist:signed
```

签名使用钥匙串中的 Developer ID，或 `CSC_LINK` 与 `CSC_KEY_PASSWORD`。`forceCodeSigning` 会让缺少签名身份的正式构建失败。启用 hardened runtime；签名与 helper entitlement 规则见 [Apple Contacts](apple-contacts.md#打包与权限)。ad-hoc 包另用 unsigned plist 允许加载 Electron 的不同团队预签名库。

公证接受任一完整配置，缺省时跳过：

- `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`。
- `APPLE_API_KEY`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`。
- `APPLE_KEYCHAIN_PROFILE`，需要时加 `APPLE_KEYCHAIN`。

构建器的凭证规则见 [electron-builder 26 macOS 文档](https://www.electron.build/v26/docs/mac/)。签名与继承 plist 在 `apps/desktop/build/`；Apple Contacts helper 使用独立 entitlement，具体规则见 [Apple Contacts](apple-contacts.md#打包与权限)。

## 自动更新

core 接受 Electron updater 适配器，统一配置和发起网络检查。窗口显示后先检查钥匙串是否配置令牌，再用 `codesign --verify --deep --strict` 验证 app，并确认 Developer ID Application Authority 和 TeamIdentifier；开发环境、ad-hoc 包和未配置令牌的私库安装均不开启更新。

已签名 app 从私库 `Fanzzzd/openmail` 的 GitHub Releases 获取更新。在「设置 > 常规 > 软件更新」保存 GitHub 访问令牌，令牌只进系统钥匙串。设置页显示令牌是否已保存、更新版本和检查／下载状态，不读取或回显令牌，不使用环境变量或开发者的 `GH_TOKEN`。每 6 小时检查一次，主窗口显示可用更新。自动下载默认开启，可在设置中关闭并显式下载；下载完成后，退出时先检查待处理草稿，再重新核对令牌、签名和渠道资格后安装。网络失败不影响收发。macOS 更新需要 ZIP 和签名，见 [electron-builder 26 自动更新文档](https://www.electron.build/v26/docs/features/auto-update/)。

首次真实发布前还要验证：

- Developer ID 签名、公证、staple 和 Gatekeeper。
- 用测试私库 release 验证发现、下载、退出安装和签名拒绝；当前任务不发布 release。
- 在 Intel Mac 上启动 x64 包，并在两种架构验证钥匙串读写。Apple Silicon 的 Rosetta 启动只作为补充。
- 用正式签名包实际加载 sqlite-vec 和 ONNX。

## 旧邮件与缓存

设置中的 Local cache 页显示每账户已检查的邮件数、完成状态和最近错误，支持暂停、继续。检查点保存在迁移 13 的 `backfill` 表。页面同时显示消息文本与附件缓存字节，可清理单账户或全部缓存；统计不包含邮件头与索引的数据库空间。

每页最多 50 封。后台每 20 秒轮流处理一个账户，至少间隔 10 秒；失败等 5 分钟重试，单页超时 90 秒。正常同步占用同一个网络锁，回填在同步之间运行；已开始的单页会完成或超时，再让同步接手。暂停阻止下一页，当前页落库后保存检查点。退出中断未完成的页，重启从上一页重试。

Gmail 用固定时间上界的 `messages.list` 与 `pageToken`，Graph 按 `receivedDateTime` 倒序并保存 `@odata.nextLink`，IMAP 保存文件夹、UIDVALIDITY 和下降的 UID 范围。正常同步游标独立，历史扫描从最早的本地邮件日期开始；列出 ID 后先排除本地缓存与待推送操作，再下载正文。写入前再检查一次，防止下载过程中删除的草稿重新出现。回填的 IMAP UID 加入正常旗标和删除跟踪，但不推进新邮件或 MODSEQ 检查点；UIDVALIDITY 改变或发现新文件夹时重新启动历史回填。

滚到底先翻本地页；本地页用尽后请求回填。搜索先用现有服务器搜索取冷缓存匹配，再请求历史回填。后台进度只刷新缓存状态与计数；主动翻页追加已落库的旧邮件。正常邮件变更在一次查询中刷新全部已加载行，保留滚动位置和选中邮件。

缓存默认：Inbox 全部，All Mail 一年，Spam/Trash 30 天。标签设置覆盖 All Mail；多标签邮件用最长的匹配期限，草稿始终保留。自定义标签的「使用默认值」继承账户规则。

过期时清空消息文本与 HTML，保留邮件头、预览和附件名称、大小、类型。附件按需下载到持久文件缓存，默认全局上限 512 MiB，按访问时间 LRU 淘汰；可在 Local cache 页调整上限或关闭。清缓存保留邮件头与草稿，用户保存的文件不属于缓存。内存附件 LRU 是另一个限额，见[性能](performance.md#内存与启动)。

每日按日期索引只检查可能过期的消息文本；修改缓存规则可强制清理。最近 24 小时打开的邮件跳过清理。FTS 触发器响应索引内容变更，清内容仍保留 rowid 和邮件头词项。媒体和语义更新触发器跳过 body_cached 状态切换，保留 OCR/PDF 文本及向量。CLI/MCP 的 thread 和模型读取只读本地；桌面显式 readerThread 才补取内容，单封失败返回邮件头与 bodyCached:false，其他邮件仍可阅读。

## Intel 版语义搜索限制

本次保留主线 ONNX Runtime 1.30.0。它的 npm 包没有 macOS x64 binding，postinstall 也没有提供补下载；[上游已记录该问题](https://github.com/microsoft/onnxruntime/issues/27961)。x64 包的邮件、联系人、日历和通用 Vision helper 可用，语义模型加载需等待上游补齐或另行提供同版本构建。未混入其他版本的 native binding，未降级主线运行时。

## 历史验证（发布切片）

以下为发布切片的验收记录，测试数量不代表当前仓库。现在的自动检查见[测试](testing.md)，尚需用户完成的验收见[路线图](roadmap.md#待用户完成)。

- `pnpm build && pnpm test && pnpm exec oxlint && pnpm exec oxfmt --check .` 通过，core 330 个测试、桌面 18 个测试，1 项模型集成默认跳过，只有原有两条 IO 边界类型断言警告。
- `pnpm --filter @openmail/desktop dist` 生成四个安装包，两种 app 的 `codesign --verify --deep --strict` 通过。构建中未公证、未发布。
- arm64 与 x64（Rosetta）均用临时 `--user-data-dir` 启动，renderer、sandbox preload、core SQLite 均正常。x64 的 `node:sqlite` 和 keyring N-API 模块也单独加载成功，未读写真实钥匙串项。
- arm64 额外用 500 封合成邮件验证分页和阅读设置，挂载行数 18 至 26，行高 84px，未捕获渲染异常。临时账户设置为需要重新授权，验证不访问邮件服务器。
- arm64 包中的 ONNX、keyring 和 sqlite-vec 已实际加载；x64 仍缺上游 ONNX binding，限制见上文。
- 修复了打包后 platform-node 总入口加载未打包 Redis peer 的启动错误，core 改为只导入实际使用的子路径。包内无构建日志和更新令牌。
