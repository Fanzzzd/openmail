# Microsoft (Azure) OAuth 客户端设置

桌面 app 和 CLI 默认用 openmail 自己注册的 Azure 公共客户端（`consumers` 租户，`http://localhost` 回调，无 secret）登录个人 outlook.com 账户，来源见[发布](release.md#内置-oauth-客户端)。添加 Outlook 时直接点 **Sign in with Microsoft**。

本页是进阶和自托管路径：构建里没有内置客户端，或你想用自己在 Azure 注册的应用。在 app 的 **Use your own OAuth client** 里填入的 client ID 优先于内置客户端，只影响之后的新登录；已有账户继续用签发其 refresh token 的客户端，规则见 [Google 页](setup-google.md#账户与签发客户端)。凭证只存在本机，走 Microsoft Graph。

> 只支持个人账户（outlook.com / hotmail / live）。公司或学校的 Microsoft 365 账户需要租户管理员先给应用授权，openmail 不绕过这一步。

0. 个人账号必须先有一个 Entra 目录。微软已经不允许在目录之外注册应用，App registrations 页会提示 "The ability to create applications outside of a directory has been deprecated"。开通免费 Azure 账号（<https://azure.microsoft.com/free>，要信用卡和手机号，只做预授权，不升级不扣费）会自动建一个 Default Directory。开户时如果在带调试端口的浏览器里提交地址页，微软会返回 "unexpected error"，换日常浏览器提交。
1. 打开 <https://portal.azure.com/>，进入 **Microsoft Entra ID → App registrations → New registration**。
2. Name 填 `openmail`。**Supported account types** 选 **Personal Microsoft accounts only**。
3. **Redirect URI**：平台选 **Public client/native (mobile & desktop)**，值填 `http://localhost`。
   - Azure 的文本框不接受 `http://127.0.0.1`，但 `http://localhost` 对 loopback 是任意端口通配，登录时用哪个端口都能回调。
4. 注册后，在 **Overview** 页记下 **Application (client) ID**。
5. 进入 **API permissions → Add a permission → Microsoft Graph → Delegated**，加上必需的 `Mail.ReadWrite`、`Mail.Send`、`User.Read`、`offline_access`、`MailboxSettings.ReadWrite`。新账户只请求这组基础权限。`MailboxSettings.ReadWrite` 是 masterCategories 分类管理所需权限，分类属于基础邮件标签功能。可选服务按下面的表添加；个人账户不需要管理员同意。
6. 进入 **Authentication**，确认 **Allow public client flows** 打开（公共客户端用 PKCE，不用密钥）。
7. 在 openmail 添加账户页填入 client ID（有内置客户端时在 **Use your own OAuth client** 里），或用 CLI：

   ```sh
   openmail config microsoft --client-id <application-client-id>
   openmail accounts add outlook
   ```

公共客户端没有 secret。client ID 存在 `config.json`（权限 600），refresh token 存在系统钥匙串。

## 可选服务

在 **Settings → Accounts → Optional services** 逐项连接。授权只使用账户的签发客户端（openmail 内置或自己注册）和 Microsoft 官方 `consumers` 同意页；请求保留已知授权并添加本次服务 scope。新授权按 token 响应记录。完全没有 scope 记录的旧 Outlook 账户升级时按旧版完整权限登记，保留联系人和别名缓存；已记录的空授权或部分授权不会扩权。启动不清缓存，实际 403 仍按局部能力错误处理。普通重新登录和重新添加已有账户重列该账户已保存的 scopes；未指定地址重新添加时，先识别账户，再为已有账户补发保留权限的官方授权。

停用只控制本机使用，不撤销 Microsoft 授权：

| 开关            | 停用后的行为                                               | 清除的缓存                                     |
| --------------- | ---------------------------------------------------------- | ---------------------------------------------- |
| Contacts        | 停止服务器联系人刷新；本地往来地址仍可补全                 | 服务器联系人、分组、照片和对应的服务器补全条目 |
| Calendar        | 停止服务器事件查询、创建和邀请响应                         | 无                                             |
| MailboxSettings | 停止服务器规则和自动回复修改；分类管理与已有设置读取仍可用 | 无                                             |

`MailboxSettings.ReadWrite` 保留在基础 scopes，因为列出、注册 masterCategories 需要该权限；MailboxSettings 开关只控制可选设置修改。[依据](https://learn.microsoft.com/en-us/graph/api/outlookuser-list-mastercategories?view=graph-rest-1.0)

| 服务            | 在 API permissions → Microsoft Graph → Delegated 添加的权限 |
| --------------- | ----------------------------------------------------------- |
| Contacts        | `Contacts.Read`、`People.Read`                              |
| Calendar        | `Calendars.ReadWrite`                                       |
| MailboxSettings | `MailboxSettings.ReadWrite`，已包含在基础权限中             |

`Contacts.Read` 对应已保存联系人，`People.Read` 对应人员建议。当前刷新路径同时查询两类数据；某一请求缺权限会使本次刷新失败，已有缓存继续保留。未授权或停用时，对应功能提示连接服务，邮件继续同步。尚未实测真实同意页和部分授权结果。

依据：[Microsoft 增量同意与 scopes](https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc)。

新增能力使用 Microsoft Graph v1.0 的委托权限：

| 端点与操作                                                                                                                             | OAuth scope                             |
| -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `/me/messages/{id}?$expand=microsoft.graph.eventMessage/event` 找关联事件；普通 `.ics` 附件按 `/me/events?$filter=iCalUId eq '…'` 查找 | `Mail.ReadWrite`、`Calendars.ReadWrite` |
| `/me/events/{id}/accept`、`tentativelyAccept`、`decline`，POST `sendResponse: true`                                                    | `Calendars.ReadWrite`                   |
| `/me/contacts` 及根／嵌套 `contactFolders` 的联系人，读取 `displayName,emailAddresses,companyName`                                     | `Contacts.Read`                         |
| `/me/people`，读取 `displayName,scoredEmailAddresses`                                                                                  | `People.Read`                           |

联系人刷新遍历默认联系人、全部根联系人文件夹及递归子文件夹，每个集合沿 nextLink 分页，按 contact ID 去重，再合并邮箱地址。`/me/people` 是相关性建议，只取首批最多 250 人，不作为完整联系人清单；不沿 People 的 nextLink 扩大范围。实现见 [outlook-features.ts](../packages/core/src/providers/outlook/outlook-features.ts)，分页链接校验见[架构](architecture.md#provider-与-store)，回归见 [outlook.test.ts](../packages/core/src/providers/outlook/outlook.test.ts)。

已有授权缺少新增 scope 时，在对应能力提示连接可选服务，不停邮件同步。联系人每 6 小时刷新一次，失败后 1 小时再试，旧缓存继续补全。日历响应只由用户点击触发。所有授权和续期仍走 `https://login.microsoftonline.com/consumers`，不改用公司租户。

依据：[接受事件](https://learn.microsoft.com/en-us/graph/api/event-accept?view=graph-rest-1.0)、[关联会议消息](https://learn.microsoft.com/en-us/graph/api/eventmessage-get?view=graph-rest-1.0)、[Contacts](https://learn.microsoft.com/en-us/graph/api/user-list-contacts?view=graph-rest-1.0)、[People](https://learn.microsoft.com/en-us/graph/api/user-list-people?view=graph-rest-1.0)。

代码依据：[optional-services.ts](../packages/core/src/providers/optional-services.ts) 定义基础及分服务 scopes，[store-services.ts](../packages/core/src/store/store-services.ts) 处理旧账户授权记录，[mailbox-services.ts](../packages/core/src/mailbox/mailbox-services.ts) 执行本机启停；官方授权与 token 响应处理见 [mailbox-live.ts](../packages/core/src/mailbox/mailbox-live.ts)、[Node OAuth](../packages/core/src/platform/node/oauth.ts)和[手机 OAuth](../packages/core/src/platform/react-native/oauth.ts)。迁移 33 只保存本机开关，不存凭证。局部权限错误与脱敏日志见[安全说明](security.md#服务商诊断)。

## 手机端

给自己注册的公共应用增加原生平台回调，不借用其他应用的 client ID。手机端不需要 secret，授权和续期都只走 `consumers`。

1. 按本页步骤创建应用，Supported account types 保持 **Personal Microsoft accounts only**。将自己的 Application (client) ID 设为 `EXPO_PUBLIC_MICROSOFT_CLIENT_ID`。可在自己的同一个应用注册里添加两个手机平台。
2. 确定 `OPENMAIL_IOS_BUNDLE_ID` 和 `OPENMAIL_ANDROID_PACKAGE`，默认 `com.openmail.mobile`。
3. 在 **Authentication → Add a platform → iOS/macOS** 填相同 Bundle ID。注册回调 `msauth.<bundle-id>://auth`。`app.config.ts` 自动注册 scheme，iOS 使用该完整 URI。
4. 在 **Add a platform → Android** 填相同 Package name 和自己的签名 hash。对实际构建的证书运行以下命令得到 Base64 SHA-1，填写控制台的 Signature hash；开发/发布证书不同就分别注册。

   ```sh
   keytool -exportcert -alias <alias> -keystore <keystore> | openssl sha1 -binary | openssl base64
   ```

5. 复制控制台生成的完整 Android redirect URI，通常是 `msauth://<package-name>/<URL-encoded-signature-hash>`，设为 `EXPO_PUBLIC_MICROSOFT_ANDROID_REDIRECT`。不要把 Base64 中的 `+`、`/` 或 `=` 手写成其他编码。Expo Android intent filter 使用 package host 和此 URI 的 path，系统浏览器回调给当前应用；这里没有 MSAL broker。
6. **Allow public client flows** 保持开启，Delegated permissions 沿用本页列表。PKCE 不需要开启 implicit grant。回调或环境变量变化后重新生成并安装开发构建；Expo Go 不适用。
7. 点击添加 Outlook 账户，打开 Microsoft 官方个人账户授权页。AuthSession 验证 state，core 使用相同 redirect URI 和 PKCE verifier 交换 token，refresh token 只进 expo-secure-store。

手机授权仍需真实账户验收。公司/学校 M365 租户仍不支持。桌面回环 URI 保持不变，普通登录只请求基础邮件 scopes。

依据：[Microsoft 手机平台配置](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-mobile-app-configuration)、[Android redirect URI](https://learn.microsoft.com/en-us/entra/msal/android/frequently-asked-questions)、[Expo 原生回调](https://docs.expo.dev/guides/authentication/)。
