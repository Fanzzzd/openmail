# 路线图

桌面目标是对齐 Mimestream 的邮件功能，并支持个人 Outlook 和 IMAP/SMTP。手机端复用 core。逐项对齐证据保留在 [parity](parity.md)，本页维护当前进度和验收事项。

## 进度（2026-10-03）

slice 22 至 41 的实现已进入当前代码。下表的“完成”指产品路径和自动回归已存在；真实账户、设备权限与正式发行另行验收。slice 42 的安全文档与加固由并行任务维护，本页不将它视为已完成验收。

| 范围             | 已完成                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 邮件操作与可靠性 | 批量／单封操作、持久撤销记录、队列重试、离线状态保护、草稿恢复、数据库恢复和脱敏诊断                                         |
| 撰写             | 富文本格式、纯文本与 Markdown、模板变量与 Bcc、命名签名、Gmail 签名同步、发件地址选择、联系人组／公司／照片、附件与发送保护  |
| 阅读与日历       | 会话顺序、引用折叠、消息文本查找、原始邮件／EML、附件互操作、会议入口、邀请历史与响应、冲突查询、确认创建可识别事件          |
| 搜索与整理       | 布尔与排除、短语、字段／日期／大小／分类／Message-ID 运算符、词索引与 trigram 回退、服务器搜索、规则编辑与历史应用、稍后提醒 |
| 桌面集成         | 键盘与原生菜单、Profiles、通知时段、菜单栏与 Dock、文件打开草稿、拼写检查、持久附件缓存、账户与更新设置                      |
| AI               | Model 服务、账户文本授权、流式摘要与缓存、邮件助手、撰写差异预览／改写／翻译、独立开关的分拣建议、本地语义检索               |
| Apple Contacts   | 显式授权、进程内快照、组首选邮箱、照片、卡片跳转与 vCard 导入入口                                                            |
| 工程验证         | 性能查询计划与内存回归、无障碍与键盘回归、renderer 模块拆分、真实 App／RPC／Mailbox 的 24 项邮件流程测试、十种语言目录检查   |
| 平台与手机基础   | Node 平台拆分、portable 入口、Expo 项目、op-sqlite／SecureStore／AuthSession adapters、Gmail／Outlook 邮箱与受限阅读界面     |

Gmail 与个人 Outlook 的基础读写、发信已有真实账户验证记录。后续能力的 fake provider、fake Model、临时数据库及 DOM 回归不能代替新增 scope、真实模型、原生权限和发行验收。验证入口见[测试](testing.md)，测量条件见[性能](performance.md)。

## 待用户完成

- OAuth：按 [Google](setup-google.md) 与 [Microsoft](setup-microsoft.md) 在自己的控制台启用 API 和权限。旧授权遇到设置、日历或联系人缺权限时，在对应页面重新登录。Gmail 永久删除须另加 `https://mail.google.com/` 并通过 app 的永久删除权限入口重新授权；普通收发不要求这个 scope。权限依据见 [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)。
- 发行：提供自己的 Apple Developer 签名身份和公证凭证。验证 Developer ID、公证、Gatekeeper、两种架构的钥匙串与原生依赖，以及测试私库自动更新。构建和凭证细节只在[发布说明](release.md)维护。
- 手机注册：创建自己的 Google iOS／Android 客户端和 Microsoft 原生回调，配置 bundle ID、package name 与签名信息。按[手机端说明](../apps/mobile/README.md)创建开发构建，验证原生 SQLite、FTS5、WAL、Metro、两家 OAuth 和大邮箱分页。Expo Go 不覆盖这些能力。
- 推送决策：确定是否引入中转服务，再设计 Gmail watch／Graph subscriptions、APNs／FCM、设备注册、续期和隐私契约。当前桌面轮询与 IMAP IDLE 已实现，手机端没有后台刷新或推送。

真实账户与系统验收还包括：

