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

## 进度（2026-09-30）

阶段 0、阶段 1 已完成，阶段 2 完成了新邮件、回复、转发、附件、5 秒撤销发送。已加 `gmail.modify`、`gmail.send`、`Mail.ReadWrite`、`Mail.Send`，两个真实账户已重新授权并验证过读写和发信。

剩下的按这个顺序做，一次一个切片，每个切片从 core 到界面做完、测完再开始下一个：

1. 撰写（已完成，待真实账户验证）：草稿双向同步和自动保存、发送并归档、撤销发送时长、作为附件转发、忘带附件提醒、Markdown、模板、本地签名、按往来邮件补全联系人。
2. 阅读（已完成，待真实账户验证）：标为已读的时机、原始邮件、打印和 PDF、单独窗口、单封背景和字号、追踪器拦截、附件保存和打开、按发件人允许远程图片、会话归组和顺序。
3. 搜索与整理：服务器端搜索和本地结果合并、搜索 token、标签和文件夹管理、前往文件夹、稍后提醒、过滤器、自动回复、Gmail 发件别名和签名同步。要加 `gmail.settings.basic`、`MailboxSettings.ReadWrite`。
4. 系统集成：通知、菜单栏、Dock 未读数、`mailto:`、多窗口、深链接、三套快捷键、设置页。
5. 日历邀请和联系人：邀请横幅、接受拒绝、服务器联系人补全。要加日历和联系人 scope。
6. 发布：打包、签名公证、自动更新、更早邮件回填、按标签的缓存窗口。签名需要 Apple Developer 账号。

新 scope 集中在第 3、5 步之后一次加，减少重新授权的次数。

### 切片 1 撰写：做了什么，留了什么

做了：

- 草稿：本地先存，经队列推到服务器。Gmail 用 drafts API，Outlook 用 Drafts 文件夹里的邮件，IMAP 用 APPEND 加 `\Draft` 标记。写信窗口停止输入 2 秒后自动保存，关闭时也保存。「草稿」文件夹和会话里的草稿都能点开继续写。别的客户端建的草稿打开时取原始 MIME，密送和附件都在。发送后本地和服务器上的草稿都删掉，丢弃同理。设计见 [architecture.md](architecture.md) 的「草稿」。
- 发送并归档：回复和回复全部有这个按钮，快捷键 ⇧⌘↩。
- 撤销发送：关闭、5、10、20、30 秒，在「设置 > 撰写」里改，存在 core 的 `prefs` 表。等待是渲染进程里的一个计时器（core 的 `holdSend`），撤销就是清掉它，邮件不会到主进程。提示条显示整个等待期，被别的提示顶掉时用 ⌘Z 撤销。设成关闭时直接发，没有撤销提示。
- 作为附件转发：工具栏按钮和 ⇧F。原邮件的原始 MIME 作为 `message/rfc822` 附件发出，三家都走新邮件的发送路径。Outlook 这时把整封信拼成 MIME 交给 sendMail，不用 JSON 的 fileAttachment：后者会被 Exchange 当成普通文件重新编码，Gmail 预览时猜错字符集。
- 忘带附件提醒：正文（不算引用和签名）提到「附件」「attached」等词而没有附件时，发送前先确认。两个选择：「返回添加附件」关掉提醒并打开文件选择，什么都不发；「仍然发送」。
- Markdown：写信窗口的 M↓ 开关。core 用 markdown-it 渲染，`html: false`，输入的 HTML 一律转义，发 text 加 HTML 两部分。支持代码块。HTML 发出前包成带 `<meta charset=utf-8>` 的完整文档：通过 Graph 发的 HTML 片段没有这个声明时，Gmail 收到的中文是按 GBK 解读的 UTF-8。
- 模板：⌘/ 打开，可预设主题、收件人、抄送，支持 `{first_name}`、`{last_name}`、`{name}`、`{email}`。从当前邮件存为模板。
- 签名：按发件地址分新邮件和回复两份，写信时自动加，换发件账户时跟着换。
- 联系人补全：按本地往来邮件，写过的人权重高，越近越靠前。建议里可以隐藏某个地址，在设置里恢复。只排除当前发件地址，本人的其他账户照常出现。
- 会话里的草稿按本地草稿 id 打开。Gmail 和 IMAP 每次保存都换掉服务器上的邮件，没刷新的阅读区拿旧邮件 id 会找不到；本地 id 不变。草稿推送换了邮件后 core 发 `Changed`，阅读区和列表会重新读。
- 同步：拉取在网络上失败（没有状态码）、被限流或遇到 5xx 时，隔 5 秒、10 秒再试两次，成功就不算失败。每个请求本身已经重试约 8 秒。
- MCP 的 `draft_message` 现在建一条真实草稿。AI 权限是「只读」时草稿只在本机，人在写信窗口保存后才推到服务器；其他模式下 app 下次同步推送。它仍是一条待确认的提议，只有人能发出。

