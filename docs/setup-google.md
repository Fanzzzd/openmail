# Google OAuth 客户端设置

openmail 不是公开发布的应用。每个用户用自己的 Google Cloud 项目注册 OAuth 客户端，凭证只存在本机。

1. 打开 <https://console.cloud.google.com/>，新建一个项目，比如 `openmail`。
2. 进入 **APIs & Services → Library**，搜索 **Gmail API**，点击 Enable。
3. 进入 **Google Auth Platform → Branding**，填应用名和你的邮箱。User type 选 **External**。
4. 进入 **Audience**：
   - 状态停在 **Testing** 的话，refresh token 7 天后过期，每周要重新登录一次。
   - 点 **Publish app** 切到 **In production**，不用提交审核。登录时 Google 会显示“此应用未经验证”，点“高级 → 继续”即可。未验证应用最多 100 个用户，自用够了。
   - Publish app 是灰的、提示 “complete your configuration on the Branding page” 时，先留在 Testing：在 **Test users** 里加上要同步的 Gmail 地址，否则登录会被拒。Testing 状态下每 7 天要重新登录一次。
   - Test users 的输入框在 iframe 里，脚本和 CDP 点不中，手动或用 computer use 操作。
5. 在 **Data Access** 配置 `gmail.modify`、`gmail.send`、`gmail.settings.basic`。已有账户仍可收发，使用过滤器、自动回复或别名时再重新登录取得设置权限。
6. 进入 **Clients → Create client**，类型选 **Desktop app**，记下 Client ID 和 Client secret。
7. 在 openmail app 的引导页填入这两个值，或者用 CLI：

   ```sh
   openmail config google --client-id <id> --client-secret <secret>
   openmail accounts add gmail
   ```

Desktop 类型客户端的 secret 按 Google 的定义不算机密。openmail 把它存在 `config.json`（权限 600），把 refresh token 存在系统钥匙串。
