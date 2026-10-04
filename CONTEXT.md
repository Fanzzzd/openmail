# 领域上下文

openmail 在本机缓存邮件。桌面、CLI 和 MCP 通过 core 共享数据库、操作队列与权限。手机端复用可移植 core，使用设备自己的数据库和安全存储。

## 术语

| 名称                 | 含义                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------- |
| 账户 Account         | 一个已登录的 Gmail、个人 Outlook 或 IMAP 邮箱，包含 provider 身份与同步状态               |
| 服务商 provider      | Gmail、Outlook、IMAP；`ProviderAdapter` 把协议转成 core 的变更与操作                      |
| 可选服务             | 每账户的联系人、日历或服务商设置；scope 授权与本机启停分别记录                            |
| 只读会话             | `OPENMAIL_READ_ONLY=1` 禁止远程写入；允许网络读取、token 刷新及本地写入                   |
| 同步健康报告         | 按文件夹／标签比较本地与服务商计数，附游标年龄和待推送操作；不证明内容一致                |
| 邮件 Message         | 服务器邮件在本地的镜像；本地 ID 含账户身份，`providerId` 是服务器 ID                      |
| 会话 Thread          | 同账户中按 `threadId` 归组的邮件；列表与工具通常用代表邮件 ID 定位会话                    |
| 消息文本             | 邮件的纯文本内容；HTML 是另一个受清洗和隔离的阅读表示                                     |
| 草稿 Draft           | `drafts` 表中的本地可编辑内容；本地 ID 与服务器草稿／邮件 ID 分开                         |
| 标签 Label           | Gmail 标签或 Outlook／IMAP 文件夹的统一表示，操作须遵守各 provider 语义                   |
| Profile              | 账户分组，界面中的空间；定义账户范围、通知时段和窗口选择，不等同于账户                    |
| 命令 Command         | 可序列化的邮件改动，交给 `Mailbox.perform` 检查权限并执行                                 |
| 操作者 Actor         | 用户或代理的身份与入口，影响策略判断并进入审计                                            |
| 提议 Proposal        | 等待用户审批的代理命令；MCP 与内置助手的写入均受提议流程约束                              |
| 操作队列 pending_ops | 本地改动待推送服务商的持久队列，支持认领、重试和错误记录                                  |
| 失败提示 FailedOp    | `failed_ops` 保存推送失败与发送警告，桌面和手机经 Mailbox 查询                            |
| 重置验证队列         | `sync-reset:<account>` 保存在 prefs 的重置或 Outlook 冲突候选；未验证项保留，下次同步续验 |
| 撤销记录 UndoJournal | `undo_batches` 保存可跨重启恢复的批量／单封操作逆向状态，撤销前校验后续改动               |
| 派生数据             | 搜索文本／向量、AI 摘要及分拣建议；单独保存，不覆盖服务商邮件                             |
| Model                | 第三方语言模型的流式 Effect 服务；当前实现是 Anthropic                                    |
| ModelRuntime         | 本机 embedding 推理接口，与第三方 Model 的文本授权分开                                    |
| MailToolkit          | core 的模型工具集合，CLI、MCP 与内置助手复用其 schema 和处理器                            |
| 平台端口             | core 所需的 SQL、文件、密钥、OAuth、MIME、网络或 worker 服务                              |
| Layer                | 为 Effect 服务提供具体实现的组装单元                                                      |

- `messageId` 按边界区分：provider 返回服务器 ID；Mailbox／Store 参数用含账户前缀的本地 ID；RFC Message-ID 在 `rfcMessageId` 中，来自邮件头，通常带 `<…>`。三者不可互换。
- `MailOp` 是 read、star、move、label 等单项邮件改动；`Command` 加上目标和审批语义；`QueuedOp` 还包括草稿保存、删除和 reconcile。
- queued send（`queueSend`）保存离线／定时投递意图；delayed send（`queueUndoSend`）保存撤销发送的短暂等待。两者都写入 outbox 并显示 waiting，后者用 `desktopUndo` 标记。
- `FolderScope`（mailbox、accountIds、label）表示整夹操作目标，不包含搜索、分页或未读筛选；标签／文件夹范围也非正式地称为 "label scope"。