留到后面：

- Gmail 签名同步，要 `gmail.settings.basic`，放在第 3 步。`signatures` 表的 `source` 列是接口。
- 服务器联系人补全（Google、Outlook、目录），放在第 5 步。接在 `Mailbox.suggestContacts` 后面。
- Markdown 预览。现在只有开关，发出去才看到效果。
- `@` 提及加收件人。
- 别的客户端写的 HTML 草稿在 openmail 里按纯文本编辑，保存后格式会丢。
- Outlook 草稿和发信的附件总量上限 3 MB，超过的草稿只留在本机。大附件要走 upload session，放在第 6 步。

### 切片 2 阅读：做了什么，留了什么

做了：

- 标为已读的时机：立即、1 秒、3 秒、5 秒后、手动，在「设置 > 阅读」里改，存在 core 的 `prefs` 表。计时在渲染进程（core 的 `markReadAfter`），延迟内换到别的会话就取消。单独窗口打开会话也按这个设置。
- 会话选项：会话归组开关和会话内顺序（最早或最新在前）。归组关闭时列表按邮件列出（`ThreadQuery.flat`），阅读区只显示选中的那封。
- 原始邮件：每封邮件的菜单里「显示原始邮件」。core 的 `Mailbox.rawMessage` 用各家的 `fetchRaw` 取原始 MIME。对话框用等宽字体，邮件头可以折叠，有复制按钮。超过 40 万字符的正文只显示前面一段，复制仍是整封。
- 打印和 PDF：主进程把会话（或其中一封）拼成一个打印用的 HTML（core 的 `printableThread`），去掉脚本、框架、事件属性，拦掉追踪器，CSP 不加载任何远程资源。内嵌图片（cid:）会带上。HTML 写到临时文件，由一个隐藏窗口加载，这个窗口关了 JavaScript，用单独的 session，只放行 `file:` 和 `data:` 请求。打印走系统对话框，PDF 先问存到哪里再 `printToPDF`。⌘P 打印当前会话。
- 单独窗口：双击列表行、右键菜单、工具栏按钮或 ⇧⌘O。新窗口加载同一个渲染进程页面，带 `?thread=<id>`，preload 和安全设置和主窗口一样。窗口里有会话的操作按钮，没有回复和转发；归档、删除、报告垃圾邮件后窗口自动关闭。
- 背景和字号：每封邮件的菜单里切换浅色或深色，只在本次运行内有效；默认背景在设置里选「始终浅色」或「跟随外观」。深色是把整页反色再把图片反回来，照片和标志颜色不变。字号 7 档（80% 到 175%），存在 `prefs`，阅读区获得焦点时 ⌘+ ⌘− ⌘0 调整，邮件内容里也生效。
- 追踪器拦截：core 的 `trackers.ts` 是一份数据，覆盖约 100 个服务（Mailchimp、SendGrid、HubSpot、Mailgun、Mixpanel、Customer.io、Intercom、Klaviyo、Braze、Iterable、Marketo、Pardot、Substack、beehiiv、ConvertKit、Superhuman、Mailtrack、Streak、Yesware、Mixmax、Hunter 等）。有的域名也放正常内容，这些只匹配打开追踪的路径。`prepareMessageHtml` 在渲染前删掉这些图片和 CSS 里的地址，允许远程图片时也一样，1×1 的远程图片也算追踪像素。邮件上显示「已拦截 N 个追踪器」，悬停列出服务名。链接不改写。
- 远程图片：新迁移加 `image_senders` 表，存地址或域名（域名包括子域名）。邮件菜单和图片提示条上可以「总是加载」，设置里可以增删。原来的「加载图片」只对这封邮件、本次运行有效。只有允许时 iframe 的 CSP 才放行远程图片。
- 附件：阅读区列出附件，带类型图标和大小。点一下用默认程序打开（写到临时目录再 `shell.openPath`），箭头按钮保存，两个以上有「全部保存」。core 加了 `Mailbox.attachment(messageId, index)`，适配器各加 `fetchAttachment`：Gmail 取 `format=full` 找到对应部分，小的直接用正文数据，大的走 attachments 接口；Outlook 走 `/attachments/{id}/$value`；IMAP 按 BODYSTRUCTURE 的部分编号下载 `BODY[part]`，对不上时退回解析原始邮件。按文件名和同名序号定位，不依赖各家列出附件的顺序。能直接运行代码的文件（.app、.command、.pkg 等）不从 app 里打开，只能保存。在 macOS 上保存和打开的文件都加 quarantine 属性，第一次打开时由 Gatekeeper 检查。
- 内嵌图片：允许图片时，`Mailbox.inlineImages` 取原始邮件，把带 Content-ID 的图片转成 data URL 替换 `cid:`。

