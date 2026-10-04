# 测试

自动测试覆盖 core、CLI、桌面和手机邮件流程。它们使用 fake provider／Model、临时 SQLite 或内存数据库、DOM 和原生服务 mocks。完整邮件流程测试也在 jsdom 中运行；它们不启动 Electron、不读取真实邮箱或通讯录。真实账户、系统权限与签名包验收见[路线图](roadmap.md#待用户完成)。

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

[performance-plans.test.ts](../packages/core/src/platform/node/performance-plans.test.ts) 集中检查真实 Store SQL 的索引；同步健康用例用 120 封邮件覆盖分页回绕和 Unicode ID 顺序，属于普通测试。10 万封的 [performance-large.test.ts](../packages/core/src/platform/node/performance-large.test.ts) 默认排除，须单独运行 `pnpm test:perf`；命令、报告、时延预算及迁移 35 的写入与磁盘成本只在[性能](performance.md)维护。

Apple Contacts 的假 helper、自检与实机边界只在 [Apple Contacts](apple-contacts.md#验证边界)维护。性能数据、查询计划和复现脚本只在[性能](performance.md)维护。

`models.integration.test.ts` 默认跳过。它须显式设置 `OPENMAIL_TEST_MODELS=1`，并已有 `spikes/media/models/` 中要求的 E5 和 MobileCLIP 文件，才会运行本机推理。第三方 AI 的常规回归使用 fake Model／fetch，不做真实 API 请求。

CLI 同步进度和 SIGINT／SIGTERM 退出测试在 `packages/cli/src/sync-progress.test.ts`，只用 fake provider 和内存数据库。钥匙串等待中断测试在 `packages/core/src/platform/node/secrets.test.ts`，替换原生 keyring，不访问系统凭证。CLI 在读取凭证前输出提示；Layer 初始化期间的凭证等待也可中断。macOS 实际权限弹窗仍需人工验收。

## 出站操作与发送回归

[出站规则](sync-correctness.md#出站操作队列)用假 provider、协议响应及临时 SQLite 验证，SMTP 阶段另用本地假服务器；不向真实账户发送，不启动 Electron，不代替手机原生传输验收。

- [op-queue.test.ts](../packages/core/src/op-queue.test.ts)：退避、过期、认领丢失、复制进度、重映射失败、草稿清理和仅向拒收地址重发。
- [Node IMAP 回归](../packages/core/src/platform/node/imap-opqueue.test.ts)与[手机 IMAP 回归](../packages/core/src/platform/react-native/imap.test.ts)：复制恢复、缺失 UID／Message-ID、标记拒绝、特殊文件夹、SMTP 阶段和 Sent 保存失败。
- [Outlook 回归](../packages/core/src/outlook.test.ts)：永久写入拒绝与简短原因。
- [桌面失败提示](../apps/desktop/src/renderer/src/failed-op-notice.test.ts)与[手机失败提示](../apps/mobile/src/failed-op-notice.test.ts)：分类标题、操作与邮件详情、关闭提示及拒收重发入口；翻译检查沿用仓库命令。

离线重试测试推进 TestClock 或虚拟 Date，等待 retry_at 后再推送，避免把立即重试写成要求。

## 完整邮件流程

只跑完整邮件流程：

```sh
pnpm --filter @openmail/core build
OPENMAIL_LOW_MEMORY_TESTS=1 pnpm --filter @openmail/desktop exec vitest run --config vitest.e2e.config.ts
```

`apps/desktop/src/renderer/src/e2e/flows.test.ts` 用 jsdom、Testing Library 渲染真实 App，经 preload 同款 JSON RPC 和 `shared/mailbox-handlers.ts` 调用真实 Mailbox。`harness.ts` 为每项测试创建临时 `node:sqlite` 数据库，复用 Gmail、Outlook、IMAP fake。窗口、剪贴板等桌面能力由支架提供，通知点击从核心通知队列进入桌面事件流。

主流程覆盖首次同步、延迟已读、批量／单封撤销、草稿自动保存、撤销发送、回复／转发、附件提醒、服务器搜索、离线重试、草稿恢复、AI 关闭、提议审批、通知点击与键盘操作。耗时取决于机器，运行配置中的超时不代表产品响应时间。

扩展时，在同一文件新增测试，通过 `flow()` 配置邮件、provider 和偏好；用 UI 操作触发行为，同时断言 `server` 调用记录和 `store` 状态。用 `eventually()` 等待 RPC，`advance()` 推进自动保存、已读和撤回计时。`server.failNext` 注入一次失败，`beforePush` 注入持续失败或 Deferred 阻塞。`holdLists()` 可阻塞列表 RPC，验证导航与搜索交错。`afterEach` 关闭 Registry、RPC、Mailbox 并删除临时数据库。

同步重放回归在 `packages/core/src/pending-pull.test.ts`，覆盖三种 provider 的稍后提醒、唤醒、Flags 更新及队列索引。

检查每项流程能捕获故障：

```sh
node apps/desktop/scripts/e2e-mutations.mjs
```

脚本串行临时修改行为，要求所选测试全部失败，每轮恢复文件；覆盖主流程及相关回归。新增流程时同步扩展脚本的故障案例。完成后再跑正常测试与仓库检查。

重置删除保护回归见 [sync-reset.test.ts](../packages/core/src/sync-reset.test.ts)和 [sync-reset-imap.test.ts](../packages/core/src/sync-reset-imap.test.ts)：覆盖窗口外缓存保留、存在性验证失败与持久续验、IMAP UID 复用，以及 Outlook delta 初始／410 重启／续页／增量的 Prefer 页大小。规则只在[同步说明](sync-correctness.md#重置删除保护)维护。

[sync-stale.test.ts](../packages/core/src/sync-stale.test.ts) 检查扫描的每账户预算、小时冷却与重启续验、不可用计数、孤立远端草稿和待推送改动保护；[sync-reset.test.ts](../packages/core/src/sync-reset.test.ts)及 [outlook.test.ts](../packages/core/src/outlook.test.ts) 检查 Outlook 冲突的持久入队与游标保存顺序。

[imap.test.ts](../packages/core/src/imap.test.ts)、[sync-reset.test.ts](../packages/core/src/sync-reset.test.ts)和 [sync-reset-imap.test.ts](../packages/core/src/sync-reset-imap.test.ts) 覆盖 SEARCH 失败与空集合的区别、小数量及空列表重置验证、遗漏文件夹和 UID 身份失效。[outlook.test.ts](../packages/core/src/outlook.test.ts)及 [provider-calendar.test.ts](../packages/core/src/provider-calendar.test.ts) 检查 Graph key-segment 续页、外域拒绝、嵌套联系人文件夹、去重和 People 上限。

[provider-retry.test.ts](../packages/core/src/provider-retry.test.ts)、[gmail.test.ts](../packages/core/src/gmail.test.ts)和 [outlook.test.ts](../packages/core/src/outlook.test.ts) 覆盖非幂等写入单次提交、丢失响应后的核对、草稿 ID 保留、附件续页、changeKey 冲突及 Trash 补偿。[undo-send-and-draft-create.test.ts](../packages/core/src/undo-send-and-draft-create.test.ts)与 [mobile-outbox.test.ts](../packages/core/src/mobile-outbox.test.ts) 检查创建日志、发送认领事务、明确失败重试、renderer 断开和数据库重开；同时覆盖与 合并后的迟到草稿回调、失效认领、ID 重映射及部分拒收保护；桌面 [renderer-models.test.ts](../apps/desktop/src/renderer/src/app/renderer-models.test.ts) 检查撤销的 core RPC。行为规则只在[同步说明](sync-correctness.md#草稿与其他写入)维护。普通低内存测试即可运行，无须启动 Electron。

## 解析器 fuzz 与无障碍

解析器属性测试使用固定 seed 的 fast-check 和恶意输入语料。覆盖 MIME／TNEF／兼容编码、HTML 清洗与重解析、可见文本、认证头、URL、搜索、日历、IMAP/SMTP 分片流和附件文件名。测试检查有界输出、幂等、协议分帧及清洗后没有活动内容，不能证明所有恶意输入都安全。入口见 core [parser-fuzz.test.ts](../packages/core/src/parser-fuzz.test.ts)、[parser-fuzz-corpus.ts](../packages/core/src/parser-fuzz-corpus.ts)、[mail-socket-fuzz.test.ts](../packages/core/src/platform/mail-socket-fuzz.test.ts)，以及桌面 [reader-html-fuzz.test.ts](../apps/desktop/src/renderer/src/components/reader-html-fuzz.test.ts)和[附件文件名测试](../apps/desktop/src/main/attachment-filenames-fuzz.test.ts)。

只跑 fuzz：

```sh
pnpm --filter @openmail/core exec vitest run fuzz
pnpm --filter @openmail/desktop exec vitest run fuzz
```

固定 seed 和轮数在各测试中维护。`OPENMAIL_LOW_MEMORY_TESTS=1` 会减少部分属性测试轮数；调查 fast-check 失败时保留输出中的 seed、path 和最小反例，用对应测试的参数重放。

[accessibility.test.ts](../apps/desktop/src/renderer/src/accessibility.test.ts) 用 axe 检查主界面、设置、撰写、阅读及确认对话框；serious／critical 必须为零，moderate 必须准确匹配带理由的 [allowlist](../apps/desktop/src/renderer/src/accessibility-allowlist.ts)，当前为空。jsdom 不做布局和 canvas 对比度判断，axe 的 color-contrast 关闭；主题 token 对比度、focus 和 reduced motion 由 [accessibility-theme.test.ts](../apps/desktop/src/renderer/src/accessibility-theme.test.ts)单独检查，另有 CSS 与语言回归。键盘路径、焦点恢复、控件名称和 live region 由 DOM 交互测试覆盖，不能代替 VoiceOver 或真机手势验收。

```sh
pnpm --filter @openmail/desktop exec vitest run accessibility
```

## 桌面生产构建 smoke

构建后在仓库根目录运行：

```sh
pnpm build
node apps/desktop/scripts/smoke.mjs --db /path/to/mail.db
```

脚本启动 Electron 生产构建，通过本地 CDP 检查主窗口、首个缓存会话、撰写、Settings 和同步健康报告。它不发送邮件。实现见 [smoke.mjs](../apps/desktop/scripts/smoke.mjs)、[smoke-ui.mjs](../apps/desktop/scripts/smoke-ui.mjs)和 core [smoke.ts](../packages/core/src/platform/node/smoke.ts)。

提供 `--db` 前先关闭原库的写入进程。脚本只复制原库、存在的 WAL 和同目录 `config.json`，发现复制期间文件变化即停止；只打开临时副本并迁移到当前版本。副本强制手动已读、英语界面并关闭首次 Profiles 建议，原文件不变。钥匙串项不复制，仍沿用标准 Secrets 读取和 token 刷新。没有 `config.json` 时，副本可能提示配置 OAuth client；这不等于需要重新登录。

`--db` 可省略，使用空临时库。`--timeout` 是总等待毫秒数，默认 180000；`--port` 指定本地 CDP 端口，默认自动选取。`--keep` 保留临时库和诊断文件，报告输出 `directory`；默认删除。启动设置 `OPENMAIL_READ_ONLY=1` 和临时 `OPENMAIL_HOME`，并核对 Electron 的 `user-data-dir`。只读会话仍允许本地写入和网络读取，详细边界只在[架构](architecture.md#只读会话)维护。

stdout 输出 JSON，stderr 输出步骤和预览日志：

| 字段                                           | 含义                                                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `readOnly`、`copiedDatabase`                   | 已启用只读会话，以及是否提供原库副本                                                         |
| `steps`                                        | 每步 passed／skipped 及跳过原因；无缓存 Inbox 会话跳过阅读，无账户跳过撰写和 Settings        |
| `syncHealth`                                   | 各账户脱敏同步健康报告；无账户为空，字段和判断见[同步说明](sync-correctness.md#同步健康检查) |
| `consoleErrors`、`exceptions`、`ipcRejections` | renderer 错误、异常和 RPC 拒绝；正常中断不计拒绝                                             |
| `failure`                                      | 步骤超时、预览退出或其他脚本失败原因；成功为空                                               |

步骤成功只证明所检查的窗口路径可用。`sync-health` passed 表示报告调用完成，服务商不可用或计数不一致仍需阅读 `syncHealth`；它不使脚本自动失败，也不修复同步。空库的跳过项不能算邮件流程验收。

只有来自 `about:srcdoc`、匹配固定 `img-src data: cid:` 提示的远程图片 CSP 拦截会被忽略。其他 console 错误、异常、RPC 拒绝或 `failure` 使退出码为 1。正常结束及 SIGINT／SIGTERM／SIGHUP 共用幂等清理，终止预览并按 `--keep` 删除或保留副本；信号退出码为 130／143／129，已有退出码不覆盖。回归见 [smoke.test.ts](../packages/core/src/platform/node/smoke.test.ts)、[smoke-cleanup.test.ts](../packages/core/src/platform/node/smoke-cleanup.test.ts)、[smoke-ui.test.ts](../apps/desktop/src/renderer/src/smoke-ui.test.ts)和 [rpc-key.test.ts](../apps/desktop/src/renderer/src/rpc-key.test.ts)。

脱敏服务商诊断格式只在[安全说明](security.md#服务商诊断)维护。smoke 的原始 console、`failure` 和 stderr 不受该字段白名单约束，分享前检查内容。自动测试使用 DOM、临时库和 fake provider，不运行 Electron smoke，也不证明真实 OAuth、系统权限或签名成品。

远程消息文本／Reply-To 补全以整个会话五秒为上限，失败仍返回缓存及 `bodyRefresh="failed"`，不改变账户认证状态；未知 Reply-To 不自动猜测回复收件人。Node Layer 使用 FetchHttpClient 与 Node fetch，renderer 取消请求会中断 fetch。只读 GET 的实际传输失败等待 500 毫秒后重试一次，发送不重试。实现与回归见 [mailbox-live.ts](../packages/core/src/mailbox-live.ts)、[provider-retry.ts](../packages/core/src/provider-retry.ts)和 [read-only.test.ts](../packages/core/src/read-only.test.ts)。

空白 Composer 的 `DraftStatus` 只查询本地草稿，未保存或已删除时返回 `null`；`OpenDraft` 用于明确打开或导入已有草稿。完整流程测试覆盖空白 Composer 打开、关闭时无失败 RPC，也不查询该草稿 ID 的消息，见 [mailbox-handlers.ts](../apps/desktop/src/shared/mailbox-handlers.ts)和 [flows.test.ts](../apps/desktop/src/renderer/src/e2e/flows.test.ts)。

## 按领域组织的回归

- [undo-journal.test.ts](../packages/core/src/undo-journal.test.ts)、[signatures.test.ts](../packages/core/src/signatures.test.ts)：跨重启撤销与签名。
- [optional-services.test.ts](../packages/core/src/optional-services.test.ts)：授权、服务开关与消息文本预算。
- [graph-recurrence.test.ts](../packages/core/src/graph-recurrence.test.ts)、[calendar.test.ts](../packages/core/src/calendar.test.ts)：循环事件、邀请与邮件事件检测。
- [search.test.ts](../packages/core/src/search.test.ts)、[preferences.test.ts](../packages/core/src/preferences.test.ts)、[organization.test.ts](../packages/core/src/organization.test.ts)：搜索、偏好、分类与规则。
- [uid-remap.test.ts](../packages/core/src/uid-remap.test.ts)：IMAP 身份映射。
- [native-compose.test.ts](../apps/desktop/src/main/native-compose.test.ts)：原生分享、图片和语法辅助。
- [sender-auth.test.ts](../packages/core/src/sender-auth.test.ts)、[model-view-hiding.test.ts](../packages/core/src/model-view-hiding.test.ts)：发件人认证与隐藏模型输入。

`TestMailbox.withAdapter(adapter, opts)` 共用真实 Mailbox／Store 和内存平台，支持传入适配器或从 fake adapter 派生。`incoming()`、`outgoing()`、`account(provider)` 提供可覆盖的消息与账户；HTTP 和 IMAP 传输使用共享 fake。

默认测试收集全部领域回归。`cache.test.ts` 的 100k 会话和 `performance-plans.test.ts` 的 150k 迁移仅在 `OPENMAIL_PERF=1` 时执行：

```sh
OPENMAIL_PERF=1 OPENMAIL_LOW_MEMORY_TESTS=1 pnpm --filter @openmail/core exec vitest run src/cache.test.ts src/platform/node/performance-plans.test.ts
```
