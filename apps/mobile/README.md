# 手机端开发

`apps/mobile` 是 Expo SDK 57、React Native 0.86.3、TypeScript 和 expo-router 项目。界面只调用 `@openmail/core/portable` 的 Mailbox；SQL、迁移、provider HTTP 和 token 交换留在 core。OS 适配器在 `src/platform`，结构化 op-sqlite adapter 在 `packages/core/src/platform/react-native`，core 不依赖 React Native。

## 本地检查

从仓库根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm build
OPENMAIL_LOW_MEMORY_TESTS=1 pnpm test
pnpm exec oxlint
pnpm exec oxfmt --check .
```

手机端的 `build` 只编译 Lingui 目录和检查 TypeScript，不生成 iOS/Android 项目，不启动 Metro。测试使用 Vitest、Expo/RN mocks 和 Node SQLite shim。`pnpm check-types` 也包含手机端。pnpm 保留隔离安装；Expo Metro 自动发现 workspace 和 core 的真实软链接路径，autolinking 选择手机端的 React/native 依赖。`metro.config.cjs` 拒绝桌面 core 入口。不要把 workspace 改为 hoisted。

## 数据库

锁定 `@op-engineering/op-sqlite` 18.2.5，发布包 `cpp/sqlite3.h` 中 SQLite 是 3.53.4。`package.json` 的 `op-sqlite.fts5=true` 开启编译选项，`iosSqlite=false` 使用打包版本。FTS5 trigram 最低需要 SQLite 3.34.0；启动时创建临时 trigram 表验证实际原生构建，再启用 WAL 并运行 core 的全部迁移，见 [db/migrations.ts](../../packages/core/src/db/migrations.ts)。缺少 tokenizer 就停止启动。向量能力报告 `vectors=false`。

Effect `SqlClient` 使用同一连接、SQLite compiler、`BEGIN IMMEDIATE`、savepoints 和 semaphore。异步语句完成后才释放连接，避免取消请求时遗留写入。测试通过真实 Node SQLite 模拟 op-sqlite Promise/result API，覆盖迁移幂等、FTS 完整性、upsert rowid、分页、事务回滚、COMMIT 失败恢复及并发串行化。shim 不能证明原生 JSI、WAL、设备存储或锁行为，后续需用开发构建验证。

数据库启动经 core 的 `MobileDatabaseRecovery` Effect service，在迁移前用只读 op-sqlite 连接执行 `PRAGMA quick_check`。前台 inspect 的结果传给 open，同一进程复用成功检查；前台 quick_check 的结果与实际检查时间保存于 `mail.db.foreground-check.json`。冷 headless 启动仅复用 30 分钟内的成功记录，失败、过期、损坏或未来时间的记录都触发复查；后台检查不延长前台记录的时间。复用前仍检查恢复 marker、隔离副本状态和主库是否存在。新进程第一次进入前台仍做实际检查。完整性失败显示恢复页，用户点“重建本地数据库”后才恢复；磁盘、权限或锁错误只停止启动，不当作损坏重置。前台和 headless Mailbox 共用进程内恢复门，存在打开连接时拒绝安装新库，后台不自动恢复。

恢复先通过 Expo `File.copy()` 保留主库、WAL、SHM 和 journal，全部复制完成后写隔离副本元数据，再迁移独立新库，按桌面同一用户表清单抢救可读记录。失败重试复用该完整副本，避免重复占用整库空间；新一代原库损坏时才重新复制。重建入口按显式保护对象、当前原库最新的完整 preserved 副本、旧报告引用、其他完整副本排序，安装后始终直接保护当前报告指定的原库副本，即使其元数据丢失或不完整。主库仍存在时删除未完成的复制文件；主库已丢失且没有完整副本时，才保留一个未分类的隔离主文件供抢救。不可读的可选父记录可置空，仍复制的记录不计入跳过数；不能保留的记录才计入跳过数；账户、草稿、偏好和队列尽量保留，SecureStore 不变。缓存、FTS 和向量表不复制；同步游标、同步时间和错误清空，用户继续后由原有前台 provider 全量同步重建。整库无法读取时得到空账户列表，需要重新添加账户；原库保留在持久 mail 目录的 `mail.db.corrupt-*`。

安装前先写同目录临时文件，再 rename 为 `mail.db.recovery-state.json`，新库关闭为 DELETE journal 模式后才替换主库。Expo move 默认不覆盖现有文件，先删旧路径再移动，期间所有 openers 被 marker 阻止。中断后的恢复页可继续已准备的新库；新库已移动时先验证主库再完成。恢复结果保存在 `mail.db.recovered.json`，显示复制／跳过数，Android 另显示原库文件名，iOS 不显示不可访问的文件名；用户继续后将报告标为已读，保留其备份引用供后续清理保护；提交下一份完整副本后才允许替换该保护对象。准备失败清除未完成的新库和 sidecars，保留原库或隔离副本；移除主库后 rename 失败则保留已验证的新库与 marker，下次启动继续安装；进程中断留下的有效 marker 可继续安装。marker 撕裂、不可读或替换库真正完整性失败时只删除 marker，保留其他文件并回到 corrupt，用户可再次重建。替换库的瞬时打开／读取错误返回 unavailable，保留 marker 和替换库供重试。重试时才清理失效的新库；主库已丢失时从隔离副本抢救。无有效 marker 的准备文件不会作为主库打开。文件层没有 fsync 或跨进程锁保证，unit tests 不能证明掉电持久性、原生 WAL 或设备锁行为。

恢复只使用安装版本提供的 `open({name, location, readOnly})`、`execute`、`close` 和 Expo `File.copy()`／`File.move()`，没有假设 op-sqlite backup API。依据：[op-sqlite API](https://op-engineering.github.io/op-sqlite/docs/api/)、[Expo FileSystem](https://docs.expo.dev/versions/latest/sdk/filesystem/)。SQLite shim 在 `packages/core/test-support`，不进入 core build。文件故障 mocks 覆盖重复失败的空间控制、原子 marker、损坏 marker／替换库回退、进程检查缓存及后台过期／失败复查，另覆盖记录抢救、隔离复制、中断重试、连接门及 provider 重同步。

依据：[op-sqlite 安装与 FTS5 配置](https://op-engineering.github.io/op-sqlite/docs/installation/)、[SQLite 3.34.0](https://www.sqlite.org/releaselog/3_34_0.html)。

## 客户端配置

只使用自己注册的手机客户端，不填 secret。步骤分别见 [Google](../../docs/setup-google.md#mobile) 和 [Microsoft](../../docs/setup-microsoft.md#mobile)。配置项如下：

| 环境变量                                 | 内容                                                          |
| ---------------------------------------- | ------------------------------------------------------------- |
| `OPENMAIL_IOS_BUNDLE_ID`                 | iOS bundle ID，默认 `com.openmail.mobile`                     |
| `OPENMAIL_ANDROID_PACKAGE`               | Android package name，默认 `com.openmail.mobile`              |
| `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`       | 自己注册的 Google iOS client ID                               |
| `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`   | 自己注册的 Google Android client ID                           |
| `EXPO_PUBLIC_MICROSOFT_CLIENT_ID`        | 自己注册的 Microsoft 公共客户端 ID                            |
| `EXPO_PUBLIC_MICROSOFT_ANDROID_REDIRECT` | Azure 给出的完整 `msauth://<package>/<encoded-signature>` URI |

