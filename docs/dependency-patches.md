# 依赖补丁

`pnpm-workspace.yaml` 的 `patchedDependencies` 列出 `patches/` 里的补丁。补丁按版本号绑定，升级依赖时 pnpm 会因版本不匹配报错，这时按下面的条件决定删掉补丁还是重做。三个补丁都只影响手机端。最后一节是 Effect 的版本覆盖，升级 Effect 时一起看。

## react-native-tcp-socket@6.4.3

IMAP／SMTP 的 TCP 和 TLS 传输。补丁改了四处：

- Android 的 TLS 连接校验证书主机名。上游 issue [#239](https://github.com/Rapsssito/react-native-tcp-socket/issues/239)，修复 PR [#240](https://github.com/Rapsssito/react-native-tcp-socket/pull/240)。
- iOS 在 TLS 握手完成前不发 `connect`。上游 issue [#237](https://github.com/Rapsssito/react-native-tcp-socket/issues/237)，修复 PR [#238](https://github.com/Rapsssito/react-native-tcp-socket/pull/238)。
- Android 的 STARTTLS 升级：读线程在升级期间让出 socket，不再用 `BufferedInputStream` 预读明文，否则会吞掉握手字节；升级完成后发 `connect`。
- 两端在 STARTTLS 握手完成后才发 `secureConnect`（`src/TLSSocket.js`、`src/index.js`）。

后两项上游还没有 issue。删除条件：#240 和 #238 合并并发布，且新版本的 STARTTLS 升级在 Android 和 iOS 上都等握手完成再发 `secureConnect`。

## expo-background-task@57.0.21

手机后台刷新（见 [apps/mobile/README.md](../apps/mobile/README.md)）。补丁把 iOS 的 `BGProcessingTask` 换成 `BGAppRefreshTask`（后台模式 `fetch`，标识符 `com.openmail.mobile.refresh`），去掉任务过期通知里多余的 `url` 判断；Android 的 WorkManager 约束改成非计费网络加电量不低，并挂到每个任务请求上。

上游 issue [expo/expo#48122](https://github.com/expo/expo/issues/48122) 提议让网络约束可配置。任务类型、标识符和电量约束没有上游 issue，属于 OpenMail 的取舍。删除条件：expo-background-task 允许按任务选择 app refresh 和自定义约束。在那之前每次升级都要重做这个补丁。

## expo-notifications@57.0.21

本地新邮件通知。补丁做 OpenMail 自己的事，没有对应的上游缺陷：

- 从库的 AndroidManifest 去掉 `RECEIVE_BOOT_COMPLETED`、开机广播和 Firebase 消息服务。OpenMail 没有推送，也不在开机后重新调度。
- Android 用 `openmailAccount` 给通知分组，用 `openmailPublicTitle` 生成锁屏公开版本，锁屏不显示发件人和主题。
- iOS 用 `openmailThread` 设置 `threadIdentifier`，同一会话的通知归成一组。

删除条件：清单部分可以改成 app 的 config plugin，用 `tools:node="remove"` 移除；分组、公开版本和 `threadIdentifier` 要等 expo-notifications 的本地通知内容提供对应字段。

## 版本覆盖：@effect/platform-node-shared

`pnpm-workspace.yaml` 的 `overrides` 把 `@effect/platform-node-shared` 固定在 4.0.2。Effect 的包按同一个版本号一起发布，`@effect/platform-node` 4.0.2 对它的依赖写的是 `^4.0.2`，pnpm 会解析到 4.0.3，而 4.0.3 要求 effect 4.0.3。没有这条覆盖，桌面和 CLI 会在 effect 4.0.2 上跑 4.0.3 的平台代码。

Dependabot 不改 `overrides`。升级 Effect 家族时同一个提交里处理这一条：新版本的 `@effect/platform-node` 能解析到同版本的 `platform-node-shared` 时删掉覆盖，否则把它改成新的版本号。用 `pnpm peers check` 确认没有 effect 的 unmet peer。
