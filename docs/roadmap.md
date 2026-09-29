# 路线图：对齐 Mimestream，再做手机端

目标：桌面端具备 Mimestream 的全部功能，同时支持个人 Outlook；之后出 iOS/Android 版，和桌面共用 core。

Mimestream 功能清单来自 mimestream.com 的用户指南、FAQ、Trust Center 和更新日志，2026-09-29 查的。Mimestream 不公开它申请的 OAuth scope，下文的 scope 按 Gmail API 和 Graph 文档推断。

## 前提：scope 升级

现在只申请只读 scope。对齐 Mimestream 需要写权限，分阶段加，每次加 scope 用户要重新授权一次。

| 能力                   | Gmail                                     | Outlook (Graph)                |
| ---------------------- | ----------------------------------------- | ------------------------------ |
| 读（现状）             | `gmail.readonly`                          | `Mail.Read`                    |
| 归档、标签、已读       | `gmail.modify`                            | `Mail.ReadWrite`               |
| 发送                   | `gmail.send`（`gmail.modify` 已含草稿）   | `Mail.Send`                    |
| 过滤器、自动回复、别名 | `gmail.settings.basic`                    | `MailboxSettings.ReadWrite`    |
| 联系人补全、头像       | `contacts.readonly`、`directory.readonly` | `Contacts.Read`、`People.Read` |
| 日历邀请               | `calendar.events`                         | `Calendars.ReadWrite`          |

`gmail.modify` 属于 Google 的 restricted scope。自用的未验证应用在 In production 状态下最多 100 个用户，登录时显示「未经验证」警告，不影响使用。

## 已完成（阶段 0）

- Gmail、个人 Outlook 只读同步，history / delta 增量。
- 多账户，统一收件箱，账户磁贴切换。
- 空间（profile）：把账户分组，底部切换条，⌃1 总览、⌃2 全部、⌃3 起各空间。总览页显示每个空间的未读、同步状态和最新未读。
- 重要、垃圾邮件、已删除、Gmail 分类、Gmail 标签和 Outlook 自定义文件夹。
- 会话列表（按 thread 聚合，显示参与者和封数）、未读/星标筛选、滚动加载。
- 三栏界面（Mimestream 布局），会话堆叠，头像在左。
- HTML 沙箱渲染，默认拦截远程图片。
- 本地全文搜索（FTS5 trigram）。
- CLI 和只读 MCP。

## 阶段 1：处理邮件

加 `gmail.modify` / `Mail.ReadWrite`。

- 归档、删除、移动、打标签、星标、标为未读、标为重要。
- 报告垃圾邮件、不是垃圾邮件。
- 操作后自动选中哪一封（下一封、上一封、回到列表）。Delete 键行为可设置。
- ⌘Z 撤销上一次操作。
- 快速筛选：未读、星标、重要，可组合（⌥⌘L）。
- 键盘：Mimestream 默认、Apple Mail、Gmail 三套快捷键。

实现要点：写操作先改本地库，再放进 `pending_ops` 队列推到服务器，断网时排队。队列表按 `db.ts` 的规则追加迁移。MCP 的写工具默认关闭，要显式开关。

## 阶段 2：撰写与发送

加 `gmail.send` / `Mail.Send`、`gmail.settings.basic` / `MailboxSettings.ReadWrite`、联系人 scope。

- 新邮件、回复、全部回复、转发、作为附件转发。
- 草稿与服务器双向同步，离线写的草稿联网后发送。
- 发件别名：同步 Gmail「Send mail as」，自动选最合适的发件账户。
- 签名：同步 Gmail 默认签名，另加本地签名，按地址区分新邮件和回复。
- 模板：本地存储，支持变量和预设收件人、主题（⌘/）。
- 撤销发送：客户端延迟 5、10、20、30 秒。
- 发送并归档。
- Markdown、代码块、@提及加收件人、忘带附件提醒。
- 联系人补全：Google / Outlook 联系人、Workspace 目录、macOS 通讯录。补全黑名单。
- MCP 只能建草稿。发送必须在 app 里人工确认，模型的每次写操作记审计日志。

## 阶段 3：搜索与整理

- 服务器端搜索：Gmail `q` 操作符、Graph `$search`，和本地 FTS 结果合并。
- 搜索框用 token：发件人、收件人、标签、属性、附件类型。范围可选全部邮件或当前文件夹。
- 标签管理：新建、改名、颜色、显隐、收藏夹。「前往文件夹…」。
- Gmail 分类（主要、社交、推广等），按账户开关。
- 服务器端过滤器，「按这些邮件建过滤器…」，带实时预览。
- 自动回复（休假回复）。
- 稍后提醒：Gmail API 不提供 snooze，和 Mimestream 一样做成本地功能，到点通知并移到收件箱顶部，不和服务器同步。

