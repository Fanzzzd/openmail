# 桌面安全

邮件 HTML、附件、链接、启动输入和 IPC 参数均不可信。保护目标是阻止邮件执行代码、读取本机文件、调用主进程或窃取 OAuth token、AI key。已控制操作系统或替换开发源码的攻击者不在此边界内。依据：[Electron 安全清单](https://www.electronjs.org/docs/latest/tutorial/security)。

| 控制                                                                                                                                                                                                                                                                                                                                                                                                                                | 实现位置（相对 `apps/desktop/src`）                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 所有窗口启用隔离、沙箱和 webSecurity；禁 Node、混合内容、实验功能和 webview；正式包禁 DevTools                                                                                                                                                                                                                                                                                                                                      | `main/security/security-policy.ts`、`main/windows/windows.ts`、`main/files/files.ts`、`main/app/database-upgrade.ts` |
| 禁导航、重定向和新窗口；iframe 的 HTML、SVG、area 链接同样拦截。邮件链接先由阅读器截获；域名不符或国际化主机须应用内确认，提示 Unicode 与 punycode；标签使用 innerText，经 NFKC／Unicode 句点规范化后检查每个 URL／域名标记。系统出口仅 http/https，限制长度、拒绝 C0/DEL、移除用户信息。邮件 mailto 只经五字段解析器打开撰写，忽略 attach 等额外字段                                                                               | `main/windows/windows.ts`、`main/security/external.ts`、`shared/external-url.ts`、core `link-security.ts`            |
| request/check/device 默认全部拒绝；仅应用顶层页可用 clipboard-sanitized-write，邮件 frame 和剪贴板读取仍拒绝。通知由主进程原生 API 提供                                                                                                                                                                                                                                                                                             | `main/security/security-bootstrap.ts`、`main/security/security.ts`                                                   |
| 应用通过 `openmail-app://app/index.html` 加载。仅 GET 读取 renderer 白名单资源；校验解码路径和符号链接。只启用 standard、secure、corsEnabled 和 codeCache。前三项供相对资源、独立来源和 ES 模块使用，codeCache 只缓存本地脚本的字节码                                                                                                                                                                                               | `main/security/app-protocol.ts`、`main/security/security-bootstrap.ts`                                               |
| 正式包 CSP 响应头与 meta 一致：script-src self，无 unsafe-eval，禁网络连接、插件和表单。开发 URL 仅 loopback，HMR 内联脚本和 WebSocket 例外仅在 Vite serve 生效                                                                                                                                                                                                                                                                     | `renderer/index.html`、`main/security/security-policy.ts`、`../apps/desktop/electron.vite.config.ts`                 |
| 邮件 iframe sandbox 无 allow-scripts；CSP 拒绝远程资源，远程图片设置放行该消息后仅加载 HTTPS。core 先按邮件首个 http/https base 解析相对链接和资源，再移除 base；HTTP 资源升级为 HTTPS，无 HTTP 回退。始终禁脚本、表单、插件及嵌套 frame。禁 DNS 预取，移除非 stylesheet 的 link；CSS 字符串 @import 与 image-set 同样经过资源和 tracker 重写                                                                                       | `renderer/src/features/reader/frame/EmailFrame.tsx`                                                                  |
| 应用窗口共用 session；打印使用独立内存 session，禁 JavaScript、拼写检查，只允许任务持有的临时文件和 data 资源。每个任务用 mkdtemp 建 0700 目录，文件 0600，结束后删除目录；启动时清理崩溃遗留的 openmail-print 目录，不跟随符号链接。应用拼写设置不影响打印                                                                                                                                                                         | `main/files/files.ts`、`main/files/attachment-temp.ts`、`main/windows/spellcheck.ts`                                 |
| IPC 只接受已登记的应用窗口顶层 frame、准确页面来源和 window 类型；顶层 frame 按 Electron 44 的 frameTreeNodeId 比较，不依赖包装对象身份。Schema 校验有界 envelope，再由每个 RPC 的 Schema 解码参数。preload 只暴露固定频道；错误不传堆栈或原始 provider/OS 细节；保留分类及自有固定 InvalidInput 文案。renderer 按分类显示翻译，e2e 使用同一解码与脱敏路径；renderer 按请求归属路由回复，避免短期密钥客户端在接收循环启动前丢失回复 | `main/security/security.ts`、`main/rpc/rpc-security.ts`、`shared/rpc.ts`、`preload/index.ts`                         |
| deep link 拒绝超长输入、控制字符、穿越、非法编码和额外 openmail 参数。mailto 只读取可人工检查的五个字段，忽略其他字段，不自动发送。open-file 只接受有界本地绝对路径，不解码为 URL；文件读取拒绝符号链接、非普通文件和超限内容                                                                                                                                                                                                       | core `system.ts`；`main/system/system.ts`、`main/security/security-policy.ts`、`main/files/dock-files.ts`            |

OAuth 回环服务器（core `platform/node/oauth.ts`）只接受 GET `/` 且 `state` 与本次登录一致的请求。路径、方法或 state 不符的请求得到 404，登录继续等待，例如 favicon、其他本机进程或伪造的 `?error=`。页面回显的 provider error 经 HTML 转义，响应带 `default-src 'none'` CSP。界面取消登录时中断 RPC，作用域结束后关闭服务器。回归见 `packages/core/src/platform/node/oauth.test.ts`。

主进程不启用 Node compile cache。缓存目录可被同一用户的任何进程写入，Node 只用源码 CRC 校验，植入的字节码会在持有钥匙串 token 的签名主进程中运行，绕过 ASAR 完整性和 fuses。

refresh token、IMAP 密码和 AI key 仅持久化于 core 的 `platform/node/secrets.ts` 系统钥匙串。renderer 仅获取配置状态；内置 OAuth 客户端值只编进主进程，renderer 只收到配置状态和来源，不含客户端值，见[发布](release.md#内置-oauth-客户端)；输入中的 key 临时经 IPC 保存，不写浏览器存储。浏览器存储仅保存界面设置，应用无复制凭据接口，主窗口和撰写窗口标题固定为 OpenMail；thread/message 使用去控制字符、最多 200 字符的主题。`main/index.ts` 的文件 logger 不记录原始错误；启动失败的 `Cause.pretty` 仅输出到 stderr；core `platform/node/diagnostics.ts` 在写入和导出时限制字段，账户只保留散列。未启用 crashReporter，并设置 disable-breakpad；系统自行生成的内存转储由操作系统策略管理。联系人和通知设置的系统协议由主进程固定构造，邮件不能指定。

`electron-builder.config.cjs` 的 afterPack 调用 `build/security-fuses.cjs`，签名前关闭 RunAsNode、NODE_OPTIONS、CLI inspect、file 额外权限；开启 CookieEncryption、ASAR 完整性、OnlyLoadAppFromAsar。完整性依赖正式包的 ASAR 元数据和签名。参见 [fuses 文档](https://www.electronjs.org/docs/latest/tutorial/fuses)。

macOS 启用 hardened runtime。`build/entitlements*.plist` 仅声明：

- `allow-jit`：Electron/V8 主进程及 helper 所需。
- `personal-information.addressbook`：可选本机联系人功能，应用和 contacts helper 声明，其他继承 helper 不授予。
- `disable-library-validation`：仅未签名构建，用于无团队签名的原生依赖；正式签名配置不含此例外。推理使用 Electron 的专用 Plugin utility process，见 `main/app/inference.ts`。
- contacts helper 仅有 addressbook，无摄像头、麦克风、定位、Apple Events 或全磁盘权限。

验证：`security.test.ts`、`rpc-security.test.ts`、`files-security.test.ts` 及现有窗口、iframe、诊断和钥匙串测试；读取构建后的 HTML、preload、JS。fuses 测试修改临时模拟二进制的真实 fuse wire，不修改已安装的 Electron。使用 `OPENMAIL_LOW_MEMORY_TESTS=1`。本次未启动 Electron、未生成签名安装包；运行时及正式签名仍需发布流程验证。

CookieEncryption 在 macOS 使用系统钥匙串。ad-hoc 签名的本地包或重签名后首次启动可能弹出 Chromium cookie 加密密钥访问提示，反复重建也可能再次询问。这与 OpenMail 的 OAuth/API key 钥匙串项不同；不为消除提示关闭 fuse，因为关闭后已有 cookie 存储可能无法使用。参见 [Electron cookieEncryption](https://www.electronjs.org/docs/latest/tutorial/fuses#cookieencryption)。

frame 标识依据：[Electron WebFrameMain](https://www.electronjs.org/docs/latest/api/web-frame-main#frameframetreenodeid) 及已安装 Electron 44 类型定义。frameTreeNodeId 在浏览器内唯一，生命周期内固定。

## 邮件内容保护

可见文本过滤是没有浏览器布局引擎的 CSS 模型，只提供纵深防御。主防线是不可信邮件内容封套，以及每次写操作的人工确认。过滤器对未知图片绘制、无法解析的颜色、媒体条件与动态选择器、CSS 嵌套、伪元素、滤镜与混合模式、重叠绘制和预算耗尽均保守处理，不能证明可见的文字不进入模型。

- 模型上下文和文本向量先走 `prepareMessageHtml` 和 `sanitizeReaderHtml`，再将保留的邮件 HTML 放入阅读器参考 shell：html／head／`body dir="auto"`，原 body 属性由清洗器映射到 `openmail-reader-body` 容器。使用 [parse5](https://parse5.js.org/) 的 HTML5 解析，包括表格 foster-parenting；只索引阅读器保留的 style。控制表单、SVG／MathML、活动内容和媒体后备内容不进文本。原始结构诊断仍单独统计缓存 HTML，不代表实际渲染树。
- 字号与 visibility 按元素继承，在文本叶节点判断。em／百分比按父字号，rem 按根字号；明确的 px／pt 字号和 visibility:visible 可恢复可读后代。零字号容器不提前剪掉子树。font 简写和可计算的 calc／min／max／clamp 参与计算；有效但无法确定的字号、revert-layer、all、var／env／attr 保守处理。无效声明与 `!ie`、`!importantx` 等非标准 important 标记不覆盖有效隐藏值。
- 各级 opacity、filter opacity、scale／zoom 的衰减累计后与 0.1 阈值比较。删除 display:none、hidden／aria-hidden、content-visibility:hidden、极小字号、透明文本与 -webkit-text-fill-color、低对比度文本、巨大偏移、常量退化变换、裁剪、零尺寸与隐藏 overflow／contain:paint 组合、全透明渐变 mask。厂商 -webkit／-moz 属性先归一到标准名称。除已建模的纯 opacity() filter 外，非 none 的 filter／backdrop-filter 及非 normal 的 mix-blend-mode 均按绘制不确定移除整个子树。支持独立 scale／translate、translate 变换、rotateX／rotateY 边缘投影、退化 matrix、right／bottom／inset／margin-inline-start 正向大偏移、calc 负缩进及不大于 -100% 的缩进。祖先已被剪掉时，后代不能恢复。
- color-string 解析命名颜色、HSL、百分比 RGB 和 4／8 位 hex。HTML bgcolor／font color 按 [WHATWG 旧式颜色算法](https://html.spec.whatwg.org/multipage/common-microsyntaxes.html#rules-for-parsing-a-legacy-colour-value) 解析。background 简写展开为 background-color／background-image，与长写共享顺序、specificity 和 important 优先级；none／透明色透出祖先背景，alpha 色合成到同场景的父背景。文字与合成后的有效背景按相对亮度计算对比度，计入前景 alpha 和继承 opacity；低于 1.5:1 按隐藏风险剔除，草稿加载与传输清洗沿用同一规则。远程 URL 背景使用默认被 CSP 拦截时的 fallback 色，同样按有效对比度判断；CSS 或旧式 background 属性中的 data／cid 图片始终可能加载，按未知绘制处理；渐变的每个颜色 stop 和巨大 inset box-shadow 都参与比较。无法解析的 ink 或背景不能证明对比度，按 uncertain-paint 移除。部分宽度范围或动态选择器保留隐藏候选，不混用 light／dark 或其他环境的颜色。
- 阅读器与过滤器共用 reader-style 的默认颜色，包括链接和 mark。::first-line／::first-letter 的颜色或隐藏规则使目标文字不确定。CSS 嵌套规则尚未展开，匹配其外层选择器的子树按 uncertain-css 移除。在同一 containing block 内，定位、变换、负 margin、outline 和 outset shadow 的绘制检查不依赖 DOM 前后顺序。普通 painter 仅按墨色匹配移除文字，忽略小于 10px 的负 margin。替换元素仅在 absolute／fixed 或 transform 下，且两个轴的声明尺寸均达到 containing block 的一半，或明确 inset:0 时，作为未知绘制参与；装饰性小图片不参与。独立覆盖规则检查明确的整块不透明遮罩、向上移动且具有足够高度的整行不透明块，以及能伸入邻近文本行的厚实 outline；仅移除覆盖范围内的文字。inline-block 或 inline 替换元素的横向负 margin 至少 10px，且声明宽度覆盖该位移、声明高度容纳一行时，只检查前方 inline 兄弟；替换元素按未知绘制移除，已知不透明背景按覆盖后的同色移除。margin 简写先展开为长写，共享顺序与 important 优先级。负 z-index 仅作为背景参与比较；inset shadow 在任意 spread 都作为背景。按 positioned-overlay 计数，不执行浏览器几何布局。暗色阅读器只对图片、视频、picture、SVG image 和 URL 背景反转第二次，渐变及 SVG 文本随页面反转一次。
- HTML 优先于 plain alternative，差异明显时标记 `plain-differs`，移除隐藏文本时标记 `hidden-text-removed`。检查预算耗尽时返回 `budget-exceeded`，模型省略该封文本；搜索索引可保留非活动原文。摘要与回答作为纯文本显示，URL 和电话不会自动变成链接。MCP 列表和搜索不返回 provider snippet。实现：[visible-text.ts](../packages/core/src/visible-text/visible-text.ts)、[model-view.ts](../packages/core/src/ai/model-view.ts)、[semantic-indexer.ts](../packages/core/src/ai/semantic-indexer.ts)。
- CSS 预算耗尽时，用固定占位文本 `[Message too complex for AI: message text omitted.]` 省略消息文本。所有外发工具结果的邮件派生字段统一放入 `untrusted_mail`，并带固定 `notice`。引用移除识别 In-Reply-To、匹配的 `>` 引用、`On … wrote:`，以及完整的 From/Sent/To/Subject 回复头块；后两种不依赖缓存邮件头。无可靠边界时移除 `>` 行会返回 `quoted-text-removed` 和字符数。
- 认证结果只考虑按收到顺序排列的最上一个 Authentication-Results，低位头不能建立或覆盖信任。Gmail 要求 authserv-id 为 `mx.google.com`。IMAP 默认 unknown；用户可在每账户设置显式填写管理员提供的 authserv-id，必须与最上一个头匹配，IMAP host／预设不代表信任。变更该设置会清空该账户的缓存认证结果。Microsoft 格式没有 authserv-id：原始头解析仅接受格式以 spf/dkim/dmarc 开始，首个 Received 的接收方为 `*.outlook.com`，且认证头位于首个接收 hop 的头块内（第二个 Received 之前，可在首个 Received 上方或后方）；其他顺序均 unknown。当前 Graph 的认证结果固定为 unknown：delta `$select` 不含 `internetMessageHeaders`；普通消息 GET 仍取邮件头供本地搜索使用，但不依据其顺序建立认证信任。因此 Outlook 不启用认证相关的自动图片或一键 POST。AR 先移除嵌套注释与引用字符串，再按顶层分号解析，每种方法取最后一次结果。迁移 32 存储 DMARC/SPF/DKIM 与安全退订目标；旧缓存缺少结果时仍为 unknown。发件人名称去除 Unicode Cf 字符，阅读器始终显示地址，DMARC 失败和名称夹带其他地址均告警。长期图片许可仅在可信 DMARC pass 时生效，否则逐封加载。Reading 设置的远程图片默认“总是”。prefs 表没有 `remoteImages` 行时 `remoteImagesChosen` 为 false，该字段只由这一行推导，不进 `PrefsPatch`。桌面有账户后在主窗口显示一次选择卡片，选择或关闭后写入该行，此后不再显示；关闭记为“总是”。手机没有卡片，未选择时按“每次询问”处理。设置页在未选择时不选中任何项，点哪一项都会记录。prefs 未加载或加载失败时阅读器按“每次询问”处理；无法解析的行也按“每次询问”。旧版存的布尔值视为已选择，false 为询问。“每次询问”只放行 DMARC pass 的允许表发件人；“来自我认识的人”只对服务端联系人、桌面开启的 Apple 通讯录、本账户或发过邮件的地址生效，且同样要求 DMARC pass，因此 Outlook 和未配置可信 authserv-id 的 IMAP 不会自动加载；“总是”加载所有邮件。core `shouldLoadRemote` 统一判断，桌面和手机共用。“加载图片”只放行点击时显示的消息，之后加入会话的消息仍会询问。已知跟踪器和 1×1 像素在任何模式下都移除。cid 内嵌图片来自缓存原文或服务商，始终显示，不触发提示。IMAP 管理者须确保服务器剥除外来同名认证头。实现：[message-security.ts](../packages/core/src/reader/message-security.ts)、[Gmail](../packages/core/src/providers/gmail/gmail.ts)、[Outlook](../packages/core/src/providers/outlook/outlook.ts)、[Node IMAP](../packages/core/src/platform/node/imap/adapter.ts)、[store.ts](../packages/core/src/store/store.ts)；`Reader.tsx`、`AccountControls.tsx`。
- 邮件打开链接默认去掉 `utm_*`、fbclid、gclid、mc_eid、mc_cid，可在 Reading 设置关闭。仅删除原始 query 中对应的段，保留其余字节编码；存在 `X-Amz-*`、Signature／sig／signature、token、hmac、Expires、Key-Pair-Id 或 Policy 时完全跳过清理。浏览器的 popup 出口始终拒绝，无法跳过阅读器确认。邮件 mailto 不交给 shell，发送仍须人工审阅。域名比较使用注册域并包含私有后缀；实现见 [link-security.ts](../packages/core/src/reader/link-security.ts)和 [email-links.ts](../apps/desktop/src/renderer/src/features/reader/frame/email-links.ts)。
- 可执行文件、磁盘映像、宏文档、Finder 位置文件、Windows 启动器、系统导入及活动文档扩展不交给 native open/preview/openWith/share/copy/drag；保存仍允许。保存和打开的文件经 `/usr/bin/xattr` 写入 com.apple.quarantine。自定义保存文件夹只能由主进程的文件夹选择器写入；renderer 的 SetPrefs 只能把它重置为询问或下载，传入路径会被拒绝，已保存的路径继续有效。HTML/SVG 的打开与预览走无脚本、禁远程资源的 EmailFrame。ICS/VCF 进入应用内预览，添加联系人或日历事件须单独点击；iTIP 邀请仍走回应流程。IMAP 无日历写权限，只读会话禁止日历导入写入，联系人导入沿用 macOS Contacts 支持。实现：`main/files/attachment-filenames.ts`、`attachment-actions.ts`、`files.ts`、`attachment-folder.ts`、`file-quarantine.ts`、`shared/renderer-prefs.ts`、`AttachmentImportDialog.tsx`；core `attachment-import.ts`。
- 所有 provider 都显示 organizer 与 MIME From 不同的邀请警告，Sender 头不能压过真实 From。未知 agent surface 或不在该 surface 操作清单内的命令默认拒绝。实现：core `invites.ts`、`policy.ts`；`InviteBanner.tsx`。
- 退订先显示目标并确认。仅当可信 provider 的 DKIM pass 通过 d（或 i 的域）/s/b 唯一对应一条签名、d 与 From 的注册域对齐、且 h 覆盖 From 和两个唯一的 List-Unsubscribe 头时，才启用 RFC 8058 HTTPS POST。认证元数据缺失、签名歧义或覆盖不足时仅允许 mailto 经撰写确认；没有安全路径则不显示退订按钮。Node adapter 解析并固定公共 DNS 地址，只发 `List-Unsubscribe=One-Click`，无 cookie、Authorization 或重定向，也不 GET 任意退订 URL。只读会话禁止 POST；其他平台未提供 POST adapter 时拒绝执行。实现：core `message-security.ts`、`unsubscribe.ts`、`platform/node/unsubscribe.ts`；`UnsubscribeButton.tsx`。协议依据：[RFC 8058](https://www.rfc-editor.org/rfc/rfc8058)。

响应式级联和继承仍在 `W={720,1080}` CSS px 分别计算，只保留所有环境场景和两个宽度都可见的同一 DOM 文本节点。参考环境为 screen／非 print。prefers-color-scheme 按 light／dark 分别计算；消息涉及的 hover、pointer、orientation 及 WebKit 像素比也枚举一致场景，WebKit 另包含特征不受支持的情况。width 条件按各参考宽度精确判断；不在当前宽度匹配的隐藏规则不应用。因此仅在 600px 以下隐藏的桌面版本可保留，窄屏移动版本被排除；相同文本不能跨两个互斥节点拼出可见性交集。

解除隐藏另须证明声明在 0–8000 整数 CSS px 的安全范围内均匹配。相同属性、值和优先级的连续互补规则可合并证明，600／601px 断点对可覆盖该范围；min-width:320px、max-width:1920px 等部分范围不能单独解除隐藏。同一场景中，匹配条件的颜色、背景和其他声明一起进入级联，不能拼接不同场景的前景与背景。无法精确求值的条件及 @supports／@layer／@container 同时检查匹配和不匹配的保守场景；最多 64 个环境组合，超限返回检查预算标记。匹配选择器只允许类型、class、id、组合器、阅读器保留的属性和静态伪类解除隐藏；:read-only、:lang、:hover、:visited 等动态伪类仅能隐藏。

规则体只解析一次，单块最多 8192 个声明；只保存读取的属性、最后有效值和 important。按规则 ID 共享匹配列表与逐宽度级联，按属性键排序后线性合并显示覆盖；每键最多 256 个区间，超过上限不建立完整覆盖证明。匹配优先级依次为 important、选择器优先级和源码顺序；`:where` 为零，`:is`／`:not`／`:has` 取参数最大值。stylesheet important 可覆盖普通内联值，内联 important 优先。语义依据：[Media Queries](https://www.w3.org/TR/mediaqueries-4/) 和 [CSS Cascade](https://www.w3.org/TR/css-cascade-5/)。

可见文本提取采用保守静态 CSS 判断，不运行浏览器布局或外部样式表；不能证明任意 CSS 都与实际像素一致。未覆盖覆盖层、元素遮挡及 DARK_CSS 的暗色双重反转；不运行浏览器布局，也不提取 CSS 生成内容。暗色反转由 renderer 单独处理。回归包含 Gmail／Microsoft／Fastmail 格式、顶层失败与低位伪造通过、AR 注释／引用注入、IMAP 信任保存与撤销、MCP snippet 删除、CSS 隐藏方式、Unicode／嵌入式链接标签和签名 query 保留，以及先前的 DKIM、退订、附件和 agent policy 样例。未启动 Electron，也未对真实邮件服务执行退订。

- 搜索词和“在邮件中查找”的命中用 [CSS Custom Highlight API](https://developer.mozilla.org/docs/Web/API/CSS_Custom_Highlight_API) 绘制：core 的 `textSearchHits` 在文本节点里找命中，阅读器建 Range 并登记到 frame 自己的 `CSS.highlights`，邮件 DOM 不增加元素、class 或属性。邮件 CSS 因此无法用 `:has()`、属性选择器或计数器得知搜索了什么，再经 `background:url()` 传出。`::highlight()` 只接受颜色和文字装饰，不能加载 URL。邮件 CSS 中含 `:has()` 的选择器另被移除，作为纵深防御；规则的其他选择器保留。显示引用和贴合页面仍会改 `hidden` 与内联样式。真实 Chromium 回归见 `apps/desktop/src/main/remote/reader-frame.test.ts` 的 highlightdom 用例。实现：[search-highlight.ts](../packages/core/src/search/search-highlight.ts)、`renderer/src/features/search/text-highlights.ts`。
- 阅读器清洗器丢弃 `<link>` 与 `@import`，渲染层 CSP 继承应用页面的 `style-src 'self' 'unsafe-inline'`。邮件 frame 自己的 CSP 也只允许 `style-src 'unsafe-inline'`，图片放行时同样不加载外部样式表：样式表内的 `url()` 与 `@import` 不经过 tracker 和像素过滤。回归见 `email-frame.test.ts`。
- 最近搜索只存在本机 renderer 的 localStorage（`openmail.recentSearches`，最多 8 条），不进数据库、日志或同步，移除任一账户时清空。实现：`apps/desktop/src/renderer/src/state/recent-searches.ts`。

## 服务商诊断

桌面在 `OPENMAIL_HOME/diagnostics/diagnostics.jsonl` 记录固定字段，默认数据目录见 [README](../README.zh-CN.md#cli-与-mcp)。Gmail／Graph 的 `provider-failure` 只保存时间、服务商、HTTP 方法、端点模板、可用的 status、failure 分类和账户 ID 的 16 位 SHA-256 前缀。搜索失败还保存 operation=search 和固定枚举的 Graph error.code，未知代码保存 unknown；延期不写事件。不保存完整 URL、query、资源 ID、消息文本、错误正文、堆栈或 token。该格式不提供 IMAP 协议逐条日志，也不证明散列匿名化。

`failure` 分为 `http`、`transport`、`credentials`、`configuration`、`other`。只有实际传输失败用 status 0；缺少 OAuth client 属于 configuration，无 HTTP 状态。凭证失败与局部服务权限不足分别处理，可选端点的权限 403 在重新登录前停止重复请求，不暂停正常邮件同步；限流或未启用 API 不按此规则缓存。

`reauth` 事件在账户被标记为需要重新登录时写入一次，只含时间、服务商、原因代码和账户 ID 的 16 位 SHA-256 前缀。原因代码的含义见[同步正确性](sync-correctness.md#重新登录的判定)。

同步失败时，core 只保存按原因分类的固定英文句子（quota、auth、network、server、unknown，以及 IMAP 连接的 dns、refused、no_response、tls、unsafe_login），不保存 provider 的错误正文。连接原因的句子与应用其他地方的提示相同，说明该检查哪项设置；unsafe_login 不自动重试。桌面按原因显示翻译后的固定文字；旧版本存下的原始文本一律显示为 unknown 的文字。同时写一条 `runtime-warning`，reason 为 `sync-failed`，只含服务商（含 imap）、分类、full／inbox 范围、可用的 status 和账户 ID 的 16 位 SHA-256 前缀。实现见 [sync-failure.ts](../packages/core/src/sync/sync-failure.ts)。

`sync-reset` 诊断还记录服务商、listing／reset／verification 阶段、账户与文件夹哈希，以及列出、保留、候选、已验证和延期等计数，不记录候选 ID。runtime-error 的 sync-crashed 还允许固定 phase 和 causeKind，不导出异常内容或堆栈。RPC renderer 回调显式返回 void，防止 Fiber 经 contextBridge 返回时触发克隆错误；回归用 structuredClone 检查 JSON 帧和回调返回值。事件定义见 [sync-reset.ts](../packages/core/src/sync/sync-reset.ts)，落盘与导出沿用同一字段白名单。

每文件默认 256 KiB，另保留最多三份轮转档。Feedback 展示导出预览并让用户选择附件，创建反馈草稿不自动上传；旧日志在预览时重新按白名单编码。RPC 失败仅记录方法名，不记录参数，正常中断不记录。实现见 [provider-diagnostics.ts](../packages/core/src/providers/provider-diagnostics.ts)、[diagnostics.ts](../packages/core/src/platform/node/diagnostics.ts)、[reliability.ts](../apps/desktop/src/main/app/reliability.ts)和 [Feedback.tsx](../apps/desktop/src/renderer/src/features/feedback/Feedback.tsx)，回归见 [provider-diagnostics.test.ts](../packages/core/src/providers/provider-diagnostics.test.ts)。

只读会话的范围只在[架构](architecture.md#只读会话)维护；smoke 的原始 console 和 stderr 不是上述脱敏日志。解析器 fuzz 与无障碍测试的运行方式和限制只在[测试](testing.md#解析器-fuzz-与无障碍)维护。

## 连接 AI 应用

「设置 > AI 权限 > AI 应用」检测 Claude Code、Codex、Claude 和 Cursor，并读取它们的 MCP 配置判断连接状态。读取只解析配置，不改文件。OpenMail 只在用户点击「连接」「重新连接」或「断开连接」并在确认框里看过改动后，才改别的应用的配置：

- 确认框列出要运行的命令（argv）和配置文件的 diff。主进程在应用前重新计算，预览令牌不同就拒绝，要求重新预览。直接改文件时令牌是整个文件的哈希；走 CLI 时只哈希 `openmail` 条目，因为 Claude Code 随时改写 `~/.claude.json` 的其他部分。
- Claude Code 用 `claude mcp add-json --scope user openmail <条目 JSON>` 和 `claude mcp remove --scope user openmail`。`add` 拒绝已有名称，所以重新连接先 remove 再 add-json；add-json 失败时用旧条目再 add-json 一次，放回原状。没找到 `claude` 时只提供复制命令。
- Codex 新连接用 `codex mcp add`，断开用 `codex mcp remove`。`codex mcp add` 只能写命令、参数和 env，所以重新连接直接改 `config.toml`。没找到 Codex CLI 时同样直接改文件。CLI 都用 `execFile` 加固定 argv 运行，不经过 shell，30 秒超时。
- Claude 和 Cursor 没有 CLI，主进程直接改 JSON。重新连接只改条目里的 `command`、`args` 和 `env.OPENMAIL_HOME`，用户自己加的键（`disabled`、`autoApprove`、`startup_timeout_sec`、其他 env）保留。JSON 用 jsonc-parser 逐键做最小文本编辑，保留 BOM；TOML 只替换 `[mcp_servers.openmail]` 表及其子表这一段文本，段内注释不保留，其余内容和注释原样保留。改完把前后两份都解析一遍：`openmail` 条目必须等于预期，删掉它之后剩下的内容必须完全相同，否则拒绝。文件解析失败或条目写成内联表时同样拒绝，不猜。
- OpenMail 自己改文件之前在原文件旁写备份 `<文件名>.openmail-backup-<UTC 时间>[-n]`，保留原权限，每个文件按时间和序号留最新 5 份。CLI 自己改文件，不另做备份。写入走同目录临时文件加 rename，保留原权限；配置是符号链接时写到链接目标，链接保持不变。
- 配置条目里只有命令、参数，以及数据目录不是默认值时的 `OPENMAIL_HOME`。不写 token、密钥或其他凭证。
- 条目的命令是绝对路径但文件已不存在（例如版本管理器删掉的 Node）时，卡片显示指向另一个副本，提示重新连接。查找 CLI 时除 PATH 外还看 `~/.local/bin`、Homebrew、`~/.npm-global/bin`、Volta、Bun、pnpm，以及 fnm 和 nvm 的默认版本；只取解析后的绝对路径，不用 fnm 每个 shell 临时建的 multishell 目录。

打包的 app 用自己的可执行文件启动 MCP：`OpenMail --mcp [--allow-writes]`。RunAsNode fuse 保持关闭，所以 `ELECTRON_RUN_AS_NODE` 不能让任意脚本借用 app 的签名、TCC 授权和钥匙串访问。`--mcp` 只运行 CLI 包里的 MCP 服务：不开窗口，不进 Dock，不取单实例锁。Chromium 数据放在每个进程自己的临时目录 `OpenMail MCP <pid>`，退出时删除，启动时清掉已退出进程留下的目录，多个客户端同时启动服务也不共用目录。MCP 服务等 Electron ready 之后才启动，因为推理 worker 是 utilityProcess。开发构建用 `node packages/cli/dist/cli.js mcp`。

MCP 服务每次工具调用写一行 `agent_activity`（CLI 的 `openmail tool` 命令不写）：时间、客户端名、工具名、成功与否，不含参数和结果，最多 500 行。设置页按客户端显示最近的调用。实现见 [ai-clients.ts](../apps/desktop/src/main/agents/ai-clients.ts)、[mcp-config.ts](../apps/desktop/src/main/agents/mcp-config.ts) 和 [mcp-mode.ts](../apps/desktop/src/main/agents/mcp-mode.ts)，回归见 [ai-clients.test.ts](../apps/desktop/src/main/agents/ai-clients.test.ts)，测试只用临时 HOME 和假 CLI。

## 远程访问

用户可以在手机或另一台电脑的浏览器里使用这台 Mac 上的 OpenMail。默认关闭，在 Settings > Remote access 打开。

```
手机浏览器 ──WireGuard (tailnet)──▶ Mac 上的 Tailscale app
                                     │  tailscale serve --https=8443
                                     │  加 Tailscale-User-Login / -Name，保留 Host
                                     ▼
                     OpenMail 主进程 http://127.0.0.1:<port>
                       ├─ GET /、/assets/*   out/web 静态文件
                       ├─ GET /api/attachment 附件下载
                       ├─ POST /api/upload    附件上传
                       └─ WS /rpc             RemoteRpcs（Effect RPC）
                                     ▼
                                 packages/core
```

主进程只做传输：HTTP、WebSocket、会话、Tailscale CLI 调用。邮件逻辑仍在 core，远程 RPC 复用 `shared/mailbox-handlers.ts`。代码在 `main/remote/`。

### 发布

- OpenMail 先找 Tailscale app 自带的 `/Applications/Tailscale.app/Contents/MacOS/Tailscale`，再找 CLI 单独安装的 `/opt/homebrew/bin/tailscale`、`/usr/local/bin/tailscale` 和 `PATH` 里绝对路径目录下的 `tailscale`（`tailscale.ts` 的 `tailscaleCandidates`）。它们连同一个 tailscaled，`status`、`serve` 和身份头行为相同。调用一律用 `execFile` 和固定 argv，不经过 shell。OpenMail 不安装任何东西，都找不到时设置页给出 tailscale.com/download 链接。
- 打开前依次检查：已安装、已登录、tailnet 开了 HTTPS 证书（`status --json` 的 `CertDomains` 非空）。
- 先读 `serve status --json`。8443 已被别的映射、TCP 转发、前台 serve 或 Funnel 占用时拒绝，不覆盖。之后运行 `tailscale serve --bg --https=8443 http://127.0.0.1:<port>`。
- 关闭时运行 `tailscale serve --https=8443 off`，只在映射指向本应用端口时执行。`serve status` 或 `serve off` 失败时（例如 Tailscale 没在运行）不报告“已关闭”：状态为 `error`，问题为 `removeFailed`，设置页提示没能移除映射。控制器记下这个映射，每 30 秒（`RETRY_MS`）和每次 Refresh 重试，Tailscale 恢复后按同样的归属检查移除。
- 只读会话（`OPENMAIL_READ_ONLY=1`，例如 smoke）不运行 Tailscale CLI，视为未安装，不发布也不移除映射（`sessionTailscale`）。
- 启动时设置为关闭但存过端口（上次可能崩溃在开启状态），同样检查一次，映射指向本应用旧端口时移除。Tailscale 不可达时不报错，后台重试。
- 退出应用时同样移除映射，最多等 3 秒（`QUIT_TIMEOUT_MS`），设置保持打开，下次启动重新发布。否则应用关闭期间映射仍指向空着的 loopback 端口，本机其他进程或其他 macOS 用户可以占用该端口，接收 tailnet 流量和身份头。超时或 CLI 失败时映射会留下，下次启动时 `serve status` 识别为本应用的旧映射并替换。
- serve 目标只用 TCP loopback。macOS 图形版 Tailscale 是沙盒内的网络扩展，大概率读不到用户目录下的 unix socket，没有实测前不改用 socket 目标。
- 从不运行 `tailscale funnel`。`serve status` 里该端口有 `AllowFunnel` 时拒绝启动。
- 可选的 Tailscale Service（如 `svc:openmail`）改用 `serve --service=svc:openmail --https=443`。

### 每个请求的检查

`checkRequest`（`remote-auth.ts`）按顺序检查，任一失败返回 403 或 421：

1. TCP 来源是 loopback。服务只监听 127.0.0.1，这一条防止监听地址改错。
2. 没有 `Tailscale-Funnel-Request`。
3. 有 `Tailscale-User-Login`。Serve 只给 tailnet 里属于某个用户的设备加这个头；本机直接访问和 tagged 设备都没有，因此被拒。
4. `Host` 等于 `<magicdns>:8443`（或 Service 的主机名）。挡住 DNS rebinding。
5. login 在允许列表里，大小写不敏感。列表默认是这台 Mac 自己的 tailnet 登录名，只在第一次打开时写入一次，最多 64 个。

WebSocket 升级和上传还要求 `Origin` 等于 `https://<host>`。

### 会话

Tailscale 身份才是凭证。会话只把一个浏览器的 WebSocket、下载和上传绑到它的 login 上，方便列出和断开。

- 只有应用页面（无扩展名的路径）签发 `__Host-openmail-session`，静态资源和 404 不签发：HttpOnly、Secure、SameSite=Strict、Path=/。值是随机 id 加 HMAC，密钥每次启动重新生成。
- 会话绑定 login，12 小时过期，存在主进程内存里，退出即失效。请求的 login 和会话的 login 不一致时拒绝。最多 50 个，超过时结束最早的一个。
- 服务器每 60 秒清理一次过期会话，关闭其 WebSocket（关闭码 4401）。
- 设置页的 Disconnect 只结束一个会话并关闭其 WebSocket。只要 login 还在允许列表里，浏览器重新加载就会拿到新会话，页面提示也这样写。要真正拒绝某人，从允许列表删掉其 login：其会话立即结束，之后的请求都被拒绝。

### 远程 RPC 表

`shared/remote-policy.ts` 的 `REMOTE_RPC_POLICY` 列出允许的 RPC，`main/remote/remote-rpcs.ts` 的 `RemoteRpcs` 只由这些 RPC 组成。不在表里的 RPC 在远程服务器上没有处理器，请求被拒绝并记日志。`remote-rpcs.test.ts` 固定了完整的允许列表和必须拒绝的列表，并断言新增 RPC 默认被拒。

web 构建读同一张表。`lib/platform.ts` 的 `canCall(tag)` 在桌面恒为真，在 web 构建里只对表里的 RPC 为真。会调用被拒 RPC 的控件按它调用的 RPC 隐藏，例如“重新登录”在 web 上换成“在 Mac 上重新登录”。

允许：读取、搜索、撰写、发送（与桌面同一个发件箱和撤销发送）、整理（归档、标签、稍后提醒、删除）、联系人建议、日历邀请回复，以及 `REMOTE_PREF_KEYS` 里的邮件和界面偏好。

拒绝：本机文件和 Finder、打开浏览器、打印、窗口、剪贴板、OAuth 和添加账户、钥匙串、MCP 和 AI key、更新、退出和恢复、默认邮件客户端、Apple 联系人、远程访问设置本身。

`OPENMAIL_READ_ONLY=1` 在 core 的 provider 层生效，远程写入同样被拦截。远程发送不另加确认，和桌面一样走撤销发送。

### 附件

- 下载：`GET /api/attachment?message=<id>&part=<path>`，需要会话。响应 `application/octet-stream`、`Content-Disposition: attachment`、`Content-Security-Policy: sandbox`，浏览器不会在本源下渲染附件。
- 上传：`POST /api/upload?account=<id>`，需要会话、Origin、存在的账户和 Content-Length（缺少返回 411），因此账户的类型检查总会执行。限制和桌面相同：合计 30 MB；Gmail 拒绝的类型返回 415。同时最多两个上传，再多返回 503。请求体按声明长度读入一个缓冲区，解析后编码为 base64 交给 core。

### 浏览器页面

- `out/web` 是同一套 renderer 的第二个 Vite 构建，入口 `renderer/web.html`、`renderer/src/web.tsx`。
- 响应头：`default-src 'self'`、`connect-src 'self'`、`frame-ancestors 'none'`、`object-src 'none'`、`base-uri 'none'`，另有 `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store`（应用页面）。
- 邮件 iframe 和桌面一样：`sandbox` 不含 `allow-scripts`，iframe 内 CSP 拦截远程资源。
- 静态文件按 realpath 限制在 `out/web` 内，拒绝穿越和越界符号链接。

### 不在边界内

- 同一用户下的本机进程可以直连 127.0.0.1 并伪造 Tailscale 头。它们本来就能读数据库和钥匙串授权的进程内存，不在本边界内。浏览器网页不能跨源发自定义头，Host 检查挡住 DNS rebinding。
- 允许列表里的 login 能在任何属于该用户的 tailnet 设备上登录。限制设备要靠 tailnet 的访问策略。
- 退出时移除映射超时或失败，映射会留到下次启动。这期间端口占用的风险见上文“发布”。
- Disconnect 不能挡住仍在允许列表里的 login，见“会话”。

验证：`remote-server.test.ts`（认证矩阵、会话签发范围、上限、清理、CSP、穿越、附件上下行限制、上传并发、WebSocket Origin 和断开）、`remote-rpcs.test.ts`、`tailscale.test.ts`（serve 参数、冲突检测和 CLI 查找顺序）、`remote-access.test.ts`（假 CLI 下的开关流程、退出时移除映射、CLI 卡住时的超时、Tailscale 不可达时的 `removeFailed` 与重试、启动时清理崩溃留下的映射、找不到 CLI 时保留端口）、`e2e/web.test.ts`（浏览器端经 WebSocket 渲染收件箱；逐个点击 web 设置页每个标签里的控件，断言服务器没有拒绝或失败的调用）。`OPENMAIL_WEB_SHOT=<dir>` 时 `web-shot.test.ts` 用 Electron 的 Chromium 截取 390 px 和 1280 px 的构建产物。