`app.config.ts` 生成 Google 反向 client ID scheme、iOS `msauth.<bundle>://auth` 和 Android intent filter。环境变量里的 client ID 是公开注册信息，refresh token 不进入配置、数据库或日志，只经 expo-secure-store 保存到设备安全存储。卸载 Android 应用会删除安全存储；iOS Keychain 的卸载保留行为由系统决定。

OAuth 使用系统浏览器、PKCE S256、随机 state、五分钟超时和原生 scheme 回调。token 交换经 fetch HttpClient；错误正文不返回界面。Outlook 只用 `consumers`。Expo Go 无法提供自定义原生模块和这些回调，后续测试须创建开发构建；真实授权、模拟器、Metro 或 EAS 仍需开发构建验收。

## 邮件操作

界面保持单列，按账户／邮箱、会话列表、阅读三层导航；撰写用独立 modal，设置从账户页进入。

- 整理复用 `mailbox.organize` 的 `modifyWithUndo`、`snoozeWithUndo` 和 `undoBatch`：归档、垃圾桶、已读／未读、星标、Gmail 标签／Outlook 移动、稍后提醒。支持多选、长按菜单和 VoiceOver actions。左右短滑 60pt、长滑 180pt，在设置中分别配置；竖向滚动和拖回起点不执行操作。
- 撰写支持新邮件、回复、全部回复和转发，收件人建议只查 core 的本地联系人。选中文本后可加粗、斜体，支持项目列表；未选中文本时应用到全文。重开草稿从清洗后的 HTML 恢复样式范围与列表，首次编辑保留格式。HTML 与消息文本经桌面同一 compose sanitizer 归一化。转发附件由 core 获取。
- 文件来自 document picker，照片来自系统照片库；不请求相机权限。照片先解码并重编码为 JPEG，PNG 保留透明度并重编码为 PNG，去掉原文件的 EXIF／GPS 后再读取 base64；关闭 picker 的 exif 返回值不能代替文件重编码。文件只保存于设备数据库，读完、失败或超限后均在 finally 删除 picker 和重编码的缓存副本，不删除照片库原件。已有附件与新增附件合计上限 15 MiB；入队前复用 core 的 attachmentProblem 检查 Gmail 禁止附件及 Outlook 3 MiB 上限。旧队列里的验证失败显示“发送前被拒绝”，不标为投递不确定。portable MIME 仍有 25 MiB 总量限制。
- 只有实际编辑后才每 600ms 自动保存，写入串行，离开时保存最后一次编辑；未完成的收件人输入也能保存。打开新邮件／回复／转发而未编辑不会创建草稿；邮箱页的草稿入口查询 core 的 drafts mailbox，撰写页可丢弃草稿及待发送意图。沿用 core 草稿队列，手机 Layer 的 `localDraftQueue` 阻止服务器草稿推送，附件在明确发送前不上传。数据库位于持久目录，系统清空缓存不会删除本地草稿或待发送邮件。
- 发送先人工确认，再按共享偏好等待 0／5／10／20／30 秒。发送意图持久保存在既有 prefs 表的保留键中，无新增迁移；交付复用 core 的 user/app 发送校验与审计。撤销会保留草稿。离线时保持待发送，下次前台或下拉刷新再处理。
- 发件箱区分明确失败与结果不确定。明确失败可通过“重试发送”打开保留草稿；不确定结果须先检查已发送，不能自动重发。事务、重启与重发保护的完整规则见[同步说明](../../docs/sync-correctness.md#持久发送意图)。
- 搜索复用 Gmail 操作符 parser。本地无结果时回退到服务器，也可主动搜索服务器；显示回退提示及错误、截断或忽略操作符的提示。
- 设置包含账户添加、重新登录、启用／停用、移除，四种滑动动作、撤销发送时间、远程图片默认值和语言。远程图片默认阻断；主动开启后仅允许图片 HTTPS，脚本、表单、字体与导航限制继续生效。
- Lingui 包含 en、zh-CN、cs、nl、fr、de、it、ja、ru、es。相同文案复用桌面译文，消息文本字段保留提取注释。修改后执行 `pnpm --filter @openmail/mobile i18n:extract`、补齐译文，再执行 `i18n:compile`。测试检查目录同步与漏译。

## 前后台同步与原生权限

初次进入前台、从后台返回和下拉刷新运行 core 同步。后台刷新默认关闭，设置中可开启；expo-background-task 通过 iOS BGAppRefreshTask／Android WorkManager 调度，最小间隔 15 分钟只是调度提示，执行时间由 OS 决定，并非实时。后台共享 portable Mailbox 的 Inbox 增量命令，约 25 秒总预算，逐账户分配时间；未完成首次同步、缺失或过期游标、IMAP UIDVALIDITY 变化均留待前台处理，不全量同步、不回填、不发送或推送整理队列。自定义 `index.js` 先导入后台任务，再导入 Router；headless 启动不依赖路由加载。iOS 检查 NWPath 的 constrained／expensive 和低电量模式；Android worker 要求 unmetered network、battery-not-low，并检查省电模式，只有非计费网络才运行。Android 重启后不会重新调度，须打开应用恢复，因为 RECEIVE_BOOT_COMPLETED 被显式屏蔽。无轮询或推送中转。

本地新邮件通知按账户选择开启，默认关闭。前后台消费 core 的 NewMail 事件：首次同步、早于上次同步的邮件及已见过的移动邮件不提醒；稳定消息 ID 在现有 prefs 中保留 30 天去重，按记录时间和账户清理；旧布尔记录首次清理时获得一次 30 天保留期，已移除账户的记录删除。常规 compose.prefs 读取排除整个 mobile-background 前缀，先认领再提交 OS，进程在两者之间退出可能漏一次提醒，不重复。前台可见 Inbox 静默；同账户／会话复用通知 ID，iOS 按会话分组，Android 按账户分组。点击通知沿现有 `/reader` 路由打开会话。只显示发件人和主题，不显示消息文本；默认开启隐藏内容，通知中仅包含发件人，包括解锁后的通知，关闭后显示主题。发件人／主题先清除 C0/C1 和双向文本控制符、折叠空白，再限制为 80／120 个字符；发件人为空时回退地址，再回退本地化“新邮件”。Android 改用新 PRIVATE 通道并删除旧 PUBLIC 通道，公开锁屏版本只显示本地化“新邮件”。系统权限只在通知或徽标 opt-in 时请求，不请求远程 push token。已展示的通知由系统管理。

app icon 未读 Inbox 徽标默认关闭，沿用 core 本地未读数和会话分组偏好，未缓存邮件不计入。系统／Android launcher 可能不支持或限制徽标。徽标更新失败不撤回已保存设置，后续刷新再尝试。发送延迟只在前台处理，进入后台后不启动新的发送；已开始的传输可能继续完成。发送撤销 toast 与整理撤销 toast 分开。

Expo 的默认 background-task iOS 实现使用 BGProcessingTask，本项目依赖补丁改为 BGAppRefreshTaskRequest，plist 仅添加 `UIBackgroundModes=fetch` 与 `com.openmail.mobile.refresh` permitted identifier。notifications 补丁移除 Firebase messaging service 和启动广播，补齐两端原生分组；本地 config plugin 仅允许 POST_NOTIFICATIONS，并阻止 APNs entitlement、Firebase 服务及自动初始化。Android 继续屏蔽 RECEIVE_BOOT_COMPLETED、C2DM RECEIVE、CAMERA、RECORD_AUDIO；image-picker 关闭相机和麦克风权限。测试检查 Expo introspect、实际 autolinking 和已安装依赖源码；尚未验证真机任务唤醒、系统中止、通知点击、锁屏或徽标。

依据：[BackgroundTask](https://docs.expo.dev/versions/v57.0.0/sdk/background-task/)、[Notifications](https://docs.expo.dev/versions/v57.0.0/sdk/notifications/)、[ImagePicker](https://docs.expo.dev/versions/latest/sdk/imagepicker/)。

实现见 [background.ts](src/background.ts)、[background-policy.ts](src/background-policy.ts)、core [mobile-background.ts](../../packages/core/src/mailbox/mobile-background.ts)和 [mailbox-live.ts](../../packages/core/src/mailbox/mailbox-live.ts)。默认值与持久去重由 core 管理；原生配置见 [app.config.ts](app.config.ts)及 [plugins](plugins)。

## AI、稍后提醒与签名

AI 默认关闭，逐账户确认后才向 Anthropic 发送可见消息文本。API 密钥仅经 SecureStore 保存，界面只查询是否已配置；模型沿用 core 的选项。会话摘要支持按需生成；自动摘要仅在开启该账户的自动选项后、打开会话时生成，不在后台刷新中调用 AI。询问会话会预先装入同一可见文本管线的上下文；助手可提议归档、Gmail 用户标签和纯文本草稿，用户在手机审批页查看全部会话、真实标签及完整草稿后批准或拒绝。内置助手不看共享写权限，始终只创建提议。批准草稿后进入撰写页，发送仍须原有人工确认。

改写、缩短、友好／正式语气只处理签名和引用之前的自写消息文本，显示改写前后内容，用户接受后才修改当前草稿。签名、引用和未改部分的格式保留；接受后消息文本未变化时可撤销 AI 编辑，恢复之前的消息文本与格式。生成后草稿有变化就须重新生成。退出页面、进入后台或关闭账户授权会中断请求。AI 输入移除隐藏文本；HTML 的 CSS 检查超预算时省略消息文本并附上“消息过于复杂，无法用于 AI”的标记，避免将由 HTML 派生的纯文本误当作安全备选。搜索仍保留全文。AI 输入不包含图片、附件或附件派生内容；输出用原生 Text 显示，不自动加载链接或图片。

线程操作提供稍后提醒预设、日期／时间选择和取消提醒，Snoozed 邮箱查询共享提醒表。前台同步前、前台每 30 秒的本地计时器与已启用的后台刷新都唤醒到期提醒，前台离线时也生效；后台离线时也处理本地到期提醒，provider 写入仍留待前台同步。仅为开启该账户通知且有系统权限的账户提交本地提醒，沿用通知内容隐藏设置与会话分组；每次到期单独去重。OS 决定后台任务运行时间，不保证准点提醒。

设置可编辑每个账户用于新邮件及回复／转发的默认签名，复用共享签名库和默认值表。新撰写会话插入纯文本签名，已有草稿保留已存内容。没有新增迁移。

出站失败提示复用 core，显示操作、主题、发件人及原因；仅向拒收地址重发会打开新草稿。规则见[同步说明](../../docs/sync-correctness.md#出站操作队列)。

## 能力

| 能力             | 当前实现与边界                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gmail／Outlook   | 共享 core fetch provider、OAuth、同步、阅读、整理与确认发送；个人 Outlook 只用 consumers。                                                                                                                                                                                                                                                                                                                          |
| IMAP／SMTP       | iCloud、Yahoo、QQ、163、Fastmail、Other 设置及密码更新。共享 Mailbox 命令接入 portable 协议，原生 TCP/TLS 使用 react-native-tcp-socket 6.4.3；应用密码只存 SecureStore。993／465 使用 TLS，其他端口强制 STARTTLS。依赖补丁补齐 Android 证书主机名校验及读取线程升级同步，并补齐两端 STARTTLS 握手完成事件。                                                                                                         |
| IMAP 同步与整理  | 首次同步每文件夹最近 90 天内最多 1000 封；后续追踪 UIDVALIDITY、增量、已读、星标和删除。支持历史分页和有上限的服务器搜索，无 IDLE、服务端草稿、永久删除、过滤器或自动回复。复制进度、UID 缺失与源副本处理见[同步说明](../../docs/sync-correctness.md#imap-复制移动与草稿)。                                                                                                                                         |
| IMAP 发送        | core MIME／SMTP，发送前沿用人工确认与撤销队列；Bcc 只进信封。DATA 和 APPEND 按 64 KiB 分块并等待写入。不确定结果、重发保护及 Sent 副本缺失提示见[发送结果](../../docs/sync-correctness.md#发送结果)。                                                                                                                                                                                                               |
| 阅读附件         | Gmail／Outlook／IMAP 经 core 下载；按账户与缓存键哈希写入 `Paths.cache/openmail-attachments`，遵循共享缓存容量和清理；本进程按最近访问驱逐，重启后以文件修改时间排序，系统也可驱逐。iOS 分享面板结束即删除副本。Android 在 URI 交接后保留副本，供接收应用延迟读取；启动及分享时按 24 小时和 64 MiB 总量驱逐，分享失败立即清理。iOS 的预览／打开选项由系统分享面板和已安装应用提供。IMAP 原始 MIME 单封上限 25 MiB。 |
| 图片与链接       | 仅含 cid: 的 HTML 查询 core 图片，按消息 ID 复用下载结果，邮箱刷新保留阅读视图。远程图片默认阻断，可逐封加载，CSP 仅允许 HTTPS；WebView JS 始终关闭。移除 form、全部 meta http-equiv 和非 stylesheet link；iOS 只打开用户点击链接，Android 兼容省略 isTopFrame 的 release 事件，明确子框架仍拒绝；先显示 ASCII 域名及解码后的国际化域名供确认，CSP 禁止框架。                                                       |
| 联系人           | 撰写 To／Cc／Bcc 自动补全查询共享联系人表及本地邮件历史；已有 路径保留。                                                                                                                                                                                                                                                                                                                                            |
| 邮箱列表         | 账户内标签／文件夹的嵌套名称与共享未读数；未缓存邮件不计入本地未读数。                                                                                                                                                                                                                                                                                                                                              |
| 后台刷新         | 默认关闭；OS 控制时间，约 25 秒 Inbox 增量预算，低电量／受限网络暂停，不保证实时。                                                                                                                                                                                                                                                                                                                                  |
| 通知与徽标       | 本地通知按账户 opt-in，默认仅显示发件人；未读 Inbox 徽标单独 opt-in。无远程推送。                                                                                                                                                                                                                                                                                                                                   |
| AI               | 逐账户 opt-in 的 Anthropic 摘要、会话助手及撰写帮助；所有整理提议在 app 内审批，改写须接受。自动摘要仅在打开已授权且启用自动摘要的会话时运行；后台不调用 AI。                                                                                                                                                                                                                                                       |
| 稍后提醒         | 预设、日期／时间选择、取消提醒及 Snoozed 邮箱；同步和后台刷新唤醒，账户通知 opt-in 后提交本地通知。OS 控制执行时间。                                                                                                                                                                                                                                                                                                |
| 签名             | 共享签名库及每账户的新邮件／回复默认值，手机设置可编辑，撰写插入纯文本。                                                                                                                                                                                                                                                                                                                                            |
| 数据库恢复       | 启动 quick_check；用户确认后隔离原库、抢救可读用户记录、重建 provider 缓存。恢复页显示结果并支持中断重试。边界见上方数据库说明。                                                                                                                                                                                                                                                                                    |
| PDF 文本提取     | `PdfWorker` 明确返回 unavailable，阅读器提示不支持提取；仍可在设备上打开／分享附件，不用于搜索索引或 AI。                                                                                                                                                                                                                                                                                                           |
| 固定地址图片下载 | `ImageNetwork` 明确返回 unavailable；手机无撰写 URL 图片导入或联系人头像下载入口。阅读器远程图片沿用 shouldLoadRemote 和 HTTPS CSP。                                                                                                                                                                                                                                                                                |
| 端侧推理         | 不支持。现有 ONNX／Transformers adapter 依赖 Node 子进程，手机没有 ModelRuntime、Vision 或向量扩展 Layer。                                                                                                                                                                                                                                                                                                          |
| 文件层           | 支持沙箱内目录、读取、写入、复制、改名和删除，其他 Effect FileSystem 操作仍不支持。                                                                                                                                                                                                                                                                                                                                 |

协议和队列实现见 core [IMAP/SMTP adapter](../../packages/core/src/platform/react-native/imap.ts)、[mail-socket.ts](../../packages/core/src/platform/mail-socket.ts)，OS 接线见 [transport.ts](src/platform/transport.ts)和 [平台组装](src/platform/index.ts)。UID 重置及 COPY／删除回退的边界只在[同步说明](../../docs/sync-correctness.md)维护；重置删除保护已合入共享 core，将所有重置删除候选纳入持久续验，未验证项保留。

原生库需重新生成开发构建。自动测试使用分片协议流、SQLite 与原生 API mocks，没有连接真实邮箱；不能证明各服务商兼容性、真机 TLS、分享面板预览或 Metro 打包。依赖依据：[TCP/TLS API](https://github.com/Rapsssito/react-native-tcp-socket)、[Expo Sharing](https://docs.expo.dev/versions/latest/sdk/sharing/)。

## 媒体适配边界

现有 PDF 提取依赖 `pdfjs-dist` 6.3.289，在桌面 disposable Node worker 中运行；仓库没有已验证可在 RN／Hermes 使用的纯 JS extractor。PDF.js 的浏览器 worker／DOM 和 Node worker 不由 Hermes 提供，无法沿用桌面的 32 MiB、100 页、30 秒、128 MiB worker 内存预算与强制终止。当前 `PdfWorker` 立即返回 unavailable，不引入新原生依赖，也不上传 PDF 代为提取。若以后接入原生 worker，仍须遵守相同预算。依据：[PDF.js 示例的浏览器／Node 环境](https://mozilla.github.io/pdf.js/examples/index.html)。

桌面 `ImageNetwork` 在解析 DNS 后固定公网 IP，每次重定向重新校验，拒绝私网、凭证、异常端口和非 raster 响应，并限制流量与时间。手机没有需要此端口的界面入口，Expo／RN fetch 不能满足地址固定要求，故保留明确拒绝的 no-op。阅读器远程图片是独立路径，默认阻断，按共享 `shouldLoadRemote` 与逐封选择放行，仅在设备 WebView 直接请求 HTTPS 图片；cid 图片仍经 core 下载。图片、PDF 和媒体派生内容不发送给 AI 或第三方转换服务。

端侧推理不支持：现有实现使用 `onnxruntime-node`、Transformers 和 Node 子进程；手机没有相应原生运行时、可终止推理 worker、Vision 或 sqlite-vec Layer。`vectors=false`、索引能力 unavailable，不下载模型或回退为云端媒体推理。账户 opt-in 的 Anthropic 可见消息文本功能见上方 AI 说明。

## 尚需验证

自动测试覆盖屏幕 view-model、串行草稿、搜索／滑动／富文本、原生 picker／备份排除 mocks、两家 core 整理与发送命令、撤销、发送失败和数据库重开。未启动模拟器、Metro 或 EAS。自动测试补充 AI 授权与隐藏文本过滤、提议审批、草稿接受、共享签名和后台提醒去重；未调用真实 Anthropic API。真机仍需验证 SQLite／Metro、两家 OAuth、五家 IMAP／SMTP 及 Other 服务器、大邮箱分页、备份排除的原生属性、手势与 VoiceOver、照片／文档选择、原生日期选择、AI 请求取消与审批界面、提醒到期通知、附件投递及前后台生命周期。推送须先决定中转服务。

版本依据：[SDK 57](https://expo.dev/changelog/sdk-57)、[Expo monorepo](https://docs.expo.dev/guides/monorepos/)、[AuthSession](https://docs.expo.dev/guides/authentication/)。

## 备份与锁屏

邮件数据库、WAL、SHM、本地草稿、发送意图与 core 文件保存在 `Paths.document/openmail-data`，不使用可被系统清空的 cache。启动时优先将旧 `Paths.cache/openmail` 整目录迁移，保留 DB／WAL／SHM；没有 cache 时迁移旧 Documents/openmail。已有持久数据库时不覆盖，把残留副本移入持久目录内独立的 legacy 子目录。空目标目录可在中断后继续迁移。

iOS 本地 Expo module `modules/openmail-storage` 在移动目录前和打开数据库前同步设置并确认 `URLResourceValues.isExcludedFromBackup`；只允许三个固定 mail 目录。模块缺失或备份排除失败就停止数据库启动。需要重新生成开发构建以链接该模块；autolinking 与 Swift 语法已检查，尚未用真机验证属性继承、目录迁移和原生模块调用。Android 继续设置 `android.allowBackup=false`。阅读器使用 incognito WebView。

新建 SecureStore 项使用 `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`。已有项不会因 SecItemUpdate 自动改变可访问性；在 iOS 前台解锁后、联网检查和同步前，逐个迁移账户秘密及 core 的模型／更新密钥：先写并验证临时副本，再删除旧项、以新属性重建并验证，最后记录完成标记并清理副本。同键读写串行，失败或进程退出后可从安全副本读取，下次前台重试；不在 headless 任务中迁移。未完成迁移的旧项在锁屏时仍可能不可读。锁屏或安全存储不可用时，读取返回可重试的 `ProviderError`，不把它当作凭证撤销，不删除 token，错误不包含原生异常或密钥内容。解锁后重试。后台在首次解锁后可读凭证，继续处理重启后首次解锁前的读取失败；该可访问性设置只在 iOS 生效。

阅读器在渲染前移除全部 meta http-equiv 和非 stylesheet link，阻止自动刷新与资源预取。iOS 只将 navigationType=click 的顶层链接交给系统，Android 必须先确认真实域名与完整 URL。远程图片 CSP 只允许 HTTPS。阅读器的 CSP 在桌面资源限制上增加 `form-action 'none'` 和 `base-uri 'none'`，渲染前移除 form 子树，防止 Android POST 绕过导航回调。WebView 始终拒绝导航；通过上述点击／确认流程且不含 URL 用户名/密码的 http、https、mailto 链接才交给系统浏览器或邮件应用。OAuth 回调经 `+native-intent.tsx` 路由到账户页，code/state 仍由 AuthSession 监听和校验。

依据：[Apple 目录与备份](https://developer.apple.com/documentation/foundation/using-the-file-system-effectively)、[Android allowBackup](https://docs.expo.dev/versions/latest/config/app/#allowbackup)、[SecureStore 可访问性](https://docs.expo.dev/versions/v57.0.0/sdk/securestore/)、[Expo native intent](https://docs.expo.dev/router/advanced/native-intent/)。

本地缓存 T07：`CacheStorage` 暂用 core 的默认 no-op，返回 `disk: null`、零 WAL／恢复副本字节。手机尚未接入数据卷剩余空间查询，不触发低磁盘自动收紧；数据库页、消息文本和附件仍由现有服务计量。手机界面尚未暴露整库目标与“立即压缩”。`CacheMaintenance` 暂为 no-op，完整压缩返回 unavailable；没有 Node worker 和卷空间预检。op-sqlite 升级共用 `db/migrate.ts` 的迁移外键包装，异步原生 execute 保留迁移 37 的依赖行；Node shim 回归不替代设备验证。Node 桌面能力及测试见[性能说明](../../docs/performance.md#本地缓存管理t07)。
