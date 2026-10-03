# Google OAuth 客户端设置

openmail 不是公开发布的应用。每个用户用自己的 Google Cloud 项目注册 OAuth 客户端，凭证只存在本机。

1. 打开 <https://console.cloud.google.com/>，新建一个项目，比如 `openmail`。
2. 进入 **APIs & Services → Library**，启用 **Gmail API**、**Google Calendar API** 和 **People API**。
3. 进入 **Google Auth Platform → Branding**，填应用名和你的邮箱。User type 选 **External**。
4. 进入 **Audience**：
   - 状态停在 **Testing** 的话，refresh token 7 天后过期，每周要重新登录一次。
   - 点 **Publish app** 切到 **In production**，不用提交审核。登录时 Google 会显示“此应用未经验证”，点“高级 → 继续”即可。未验证应用最多 100 个用户，自用够了。
   - Publish app 是灰的、提示 “complete your configuration on the Branding page” 时，先留在 Testing：在 **Test users** 里加上要同步的 Gmail 地址，否则登录会被拒。Testing 状态下每 7 天要重新登录一次。
   - Test users 的输入框在 iframe 里，脚本和 CDP 点不中，手动或用 computer use 操作。
5. 在 **Data Access** 配置 `gmail.modify`、`gmail.send`、`gmail.settings.basic`、`calendar.events`、`contacts.readonly`、`contacts.other.readonly`，完整前缀都是 `https://www.googleapis.com/auth/`。已有账户仍可收发；使用新增设置、日历响应或服务器联系人时，按界面提示重新登录。
6. 进入 **Clients → Create client**，类型选 **Desktop app**，记下 Client ID 和 Client secret。
7. 在 openmail app 的引导页填入这两个值，或者用 CLI：

   ```sh
   openmail config google --client-id <id> --client-secret <secret>
   openmail accounts add gmail
   ```

Desktop 类型客户端的 secret 按 Google 的定义不算机密。openmail 把它存在 `config.json`（权限 600），把 refresh token 存在系统钥匙串。

新增能力只访问本人的数据：

| API                 | 端点与操作                                                                                                                       | OAuth scope                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Google Calendar API | `calendars/primary/events?iCalUID=…` 查邀请，`events/{id}` PATCH 本人 attendee 的 `responseStatus`，`sendUpdates=all` 通知组织者 | `https://www.googleapis.com/auth/calendar.events`         |
| People API          | `people/me/connections`，`personFields=names,emailAddresses`                                                                     | `https://www.googleapis.com/auth/contacts.readonly`       |
| People API          | `otherContacts`，`readMask=names,emailAddresses`                                                                                 | `https://www.googleapis.com/auth/contacts.other.readonly` |

联系人每 6 小时刷新一次，失败后 1 小时再试，旧缓存继续补全。只有 `contacts.readonly` 时先补全已保存联系人，缺少可选 `contacts.other.readonly` 不阻止这部分缓存。隐藏地址同时排除本地往来邮件和服务器联系人。日历响应只在点击接受、暂定或拒绝后发送；日历里找不到邀请时，先用 Google Calendar 添加。没有启用 API 时需在上述 Cloud 项目启用，重新登录不能代替启用 API。

依据：[Calendar events](https://developers.google.com/workspace/calendar/api/v3/reference/events)、[People connections](https://developers.google.com/people/api/rest/v1/people.connections/list)、[Other contacts](https://developers.google.com/people/api/rest/v1/otherContacts/list)。

过滤器列表可用已有 `gmail.modify` 或 `gmail.readonly` 读取，成功返回空列表时无需重新登录；创建或删除过滤器仍需 `gmail.settings.basic`。实际 403 权限错误只在设置中提示重新登录，不改变邮件同步状态。依据：[读取列表](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.settings.filters/list)、[创建过滤器](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.settings.filters/create)。

## 永久删除权限

Gmail 的 `gmail.modify` 不允许永久删除。需要从 app 永久删除或清空垃圾箱时，在自己项目的 **Data Access** 增加 `https://mail.google.com/`，再通过 app 的永久删除权限提示重新登录。core 只在该功能的授权流程额外请求这个 scope，并检查实际授予的权限；普通登录与收发仍使用原 scopes。权限缺失不停止普通同步。CLI 的 `accounts reauth` 不请求这个额外 scope。

依据：[Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)。

## 手机端

手机端必须新建 iOS 和 Android 客户端，不使用 Desktop client ID 或 secret。先完成本页项目、API、Audience 和 Data Access 设置，再配置 `apps/mobile/app.config.ts` 使用的环境变量。

1. 确定自己应用的 bundle ID/package name，分别设 `OPENMAIL_IOS_BUNDLE_ID`、`OPENMAIL_ANDROID_PACKAGE`，默认都是 `com.openmail.mobile`。
2. 在 **Google Auth Platform → Clients → Create client** 选 **iOS**，填写相同 Bundle ID。记下 client ID，设为 `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`。若控制台要求 App Store ID/Team ID，填写自己的应用/Apple team 信息。
3. 再创建 **Android** 客户端，填写相同 Package name 和自己的签名证书 SHA-1。开发证书、发布证书、Play App Signing 证书可能不同；为实际使用的 package/证书创建匹配的客户端。可从自己的 keystore 用 `keytool -list -v -keystore <keystore>` 查看 SHA-1。
4. Android client ID 设为 `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`。本切片采用 AuthSession 系统浏览器流程，需在该 Android 客户端 **Advanced Settings → Custom URI scheme** 启用自定义 scheme。Google 默认禁用它，并推荐原生 Google Identity Services；若控制台不允许启用，当前浏览器流程不能用于该客户端，需先接原生 SDK。不要拿 iOS/Desktop client ID 代替。
5. 两个平台回调都按自己的 client ID 生成：`123.apps.googleusercontent.com` 对应 `com.googleusercontent.apps.123:/oauthredirect`。Expo 配置自动注册该 scheme。客户端 ID 变更后，重新生成并安装开发构建；Expo Go 不支持此回调。
6. 用添加 Gmail 账户按钮打开官方授权页。AuthSession 发送 authorization code、PKCE S256 和 state，core 交换 token；手机客户端不发送 client secret。refresh token 仅进入 expo-secure-store。

本切片已接好授权流程，未做真实登录。scope 复用现有 core Gmail 请求，桌面 scopes 未修改。

依据：[注册 Android/iOS 客户端及 Advanced Settings](https://support.google.com/googleapi/answer/6158849?hl=en)、[Google 自定义 URI 限制与启用选项](https://developers.googleblog.com/improving-user-safety-in-oauth-flows-through-new-oauth-custom-uri-scheme-restrictions/)、[原生 OAuth PKCE](https://developers.google.com/identity/protocols/oauth2/native-app)。