## 阶段 4：阅读

- 会话分组开关，会话内时间顺序可选。
- 标为已读的时机：立即、延迟、手动。
- 查看原始邮件、打印、导出 PDF、在单独窗口打开。
- 单封邮件切换浅色或深色背景，7 档字号。
- 追踪器拦截：维护一份追踪像素域名清单（Mimestream 覆盖 75 个以上的服务）。
- 日历邀请横幅：接受、拒绝、建议新时间、会议链接（日历 scope）。
- 联系人头像。

## 阶段 5：通知与系统集成

- 通知：按账户选「主要」「收件箱」或关闭；通知上的归档、删除按钮。
- 菜单栏图标列出未读邮件，Dock 未读数。
- 配置文件：把账户分成「工作」「个人」，各自的图标、颜色、通知时段。⌃⌘1… 切换。
- 设为系统默认邮件客户端（`mailto:`）。
- 多窗口。
- 复制邮件的深链接。

新邮件推送有两条路，要选一条：

1. 轮询 history / delta，间隔 30 到 60 秒。不需要服务器，延迟在一分钟以内。
2. 和 Mimestream 一样用 Gmail `users.watch` 推到 Pub/Sub，再经一个中转服务发给客户端。Outlook 用 Graph 订阅，需要公网 webhook。延迟几秒，但要架服务器。

桌面端先做轮询。手机端见下文。

Electron 做不到、需要原生模块的：macOS Focus 过滤器、分享扩展、Quick Look、Apple Writing Tools、Liquid Glass 材质。这些排在最后，逐个评估。

## 阶段 6：发布

- 打包、签名、公证、自动更新（参考 plany 的 electron-builder 配置）。
- 附件下载、列表分页、更早邮件回填、按标签的缓存窗口。

## 手机端

### 选型

`apps/mobile` 用 Expo（React Native）。理由：core 是 TypeScript，手机端直接复用，界面层用 React，和桌面的写法一致。

### core 要拆出平台接口

core 里能直接在手机上跑的：`mime.ts`、`types.ts`、`store.ts`（纯 SQL），`gmail.ts`、`outlook.ts` 里调 API 的部分。

绑定 Node 的，要抽成接口，桌面和手机各实现一份：

| 接口       | 桌面（现状）                 | 手机                                               |
| ---------- | ---------------------------- | -------------------------------------------------- |
| 数据库     | `node:sqlite`                | op-sqlite（自带 SQLite，含 FTS5）                  |
| 密钥存储   | `@napi-rs/keyring`           | expo-secure-store（iOS 钥匙串 / Android Keystore） |
| OAuth 授权 | 本机 HTTP 回调（`oauth.ts`） | expo-auth-session，系统浏览器加自定义 scheme 回调  |
| 配置       | `config.json`（`config.ts`） | expo-secure-store 或 app 沙箱文件                  |
| 数据目录   | `paths.ts`                   | app 沙箱                                           |

`store.ts` 现在直接用 `DatabaseSync` 的类型。拆的时候定义一个只含 `prepare().all/get/run` 和 `exec` 的最小 `Db` 接口，op-sqlite 的同步 API 能满足。trigram 分词器要求 SQLite 3.34 以上，op-sqlite 自带的版本要确认。

这一步等桌面阶段 1 做完再动：写操作队列会改 core 的结构，一起拆省一次返工。拆完之后，core 里除了平台实现文件，其他文件不能 import `node:` 模块。这条到时写进 AGENTS.md。

### OAuth 客户端

手机端要另外注册客户端，`scripts/setup-oauth.sh` 到时加这两步：

- Google：iOS 类型和 Android 类型客户端，没有 secret，回调用反向 client ID scheme。
- Azure：同一个应用注册里加 iOS/macOS 和 Android 平台，回调 `msauth.<bundle id>://auth`。

### 推送

不架服务器的话，iOS 只能靠 BGAppRefreshTask 后台刷新，间隔由系统决定，从十几分钟到几小时不等。要即时推送，需要一个中转服务：Gmail watch 或 Graph 订阅事件进来，中转服务发 APNs / FCM，只传账户和 history ID，不经手 token 和邮件内容。Mimestream 的 Private Push 就是这个结构。

这是本地优先原则下唯一要引入服务器的地方，做之前要决定。

### 界面

手机端单栏：账户和邮箱列表、邮件列表、会话三层导航。左右滑动做归档、删除、标为未读，方向可设置。视觉规格沿用 `docs/design/index.html`。
