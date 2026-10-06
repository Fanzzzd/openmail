# 路线图

桌面目标是对齐 Mimestream 的邮件功能，并支持个人 Outlook 和 IMAP/SMTP。手机端复用 core。逐项对齐证据保留在 [parity](parity.md)，本页维护当前进度和验收事项。

## 进度（2026-10-03）

本页按当前代码维护。下表的“完成”指产品路径和自动回归已存在；真实账户、设备权限与正式发行另行验收。同步重置删除保护和 Outlook delta 分页修复、过期缓存扫描与 Outlook 冲突队列均已合入。当前实现将所有重置删除候选纳入验证，并修复 IMAP 搜索失败处理、Graph 续页和 Outlook 联系人文件夹遍历。同步规则与证据见[同步说明](sync-correctness.md#重置删除保护)。

| 范围             | 已完成                                                                                                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 邮件操作与可靠性 | 批量／单封操作、持久撤销记录、队列重试、离线状态保护、草稿恢复、数据库恢复、脱敏服务商诊断、只读会话和同步健康检查                                                   |
| 撰写             | 富文本格式、纯文本与 Markdown、模板变量与 Bcc、命名签名、Gmail 签名同步、发件地址选择、联系人组／公司／照片、附件与发送保护                                          |
| 阅读与日历       | 会话顺序、引用折叠、消息文本查找、原始邮件／EML、附件互操作、会议入口、邀请历史与响应、冲突查询、确认创建可识别事件                                                  |
| 搜索与整理       | 布尔与排除、短语、字段／日期／大小／分类／Message-ID 运算符、词索引与 trigram 回退、服务器搜索、规则编辑与历史应用、稍后提醒                                         |
| 桌面集成         | 键盘与原生菜单、Profiles、通知时段、菜单栏与 Dock、文件打开草稿、拼写检查、持久附件缓存、账户与更新设置                                                              |
| AI               | Model 服务、账户文本授权、流式摘要与缓存、邮件助手、撰写差异预览／改写／翻译、独立开关的分拣建议、本地语义检索                                                       |
| Apple Contacts   | 显式授权、进程内快照、组首选邮箱、照片、卡片跳转与 vCard 导入入口                                                                                                    |
| 工程验证         | 性能查询计划与内存回归、无障碍与键盘回归、renderer 模块拆分、真实 App／RPC／Mailbox 邮件流程、解析器 fuzz 与 axe 检查、十种语言目录检查                              |
| 平台与手机       | Node 平台拆分、portable 入口、Expo 项目、op-sqlite／SecureStore／AuthSession adapters、Gmail／Outlook／IMAP/SMTP、受限阅读、撰写与确认发送、后台刷新、本地通知和徽标 |

当前新增能力的证据见 [只读与可选服务](architecture.md#只读会话)、[邮件内容保护](security.md)、[同步健康报告](sync-correctness.md#同步健康检查)和[测试入口](testing.md)。[db.ts](../packages/core/src/db.ts) 已有迁移 1 至 36；消息文本容量预算不等于整库空间上限。迁移 36 与出站可靠性规则见[同步说明](sync-correctness.md#出站操作队列)。已合入迁移 35 和 10 万封性能预算；测量条件、查询计划及写入成本见[性能](performance.md)。

Gmail 与个人 Outlook 的基础读写、发信已有真实账户验证记录。后续能力的 fake provider、fake Model、临时数据库及 DOM 回归不能代替新增 scope、真实模型、原生权限和发行验收。验证入口见[测试](testing.md)，测量条件见[性能](performance.md)。

## 待用户完成

- OAuth：按 [Google](setup-google.md) 与 [Microsoft](setup-microsoft.md) 在自己的控制台启用 API 和权限。联系人、日历和服务商设置按账户逐项连接；停用不撤销远程授权。旧授权缺权限时从可选服务入口重新授权。Gmail 永久删除须另加 `https://mail.google.com/` 并通过 app 的永久删除权限入口重新授权；普通收发不要求这个 scope。权限依据见 [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)。
- 发行：提供自己的 Apple Developer 签名身份和公证凭证。验证 Developer ID、公证、Gatekeeper、两种架构的钥匙串与原生依赖，以及测试私库自动更新。构建和凭证细节只在[发布说明](release.md)维护。
- 手机注册：创建自己的 Google iOS／Android 客户端和 Microsoft 原生回调，配置 bundle ID、package name 与签名信息。按[手机端说明](../apps/mobile/README.md)创建开发构建，验证原生 SQLite、FTS5、WAL、Metro、两家 OAuth 和大邮箱分页。Expo Go 不覆盖这些能力。
- 推送决策：确定是否引入中转服务，再设计 Gmail watch／Graph subscriptions、APNs／FCM、设备注册、续期和隐私契约。当前桌面轮询与 IMAP IDLE 已实现，手机端已有 OS 调度的后台增量刷新和本地通知，无远程推送。

真实账户与系统验收还包括：

1. 三家草稿往返、别名与签名切换、附件和大附件、离线推送、永久删除与清空垃圾箱。
2. 冷缓存与跨 90 天回填、搜索范围和截断、嵌套文件夹、过滤器新邮件／历史命中、自动回复时区、稍后提醒与重启。
3. Gmail／Outlook 邀请响应、重复实例、取消和组织者通知；IMAP iTIP REPLY；联系人分页及撤权刷新。
4. 签名包的通知权限与动作、Dock 与 Profiles、默认邮件客户端、冷启动链接、拼写检查、打印和 PDF。
5. Apple Contacts 的系统授权、部分授权、撤权、联系人卡片跳转和导入确认。测试边界见 [Apple Contacts](apple-contacts.md#验证边界)。
6. 使用自己的 API 密钥验证摘要、助手、撰写和分拣的真实模型请求、取消与费用。端侧索引另验正式签名包的 Vision、sqlite-vec 和 ONNX。

## 剩余功能

原生能力以 [parity](parity.md) 的功能编号为准：

| 功能编号        | 剩余范围                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| A05             | ASWebAuthenticationSession 与授权浏览器选择                                                               |
| C51、I01 至 I05 | 系统自动纠错、行内预测、Apple Writing Tools 和系统 ChatGPT 扩展；显式语法检查已有，仍需实机验收           |
| N11             | 按 Profile 接入 Focus Filter／App Intents                                                                 |
| N17、N19、M05   | Universal Links、Associated Domains、HTTPS 回退页和接收内容的系统分享扩展；向外分享链接已有，仍需实机验收 |
| M06 至 M08      | Photos picker 与 Continuity Camera 的实机验收；Markup 写回尚未实现                                        |
| M11、P06、P07   | Liquid Glass 原生控件、WebKit 行为对齐、macOS App Sandbox                                                 |
| M01             | 单个 Universal app；当前配置生成 arm64 与 x64 两套包，Intel 真机及 ONNX 限制见发布说明                    |
| R40             | Apple Calendar；现有 Gmail／Outlook 事件创建也不覆盖模糊自然语言日期及所有重复规则                        |

其余缺口包括 Workspace Directory、可选服务真实授权验收、部分 Gmail 搜索扩展与规则条件、Gmail 服务器草稿标签／星标、整库空间控制，以及实时推送。Google restricted-scope verification、Advanced Protection 与 CASA 属于外部审核事项。内置 AI 已实现，I01 至 I05 仍专指 Apple 原生能力。

历史切片更新保存在 git；parity 维护当前能力计数。模块入口按 [CONTEXT.md](../CONTEXT.md) 和[架构](architecture.md)读取。

## 手机端

### core 平台接口

Node 专用实现集中在 `packages/core/src/platform/node/`。手机从 `@openmail/core/portable` 加载 Mailbox、Store、迁移及 HTTP provider。接口见[架构的 Platform 端口](architecture.md#platform-端口)，逐文件清单见[平台依赖清单](platform-inventory.md)。

### 手机基础

已接入 Expo、React Native、op-sqlite、SecureStore、系统浏览器 PKCE 授权、账户／邮箱／会话列表、分页、受限 HTML 阅读、下拉同步及十种语言。根 `build` 只编译语言目录和检查类型；自动测试使用 Node SQLite shim 与原生服务 mocks。

### 手机邮件流程与后台能力

已接入整理与撤销、多选、可配置滑动、VoiceOver actions、回复／转发／富文本撰写、文件与照片附件、本地草稿和持久发送队列。IMAP/SMTP 使用 portable 协议和原生 TCP/TLS，强制 TLS 或 STARTTLS；阅读附件经 core 下载。实现见 [手机平台组装](../apps/mobile/src/platform/index.ts)、[IMAP adapter](../packages/core/src/platform/react-native/imap.ts)和[撰写界面](../apps/mobile/app/compose.tsx)。

后台刷新、本地通知和徽标默认关闭。OS 决定后台任务时间；后台只拉取 Inbox 增量，不回填、不发送或推送整理队列。通知默认只显示发件人，不显示消息文本，无远程推送。代码与原生补丁见 [background.ts](../apps/mobile/src/background.ts) 和[手机端说明](../apps/mobile/README.md#前后台同步与原生权限)。

自动测试使用 SQLite shim、分片协议流和原生服务 mocks，不能证明真机 TLS、Metro、通知、锁屏存储或后台唤醒。数据库恢复已接入完整性检查、隔离副本、可读用户记录抢救、中断重试及 provider 重同步。PDF 文本提取和固定地址图片下载已有明确返回 unavailable 的移动 no-op adapters；端侧推理不支持，原因及后续原生验证边界见手机端说明。能力表、权限和真机验收只在[手机端说明](../apps/mobile/README.md)维护。
