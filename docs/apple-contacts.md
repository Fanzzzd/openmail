# Apple Contacts 接入

Settings → Compose 中的 “Use Apple Contacts” 默认关闭。仅该开关开启时调用 `ContactsCLI --request`；启动、地址建议、菜单、刷新和照片查询只检查现有授权，不弹权限请求。拒绝、系统限制和部分授权显示独立状态，并提供 System Settings 入口。

本页维护 Apple 联系人的权限、快照和签名规则。模块位置见[架构](architecture.md)，MCP 与内置助手的数据范围见[代理使用指南](agents.md)，通用检查入口见[测试](testing.md)。

- `ContactsCLI.swift` 使用 CNContactStore，只读取标识符、姓名、邮箱、公司和联系人组。照片设置开启时才请求 thumbnail 字段，单张上限 256 KiB，本次快照总缩略图上限 8 MiB。
- 建议、组、照片和菜单立即使用已有内存快照；后台最多每十秒检查一次授权，每分钟刷新快照。手动刷新触发后台替换，保留旧快照直到完成。关闭开关、轮询发现撤权、helper 失败或无效 JSON 清空缓存；关闭照片立即去掉缩略图。迟到结果不能恢复已关闭或已撤权的数据。
- 每个窗口挂载联系人状态轮询。状态或快照版本变化会失效 `Keys.contacts`，刷新已有建议、组、照片和联系人标识符；状态查询不注册该 key，避免递归轮询。
- 请求权限超过 120 秒且进程被超时终止时显示“等待授权”，不再次申请。后续状态轮询发现授权或拒绝后更新界面；其他执行错误仍显示失败。
- `createAppleContactsCache` 是 core 导出的内存组件，只供 desktop RPC 适配器使用。没有数据库表、磁盘联系人缓存、网络请求、MCP 工具或 AI 上下文入口。Mailbox 的服务端联系人与 AI 路径不接入此快照。
- 地址建议合并及名称优先级见 [parity 的 C15 行](parity.md#composing)。Apple 来源使用进程内缓存，服务端／邮件历史沿用 Store 的查询。
- Apple 联系人组每人只展开一个邮箱。CNContactStore 没有分发列表首选地址 API；完整授权后通过公开的 `ABGroup.distributionIdentifier(forProperty:person:)` 读取组偏好，退回个人首选邮箱，再退回第一个有效邮箱。组成员只请求标识符和邮箱。部分授权只使用 CNContactStore 可见联系人，不访问 Address Book。失效偏好和重复组成员由 core 处理。
- “Open in Contacts” 只接受 UUID 或 UUID:ABPerson 标识符，打开保留冒号的 `addressbook://` URL；拒绝查询、片段、路径和其他记录类型。“Add to Contacts” 仅在点击后生成私有临时 vCard，通过 `/usr/bin/open -b com.apple.AddressBook` 打开 Contacts 的导入确认。helper 没有 CNSaveRequest 或其他写操作。临时文件沿用附件临时目录的权限和清理机制。

## 打包与权限

`build/build-vision.mjs` 编译 arm64／x86_64 并通过 lipo 合成 `out/native/contacts`，electron-builder 复制到 `Contents/Resources/native/contacts` 并签名。`mac.extendInfo` 提供 `NSContactsUsageDescription`，十种语言的 InfoPlist.strings 同步复制到 bundle Resources；中文同时提供 `zh_CN.lproj` 和 `zh-CN.lproj`。

[Apple 的通讯录 entitlement 文档](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.personal-information.addressbook)要求在 Hardened Runtime 的 Address Book 能力中声明 `com.apple.security.personal-information.addressbook`。主应用的签名／ad-hoc entitlement 保留此项；Electron 普通子进程的两份继承文件没有此项。`sign-contacts.cjs` 沿用 electron-builder 的签名选项，仅给 `Contents/Resources/native/contacts` 指定独立的 `entitlements.contacts.plist`。授权状态的处理依据 [Accessing the contact store](https://developer.apple.com/documentation/contacts/accessing-the-contact-store)。组内首选地址参见 [ABGroup](https://developer.apple.com/documentation/addressbook/abgroup) 和 [Contacts 分发列表说明](https://support.apple.com/guide/contacts/edit-distribution-list-lists-smart-adrbk1513/mac)。

## 验证边界

单测使用假 helper JSON、假 provider 和假模型，验证权限门控、十秒节流、后台慢读取、撤权失效、关闭／照片竞态、历史排序、组首选邮箱、严格 URL、固定 Contacts 导入、超时恢复和签名选项。composer AI 回归在账户 opt-in 开启后检查模型请求，确认没有 Apple 联系人快照字段。原生 helper 验证使用 `--self-test`，该模式检查纯函数和授权状态，不实例化 contact store 或读联系人。已有自动验证未启动 Electron，未读取真实通讯录；签名成品的系统授权、联系人卡跳转和导入确认仍需实机验收，列在[路线图](roadmap.md#待用户完成)。正式构建步骤见[发布说明](release.md)。无新迁移，不改 OAuth scopes。
