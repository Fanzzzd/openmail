# Google OAuth 客户端设置

桌面 app 和 CLI 默认用 openmail 自己注册的 Desktop 类型客户端登录，来源见[发布](release.md#内置-oauth-客户端)。添加 Gmail 时直接点 **Sign in with Google**，不需要下面的步骤。

本页是进阶和自托管路径：构建里没有内置客户端，或你想用自己 Google Cloud 项目里的客户端。在 app 的 **Use your own OAuth client** 里填入的客户端优先于内置客户端，只影响之后的新登录；已有账户继续用签发其 refresh token 的客户端，见[账户与签发客户端](#账户与签发客户端)。

## 内置客户端的发布状态

内置客户端属于 Google Cloud 项目 `openmail-510100`，目前停在 **Testing**：

- refresh token 每 7 天过期，到期后要重新登录。core 在登录时记录签发时间。内置客户端签发的 token 在签发至少 6.5 天后收到 `invalid_grant` 时，原因记为 `testing_mode_expiry`，界面说明 Google 目前把 OpenMail 的登录限制为 7 天，请用户重新登录。
- 只有项目 **Audience → Test users** 列出的地址能登录，其他地址会被拒绝。

切到 **In production** 但不提交验证时，7 天过期取消，最多 100 个用户，登录页显示“此应用未经验证”的警告。Gmail 的 `gmail.modify`、`gmail.send` 和 `https://mail.google.com/` 属于 restricted scope，完整验证需要通过 CASA 安全评估。依据：[Testing 状态的 token 过期](https://developers.google.com/identity/protocols/oauth2#expiration)、[未验证应用的用户上限](https://support.google.com/cloud/answer/7454865)、[restricted scope 验证](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)。

## 账户与签发客户端

refresh token 只能和签发它的客户端一起使用。core 在登录成功后把签发客户端的 client ID 写进数据库的 `accounts.oauth_client_id`（迁移 43）。client ID 是公开值，不进钥匙串。续期时只用这个 client ID，在用户客户端、运行时环境变量和内置客户端里找完全相同的一个；都没有时报需要重新登录，不改用其他客户端。

迁移 43 之前登录的账户没有记录。旧版本只会用环境变量或 `config.json` 里的客户端签发 token，所以续期先用环境变量的客户端，再用用户客户端，绝不用内置客户端；第一次续期成功后补记。两者都不在时，账户提示重新登录。删除账户时这条记录随账户行一起删除。

添加账户页显示新登录用的是内置客户端还是你自己的客户端。用自己的客户端且有内置客户端时，可以点 **Use the built-in client** 删除 `config.json` 里的客户端；已添加的账户继续用登录时的客户端。实现见 [oauth-clients.ts](../packages/core/src/oauth-clients.ts)。

## 注册自己的客户端

1. 打开 <https://console.cloud.google.com/>，新建一个项目，比如 `openmail`。
2. 进入 **APIs & Services → Library**，启用 **Gmail API**。使用可选日历或联系人服务时，再启用 **Google Calendar API** 或 **People API**。
3. 进入 **Google Auth Platform → Branding**，填应用名和你的邮箱。User type 选 **External**。
4. 进入 **Audience**：
   - 状态停在 **Testing** 的话，refresh token 7 天后过期，每周要重新登录一次。
   - 点 **Publish app** 切到 **In production**，不用提交审核。登录时 Google 会显示“此应用未经验证”，点“高级 → 继续”即可。未验证应用最多 100 个用户，自用够了。
   - Publish app 是灰的、提示 “complete your configuration on the Branding page” 时，先留在 Testing：在 **Test users** 里加上要同步的 Gmail 地址，否则登录会被拒。Testing 状态下每 7 天要重新登录一次。
   - Test users 的输入框在 iframe 里，脚本和 CDP 点不中，手动或用 computer use 操作。
5. 在 **Data Access** 配置必需的 `gmail.modify`、`gmail.send`，完整前缀是 `https://www.googleapis.com/auth/`。新账户只请求这两个邮件权限。可选服务按下面的表逐项加入自己的项目。
6. 进入 **Clients → Create client**，类型选 **Desktop app**，记下 Client ID 和 Client secret。
7. 在 openmail app 的添加账户页填入这两个值（有内置客户端时在 **Use your own OAuth client** 里），或者用 CLI：

   ```sh
   openmail config google --client-id <id> --client-secret <secret>
   openmail accounts add gmail
   ```

Desktop 类型客户端的 secret 按 Google 的定义不算机密。openmail 把它存在 `config.json`（权限 600），把 refresh token 存在系统钥匙串。

## 可选服务

在 **Settings → Accounts → Optional services** 为每个账户分别连接服务。Google 授权仍使用本页注册的客户端，走官方同意页；请求包含基础邮件权限、数据库记录的既有授权和本次服务的 scope，并发送 `include_granted_scopes=true`。新授权状态取自 token 响应。升级时只有完全缺少 scope 记录的旧账户按旧版本完整权限登记；已有空记录或部分授权不补权限。启动不清缓存，实际 403 仍返回局部权限错误，不暂停邮件同步。

普通重新登录、CLI `accounts reauth` 和重新添加已有账户都保留该账户存储的全部 scopes，包括永久删除权限；Google 始终发送 `include_granted_scopes=true`。重新添加时若未指定地址，先用官方授权识别账户，再为识别出的已有账户补发一次保留权限的授权请求。

停用只控制本机使用，不撤销 Google 授权：

| 开关           | 停用后的行为                                               | 清除的缓存                                           |
| -------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| Contacts       | 停止服务器联系人刷新；本地往来地址仍可补全                 | 服务器联系人、联系人分组、照片和对应的服务器补全条目 |
| Calendar       | 停止服务器事件查询、创建和邀请响应；本地邀请仍可阅读       | 无                                                   |
| Gmail Settings | 停止过滤器创建、修改、删除和自动回复修改；已有设置仍可读取 | 无，保留发件别名和签名                               |

`sendAs.list` 使用基础 `gmail.modify` 即可读取，别名同步不受 Gmail Settings 开关影响。[依据](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.settings.sendAs/list)

| 服务           | 在 Data Access 添加的 scope                    | 需启用的 API        |
| -------------- | ---------------------------------------------- | ------------------- |
| Contacts       | `contacts.readonly`、`contacts.other.readonly` | People API          |
| Calendar       | `calendar.events`                              | Google Calendar API |
| Gmail Settings | `gmail.settings.basic`                         | Gmail API           |

scope 都使用 `https://www.googleapis.com/auth/` 前缀。只授予 `contacts.readonly` 时仍可使用已保存联系人；其他联系人需要另一个 scope。日历操作、自动回复和过滤器修改在对应服务未授权或停用时给出入口提示，不停止收发。

点某个服务的 **Connect** 时，同一次授权还会请求用户打开过、后来失去授权的服务；迁移 44 的 `enabled_json` 记录用户打开过哪些服务。从未打开过的服务不请求。请求的服务多于所点的一个时，打开浏览器前先列出其余服务，用户点 **Continue** 才继续。重新登录和连接服务都带 `login_hint`，Google 和 Microsoft 直接选中该账户。

Google 的[桌面 OAuth 文档](https://developers.google.com/identity/protocols/oauth2/native-app#identify-access-scopes)注明 installed apps 不支持增量授权。本实现重新走同意页并明确重列已知授权，不能据参数或本机测试认定真实客户端可无损增加授权。尚未真实账户验收；如授权页拒绝，检查自己项目的 API 与 Data Access，保留此限制，不换用其他应用客户端。

新增能力只访问本人的数据：

| API                 | 端点与操作                                                                                                                       | OAuth scope                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Google Calendar API | `calendars/primary/events?iCalUID=…` 查邀请，`events/{id}` PATCH 本人 attendee 的 `responseStatus`，`sendUpdates=all` 通知组织者 | `https://www.googleapis.com/auth/calendar.events`         |
| People API          | `people/me/connections`，`personFields=names,emailAddresses`                                                                     | `https://www.googleapis.com/auth/contacts.readonly`       |
| People API          | `otherContacts`，`readMask=names,emailAddresses`                                                                                 | `https://www.googleapis.com/auth/contacts.other.readonly` |

联系人每 6 小时刷新一次，失败后 1 小时再试，旧缓存继续补全。只有 `contacts.readonly` 时先补全已保存联系人，缺少可选 `contacts.other.readonly` 不阻止这部分缓存。隐藏地址同时排除本地往来邮件和服务器联系人。日历响应只在点击接受、暂定或拒绝后发送；日历里找不到邀请时，先用 Google Calendar 添加。没有启用 API 时需在上述 Cloud 项目启用，重新登录不能代替启用 API。

依据：[Calendar events](https://developers.google.com/workspace/calendar/api/v3/reference/events)、[People connections](https://developers.google.com/people/api/rest/v1/people.connections/list)、[Other contacts](https://developers.google.com/people/api/rest/v1/otherContacts/list)。

过滤器列表可用已有 `gmail.modify` 或 `gmail.readonly` 读取，成功返回空列表时无需重新登录；创建或删除过滤器仍需 `gmail.settings.basic`。过滤器读取可用基础邮件权限；修改要求连接 Gmail Settings 服务；403 权限错误只提示连接该服务，不改变邮件同步状态。依据：[读取列表](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.settings.filters/list)、[创建过滤器](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.settings.filters/create)。

代码依据：[optional-services.ts](../packages/core/src/optional-services.ts) 定义基础及分服务 scopes，[store-services.ts](../packages/core/src/store-services.ts) 处理旧账户授权记录，[mailbox-services.ts](../packages/core/src/mailbox-services.ts) 执行本机启停；官方授权与 token 响应处理见 [mailbox-live.ts](../packages/core/src/mailbox-live.ts)、[Node OAuth](../packages/core/src/platform/node/oauth.ts)和[手机 OAuth](../packages/core/src/platform/react-native/oauth.ts)。迁移 33 只保存本机开关，不存凭证。局部权限错误与脱敏日志见[安全说明](security.md#服务商诊断)。

## 永久删除权限

Gmail 的 `gmail.modify` 不允许永久删除。需要从 app 永久删除或清空垃圾箱时，在自己项目的 **Data Access** 增加 `https://mail.google.com/`，再通过 app 的永久删除权限提示重新登录。core 只在该功能的授权流程额外请求这个 scope，并检查实际授予的权限；普通登录与收发仍只请求基础邮件 scopes。权限缺失不停止普通同步。CLI 的 `accounts reauth` 不新增这个额外 scope；已保存的永久删除权限仍随普通重新登录保留。

依据：[Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)。

## 手机端

手机端必须新建 iOS 和 Android 客户端，不使用 Desktop client ID 或 secret。先完成本页项目、API、Audience 和 Data Access 设置，再配置 `apps/mobile/app.config.ts` 使用的环境变量。

1. 确定自己应用的 bundle ID/package name，分别设 `OPENMAIL_IOS_BUNDLE_ID`、`OPENMAIL_ANDROID_PACKAGE`，默认都是 `com.openmail.mobile`。
2. 在 **Google Auth Platform → Clients → Create client** 选 **iOS**，填写相同 Bundle ID。记下 client ID，设为 `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`。若控制台要求 App Store ID/Team ID，填写自己的应用/Apple team 信息。
3. 再创建 **Android** 客户端，填写相同 Package name 和自己的签名证书 SHA-1。开发证书、发布证书、Play App Signing 证书可能不同；为实际使用的 package/证书创建匹配的客户端。可从自己的 keystore 用 `keytool -list -v -keystore <keystore>` 查看 SHA-1。
4. Android client ID 设为 `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`。本切片采用 AuthSession 系统浏览器流程，需在该 Android 客户端 **Advanced Settings → Custom URI scheme** 启用自定义 scheme。Google 默认禁用它，并推荐原生 Google Identity Services；若控制台不允许启用，当前浏览器流程不能用于该客户端，需先接原生 SDK。不要拿 iOS/Desktop client ID 代替。
5. 两个平台回调都按自己的 client ID 生成：`123.apps.googleusercontent.com` 对应 `com.googleusercontent.apps.123:/oauthredirect`。Expo 配置自动注册该 scheme。客户端 ID 变更后，重新生成并安装开发构建；Expo Go 不支持此回调。
6. 用添加 Gmail 账户按钮打开官方授权页。AuthSession 发送 authorization code、PKCE S256 和 state，core 交换 token；手机客户端不发送 client secret。refresh token 仅进入 expo-secure-store。

手机授权流程已接入，仍需真实账户验收。普通登录与桌面共用基础邮件 scopes；可选服务在桌面按账户连接。

依据：[注册 Android/iOS 客户端及 Advanced Settings](https://support.google.com/googleapi/answer/6158849?hl=en)、[Google 自定义 URI 限制与启用选项](https://developers.googleblog.com/improving-user-safety-in-oauth-flows-through-new-oauth-custom-uri-scheme-restrictions/)、[原生 OAuth PKCE](https://developers.google.com/identity/protocols/oauth2/native-app)。