留到后面：

- 归组关闭时，工具栏和快捷键的操作仍然作用于整个会话。按单封邮件改动要给 `modify` 加消息级别的命令。
- 远程 CSS 文件里引用的追踪地址拦不到，只拦 HTML 里和内联样式里的。
- 打印和 PDF 不加载远程图片。
- Gmail 列出的附件里含内嵌图片（签名里的标志等），阅读区照常列出。
- Quick Look 预览附件，需要原生模块，放在阶段 5 之后评估。
- 真实账户上要验证：三家的附件下载（含大附件和同名附件）、Outlook 的内嵌图片、打印对话框在隐藏窗口上能否正常弹出、PDF 分页。

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

- 新邮件、回复、全部回复、转发、作为附件转发。（已完成）
- 草稿与服务器双向同步，离线写的草稿联网后发送。（已完成）
- 发件别名：同步 Gmail「Send mail as」，自动选最合适的发件账户。
- 签名：同步 Gmail 默认签名，另加本地签名，按地址区分新邮件和回复。（本地签名已完成）
- 模板：本地存储，支持变量和预设收件人、主题（⌘/）。（已完成）
- 撤销发送：客户端延迟 5、10、20、30 秒。（已完成）
- 发送并归档。（已完成）
- Markdown、代码块、@提及加收件人、忘带附件提醒。（除 @提及 外已完成）
- 联系人补全：Google / Outlook 联系人、Workspace 目录、macOS 通讯录。补全黑名单。（本地往来邮件和黑名单已完成）
- MCP 只能建草稿。发送必须在 app 里人工确认，模型的每次写操作记审计日志。（已完成）

## 阶段 3：搜索与整理

- 服务器端搜索：Gmail `q` 操作符、Graph `$search`，和本地 FTS 结果合并。
- 搜索框用 token：发件人、收件人、标签、属性、附件类型。范围可选全部邮件或当前文件夹。
- 标签管理：新建、改名、颜色、显隐、收藏夹。「前往文件夹…」。
- Gmail 分类（主要、社交、推广等），按账户开关。
- 服务器端过滤器，「按这些邮件建过滤器…」，带实时预览。
- 自动回复（休假回复）。
- 稍后提醒：Gmail API 不提供 snooze，和 Mimestream 一样做成本地功能，到点通知并移到收件箱顶部，不和服务器同步。

## 阶段 4：阅读

- 会话分组开关，会话内时间顺序可选。（已完成）
- 标为已读的时机：立即、延迟、手动。（已完成）
- 查看原始邮件、打印、导出 PDF、在单独窗口打开。（已完成）
- 单封邮件切换浅色或深色背景，7 档字号。（已完成）
- 追踪器拦截：维护一份追踪像素域名清单（Mimestream 覆盖 75 个以上的服务）。（已完成）
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
- 列表分页、更早邮件回填、按标签的缓存窗口。（附件下载已在切片 2 完成）

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