1. 三家草稿往返、别名与签名切换、附件和大附件、离线推送、永久删除与清空垃圾箱。
2. 冷缓存与跨 90 天回填、搜索范围和截断、嵌套文件夹、过滤器新邮件／历史命中、自动回复时区、稍后提醒与重启。
3. Gmail／Outlook 邀请响应、重复实例、取消和组织者通知；IMAP iTIP REPLY；联系人分页及撤权刷新。
4. 签名包的通知权限与动作、Dock 与 Profiles、默认邮件客户端、冷启动链接、拼写检查、打印和 PDF。
5. Apple Contacts 的系统授权、部分授权、撤权、联系人卡片跳转和导入确认。测试边界见 [Apple Contacts](apple-contacts.md#验证边界)。
6. 使用自己的 API 密钥验证摘要、助手、撰写和分拣的真实模型请求、取消与费用。端侧索引另验正式签名包的 Vision、sqlite-vec 和 ONNX。

## 剩余功能

原生能力以 [parity](parity.md) 的功能编号为准：

| 功能编号        | 剩余范围                                                                               |
| --------------- | -------------------------------------------------------------------------------------- |
| A05             | ASWebAuthenticationSession 与授权浏览器选择                                            |
| C51、I01 至 I05 | 系统语法／自动纠错、行内预测、Apple Writing Tools 和系统 ChatGPT 扩展                  |
| N11             | 按 Profile 接入 Focus Filter／App Intents                                              |
| N17、N19、M05   | Universal Links、Associated Domains、HTTPS 回退页、系统分享扩展与分享链接              |
| M06 至 M08      | Photos picker、Continuity Camera、Markup                                               |
| M11、P06、P07   | Liquid Glass 原生控件、WebKit 行为对齐、macOS App Sandbox                              |
| M01             | 单个 Universal app；当前配置生成 arm64 与 x64 两套包，Intel 真机及 ONNX 限制见发布说明 |
| R40             | Apple Calendar；现有 Gmail／Outlook 事件创建也不覆盖模糊自然语言日期及所有重复规则     |

其余缺口包括 Workspace Directory、逐 Google 服务授权开关、部分 Gmail 搜索扩展与规则条件、Gmail 服务器草稿标签／星标、自适应整库空间控制，以及实时推送。Google restricted-scope verification、Advanced Protection 与 CASA 属于外部审核事项。内置 AI 已实现，I01 至 I05 仍专指 Apple 原生能力。

parity 保留各次切片的历史基准与计数。涉及旧路径或旧工作树的记录用于追溯，当前模块入口按 [CONTEXT.md](../CONTEXT.md) 和[架构](architecture.md)读取。

## 手机端

### core 平台接口（slice 39 已完成）

Node 专用实现集中在 `packages/core/src/platform/node/`。手机从 `@openmail/core/portable` 加载 Mailbox、Store、迁移及 HTTP provider。接口见[架构的 Platform 端口](architecture.md#platform-端口)，逐文件清单见[平台依赖清单](platform-inventory.md)。

### 手机基础（slice 41 已完成）

已接入 Expo、React Native、op-sqlite、SecureStore、系统浏览器 PKCE 授权、账户／邮箱／会话列表、分页、受限 HTML 阅读、下拉同步及十种语言。根 `build` 只编译语言目录和检查类型；自动测试使用 Node SQLite shim 与原生服务 mocks。

### 手机邮件流程（slice 44 已完成）

已接入整理与撤销、多选、四种可配置滑动、长按／VoiceOver 操作、回复／转发／富文本撰写、联系人建议、文件与照片附件、本地草稿队列、持久离线发送与撤销发送、Gmail 操作符搜索和服务器回退、前台／下拉同步、账户与阅读／语言设置。发送复用 core 的 user/app 命令；没有新增迁移、OAuth scopes、后台 fetch 或推送。

自动测试覆盖屏幕逻辑、原生模块 mocks、两家 provider 的共享 core 命令、portable MIME、离线保留、失败后人工检查和数据库重开。未运行模拟器、Metro 或 EAS。仍需真机验证基础适配器、手势／无障碍、picker、附件投递及生命周期；阅读附件缓存、IMAP/SMTP、PDF、固定地址图片网络、端侧推理及数据库恢复待对应移动 adapter。后台刷新与推送按上面的推送决策继续。手机完整能力表、原生权限限制及配置只在[手机端说明](../apps/mobile/README.md)维护。

slice 44 修正：草稿只在实际编辑后自动保存，提供草稿入口与丢弃；邮件数据库从 cache 整目录迁入持久存储并排除 iOS 备份；照片重编码去除 EXIF／GPS，清理 picker 临时文件；入队前执行共享附件策略与累计大小检查，区分发送前拒绝与投递不确定。撤销发送与整理提示分开，重开富文本草稿保留样式，Outlook 移动列表不含 category、Drafts 或 Sent。暂时移除 icon 徽标与通知模块，屏蔽相机、麦克风、启动广播及通知权限。