## 模块入口

| 位置                                                                       | 职责                                                                               |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `packages/core/src/domain.ts`、`services.ts`、`mailbox.ts`                 | 领域 schema、内部服务端口与调用方 Mailbox 接口                                     |
| `mailbox-live.ts`、`mailbox-*.ts`                                          | 同步、策略、队列与审计的组装；分拆批量、文件夹、缓存、联系人／日历、整理与 AI 能力 |
| `store.ts`、`store-*.ts`、`db.ts`                                          | SQLite 查询、投影与追加迁移；消息写入经过 `upsertMessage`                          |
| `gmail.ts`、`outlook.ts`、`platform/node/imap.ts`                          | 服务商适配器；拉取产出 Change，由 Mailbox 落库                                     |
| `platform/react-native/imap.ts`、`platform/mail-socket.ts`                 | 手机 IMAP/SMTP 协议与可移植传输；原生 TCP/TLS Layer 由 app 提供                    |
| `read-only.ts`、`optional-services.ts`、`mailbox-services.ts`              | 只读方法白名单、各服务 scopes 与本机启停                                           |
| `sync-reset.ts`、`store-sync-reset.ts`                                     | 限定重置删除范围、持久冲突候选、过期缓存扫描与服务商存在性验证                     |
| `sync-health.ts`、`store-sync-health.ts`、`provider-diagnostics.ts`        | 同步健康报告、本地计数和脱敏服务商失败事件                                         |
| `model.ts`、`mailbox-ai.ts`、`store-ai.ts`、`model-view.ts`                | 第三方模型、账户授权、缓存、分拣与模型消息文本上下文                               |
| `tools.ts`、`tool-pages.ts`                                                | 工具集合、身份、分页与输出预算                                                     |
| `indexer.ts`、`semantic-indexer.ts`、`store-media.ts`、`store-semantic.ts` | 本机 OCR／PDF 派生文本、向量与检索                                                 |
| `platform/`、`platform/node/`、`platform/react-native/`                    | 可移植端口、Node 实现、无 React Native 依赖的移动 SQL／OAuth／MIME adapters        |
| `apps/desktop/src/main`、`preload`、`shared`                               | 窗口与系统能力、sandbox preload、RPC schema 和 Mailbox 处理器                      |
| `apps/desktop/src/renderer/src/app`、`state`、`components`                 | 界面控制 hooks、Effect atoms、邮件与设置组件                                       |
| `packages/cli/src`                                                         | 人工 CLI 命令和 stdio MCP server，共用 NodeMailbox                                 |
| `apps/mobile/app`、`apps/mobile/src/platform`                              | Expo 路由、移动界面与 OS Layers，只调用 portable Mailbox                           |
| `apps/desktop/src/renderer/src/e2e`                                        | 真实 App、RPC、Mailbox 和临时 SQLite 的完整邮件流程测试                            |
| `apps/desktop/scripts/smoke.mjs`                                           | 用数据库副本启动生产构建，检查窗口与同步健康报告                                   |
| `apps/mobile/src/background.ts`、core `mobile-background.ts`               | OS 后台增量刷新、本地通知、徽标和持久去重                                          |

## 规则来源

修改代码前读 [AGENTS.md](AGENTS.md)。模块接口与数据流见[架构](docs/architecture.md)，平台变更读[平台依赖清单](docs/platform-inventory.md)。模型工具与审批约束读[代理使用指南](docs/agents.md)，Apple 联系人接入读[Apple Contacts](docs/apple-contacts.md)。测试入口见[测试](docs/testing.md)，产品范围与真实验收见[路线图](docs/roadmap.md)。详细规则各自在这些文档维护。
