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

本机安装记录：新增依赖首次安装 20.62 秒；热安装修改前 0.23 秒、修改后 0.22 秒。首次安装含下载和锁文件解析，这些数据不代表其他机器或网络。

## 数据库

锁定 `@op-engineering/op-sqlite` 18.2.5，发布包 `cpp/sqlite3.h` 中 SQLite 是 3.53.4。`package.json` 的 `op-sqlite.fts5=true` 开启编译选项，`iosSqlite=false` 使用打包版本。FTS5 trigram 最低需要 SQLite 3.34.0；启动时创建临时 trigram 表验证实际原生构建，再启用 WAL 并运行 core 的所有原有迁移。缺少 tokenizer 就停止启动。向量能力报告 `vectors=false`。

Effect `SqlClient` 使用同一连接、SQLite compiler、`BEGIN IMMEDIATE`、savepoints 和 semaphore。异步语句完成后才释放连接，避免取消请求时遗留写入。测试通过真实 Node SQLite 模拟 op-sqlite Promise/result API，覆盖迁移幂等、FTS 完整性、upsert rowid、分页、事务回滚、COMMIT 失败恢复及并发串行化。shim 不能证明原生 JSI、WAL、设备存储或锁行为，后续需用开发构建验证。

依据：[op-sqlite 安装与 FTS5 配置](https://op-engineering.github.io/op-sqlite/docs/installation/)、[SQLite 3.34.0](https://www.sqlite.org/releaselog/3_34_0.html)。

## 客户端配置

只使用自己注册的手机客户端，不填 secret。步骤分别见 [Google](../../docs/setup-google.md#手机端) 和 [Microsoft](../../docs/setup-microsoft.md#手机端)。配置项如下：

| 环境变量                                 | 内容                                                          |
| ---------------------------------------- | ------------------------------------------------------------- |
| `OPENMAIL_IOS_BUNDLE_ID`                 | iOS bundle ID，默认 `com.openmail.mobile`                     |
| `OPENMAIL_ANDROID_PACKAGE`               | Android package name，默认 `com.openmail.mobile`              |
| `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`       | 自己注册的 Google iOS client ID                               |
| `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`   | 自己注册的 Google Android client ID                           |
| `EXPO_PUBLIC_MICROSOFT_CLIENT_ID`        | 自己注册的 Microsoft 公共客户端 ID                            |
| `EXPO_PUBLIC_MICROSOFT_ANDROID_REDIRECT` | Azure 给出的完整 `msauth://<package>/<encoded-signature>` URI |

`app.config.ts` 生成 Google 反向 client ID scheme、iOS `msauth.<bundle>://auth` 和 Android intent filter。环境变量里的 client ID 是公开注册信息，refresh token 不进入配置、数据库或日志，只经 expo-secure-store 保存到设备安全存储。卸载 Android 应用会删除安全存储；iOS Keychain 的卸载保留行为由系统决定。

OAuth 使用系统浏览器、PKCE S256、随机 state、五分钟超时和原生 scheme 回调。token 交换经 fetch HttpClient；错误正文不返回界面。Outlook 只用 `consumers`。Expo Go 无法提供自定义原生模块和这些回调，后续测试须创建开发构建；本切片没有运行真实授权、模拟器、Metro 或 EAS。

## 邮件操作（slice 44）

界面保持单列，按账户／邮箱、会话列表、阅读三层导航；撰写用独立 modal，设置从账户页进入。

- 整理复用 `Mailbox.modifyWithUndo`、`snoozeWithUndo` 和 `undoBatch`：归档、垃圾桶、已读／未读、星标、Gmail 标签／Outlook 移动、稍后提醒。支持多选、长按菜单和 VoiceOver actions。左右短滑 60pt、长滑 180pt，在设置中分别配置；竖向滚动和拖回起点不执行操作。
- 撰写支持新邮件、回复、全部回复和转发，收件人建议只查 core 的本地联系人。选中文本后可加粗、斜体，支持项目列表；未选中文本时应用到全文。重开草稿从清洗后的 HTML 恢复样式范围与列表，首次编辑保留格式。HTML 与消息文本经桌面同一 compose sanitizer 归一化。转发附件由 core 获取。
- 文件来自 document picker，照片来自系统照片库；不请求相机权限。照片先解码并重编码为 JPEG，PNG 保留透明度并重编码为 PNG，去掉原文件的 EXIF／GPS 后再读取 base64；关闭 picker 的 exif 返回值不能代替文件重编码。文件只保存于设备数据库，读完、失败或超限后均在 finally 删除 picker 和重编码的缓存副本，不删除照片库原件。已有附件与新增附件合计上限 15 MiB；入队前复用 core 的 attachmentProblem 检查 Gmail 禁止附件及 Outlook 3 MiB 上限。旧队列里的验证失败显示“发送前被拒绝”，不标为投递不确定。portable MIME 仍有 25 MiB 总量限制。
- 只有实际编辑后才每 600ms 自动保存，写入串行，离开时保存最后一次编辑；未完成的收件人输入也能保存。打开新邮件／回复／转发而未编辑不会创建草稿；邮箱页的草稿入口查询 core 的 drafts mailbox，撰写页可丢弃草稿及待发送意图。沿用 core 草稿队列，手机 Layer 的 `localDraftQueue` 阻止服务器草稿推送，附件在明确发送前不上传。数据库位于持久目录，系统清空缓存不会删除本地草稿或待发送邮件。
- 发送先人工确认，再按共享偏好等待 0／5／10／20／30 秒。发送意图持久保存在既有 prefs 表的保留键中，无新增迁移；执行仍走 `Mailbox.perform` 的 user/app 命令和审计。撤销会保留草稿。离线时保持待发送，下次前台或下拉刷新再处理。
- 传输失败或执行中进程退出后，发件箱保留待检查项，不自动重发。先检查已发送，再取消队列项并从草稿重试，避免不确定的投递结果产生重复邮件。
- 搜索复用 Gmail 操作符 parser。本地无结果时回退到服务器，也可主动搜索服务器；显示回退提示及错误、截断或忽略操作符的提示。
- 设置包含账户添加、重新登录、启用／停用、移除，四种滑动动作、撤销发送时间、远程图片默认值和语言。远程图片默认阻断；主动开启后仅允许图片 HTTPS，脚本、表单、字体与导航限制继续生效。
- Lingui 包含 en、zh-CN、cs、nl、fr、de、it、ja、ru、es。相同文案复用桌面译文，消息文本字段保留提取注释。修改后执行 `pnpm --filter @openmail/mobile i18n:extract`、补齐译文，再执行 `i18n:compile`。测试检查目录同步与漏译。

## 前台同步与原生权限

初次进入前台、从后台返回和下拉刷新运行 core 同步。没有轮询、后台 fetch、推送注册或定时通知。发送延迟只在前台处理；应用进入后台后不启动新的发送，已开始的传输可能继续完成。发送撤销 toast 与整理撤销 toast 分开；无 core undoId 的整理操作不显示撤销，新的提示清除上次撤销失败状态。

手机端暂不更新 app icon 徽标，已移除仅为徽标引入的 expo-notifications，避免 APNs entitlement、FCM service 和启动广播。image-picker plugin 关闭 cameraPermission 与 microphonePermission；Android 显式屏蔽 CAMERA、RECORD_AUDIO、RECEIVE_BOOT_COMPLETED、POST_NOTIFICATIONS。测试检查 Expo introspect 后的 manifest、entitlements、plist 和实际 autolinking，不启动 bundler。依据：[DocumentPicker](https://docs.expo.dev/versions/latest/sdk/document-picker/)、[ImagePicker](https://docs.expo.dev/versions/latest/sdk/imagepicker/)、[ImageManipulator](https://docs.expo.dev/versions/latest/sdk/imagemanipulator/)。

## 能力（slice 47）

| 能力            | 当前实现与边界                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gmail／Outlook  | 共享 core fetch provider、OAuth、同步、阅读、整理与确认发送；个人 Outlook 只用 consumers。                                                                                                                                                                                                                                                                                                                          |
| IMAP／SMTP      | iCloud、Yahoo、QQ、163、Fastmail、Other 设置及密码更新。共享 Mailbox 命令接入 portable 协议，原生 TCP/TLS 使用 react-native-tcp-socket 6.4.3；应用密码只存 SecureStore。993／465 使用 TLS，其他端口强制 STARTTLS。依赖补丁补齐 Android 证书主机名校验及读取线程升级同步，并补齐两端 STARTTLS 握手完成事件。                                                                                                         |
| IMAP 同步与整理 | 首次同步每文件夹最近 90 天内最多 1000 封；后续追踪 UIDVALIDITY、增量、已读、星标和删除。移动使用 MOVE，或 UIDPLUS 定向 expunge；缺少两者时拒绝移动。支持历史分页和有上限的服务器搜索，无 IDLE、服务端草稿、永久删除、过滤器或自动回复。                                                                                                                                                                             |
| IMAP 发送       | core MIME／SMTP，发送前沿用手机人工确认与撤销队列；Bcc 只进信封，不进入投递 MIME。SMTP DATA 和 IMAP APPEND 按 64 KiB 分块并等待写入。SMTP 接受后不因 Sent 归档失败重发；归档失败记录脱敏警告，已发送副本仍可能缺失。                                                                                                                                                                                                |
| 阅读附件        | Gmail／Outlook／IMAP 经 core 下载；按账户与缓存键哈希写入 `Paths.cache/openmail-attachments`，遵循共享缓存容量和清理；本进程按最近访问驱逐，重启后以文件修改时间排序，系统也可驱逐。iOS 分享面板结束即删除副本。Android 在 URI 交接后保留副本，供接收应用延迟读取；启动及分享时按 24 小时和 64 MiB 总量驱逐，分享失败立即清理。iOS 的预览／打开选项由系统分享面板和已安装应用提供。IMAP 原始 MIME 单封上限 25 MiB。 |
| 图片与链接      | 仅含 cid: 的 HTML 查询 core 图片，按消息 ID 复用下载结果，邮箱刷新保留阅读视图。远程图片默认阻断，可逐封加载，CSP 仅允许 HTTPS；WebView JS 始终关闭。移除 form、全部 meta http-equiv 和非 stylesheet link；iOS 只打开用户点击链接，Android 兼容省略 isTopFrame 的 release 事件，明确子框架仍拒绝；先显示 ASCII 域名及解码后的国际化域名供确认，CSP 禁止框架。                                                       |
| 联系人          | 撰写 To／Cc／Bcc 自动补全查询共享联系人表及本地邮件历史；已有 slice 44 路径保留。                                                                                                                                                                                                                                                                                                                                   |
| 邮箱列表        | 账户内标签／文件夹的嵌套名称与共享未读数；未缓存邮件不计入本地未读数。                                                                                                                                                                                                                                                                                                                                              |
| 仍不支持        | PDF 文本提取、固定地址图片下载、推理和数据库恢复。文件层支持沙箱内目录、读取、写入、复制、改名和删除，其他 Effect FileSystem 操作仍不支持。                                                                                                                                                                                                                                                                         |

原生库需重新生成开发构建。自动测试使用分片协议流、SQLite 与原生 API mocks，没有连接真实邮箱；不能证明各服务商兼容性、真机 TLS、分享面板预览或 Metro 打包。依赖依据：[TCP/TLS API](https://github.com/Rapsssito/react-native-tcp-socket)、[Expo Sharing](https://docs.expo.dev/versions/latest/sdk/sharing/)。

## 尚需验证

自动测试覆盖屏幕 view-model、串行草稿、搜索／滑动／富文本、原生 picker／备份排除 mocks、两家 core 整理与发送命令、撤销、发送失败和数据库重开。未启动模拟器、Metro 或 EAS。真机仍需验证 SQLite／Metro、两家 OAuth、五家 IMAP／SMTP 及 Other 服务器、大邮箱分页、备份排除的原生属性、手势与 VoiceOver、照片／文档选择、原生日期选择、附件投递及前后台生命周期。推送须先决定中转服务。

版本依据：[SDK 57](https://expo.dev/changelog/sdk-57)、[Expo monorepo](https://docs.expo.dev/guides/monorepos/)、[AuthSession](https://docs.expo.dev/guides/authentication/)。

## 备份与锁屏

邮件数据库、WAL、SHM、本地草稿、发送意图与 core 文件保存在 `Paths.document/openmail-data`，不使用可被系统清空的 cache。启动时优先将旧 `Paths.cache/openmail` 整目录迁移，保留 DB／WAL／SHM；没有 cache 时迁移旧 Documents/openmail。已有持久数据库时不覆盖，把残留副本移入持久目录内独立的 legacy 子目录。空目标目录可在中断后继续迁移。

iOS 本地 Expo module `modules/openmail-storage` 在移动目录前和打开数据库前同步设置并确认 `URLResourceValues.isExcludedFromBackup`；只允许三个固定 mail 目录。模块缺失或备份排除失败就停止数据库启动。需要重新生成开发构建以链接该模块；autolinking 与 Swift 语法已检查，尚未用真机验证属性继承、目录迁移和原生模块调用。Android 继续设置 `android.allowBackup=false`。阅读器使用 incognito WebView。

SecureStore 当前使用 `WHEN_UNLOCKED_THIS_DEVICE_ONLY`，锁屏或安全存储不可用时，读取返回可重试的 `ProviderError`，不把它当作凭证撤销，不删除 token，错误不包含原生异常或密钥内容。解锁后重试。后台刷新落地时，必须改用 `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`，并继续处理重启后首次解锁前的读取失败；该可访问性设置只在 iOS 生效。

阅读器在渲染前移除全部 meta http-equiv 和非 stylesheet link，阻止自动刷新与资源预取。iOS 只将 navigationType=click 的顶层链接交给系统，Android 必须先确认真实域名与完整 URL。远程图片 CSP 只允许 HTTPS。阅读器的 CSP 在桌面资源限制上增加 `form-action 'none'` 和 `base-uri 'none'`，渲染前移除 form 子树，防止 Android POST 绕过导航回调。WebView 始终拒绝导航；通过上述点击／确认流程且不含 URL 用户名/密码的 http、https、mailto 链接才交给系统浏览器或邮件应用。OAuth 回调经 `+native-intent.tsx` 路由到账户页，code/state 仍由 AuthSession 监听和校验。

依据：[Apple 目录与备份](https://developer.apple.com/documentation/foundation/using-the-file-system-effectively)、[Android allowBackup](https://docs.expo.dev/versions/latest/config/app/#allowbackup)、[SecureStore 可访问性](https://docs.expo.dev/versions/v57.0.0/sdk/securestore/)、[Expo native intent](https://docs.expo.dev/router/advanced/native-intent/)。
