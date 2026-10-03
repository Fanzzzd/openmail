# 测试

自动测试覆盖 core、CLI、桌面和手机基础。它们使用 fake provider／Model、临时 SQLite 或内存数据库、DOM 和原生服务 mocks。完整邮件流程测试也在 jsdom 中运行；它们不启动 Electron、不读取真实邮箱或通讯录。真实账户、系统权限与签名包验收见[路线图](roadmap.md#待用户完成)。

## 仓库检查

在仓库根目录运行：

```sh
pnpm build
OPENMAIL_LOW_MEMORY_TESTS=1 pnpm test
pnpm exec oxlint
pnpm exec oxfmt --check .
```

`pnpm build` 构建 core／CLI／桌面，并编译手机语言目录及检查类型。`pnpm test` 包含桌面完整邮件流程、桌面和手机 Lingui 目录同步／漏译，以及桌面术语与 ICU 检查。其他类型检查可单独运行 `pnpm check-types`。提交要求见 [AGENTS.md](../AGENTS.md)。

`OPENMAIL_LOW_MEMORY_TESTS=1` 启用 `packages/core/vitest.low-memory.ts`：一个 worker、文件串行、不隔离模块、单测与 hook 超时 60 秒。普通运行保留文件隔离。完整邮件流程配置独立使用一个 worker 和 10 秒超时。

## 验证范围

| 路径                                                                                | 覆盖与限制                                                                                                 |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `packages/core/src/*.test.ts`                                                       | 同步、离线队列、草稿、撤销、FTS、搜索、日历／联系人、AI 授权与模型协议；服务商网络使用 fake                |
| `packages/core/src/platform/node/node-mailbox.test.ts`                              | 真实 NodeMailbox、临时数据库、MIME、附件缓存、PDF／图片输入与拒绝路径；IMAP 传输和密码使用 fake            |
| `packages/core/src/platform-imports.test.ts`                                        | 非 Node 源码的导入、隐式全局和 portable 本地依赖图；不代替 Metro 或设备验证                                |
| `packages/cli/src/mcp-server.test.ts`                                               | MCP 握手、工具 schema、身份、分页／预算和写权限                                                            |
| `apps/desktop/src/main/*.test.ts`、renderer 测试                                    | 窗口与菜单处理器、RPC、键盘／选择／焦点、无障碍、编辑器和 AI 差异；OS 行为由支架提供                       |
| `packages/core/src/platform/react-native/*.test.ts`、`apps/mobile/src/**/*.test.ts` | Node SQLite shim、OAuth／MIME adapters、Expo 服务 mocks；不证明 JSI、设备锁、WAL、安全存储或真实浏览器回调 |

Apple Contacts 的假 helper、自检与实机边界只在 [Apple Contacts](apple-contacts.md#验证边界)维护。性能数据、查询计划和复现脚本只在[性能](performance.md)维护。

`models.integration.test.ts` 默认跳过。它须显式设置 `OPENMAIL_TEST_MODELS=1`，并已有 `spikes/media/models/` 中要求的 E5 和 MobileCLIP 文件，才会运行本机推理。第三方 AI 的常规回归使用 fake Model／fetch，不做真实 API 请求。

CLI 同步进度和 SIGINT／SIGTERM 退出测试在 `packages/cli/src/sync-progress.test.ts`，只用 fake provider 和内存数据库。钥匙串等待中断测试在 `packages/core/src/platform/node/secrets.test.ts`，替换原生 keyring，不访问系统凭证。CLI 在读取凭证前输出提示；Layer 初始化期间的凭证等待也可中断。macOS 实际权限弹窗仍需人工验收。

## 完整邮件流程

只跑完整邮件流程：

```sh
pnpm --filter @openmail/core build
OPENMAIL_LOW_MEMORY_TESTS=1 pnpm --filter @openmail/desktop exec vitest run --config vitest.e2e.config.ts
```

`apps/desktop/src/renderer/src/e2e/flows.test.ts` 用 jsdom、Testing Library 渲染真实 App，经 preload 同款 JSON RPC 和 `shared/mailbox-handlers.ts` 调用真实 Mailbox。`harness.ts` 为每项测试创建临时 `node:sqlite` 数据库，复用 Gmail、Outlook、IMAP fake。窗口、剪贴板等桌面能力由支架提供，通知点击从核心通知队列进入桌面事件流。

主流程文件包含 28 项测试实例，覆盖首次同步、延迟已读、批量／单封撤销、草稿自动保存、撤销发送、回复／转发、附件提醒、服务器搜索、离线重试、草稿恢复、AI 关闭、提议审批、通知点击与键盘操作。耗时取决于机器，运行配置中的超时不代表产品响应时间。

扩展时，在同一文件新增测试，通过 `flow()` 配置邮件、provider 和偏好；用 UI 操作触发行为，同时断言 `server` 调用记录和 `store` 状态。用 `eventually()` 等待 RPC，`advance()` 推进自动保存、已读和撤回计时。`server.failNext` 注入一次失败，`beforePush` 注入持续失败或 Deferred 阻塞。`holdLists()` 可阻塞列表 RPC，验证导航与搜索交错。`afterEach` 关闭 Registry、RPC、Mailbox 并删除临时数据库。

同步重放回归在 `packages/core/src/pending-pull.test.ts`，覆盖三种 provider 的稍后提醒、唤醒、Flags 更新及队列索引。

检查每项流程能捕获故障：

```sh
node apps/desktop/scripts/e2e-mutations.mjs
```

脚本串行临时修改行为，要求所选测试全部失败，每轮恢复文件；覆盖 25 项主流程及相关回归。新增流程时同步扩展脚本的故障案例和总数。完成后再跑正常测试与仓库检查。

## 桌面生产构建 smoke

协调者可在构建后运行开发 smoke harness：

```sh
pnpm build
node apps/desktop/scripts/smoke.mjs --db /path/to/mail.db
```

脚本会启动 Electron。本 slice 的自动验证不运行它。`--db` 可省略，届时使用空临时库，邮件与撰写步骤会注明跳过。`--timeout` 为总等待毫秒数，默认 180000；`--port` 可指定本地 CDP 端口，默认自动选取。`--keep` 保留临时副本和诊断文件，并在报告中输出目录；默认仍删除。

提供数据库时先关闭其写入进程。core 只读取并复制原库、WAL 和同目录存在的 `config.json`，不打开原库连接；发现复制期间文件变化即停止。副本在临时目录升级，强制 `markReadDelay="manual"` 和英语界面，并关闭首次 Profiles 建议。OAuth client 配置只写入临时副本，源文件不变；脚本不复制钥匙串项。脚本通过 [electron-vite preview](https://electron-vite.org/guide/cli) 的 `--skipBuild` 和 `--user-data-dir` 打开副本，启用本地 CDP，通过 [Browser.getBrowserCommandLine](https://chromedevtools.github.io/devtools-protocol/tot/Browser/#method-getBrowserCommandLine) 核对临时 `user-data-dir` 后，等待主窗口、跳过首次 Profiles 建议并依次打开首个会话、撰写窗口、Settings，并输出 JSON。当前视图没有缓存会话时首个会话步骤注明跳过；没有账户时撰写与 Settings 步骤跳过，报告注明首次账户设置阻挡。首个会话点击会重新查询列表项并重试，直到阅读器出现或总超时到期；失败时报告点击和等待的选择器。正常完成或收到 SIGINT／SIGTERM／SIGHUP 时共用一次清理，终止预览进程，并按 `--keep` 决定是否删除临时目录；信号退出码分别为 130／143／129，已有退出码保持不变。

`OPENMAIL_READ_ONLY=1` 在 core Layer 构建时读取，只允许明确列出的读取与连接方法，默认拒绝未知方法及 accessor；阻止 provider 邮件／文件夹／规则／假期回复／日历写入、草稿上传、发送和延迟发送。现有待处理操作与待发消息保持原状态；本地偏好、草稿、已读等写入仍可保存到副本。网络读取仍可发生，现有账户凭证仍由标准 Secrets 服务读取，网络认证沿用正常的 token 刷新路径。只读模式不扩大 OAuth scopes。

脚本收集 renderer 控制台错误、异常和 RPC 拒绝；正常的请求中断不算拒绝。只忽略已确认来自 `about:srcdoc`、针对 `img-src data: cid:` 的 CSP 图片拦截，匹配 Chromium 的两种固定提示格式。出现其他错误、RPC 拒绝、步骤超时或预览退出时退出码为 1。报告和 stderr 可能含错误文本，分享前检查内容。协调者已运行生产构建 smoke；此 slice 只用 DOM、临时数据库和 fake provider 验证。联系人权限缺失只显示在 Contacts 设置，重新登录前停止远程刷新；主进程诊断为所有 renderer RPC 错误／缺陷记录 RPC 名称，不记录参数；正常中断不记录。

服务商诊断的 `failure` 区分 `transport`、`http`、`credentials`、`configuration`，只有实际传输失败使用 status 0。源目录没有 `config.json` 时副本会出现 `configuration`，界面会提示配置 OAuth client，无需重新登录。读取旧邮件时远程正文／Reply-To 补全以整个会话五秒为上限，失败仍通过 Thread RPC 返回缓存及 `bodyRefresh="failed"`，不改变账户认证状态。未知 Reply-To 不自动填入猜测的回复收件人。

core 的 Node Layer 使用 Effect FetchHttpClient 和 Node 全局 fetch，没有注入 Electron net／session fetch。[Electron 文档](https://www.electronjs.org/docs/latest/api/net)区分 Node HTTP 与 Chromium 网络栈；因此 Chromium 网络服务重启不能据此解释 core 的 HTTP 错误。renderer 请求被取消时，Effect 会中断该请求的 fetch；只读 GET 的实际传输失败会等待 500 毫秒后重试一次，发送不重试。RPC／缓存／中断路径由 fake provider 与 fake fetch 验证；本 slice 不启动 Electron。

空白 Composer 的状态读取和关闭判断使用 `DraftStatus`：仅查询本地草稿，未保存或已删除时返回 `null`。`OpenDraft` 继续用于明确打开已有草稿或导入服务商草稿。完整流程测试覆盖空白 Composer 打开、关闭时无失败 RPC，也不查询该草稿 ID 的消息。
