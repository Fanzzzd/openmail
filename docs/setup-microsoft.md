# Microsoft (Azure) OAuth 客户端设置

openmail 用你自己在 Azure 注册的公共客户端登录个人 outlook.com 账户。凭证只存在本机，走 Microsoft Graph。

> 只支持个人账户（outlook.com / hotmail / live）。公司或学校的 Microsoft 365 账户需要租户管理员先给应用授权，openmail 不绕过这一步。

0. 个人账号必须先有一个 Entra 目录。微软已经不允许在目录之外注册应用，App registrations 页会提示 "The ability to create applications outside of a directory has been deprecated"。开通免费 Azure 账号（<https://azure.microsoft.com/free>，要信用卡和手机号，只做预授权，不升级不扣费）会自动建一个 Default Directory。开户时如果在带调试端口的浏览器里提交地址页，微软会返回 "unexpected error"，换日常浏览器提交。
1. 打开 <https://portal.azure.com/>，进入 **Microsoft Entra ID → App registrations → New registration**。
2. Name 填 `openmail`。**Supported account types** 选 **Personal Microsoft accounts only**。
3. **Redirect URI**：平台选 **Public client/native (mobile & desktop)**，值填 `http://localhost`。
   - Azure 的文本框不接受 `http://127.0.0.1`，但 `http://localhost` 对 loopback 是任意端口通配，登录时用哪个端口都能回调。
4. 注册后，在 **Overview** 页记下 **Application (client) ID**。
5. 进入 **API permissions → Add a permission → Microsoft Graph → Delegated**，加上 `Mail.ReadWrite`、`Mail.Send`、`MailboxSettings.ReadWrite`、`Calendars.ReadWrite`、`Contacts.Read`、`People.Read`、`User.Read`、`offline_access`。个人账户不需要管理员同意。
6. 进入 **Authentication**，确认 **Allow public client flows** 打开（公共客户端用 PKCE，不用密钥）。
7. 在 openmail 引导页填入 client ID，或用 CLI：

   ```sh
   openmail config microsoft --client-id <application-client-id>
   openmail accounts add outlook
   ```

公共客户端没有 secret。client ID 存在 `config.json`（权限 600），refresh token 存在系统钥匙串。

新增能力使用 Microsoft Graph v1.0 的委托权限：

| 端点与操作                                                                                                                             | OAuth scope                             |
| -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `/me/messages/{id}?$expand=microsoft.graph.eventMessage/event` 找关联事件；普通 `.ics` 附件按 `/me/events?$filter=iCalUId eq '…'` 查找 | `Mail.ReadWrite`、`Calendars.ReadWrite` |
| `/me/events/{id}/accept`、`tentativelyAccept`、`decline`，POST `sendResponse: true`                                                    | `Calendars.ReadWrite`                   |
| `/me/contacts`，读取 `displayName,emailAddresses`                                                                                      | `Contacts.Read`                         |
| `/me/people`，读取 `displayName,scoredEmailAddresses`                                                                                  | `People.Read`                           |

已有授权缺少新增 scope 时，只在对应能力提示重新登录，不停邮件同步。联系人每 6 小时刷新一次，失败后 1 小时再试，旧缓存继续补全。日历响应只由用户点击触发。所有授权和续期仍走 `https://login.microsoftonline.com/consumers`，不改用公司租户。

依据：[接受事件](https://learn.microsoft.com/en-us/graph/api/event-accept?view=graph-rest-1.0)、[关联会议消息](https://learn.microsoft.com/en-us/graph/api/eventmessage-get?view=graph-rest-1.0)、[Contacts](https://learn.microsoft.com/en-us/graph/api/user-list-contacts?view=graph-rest-1.0)、[People](https://learn.microsoft.com/en-us/graph/api/user-list-people?view=graph-rest-1.0)。
