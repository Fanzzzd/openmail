# 路线图：对齐 Mimestream，再做手机端

目标：桌面端具备 Mimestream 的全部功能，同时支持个人 Outlook；之后出 iOS/Android 版，和桌面共用 core。

Mimestream 功能清单来自 mimestream.com 的用户指南、FAQ、Trust Center 和更新日志，2026-09-29 查的。Mimestream 不公开它申请的 OAuth scope，下文的 scope 按 Gmail API 和 Graph 文档推断。

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
4. 系统集成：通知、菜单栏、Dock 未读数、`mailto:`、多窗口、深链接、三套快捷键、设置页。
5. 日历邀请和联系人（已完成，待真实账户验证）：邀请横幅、接受暂定拒绝、服务器联系人补全。已加日历和联系人 scope。
6. 发布：打包、签名公证、自动更新、更早邮件回填、按标签的缓存窗口。签名需要 Apple Developer 账号。
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
env -u ELECTRON_RUN_AS_NODE apps/desktop/node_modules/.bin/electron apps/desktop/build/check-media-electron.mjs
```

仍需人工验证：真实附件的识别质量、JPEG 方向与图片高亮；设置暂停/恢复、拔插电源与阅读器交互；签名安装包中的 Swift、sqlite-vec 和 PDF 资源加载。请用隔离测试账户及数据目录，先不接入真实邮件库。扫描 PDF 渲染/OCR、feature print、音视频、手机端和语义向量留待后续阶段。

### 切片 7 第二阶段：计划

1. 增加本地模型包下载、哈希校验及版本记录。采用 spike 选定的 MobileCLIP S0 图像 fp32、文本 q8，以及 multilingual-e5-small q8，限制见上面的设计与 [实测](../spikes/media/RESULTS.md)。邮件和附件仍只在本机推理。
2. 接入独立后台推理适配器。MobileCLIP 保存整图和切片的 512 维向量，文本固定补齐至 77 tokens；E5 将正文、OCR 和 PDF 文字按约 300 字切块，保留句子重叠，使用 `query:`/`passage:` 前缀、平均池化和归一化，写入 384 维表。缓存记录模型与预处理版本，复用第一阶段队列及电源控制。
3. 查询同时取 FTS、E5 和 MobileCLIP 候选，通过 RRF 合并并保留出处。短中文跨语言查询不能只靠向量；扩大中英文票据、代码、长图样本，测准确率、内存和后台响应。MCP 继续只返回文字块及出处。
4. 单独验证扫描 PDF 的本地渲染与逐页 OCR，再扩展页内区域定位。完成签名包和断网验证后再考虑手机、音视频；本阶段不实现这些能力。

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

### 切片 3 搜索与整理：做了什么，留了什么

做了：

- 搜索：本地 FTS 先显示，服务器请求延迟 350 毫秒启动。Gmail 用 `q`，Graph 用 `$search`，IMAP 用 SEARCH 后取 MIME。结果经 `upsertMessage` 落库，按账户和会话去重；关闭会话归组时按消息去重。可搜全部邮件或当前文件夹，界面显示服务器搜索进度、失败和结果截断。一个账户失败时仍保留其他账户和本地结果。
- 搜索 token：Base UI Combobox chips。支持 `from:`、`to:`、`label:` / `folder:`、`is:unread` / `starred` / `important`、`has:attachment`、`filename:`、`before:`、`after:`，带空格的值可加双引号。core 解析同一套条件，分别编译到 SQLite、Gmail、Graph 和 IMAP。日期按 UTC 零点解释，Gmail 转成 epoch 秒，避免 Gmail 日期默认时区造成差异。
- 标签和文件夹：在「设置 > 整理」创建、重命名、删除、选颜色、显示或隐藏、收藏。Gmail 改 labels API；Graph 支持 childFolders，空文件夹也显示；IMAP 使用 CREATE / RENAME / DELETE 并保留服务器分隔符。Graph 和 IMAP 的颜色只存在本机。删除服务器文件夹需确认，Gmail 删除标签不会删除邮件。
- 前往文件夹：⇧⌘G 打开，支持模糊匹配、上下键和 Enter，可访问隐藏的文件夹。
- 稍后提醒：3 小时后、明天 9 点、下周 9 点或自选时间。按账户和会话持久化，本地移出收件箱，不向 Gmail 请求 snooze。同步和新回复不会把它提前放回。到期回到收件箱顶部并标未读，未读和移回收件箱操作经队列推送，失败保留本地唤醒状态。只记录当时在收件箱中的邮件，不操作 Sent、Drafts、Trash 或 Spam。桌面运行时每 30 秒检查，启动同步也检查；读取列表不唤醒或推送；关闭 app 后到期的提醒在下次打开时处理。
- 过滤器：Gmail settings.filters 和 Outlook inbox messageRules 的列表、创建和删除。会话工具栏和右键菜单可按发件人预填，在表单内实时预览最多 200 封匹配邮件，Gmail 查询交给服务器，Outlook 用本地预览；带自由查询的删除过滤器需确认。创建后只处理服务器上的新邮件。支持发件人、收件人、主题、附件条件，Gmail 还支持查询；可归档、标已读、加标签或移到文件夹、删除，Gmail 可加星。
- 自动回复：读取现有设置，修改开关、起止时间、正文和仅回复联系人。Gmail 可改主题并保留已有 HTML 正文；Graph 保留独立内部正文和外部回复的关闭、仅联系人、所有人三种状态，由服务器决定主题，定时必须同时填开始和结束。Graph 的 Windows / IANA 时区用 CLDR 映射和 Intl 转换，写回 UTC。
- Gmail 别名与签名：正常同步时尝试读取 sendAs，也可在「设置 > 服务器」手动刷新。只缓存已验证别名，撰写的 From 菜单可选，回复仍留在原账户。发信前 core 校验地址归属，Gmail MIME 使用所选地址。签名转换为纯文本，写进 `signatures` 的 `source='gmail'`；同一地址有本地签名时，本地优先。换地址时更新签名，草稿保存所选地址。
- Gmail 分类：每账户单独开关，存在 `account_organization`，组合分类视图只列开启分类的 Gmail 账户。
- 迁移 7：新增 `label_preferences`、`account_organization`、`thread_reminders`、`send_as`、`snoozed_messages` 和到期时间索引。`snoozed_messages` 记下提醒时在收件箱里的消息，唤醒只恢复这些消息，不动已发送、草稿、垃圾箱和垃圾邮件。已有迁移未修改，消息仍只用 `upsertMessage` 写入，FTS rowid 不变。
- 权限：OAuth 新增 `gmail.settings.basic` 和 `MailboxSettings.ReadWrite`。设置 API 的权限不足返回 `SettingsScopeMissing`，不改整个账户的 `needsReauth`。MCP 没有新增写工具。

范围与待验证：

- 每次搜索每账户最多取 200 个匹配消息；core 调用最多 1000。Graph `$search` 本身最多 1000 条，IMAP 的 MIME 后筛选最多检查 1000 封。截断时提示缩小条件，继续翻页和后台搜索回填留后续。
- Gmail 的其他高级 `q` 运算符交给服务器，本地 FTS 和过滤器预览只理解上述公共 token。Graph 和 IMAP 的附件、未读、星标等部分条件需要取回后筛选，各家分词和匹配范围可能不同。
- 过滤器不编辑现有规则，不做转发、例外、大小条件或批量应用到历史邮件。IMAP 没有通用的过滤器或自动回复 API，这些屏幕仅列 Gmail 和 Outlook。
- Gmail 签名同步到本机的纯文本版本，不修改服务器签名或别名，也不保留签名 HTML。
- 真实账户验证：旧授权仍能同步和收发；设置页重新登录后可用；搜索冷缓存邮件及文件夹范围；三家空文件夹和嵌套文件夹创建、重命名和删除；Gmail 标签颜色；关闭 app 后到期提醒、新回复和离线重试；过滤器新邮件命中；自动回复的时区和联系人限制；已验证别名发信、草稿恢复、签名切换；分类开关和组合视图。

协议依据：[Gmail filters](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.settings.filters)、[Graph search](https://learn.microsoft.com/en-us/graph/search-query-parameter)、[Graph automatic replies](https://learn.microsoft.com/en-us/graph/api/resources/automaticrepliessetting?view=graph-rest-1.0)。

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
