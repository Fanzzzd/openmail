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

## 当前界面与范围

- 账户列表，添加 Gmail/个人 Outlook 账户。配置缺失时禁用添加。
- 邮箱列表、会话列表，keyset 使用 `before` 和 `beforeId`，下拉刷新经过 core 同步。
- 会话阅读先显示消息文本；HTML WebView 关闭 JavaScript、DOM storage、文件访问、共享 cookie 和 WebView 导航，验证的链接交给系统应用；沿用桌面资源 CSP 并禁用表单和 base URL，远程资源默认阻断。
- Lingui 包含 en、zh-CN、cs、nl、fr、de、it、ja、ru、es。相同文案复用桌面译文；新增消息文本按钮有提取注释。修改后执行 `pnpm --filter @openmail/mobile i18n:extract`、补齐译文，再执行 `i18n:compile`。测试检查目录同步与漏译。

Gmail/Outlook 复用 core 的 fetch provider；IMAP/SMTP 明确返回不支持。PostalMime 解析原始 MIME，输入限制为 25 MiB，嵌套和 header 有额外限制。发送、附件磁盘缓存、PDF、固定地址图片下载、推理和数据库恢复未开放；缺少的能力提供明确失败适配器。文件层支持沙箱内目录、读取、写入、复制、改名和删除，其他 Effect FileSystem 操作仍不支持。没有自动轮询、推送、后台调度或发送界面。

下一步是真机验证 SQLite/Metro、两家 OAuth 和大邮箱分页，再补附件、写操作、离线错误与前后台生命周期。推送须先决定中转服务。

版本依据：[SDK 57](https://expo.dev/changelog/sdk-57)、[Expo monorepo](https://docs.expo.dev/guides/monorepos/)、[AuthSession](https://docs.expo.dev/guides/authentication/)。

## 备份与锁屏

邮件数据库、WAL 和应用文件缓存位于 `Paths.cache/openmail`，不放在 Documents；iOS Caches 不进入 iCloud 或设备备份。启动时先把旧版 Documents/openmail 整目录移入 cache，包含 WAL；已有 cache 时保留旧数据到独立 legacy 子目录。系统可清空缓存，届时需要重新添加账户并同步邮件。Android 设置 `android.allowBackup=false`，禁用应用的 Auto Backup。阅读器使用 incognito WebView，避免持久保存邮件页面缓存。

SecureStore 当前使用 `WHEN_UNLOCKED_THIS_DEVICE_ONLY`，锁屏或安全存储不可用时，读取返回可重试的 `ProviderError`，不把它当作凭证撤销，不删除 token，错误不包含原生异常或密钥内容。解锁后重试。后台刷新落地时，必须改用 `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`，并继续处理重启后首次解锁前的读取失败；该可访问性设置只在 iOS 生效。

阅读器的 CSP 在桌面资源限制上增加 `form-action 'none'` 和 `base-uri 'none'`，渲染前移除 form 子树，防止 Android POST 绕过导航回调。WebView 始终拒绝导航；验证过且不含 URL 用户名/密码的 http、https、mailto 链接交给系统浏览器或邮件应用。OAuth 回调经 `+native-intent.tsx` 路由到账户页，code/state 仍由 AuthSession 监听和校验。

依据：[Apple 目录与备份](https://developer.apple.com/documentation/foundation/using-the-file-system-effectively)、[Android allowBackup](https://docs.expo.dev/versions/latest/config/app/#allowbackup)、[SecureStore 可访问性](https://docs.expo.dev/versions/v57.0.0/sdk/securestore/)、[Expo native intent](https://docs.expo.dev/router/advanced/native-intent/)。
