# 测试

在仓库根目录运行：

```sh
pnpm build
OPENMAIL_LOW_MEMORY_TESTS=1 pnpm test
```

只跑完整邮件流程：

```sh
pnpm --filter @openmail/core build
OPENMAIL_LOW_MEMORY_TESTS=1 pnpm --filter @openmail/desktop exec vitest run --config vitest.e2e.config.ts
```

`apps/desktop/src/renderer/src/e2e/flows.test.ts` 用 jsdom、Testing Library 渲染真实 App，经 preload 同款 JSON RPC 和共用处理器调用真实 Mailbox。每项测试有临时 `node:sqlite` 数据库，复用 Gmail、Outlook、IMAP fake。不启动 Electron，不碰钥匙串或真实邮箱。窗口、剪贴板等桌面能力由支架提供，通知点击从核心通知队列进入桌面事件流。24 项流程约 10 秒。

扩展时，在同一文件新增测试，通过 `flow()` 配置邮件、provider 和偏好；用 UI 操作触发行为，同时断言 `server` 调用记录和 `store` 状态。用 `eventually()` 等待 RPC，`advance()` 推进自动保存、已读和撤回计时。`server.failNext` 注入一次失败，`beforePush` 注入持续失败或 Deferred 阻塞。`holdLists()` 可阻塞列表 RPC，验证导航与搜索交错。`afterEach` 关闭 Registry、RPC、Mailbox 并删除临时数据库。

同步重放回归在 `packages/core/src/pending-pull.test.ts`，覆盖三种 provider 的稍后提醒、唤醒、Flags 更新及队列索引。

检查每项流程能捕获故障：

```sh
node apps/desktop/scripts/e2e-mutations.mjs
```

脚本串行临时修改行为，要求所选测试全部失败，每轮恢复文件；覆盖全部 24 项。新增流程时同步扩展脚本的故障案例和总数。完成后再跑正常测试与 [AGENTS.md](../AGENTS.md) 中的检查。
