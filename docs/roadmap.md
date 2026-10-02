# 路线图：对齐 Mimestream，再做手机端

目标：桌面端具备 Mimestream 的全部功能，同时支持个人 Outlook；之后出 iOS/Android 版，和桌面共用 core。

Mimestream 功能清单来自 mimestream.com 的用户指南、FAQ、Trust Center 和更新日志，2026-09-29 查的。Mimestream 不公开它申请的 OAuth scope，下文的 scope 按 Gmail API 和 Graph 文档推断。

## AI 进度（2026-10-03）

slice 31 已实现账户级第三方文本授权、钥匙串 API 密钥、Anthropic 流式摘要与缓存、可取消请求、逐账户自动摘要和 Cmd-J 邮件助手。助手共享 MCP 工具，修改只进待确认提议，草稿留本地。新增迁移 26，紧接 main 的真实迁移 25。OAuth scope 不变。隐私、协议、超时和缓存经 fake Model/provider、fake fetch 与临时数据库测试；未启动 Electron、未做真实模型请求。自动分拣已由 slice 34 补齐。详细边界见 [架构](architecture.md#model-端口)。

slice 31 修正：内置助手仅允许添加所属账户的 Gmail 用户标签，拒绝系统标签、移除标签及 Outlook/IMAP 文件夹移动。草稿确认展示全部收件人、模式、原邮件及完整正文；账户工具只返回必要身份字段，关闭授权即删除 AI 派生数据，截断摘要不缓存。快捷键和设置错误按平台与语言显示。回归使用 fake Model/provider、协议流和 Node DOM，未启动 Electron。

slice 34 已实现撰写 AI 的文本差异预览、接受 / 丢弃 / 撤销、选区改写和翻译，独立授权的收件箱分拣建议，以及助手本地语义检索。建议默认关闭，只在前台或接电时分批、限流生成，用户确认后走 Mailbox；需要回复以星标保存。分拣确认前重查收件箱与禁止文件夹，标签变化使旧建议失效；AI 撤销不会覆盖后续输入。迁移 29 紧接 main 的真实迁移 28，没有占位。10 个语言目录齐全；验证使用 fake Model、fake provider、本地向量和 Node DOM，未启动 Electron 或请求真实 API。

## 前提：scope 升级

scope 按切片添加。已有账户继续收发邮件，缺少新增设置权限时，只在对应设置页提示重新登录。

| 能力                   | Gmail                                          | Outlook (Graph)                |
| ---------------------- | ---------------------------------------------- | ------------------------------ |
| 读（现状）             | `gmail.readonly`                               | `Mail.Read`                    |
| 归档、标签、已读       | `gmail.modify`                                 | `Mail.ReadWrite`               |
| 发送                   | `gmail.send`（`gmail.modify` 已含草稿）        | `Mail.Send`                    |
| 过滤器、自动回复、别名 | `gmail.settings.basic`                         | `MailboxSettings.ReadWrite`    |
| 联系人补全、头像       | `contacts.readonly`、`contacts.other.readonly` | `Contacts.Read`、`People.Read` |
| 日历邀请               | `calendar.events`                              | `Calendars.ReadWrite`          |

`gmail.modify` 属于 Google 的 restricted scope。自用的未验证应用在 In production 状态下最多 100 个用户，登录时显示「未经验证」警告，不影响使用。

## 进度（2026-09-30）

阶段 0、阶段 1 已完成，阶段 2 完成了新邮件、回复、转发、附件、5 秒撤销发送。已加 `gmail.modify`、`gmail.send`、`Mail.ReadWrite`、`Mail.Send`，两个真实账户已重新授权并验证过读写和发信。

剩下的按这个顺序做，一次一个切片，每个切片从 core 到界面做完、测完再开始下一个：

1. 撰写（已完成，待真实账户验证）：草稿双向同步和自动保存、发送并归档、撤销发送时长、作为附件转发、忘带附件提醒、Markdown、模板、本地签名、按往来邮件补全联系人。
2. 阅读（已完成，待真实账户验证）：标为已读的时机、原始邮件、打印和 PDF、单独窗口、单封背景和字号、追踪器拦截、附件保存和打开、按发件人允许远程图片、会话归组和顺序。
3. 搜索与整理（已完成，待真实账户验证）：服务器端搜索和本地结果合并、搜索 token、标签和文件夹管理、前往文件夹、稍后提醒、过滤器、自动回复、Gmail 发件别名和签名同步、按账户显示 Gmail 分类。已加 `gmail.settings.basic`、`MailboxSettings.ReadWrite`。
4. 系统集成（已完成，待真实账户和安装包验证）：通知、45 秒收件箱轮询、菜单栏、Dock 未读数、`mailto:`、多窗口、深链接、三套快捷键、设置页。
5. 日历邀请和联系人（已完成，待真实账户验证）：邀请横幅、接受暂定拒绝、服务器联系人补全。已加日历和联系人 scope。
6. 发布（实现和本地包验证完成，待真实签名与账户验证）：列表窗口化和日期/ID 分页、旧邮件回填、按标签的缓存窗口、双架构打包、签名公证配置、签名后自动更新。签名需要 Apple Developer 账号。
7. 端侧媒体理解与语义搜索：图片、PDF、音视频附件的内容可搜索，全部在本机算，不上传。设计与实测见下面「切片 7」。

第 3 步已加入设置 scope，第 5 步已加入日历和联系人 scope。重新登录只在使用新增能力时需要。

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

- Gmail 签名同步已在第 3 步接上 `signatures.source`。
- Google、Outlook 服务器联系人补全已在第 5 步接入 `Mailbox.suggestContacts`；Workspace 目录留后续。
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

### 切片 6 发布：做了什么，留了什么

做了：

- 列表用日期加 ID 的 keyset 游标，不用 OFFSET。同一毫秒的邮件、关闭归组、搜索和本地草稿都用稳定顺序。排序日期进入 SQLite 索引，包含稍后提醒；每次只选一页，再读取这页的会话统计。渲染只挂载可见行和上下各 6 行，键盘可滚到未挂载的行。普通变更用一次查询刷新已加载范围，保留滚动位置和选择；主动翻页追加结果。
- 旧邮件：Gmail 页令牌、Graph 续页链接、IMAP UID 范围，按账户保存检查点。限速、暂停、失败重试和正常同步优先；滚到底或搜索旧邮件会请求回填。与现有邮件重叠时保留本地状态。「设置 > 阅读」加了旧邮件与缓存小节。
- 缓存：每账户、每标签设置正文保留期，默认 Inbox 全部、All Mail 一年、Spam/Trash 30 天，多标签取最长期限，草稿保留。过期只清正文，邮件头和附件元数据保留，FTS 触发器更新词项并保持 rowid。打开时重新取正文；附件本来就按需下载，没有持久化字节缓存。
- 打包：macOS arm64、x64 各出 DMG 和 ZIP，本地命令强制不发布。Developer ID、hardened runtime、entitlements、公证环境变量已接好；本地 ad-hoc 包不开自动更新。已签名安装在设置里把私库令牌存进系统钥匙串，窗口显示后再验证签名并启用更新。原有图标继续占位。
- 原生依赖：node:sqlite 随 Electron；keyring 两架构预编译包安装并解包到 ASAR 外，已保留主线的 sqlite-vec、ONNX 和图像解码库解包规则；Vision helper 改为双架构通用二进制。临时 `--user-data-dir` 同时隔离 Chromium 和 core 数据。
- 验证：回归测试及全部构建、lint、格式检查通过。覆盖假 provider、三家续页、暂停与重启、限流、同步优先、冷正文、FTS 和 10 万会话分页。四个安装包已生成，arm64 与 x64（Rosetta）均在临时数据目录启动；另用 500 封合成邮件检查界面，挂载 18 至 26 行，没有渲染异常。

留到后面：

- 真实账户验证：跨 90 天历史、Gmail 过期页令牌、Graph 限流、IMAP 稀疏 UID 与 UIDVALIDITY 变化、暂停后重启、离线冷正文和长列表键盘操作。
- Apple Developer 签名、公证、Gatekeeper 和测试私库自动更新，需要用户自己的凭证与正式发布产物。Intel Mac 的实际启动与钥匙串读写需另验；主线 ONNX 1.30.0 缺 macOS x64 binding，Intel 语义模型加载仍受上游限制，见发布说明。
- 用户从 `docs/design/icon-options` 选正式图标。媒体二期已合入，正式签名包中的 sqlite-vec 和 ONNX 加载仍需验证。缓存与回填使用迁移 13；真实迁移保留，已移除占位。

评审修正：FTS 只跟踪索引字段变更；媒体与语义更新触发器都忽略缓存状态切换。清理每日按日期索引运行，最近打开的正文保留 24 小时。回填下载前过滤本地及待推送 ID，落库时再检查。CLI/MCP 会话读取只读本地，桌面补取正文时逐封容错。列表补齐 listbox/option 的位置语义，媒体匹配行保留可见空间。

构建命令、环境变量和缓存规则只在 [release.md](release.md) 维护。

### 切片 7 端侧媒体理解：设计

原则：邮件和附件的内容只在本机处理，不发给任何云端模型。模型文件随 app 下载一次，之后离线可用。

**流水线。** core 加一个 `Indexer` 服务，和同步分开跑。新邮件落库后排一条派生任务（`derived_jobs` 表，只追加迁移），空闲时按批处理，接电源时才跑重任务，电池模式降速。每种媒体产出三样东西：文字、向量、定位信息。

| 媒体                 | 文字                                           | 向量                                             | 定位                           |
| -------------------- | ---------------------------------------------- | ------------------------------------------------ | ------------------------------ |
| 正文                 | 原文按段切块，约 300 字一块，块间重叠一句      | 多语言文本向量                                   | 块在正文里的起止               |
| 图片（附件、内嵌图） | OCR，长图和扫描件先切成重叠的方块再识别        | 整图和每个方块各一个图像向量                     | 方块坐标，搜到后在原图上框出来 |
| PDF                  | 有文字层直接抽文字；扫描页渲染成图片走图片流程 | 按页和按块                                       | 页码加方块坐标                 |
| 音频、视频           | 本地语音转文字，带时间戳                       | 转写文本按段切块；视频再按场景抽关键帧走图片流程 | 时间戳                         |

**端侧组件，桌面（macOS）：实测选型。** 2026-09-30 在 M3 Max、48GB、macOS 26.2 上做了独立 spike，未接入 app。完整结果和复现步骤见 [spikes/media/RESULTS.md](../spikes/media/RESULTS.md)。

| 能力             | 选型                                                    | 本机实测                                                                         |
| ---------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| OCR              | Swift CLI + Vision accurate，简繁中文及英文             | 混排 99.32%，217ms；15px 小字票据 99.55%，205ms                                  |
| 长图 OCR         | 高 1024px，重叠 128px，映射原图坐标                     | 900×5200 图匹配率 100%，3395ms；整图 99.94%，2086ms                              |
| 图像类别、相似图 | Vision 分类及 feature print                             | 分类只可靠给 document、screenshot；相似票据距离 0.180，异图 0.952 至 0.977       |
| 文字搜图片       | MobileCLIP S0，图像 fp32、文本 q8，onnxruntime-node CPU | 本地加载 255ms；整图 108 至 252ms；指定四条查询均排第 1；模型包 90.57MB          |
| 文本向量         | multilingual-e5-small q8，384 维                        | 加载 733ms；300 中文字 44ms，300 英文字符 12ms；中英检索 6/8；模型包 135.39MB    |
| 向量库           | sqlite-vec 0.1.9，node:sqlite                           | Node 24 与 Electron 44.4.5 main 均加载成功；10k×384，k=10，中位 3.43ms 和 2.71ms |
| 语音，可选       | whisper.cpp 1.9.4，多语言 base F16，Metal               | 30 秒英文 0.64 秒、中文 1.12 秒；首次 Metal 运行 25.19 秒；模型 147.95MB         |

推荐图文加文本模型包共 225.96MB，含语音共 373.91MB。Vision 用系统模型。本次试验实际下载 385.76MB，多出的 11.85MB 是淘汰的 q8 图像编码器。

实现时保留这些限制：

- MobileCLIP 全 q8 图像版的代码截图和中文机票查询未排第一，采用 fp32 图像编码器。文本输入固定补齐到 77 tokens。长图同时存整图和切片向量，避免中心裁剪丢边缘。
- E5 使用 query/passage 前缀、平均池化和归一化。短中文跨语言查询仍会错排，保留 FTS5 和 RRF，不能仅靠向量。
- Vision 类别只作辅助，不能据此生成机票或票据标签。缓存记录 Vision revision、模型版本、预处理版本。文本 384 维和图文 512 维分表。
- sqlite-vec 整数主键绑定 BigInt。Electron 加载只在独立 main 脚本验证，正式签名打包仍需测。
- base 中文转写有明显同音字错误，暂作速度候选。语音模型按需下载，中文质量要另测更大模型。

**手机端：** iOS 用 Vision 和 Core ML（MobileCLIP 有官方 Core ML 版本），Android 用 ML Kit OCR 和 ONNX Runtime Mobile。手机推理和 op-sqlite 扩展加载尚未实测。core 里 `Indexer` 只依赖两个平台接口：`Vision`（OCR、分类、图像向量）和 `Embedder`（文本向量），桌面和手机各实现一份。

**搜索。** 一次查询同时走三路：FTS5 全文（含 OCR 和转写文字）、文本向量、图文向量。用倒数排名融合（RRF）合并，结果显示命中的是正文、哪张图的哪个区域、PDF 第几页，还是音频第几秒。搜索框支持 `has:image`、`in:attachment` 这类 token。给 AI 用的 MCP `search` 工具也走这条路，模型拿到的是命中的文字块和出处，不是原图。

**验证范围。** 本机组件可运行，没有运行阻塞。样本只含合成截图、票据和系统语音，尚未验证真实附件、PDF、后台队列或手机。先接 Vision OCR、sqlite-vec 和 FTS，再接图文与文本向量。模型加载和推理都放后台，MCP 仍只返回命中文字及出处。

### 切片 7 第一阶段：做了什么，留了什么

已接入本机 OCR 和 PDF 文字搜索。向量扩展可缺省，可用时才建立预备向量表；尚未生成语义向量。

- core 的独立 `Indexer` 消费第 8 条迁移新增的 `derived_jobs`。含图片、CID 内嵌图或 PDF 的邮件落库时排队；内容变化使旧结果失效。任务有租约、续约和流水线版本，领取时累计处理次数，连续崩溃最多尝试 5 次。网络失败退回队列并退避，不消耗处理次数；认证失败暂停该账户，重新登录后继续。重复处理不会叠加结果。
- macOS 构建会编译 Swift Vision CLI。accurate OCR 识别简繁中文及英文；长图按 1024px 高、128px 重叠切片，去重并保留原图坐标、切片框和 Vision revision。JPEG 先按 EXIF 方向转正，使坐标与阅读器显示一致。临时图片只保存在私有目录，处理完删除。Vision 不可用时任务不运行。
- 图片附件与 CID 图复用 core 的附件、原始 MIME 接口。PDF.js 在可终止的 worker 中抽文字层，最长 30 秒、最多 100 页，限制输入、文本输出和堆预算，禁用 eval 及网络访问。字体、CMap 和 WASM 从随包文件读取。扫描页和超过 32MiB 的附件记录为后续处理范围。
- `derived_chunks` 与 `derived_fts` 保存文字及邮件、附件名/序号、页码、图片区域出处。原 `messages_fts` 语义不变。sqlite-vec 固定为 0.1.9，加载失败只记录警告和能力标志，不影响普通数据库连接。第 8 条迁移不依赖 vec0；加载成功后才建 384/512 维表，向量清理由代码完成，无扩展连接也能删除邮件。有能力的连接重开时清理遗留向量，派生块序号不复用。扩展加载后关闭加载权限，打包时从 ASAR 外读取扩展文件。
- 本地搜索通过 RRF 合并邮件和派生文字，支持 `has:image`、`in:attachment`。列表显示出处，阅读器打开原图并框出命中区域。MCP `search` 返回命中文字和出处，不返回图片字节。纯筛选不进入派生排名；文字检索最多取 4096 个派生候选块、1024 个邮件 ID，ID 筛选通过一个 JSON 参数传入 SQLite。
- 设置的「通用」页显示索引进度和持久化暂停开关。同步或用户活动只让后续 CPU 阶段等待，当前任务保留已下载字节。历史回填优先最新邮件，每分钟按元数据预留 32MiB 下载预算；CID 原始 MIME 限 8MiB，下载前查大小，Graph 另限制响应流。接电源且空闲时开始 OCR，断电或暂停会中止任务并重新排队。电池模式每批只处理一条 PDF 文字任务。

已验证：`pnpm build && pnpm test && pnpm exec oxlint && pnpm exec oxfmt --check .`，218 项 core 测试和 Lingui 检查通过，lint 只保留两条既有 IPC 类型断言警告。测试使用临时数据库和合成 MIME、PDF；未打开真实 OpenMail 数据。生产 Vision 适配器在合成长图上得到 113 行，无重复，框均在原图范围内。独立 Electron 44.4.5 main 验证了迁移、sqlite-vec 0.1.9、两种维度、KNN 和受限 PDF worker。

补充检查从仓库根目录运行，Vision 脚本使用 Node 24：

```sh
node apps/desktop/build/check-vision.mjs
# 下列 Electron 检查按需运行。
env -u ELECTRON_RUN_AS_NODE apps/desktop/node_modules/.bin/electron apps/desktop/build/check-media-electron.mjs
```

仍需人工验证：真实附件的识别质量、JPEG 方向与图片高亮；设置暂停/恢复、拔插电源与阅读器交互；签名安装包中的 Swift、sqlite-vec 和 PDF 资源加载。请用隔离测试账户及数据目录，先不接入真实邮件库。扫描 PDF 渲染/OCR、feature print、音视频、手机端和语义向量留待后续阶段。

### 切片 7 第二阶段：做了什么，留了什么

已接入本机语义搜索。原全文搜索保留，模型功能默认关闭。

- core 增加 `Embedder` 和图像向量端口。Node/Electron 的 ONNX Runtime 1.30.0 在独立子进程中运行，桌面使用 Electron utilityProcess，CLI/MCP 使用 Node fork；CPU 单线程、V8 堆预算 192MiB。按路线释放不再使用的 session，闲置 30 秒退出子进程。E5 small q8 使用 query/passage 前缀、按 mask 平均池化及 L2 归一化；MobileCLIP S0 使用 fp32 图像编码器和 q8 文本编码器，固定补齐至 77 tokens。推理进程禁用网络，不会补下载文件；图片先读头部尺寸，限 16MP，再解码。
- 模型开关位于「通用 → 本机索引」：首次启用后，在接电源、空闲且未暂停时下载约 226MB。仅下载 spike 选定的 Xenova ONNX 导出仓库中固定提交的文件，逐文件校验 SHA-256；这些仓库分别对应 Apple MobileCLIP 与 intfloat E5，版本、大小、许可和哈希见 `model-manifest.ts`。下载使用 Range 续传、原子改名和进程间租约；关闭开关或暂停会停止后台工作，已下载文件保留供复用。输入活动不再中断下载；单文件校验按 inode/大小/修改时间缓存，失败后退避 60 秒。邮件与查询不会进入下载请求。
- 第 10 条迁移新增独立向量任务及出处表，第 11 条新增队列优先级与租约索引。正文按约 300 字切块、重叠上一句并保留起止，每封最多生成 256 块，完整正文仍进全文索引；OCR/PDF 文字也生成 384 维向量。图片保留整图及 1024px 高、128px 重叠切片的 512 维向量。任务可恢复，版本变化重新生成，替换与删除只按本封邮件的 ID 清理旧向量，全库遗留向量清扫仅在打开数据库时执行；无 sqlite-vec 时继续使用全文搜索。
- 搜索对全文、E5、MobileCLIP 候选作三路 RRF，全文权重 2，向量各 1。账户、发件人、文件夹及附件范围在 KNN 前过滤。结果和 MCP 都保留文字、正文起止、附件、PDF 页码或图片框，不返回向量和图片字节。按 spike 的归一化向量分数校准，E5 最大 L2 距离 0.65，MobileCLIP 为 1.23；弱中文图像信号回退到文本/全文，阈值不能修正短中文语言偏差。搜索仅要求向量可用、开关开启且模型已校验，输入、同步、电池或暂停索引不阻断搜索；只读 ensure 不等待下载锁。后台仍遵守电源、暂停、空闲和共享下载预算，完成计算后只检查暂停与开关，不因新的活动丢弃结果。模型加载、进程退出和超时属于运行时故障，释放任务并退避，不消耗整批邮件的处理次数。
- 合成扫描 PDF 已单独验证：受限 worker 本地渲染，再交给 Vision OCR，文字及像素框正确。正式扫描页入队、PDF 页内浏览、手机和音视频继续留待后续；签名安装包仍需人工验证。

验证使用临时数据库、合成邮件及本机已有模型。普通检查默认跳过真实模型测试；明确设置环境变量且本地文件齐全时才运行，测试不会下载模型：

```sh
pnpm build && pnpm test && pnpm exec oxlint && pnpm exec oxfmt --check .
OPENMAIL_TEST_MODELS=1 pnpm --filter @openmail/core exec vitest run src/models.integration.test.ts
OPENMAIL_TEST_MODELS=1 env -u ELECTRON_RUN_AS_NODE apps/desktop/node_modules/.bin/electron apps/desktop/build/check-media-electron.mjs
node apps/desktop/build/check-scanned-pdf.mjs
env -u ELECTRON_RUN_AS_NODE apps/desktop/node_modules/.bin/electron apps/desktop/build/check-inference-process.mjs
```

真实模型检查已通过 E5 384 维归一化和长中文跨语言排序、MobileCLIP 512 维及长图切片。此前已验证真实离线 ONNX 推理；本次内存压力下未重跑重模型。轻量检查已验证 utilityProcess 的独立 PID 与子进程崩溃隔离。短中文跨语言排序仍沿用 spike 的限制，全文搜索仍为主要信号。本次完整检查通过 278 项测试，重模型 opt-in 测试默认跳过；类型与 Lingui 检查通过，lint 仅两条原有警告。macOS arm64 包已排除其他 ONNX Runtime 平台/架构二进制。尚需人工检查实际附件质量、首次下载与暂停/恢复界面，以及签名包中的运行库和 utilityProcess 加载。

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

### core 平台接口（slice 39 已完成）

Node 实现已集中到 `packages/core/src/platform/node/`，媒体检查脚本也从对应的 `dist/platform/node/` 入口加载适配器。`@openmail/core/portable` 的本地依赖不加载 Node 适配器；桌面、CLI、MCP 保留原 API，并可显式使用 `@openmail/core/node` 与 `NodeLayer`。导入守卫和 oxlint 防止平台依赖回流。迁移、OAuth scope、队列与策略未改。

### 手机基础（slice 41 已完成）

`apps/mobile` 已接入 pnpm/turbo，使用稳定 Expo SDK 57、TypeScript、expo-router 和隔离依赖安装。根 `build` 只编译手机 Lingui 目录并检查类型，不运行原生构建。开发与验证入口见[手机端说明](../apps/mobile/README.md)。

已实现：

- op-sqlite 18.2.5 的 Effect `SqlClient` adapter，运行全部原有迁移；启用 FTS5、启动探测 trigram，单连接串行事务与 savepoints。向量扩展报告不可用。
- expo-secure-store、沙箱文件/路径、expo-crypto 和 fetch HttpClient；原生 UI 只调用 portable Mailbox，token HTTP 与 SQL 留在 core。
- AuthSession 系统浏览器、PKCE S256 与 state。独立手机 client ID 来自 app config/env，Outlook 仅 `consumers`。注册步骤见 [Google](setup-google.md#手机端)、[Microsoft](setup-microsoft.md#手机端)。
- 账户、添加 Gmail/Outlook、邮箱、keyset 分页会话、消息文本阅读、受限 HTML WebView 和下拉刷新；Lingui 包含桌面的全部十种语言。
- Gmail/Outlook 复用 portable fetch provider，PostalMime 解析原始 MIME；IMAP/SMTP 明确返回不支持。
- 原生服务 mocks、通过 Node SQLite shim 的原有迁移/FTS/事务/分页测试，以及类型检查。安装时间记录与验证边界见手机端说明。

下一步：

1. 真机开发构建验证 op-sqlite/FTS5/WAL、Metro 软链接、两家 OAuth、Android 自定义 scheme 与大邮箱分页。本切片未启动模拟器、Metro 或 EAS，未实测真实授权。
2. 补发送和附件界面、便携 MIME composer、附件缓存、离线错误、前后台生命周期及后台刷新。PDF、固定地址图片传输、端侧推理、数据库恢复仍需适配；当前返回明确失败，不能用普通 fetch 替代固定地址 `ImageNetwork`。
3. IMAP/SMTP 需独立移动实现；推送先决定中转服务。本切片没有推送或自动轮询。

接口和逐文件依赖见[架构的 Platform 端口](architecture.md#platform-端口给手机留的接缝)及[平台依赖清单](platform-inventory.md)。源码边界规则仍只定义在 AGENTS.md。

### 推送

不架服务器的话，iOS 只能靠 BGAppRefreshTask 后台刷新，间隔由系统决定，从十几分钟到几小时不等。要即时推送，需要一个中转服务：Gmail watch 或 Graph 订阅事件进来，中转服务发 APNs / FCM，只传账户和 history ID，不经手 token 和邮件内容。Mimestream 的 Private Push 就是这个结构。

这是本地优先原则下唯一要引入服务器的地方，做之前要决定。

### 界面

手机端单栏：账户和邮箱列表、邮件列表、会话三层导航。左右滑动做归档、删除、标为未读，方向可设置。视觉规格沿用 `docs/design/index.html`。

### 切片 3 搜索与整理：做了什么，留了什么

做了：

- 搜索：本地 FTS 先显示，服务器请求延迟 350 毫秒启动。Gmail 用 `q`，Graph 用 `$search`，IMAP 用 SEARCH 后取 MIME。结果经 `upsertMessage` 落库，按账户和会话去重；关闭会话归组时按消息去重。可搜全部邮件或当前文件夹，界面显示服务器搜索进度、失败和结果截断。一个账户失败时仍保留其他账户和本地结果。
- 搜索 token：Base UI Combobox chips。支持 `from:`、`to:`、`label:` / `folder:`、`is:unread` / `starred` / `important`、`has:attachment`、`filename:`、`before:`、`after:`，带空格的值可加双引号。core 解析同一套条件，分别编译到 SQLite、Gmail、Graph 和 IMAP。日期按 UTC 零点解释，Gmail 转成 epoch 秒，避免 Gmail 日期默认时区造成差异。
- 标签和文件夹：在「设置 > 整理」创建、重命名、删除、选颜色、显示或隐藏、收藏。Gmail 改 labels API；Graph 支持 childFolders，空文件夹也显示，创建和重命名立即采用服务器返回的 ID / 名称，在列表追上前保留最近改动；IMAP 使用 CREATE / RENAME / DELETE 并保留服务器分隔符。Graph 和 IMAP 的颜色只存在本机。删除服务器文件夹需确认，Gmail 删除标签不会删除邮件。
- 前往文件夹：⇧⌘G 打开，支持模糊匹配、上下键和 Enter，可访问隐藏的文件夹。
- 稍后提醒：3 小时后、明天 9 点、下周 9 点或自选时间。按账户和会话持久化，本地移出收件箱，不向 Gmail 请求 snooze。同步和新回复不会把它提前放回。到期回到收件箱顶部并标未读，未读和移回收件箱操作经队列推送，失败保留本地唤醒状态。只记录当时在收件箱中的邮件；Gmail 自寄邮件同时带 INBOX 和 SENT 时也可稍后提醒，保留 SENT。不改只有 SENT 的回复，也不改 Drafts、Trash 或 Spam。桌面运行时每 30 秒检查，启动同步也检查；读取列表不唤醒或推送；关闭 app 后到期的提醒在下次打开时处理。
- 过滤器：Gmail settings.filters 和 Outlook inbox messageRules 的列表、创建和删除。会话工具栏和右键菜单可按发件人预填，在表单内实时预览最多 200 封匹配邮件，Gmail 查询交给服务器，Outlook 用本地预览；带自由查询的删除过滤器需确认。创建后只处理服务器上的新邮件。支持发件人、收件人、主题、附件条件，Gmail 还支持查询；可归档、标已读、加标签或移到文件夹、删除，Gmail 可加星。
- 自动回复：读取现有设置，修改开关、起止时间、正文和仅回复联系人。Gmail 可改主题并保留已有 HTML 正文；Graph 保留独立内部正文和外部回复的关闭、仅联系人、所有人三种状态，由服务器决定主题，定时必须同时填开始和结束。Graph 的 Windows / IANA 时区用 CLDR 映射和 Intl 转换，写回 UTC。
- Gmail 别名与签名：正常同步时尝试读取 sendAs，也可在「设置 > 服务器」手动刷新。只缓存已验证别名，撰写的 From 菜单可选，回复仍留在原账户。发信前 core 校验地址归属，Gmail MIME 使用所选地址。签名转换为纯文本，写进 `signatures` 的 `source='gmail'`；同一地址有本地签名时，本地优先。换地址时更新签名，草稿保存所选地址。
- Gmail 分类：每账户单独开关，存在 `account_organization`，组合分类视图只列开启分类的 Gmail 账户。
- 迁移 7：新增 `label_preferences`、`account_organization`、`thread_reminders`、`send_as`、`snoozed_messages` 和到期时间索引。`snoozed_messages` 记下提醒时在收件箱里的消息，唤醒只恢复这些消息，保留自寄邮件的 SENT，不动只有 SENT 的回复、草稿、垃圾箱和垃圾邮件。已有迁移未修改，消息仍只用 `upsertMessage` 写入，FTS rowid 不变。
- 权限：OAuth 新增 `gmail.settings.basic` 和 `MailboxSettings.ReadWrite`。设置 API 的权限不足返回 `SettingsScopeMissing`，不改整个账户的 `needsReauth`。MCP 没有新增写工具。

范围与待验证：

- 每次搜索每账户最多取 200 个匹配消息；core 调用最多 1000。Graph `$search` 本身最多 1000 条，IMAP 的 MIME 后筛选最多检查 1000 封。截断时提示缩小条件，继续翻页和后台搜索回填留后续。
- Gmail 的其他高级 `q` 运算符交给服务器，本地 FTS 和过滤器预览只理解上述公共 token。Graph 和 IMAP 的附件、未读、星标等部分条件需要取回后筛选，各家分词和匹配范围可能不同。
- 过滤器不编辑现有规则，不做转发、例外、大小条件或批量应用到历史邮件。IMAP 没有通用的过滤器或自动回复 API，这些屏幕仅列 Gmail 和 Outlook。
- Gmail 签名同步到本机的纯文本版本，不修改服务器签名或别名，也不保留签名 HTML。
- 真实账户验证：旧授权仍能同步和收发；设置页重新登录后可用；搜索冷缓存邮件及文件夹范围；三家空文件夹和嵌套文件夹创建、重命名和删除；Gmail 标签颜色；关闭 app 后到期提醒、新回复和离线重试；过滤器新邮件命中；自动回复的时区和联系人限制；已验证别名发信、草稿恢复、签名切换；分类开关和组合视图。

协议依据：[Gmail filters](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.settings.filters)、[Graph search](https://learn.microsoft.com/en-us/graph/search-query-parameter)、[Graph automatic replies](https://learn.microsoft.com/en-us/graph/api/resources/automaticrepliessetting?view=graph-rest-1.0)。

### 切片 4 系统集成：做了什么，留了什么

做了：

- 通知：每账户选「主要」「收件箱」或关闭。「主要」排除 Gmail 的社交、推广、动态、论坛，Outlook 和 IMAP 按收件箱处理。core 在落库后报告首次见到、时间不早于账户上次同步的未读收件箱邮件；已读、已缓存、重复拉取的邮件不通知；IMAP 移动换 UID 时按内容指纹去重。首次完整同步静默，中途保存了游标但尚未完成、退出后继续同步，也保持静默。
- 通知动作：每批超过 5 封时汇总为一条通知，点击打开该批邮件；单封通知的归档、删除以 `user:app` 走本地修改、队列、provider、审计。macOS 安装包设置 alert 样式，通知用邮件深链接作 id；重启后从通知中心恢复点击和动作监听。系统通知权限和签名要求见 [Electron 通知文档](https://www.electronjs.org/docs/latest/api/structures/notification-action)。
- 轮询：只有桌面端拉收件箱：接电每 45 秒，电池每 90 秒；离线失败按账户指数退避，最长 15 分钟，成功完整同步后恢复。完整同步仍每 2 分钟。Gmail 限定 INBOX history，Outlook 只取 Inbox delta，IMAP 只打开 INBOX；不读取标签列表或服务器签名。轮询独立保存游标，不推进完整同步游标；移动、删除和文件夹重置由完整同步处理。两种拉取互斥，已有拉取运行时跳过本次轮询。没有邮件变化或轮询错误变化时不发 Changed；轮询错误单独保存，不清除完整同步错误，应用菜单只在语言或键位变化时重建。
- 菜单栏与 Dock：菜单栏列最近 10 个未读收件箱会话，点击打开；Dock 通过 `setBadgeCount` 显示未读收件箱邮件数。都按最近获得焦点的主窗口空间筛账户，空空间显示 0，多窗口切换会恢复各自的空间。
- 空间：⌃⌘1…9 按空间排列切换，保留原来的 ⌃1 总览、⌃2 全部账户。每空间可设每日静音时段，未分组账户单独设置。按本机时区，支持跨午夜；起止相同表示全天静音，静音邮件不补发通知。
- 系统链接：安装包声明 `mailto:` 和 `openmail:`，设置中可设为默认邮件客户端。`mailto:` 的收件人、抄送、密送、主题、正文进入新草稿并保存，不发送；保留地址里的加号，拒绝邮件头换行注入。会话菜单可「复制邮件链接」，`openmail://message/<编码后的本地邮件 id>` 打开并选择对应会话。启动前收到的链接和渲染进程尚未订阅时的链接会暂存；正在编辑草稿或对话框时，链接等待关闭；菜单命令直接丢弃，不在关闭后补执行。
- 窗口：菜单中的「新建窗口」和 ⇧⌘N 新建主窗口，各窗口有自己的选择、搜索和空间。现有会话窗口保留。打包版主进程先拿单实例锁，第二个进程在打开数据库前退出，把链接转交已有实例；开发版不抢共享锁，设置中也禁止注册默认邮件客户端。
- 快捷键与设置：Mimestream、Gmail、Apple Mail 三套键位存在一份中央 keymap，主窗口、会话窗口、撰写、原生菜单、工具提示和 ? 帮助表共用。支持范围按 app 已有动作，参考 [Mimestream 键位表](https://mimestream.com/help/user-guide/keyboard-shortcuts)；⇧⌘N 固定用于新窗口，手动同步在 Mimestream / Apple Mail 下用 ⌃⌘R。设置改成侧栏分区，新增通知、快捷键和签名独立页；账户、阅读、撰写、整理、服务器、AI、操作记录继续可用。渲染层文字仍走 Lingui，中英文目录已同步。
- 存储与验证：配置留在 `prefs`。迁移 10 新增 `seen_incoming` 和 `incoming_state`，从旧 prefs 搬入去重身份、游标和首次同步标记并清除旧键；两表随账户删除级联清理。Upsert 判断缓存是否已有邮件只查 SELECT 1，不解码正文。MCP 工具和邮件 iframe 安全设置未改。测试覆盖三家轻量拉取、首次同步与去重、静音、动作与审计、链接解析、启动转交、独立窗口空间和三套键位；用临时数据和假账户检查了设置、mailto 草稿、深链接及两窗口不同选择，没有连接真实账户。

- 合并验证：保留切片 5 的邀请与联系人、切片 7 的媒体搜索与 Vision 配置。媒体索引设置位于「通用」，联系人设置位于「服务器」。阅读区不足 900px 时把会话操作收进菜单，保留标签入口；搜索框和范围选择始终可用。隔离 Electron 验证中英文共 12 个宽度案例（360–1040px）、搜索快捷键、多 token 换行、标签子菜单、邀请横幅和两项设置，渲染器无错误。

- 修复复测：覆盖迁移、prefs 不增长、消息存在查询不解码、删除再添加账户、空轮询、错误保留与恢复、离线退避、电池降频、补拉旧邮件、通知汇总和忙碌菜单命令。960px 假账户窗口中，图片提示按钮移到文字下方，宽营销邮件在 iframe 内水平滚动；sandbox 和远程资源 CSP 不变。开发版默认客户端按钮禁用并说明原因。

留到人工验证：

- 三家真实账户的新邮件轮询、首次同步与重复拉取静默、Gmail 分类切换、跨午夜静音，以及通知归档 / 删除后的服务器状态与离线重试。
- 签名安装包的通知权限、归档与悬停附加的删除按钮、重启后的通知动作、菜单栏高清图标、Dock 数字随窗口和空间切换。
- 安装后的默认客户端按钮，浏览器或其他 app 发起的 `mailto:` / `openmail:` 冷启动与二次启动，以及中文、加号地址和多收件人。
- 深链接只引用本机缓存的邮件；缓存中没有该邮件时提示错误，不做跨设备定位或服务器回填。app 完全退出时不轮询，关闭最后一扇窗口时 macOS 继续运行。

### 切片 5 日历与联系人：做了什么，留了什么

做了：

- 日历：core 用 ical.js 解析原始 MIME 中的 `text/calendar` 和 `.ics`，支持 REQUEST、CANCEL、REPLY、折行和转义、全天、浮动时间、IANA / Windows 时区、邮件自带 VTIMEZONE、重复规则和 RECURRENCE-ID。Reader 横幅列出标题、本地时间与组织者时区、地点、组织者、参与者和重复摘要；未知时区显示原始时间，全天结束日按 DTEND 排他规则换算。
- 响应：接受、暂定、拒绝都只由用户点击触发。Gmail 按 iCalUID 查主日历，用 `attendeesOmitted` 只 PATCH 本人状态，`sendUpdates=all`。重复实例按 originalStartTime 定位，移动后的开始时间不会选错实例。Outlook 从 eventMessage 取关联事件，再 POST accept / tentativelyAccept / decline，`sendResponse=true`；普通 `.ics` 附件按 iCalUId 查事件。不存在、取消、组织者不符或无法唯一定位时不写。响应前重新取 MIME，账户不是受邀者、同一缓存会话已有更新或取消时拒绝响应。
- IMAP：走现有 `perform(send)` 管线发送 iTIP REPLY 邮件。保留 UID、SEQUENCE、RECURRENCE-ID、时间和 VTIMEZONE，通过 MailComposer `icalEvent` 生成 `text/calendar; method=REPLY` alternative part，只带匹配到的本人 attendee 和 PARTSTAT，收件人只有组织者。IMAP 按已配置账户、登录地址和 send-as 地址匹配受邀者，回信使用原始 attendee 地址；云端账户由 provider 判断别名归属。IMAP 组织者与 MIME From / Sender 不匹配时警示，响应按钮显示收件地址。邮件发送和日历响应都记审计。读取、同步、MCP 不响应邀请，没有新增 MCP 写工具。
- 联系人：Gmail 分页读取 People connections 和 otherContacts，Outlook 分页读取 `/me/contacts` 和 `/me/people`。地址小写去重，优先保存的联系人姓名，与本地往来地址一起排序；To、Cc、Bcc 沿用原补全入口。隐藏地址、发件地址排除和数量限制同时适用于两种来源。补全只查本地，离线可用。
- 刷新：桌面邮件同步检查联系人刷新时间，成功后 6 小时更新，失败后 1 小时再试；手动刷新和重新授权立即尝试。必需来源的全部页面成功才在事务内替换缓存，失败保留旧缓存。缺少 Google otherContacts 的可选权限时仍缓存已保存联系人；服务器联系人只加 0.2 的常量权重，同一地址在多个账户中不累加。登录完成后在后台刷新联系人，不等分页结束。在「设置 > 服务器」增加联系人数量、刷新时间、手动刷新和缺权限重新登录入口。账户删除会级联删除缓存。
- 权限：OAuth 新增 `calendar.events`、`contacts.readonly`、`contacts.other.readonly`、`Calendars.ReadWrite`、`Contacts.Read`、`People.Read`。缺权限返回带 calendar / contacts 标记的 `FeatureScopeMissing`，只影响该能力，不设置账户 `needsReauth`。官方 API 和 scope 设置见 [setup-google.md](setup-google.md) 与 [setup-microsoft.md](setup-microsoft.md)。
- 迁移：追加第 8 条占位以给并行切片 7 留编号，第 9 条新增 server_contacts、contact_sync 和 calendar_hint。合并时需合入切片 7 的第 8 条迁移。已有迁移未改，消息仍经 upsertMessage，FTS rowid 保持稳定。
- 验证：假 HTTP 覆盖两家分页、scope 错误和响应路径；临时数据库覆盖旧版本升级、FTS、缓存重开、去重隐藏和级联删除。另测 MIME 编码、时区、重复实例、三种 iTIP 响应、禁止自动响应和旧邀请保护。完整检查通过，226 项测试通过，lint 仅原有两条警告。隔离 Electron 假 RPC 验证邀请、响应状态、缺权限提示、取消与回复横幅、联系人设置小节，并验证旧普通邮件不请求邀请原文、云端别名可响应、IMAP 警示与响应收件地址，渲染器无错误。

范围与待验证：

- 无冲突检测，不建独立日历视图，不自动创建找不到的事件。Gmail 目前只查 primary 日历；Outlook 普通 `.ics` 的重复实例若无关联 eventMessage，需在日历中处理，避免响应整个系列。
- 邀请 MIME 在展开邮件时从服务器读取，短期缓存在 Reader 查询中；联系人缓存持久化。离线未缓存的邀请横幅读取会失败。新版同步记录 calendar_hint，普通邮件不额外下载原始 MIME；第 9 条迁移按附件信息回填旧缓存标记；旧邮件没有日历证据时不请求原始 MIME。每个 ICS 上限 1 MiB，每封邮件最多解析 20 个邀请，并按 MIME 声明的字符集解码。
- 重复摘要显示频率、间隔和次数，展开可看 RRULE、RDATE、EXDATE 原文。只阻止同一已缓存会话中的更新或取消，跨会话或未同步的 IMAP 取消无法预知。未做 Workspace 目录、macOS 通讯录、头像和联系人编辑。
- 真实账户手动验证：旧授权仍可同步、收发和本地补全；新增能力缺权限的提示及重新登录；Gmail / Outlook 的接受、暂定、拒绝是否通知组织者，重复实例是否只改该次；IMAP 组织者是否识别 REPLY；跨夏令时、全天、未知时区和取消横幅；大量联系人分页、删除后的缓存刷新及隐藏地址恢复。仅使用用户自己的 OAuth client，Outlook 仍限 consumers 租户。
