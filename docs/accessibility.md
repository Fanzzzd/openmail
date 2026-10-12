# 桌面无障碍

renderer 的自动检查覆盖组件语义、键盘操作、播报内容和主题色值。测试不启动 Electron，不代表已完成真实 VoiceOver 验收。

## 自动检查

| 文件                                                               | 范围                                                                                                                                                                                                                         |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/renderer/src/tests/accessibility.test.ts`        | axe-core + jsdom：侧栏、未读/星标/选中消息行、reader 标题/附件/邀请/身份验证警告、浮动和独立 composer、格式栏、收件人、附件菜单、发送确认、15 个设置页面、命令面板、账户添加、标签编辑、稍后提醒、AI 审核、确认框和 picker。 |
| `apps/desktop/src/renderer/src/tests/accessibility.test.ts`        | 中等级问题的精确快照。当前为空。每项例外须写测试名称、规则、节点选择器和原因；新增问题或已消失的例外都会使测试失败。严重和致命问题始终失败。                                                                                 |
| `apps/desktop/src/renderer/src/tests/accessibility-locale.test.ts` | 10 个界面语言激活后，文档 `lang` 与 locale 一致。目录读取使用 fixture，激活回调使用实际实现。                                                                                                                                |
| `apps/desktop/src/renderer/src/tests/accessibility-theme.test.ts`  | 浅色/深色主题正文、次要文字、强调色、错误色达到 4.5:1；边框和焦点色达到 3:1。另检查构建后的工具类、用户标签混色和选中行表面。                                                                                                |
| `apps/desktop/src/renderer/src/tests/accessibility-css.test.ts`    | 构建后的焦点样式、层级和弹窗边界。主题测试同时检查减少动画规则。                                                                                                                                                             |
| `apps/desktop/src/renderer/src/e2e/flows.test.ts`                  | jsdom 中实际 renderer/core 流程，包括键盘从列表进入 reader、回复和发送。                                                                                                                                                     |
| `apps/desktop/src/renderer/src/e2e/layout.test.ts`                 | 按窗口宽度切换三栏、两栏和单栏。单栏下用返回按钮、Escape 和 ⌘[ 从 reader 回到列表，焦点回到原来的行。侧栏抽屉打开时焦点在当前邮箱，Escape 关闭后焦点回到开关按钮。单栏下对话框铺满窗口，带关闭按钮。                         |

键盘测试检查对话框和 picker 的 Tab 循环、Escape 关闭、焦点返回，菜单的键盘打开和关闭，格式栏方向键，以及收件人 Delete 移除。消息行通过 Shift+F10 打开完整操作菜单，提供滑动和鼠标操作的键盘入口。

消息行名称只读发件人、主题、时间、未读和星标状态；选择状态由 `aria-selected` 提供。reader 的 polite 区域读出选中消息的发件人和主题，消息文本刷新不会触发重复播报。收件人移除、撤销提示和同步故障进入/恢复使用稳定的播报区域。同步时间和进度变化不播报。表单校验错误通过 `aria-describedby` 关联，发送错误同时用 alert 提示。

HTML 消息保留无脚本 iframe sandbox 和默认资源 CSP。消息文本使用 `dir="auto"`；HTML iframe 使用界面 locale 的 `lang`，带自己的焦点和减少动画规则。链接确认默认聚焦“取消”，关闭后将焦点交还原链接。

## 已知缺口

- jsdom 没有布局和绘制，axe 的 `color-contrast` 规则关闭。色值检查能验证已列出的主题组合，不能证明任意邮件 HTML、图片、透明叠层和所有动态背景的对比度。
- 未运行 Electron 或真实 VoiceOver。需在 macOS 上人工确认虚拟列表的浏览顺序、iframe 内链接确认后的焦点返回、收件人删除后的语音和连续操作时的播报节奏。
- 邮件没有可靠的语言元数据。HTML iframe 的语言暂时继承界面 locale；其他语言的消息仍可能需要用户切换读音。自动方向依据首个强方向字符，混合方向邮件及作者自己的样式需人工确认。
- 任意邮件 HTML 的标题、表格、图片替代文本和颜色由发件人提供，组件 fixture 不覆盖这些内容。框架内的标题层级通过 axe 检查。
- composer 当前提供“发送”、回复时的“发送并归档”和发送确认框，没有独立发送下拉菜单；附件菜单和发送确认均已覆盖。

运行完整检查前先构建，主题测试会读取构建产物。按 [AGENTS.md](../AGENTS.md) 的检查命令运行，并为测试设置 `OPENMAIL_LOW_MEMORY_TESTS=1`。
