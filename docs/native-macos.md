# macOS 原生撰写能力

Electron 44 可通过原生菜单接入 Writing Tools，通过 AppKit helper 接入 Photos、语法检查和 Continuity Camera。当前 Chromium 没有已核实的 macOS 行内预测入口；现有 AppKit helper 也没有系统 Markup 的编辑结果接口。下列结论来自公开文档和源码，系统菜单、设备连通及编辑效果仍待实机验收。

下文 `native/`、`src/`、`build/` 路径均相对 `apps/desktop/`。

## 版本边界

本次按仓库锁定的 Electron 44.4.5 核对。其 [DEPS](https://github.com/electron/electron/blob/v44.4.5/DEPS) 指定 Chromium `152.0.7977.130`；下文的 Chromium 结论仅覆盖该版本。Apple API 以本机构建 SDK 的公开声明核对，低版本要求以各 API 的 availability 为准。

## I01 行内预测

macOS 14 提供 [`NSSpellChecker.showInlinePrediction(forCandidates:client:)`](<https://developer.apple.com/documentation/appkit/nsspellchecker/showinlineprediction(forcandidates:client:)>)。本机 `AppKit.framework/Headers/NSSpellChecker.h` 说明：先用 `NSTextCheckingGenerateInlinePredictionsKey` 请求候选，再把结果交给 `NSTextInputClient` 显示；`NSTextView.inlinePredictionType` 只适用于对应原生文本视图。

固定版本的 [`RenderWidgetHostViewCocoa.h`](https://chromium.googlesource.com/chromium/src/+/152.0.7977.130/content/app_shim_remote_cocoa/render_widget_host_view_cocoa.h#51) 使用 `NSView` 和 `NSTextInputClient`，并非 `NSTextView`。[`requestTextSuggestions`](https://chromium.googlesource.com/chromium/src/+/152.0.7977.130/content/app_shim_remote_cocoa/render_widget_host_view_cocoa.mm#598) 只为 Touch Bar 候选列表请求结果，传入 `options:nil`，没有调用上述内联预测 API。输入法自己的预测补全也不等于 I01。

据此，HTML 的 `autocorrect` 属性或系统预测开关不足以证明行内预测可用。本次没有找到可仅为 composer 开启此能力的公开 Electron 设置或已核实 Chromium flag，I01 保持 missing。

## I02–I05 Writing Tools

Electron 的 [44.4.5 context-menu 文档](https://github.com/electron/electron/blob/v44.4.5/docs/tutorial/context-menu.md#additional-macos-menu-items-eg-writing-tools) 明确说明：macOS 扩展菜单默认关闭；将 `params.frame` 传给 `Menu.popup({ frame })` 可启用 Writing Tools、AutoFill 和 Services。固定 Chromium 的 [`insertText:replacementRange:`](https://chromium.googlesource.com/chromium/src/+/152.0.7977.130/content/app_shim_remote_cocoa/render_widget_host_view_cocoa.mm#2694) 还处理了 Writing Tools 接受替换时丢失焦点的情况，说明文本写回已有上游路径。

`apps/desktop/src/main/spellcheck.ts` 只给主 frame 的可编辑 composer 消息文本传入 `frame`；`ComposeEditor.tsx` 用 `data-openmail-compose-body` 标识富文本和 textarea。I02 校对、I03 重写／语气及 I05 系统 Compose／ChatGPT 共用这个原生入口。实际菜单项仍由系统功能、语言、地区和用户设置决定；这些操作及写回尚未验证，保持 partial。[Apple Writing Tools 使用说明](https://support.apple.com/guide/mac-help/writing-tools-write-improve-summarize-mchldcd6c260/mac)

I04 目前只有用户选择文本的系统路径。Apple 的完整范围控制依赖原生文本视图／Writing Tools 协调器，例如 `textView(_:writingToolsIgnoredRangesInEnclosingRange:)`；Electron 的 frame 参数不暴露这些 delegate。当前接入没有默认排除签名、引用的能力，I04 保持 partial。[Apple 原生文本视图支持说明](https://developer.apple.com/documentation/appkit/customizing-writing-tools-behavior-for-system-views)

## C51 语法检查和自动纠错

Electron [session 拼写检查 API](https://github.com/electron/electron/blob/v44.4.5/docs/api/session.md) 提供拼写开关、词典和语言设置，没有公开语法检查或原生自动纠错开关。固定 Chromium 的 [`allowedTextCheckingTypes`／`enabledTextCheckingTypes`](https://chromium.googlesource.com/chromium/src/+/152.0.7977.130/content/app_shim_remote_cocoa/render_widget_host_view_cocoa.mm#650) 仅启用文字替换、智能引号和短横线，未包含 `NSTextCheckingTypeGrammar` 或 `NSTextCheckingTypeCorrection`。`autocorrect="on"` 不能补齐这条路径。

`native/GrammarCLI.swift` 在用户点击后调用公开的 [`NSSpellChecker.checkGrammar`](<https://developer.apple.com/documentation/appkit/nsspellchecker/checkgrammar(of:startingat:language:wrap:inspelldocumentwithtag:details:)>)，读取语法范围、描述和候选。`language:nil` 使用系统 Spelling 面板所选语言，不能承诺所有语言都有结果。文本只通过 stdin 交给本机 helper；实现不调用网络、不落文件、不写日志。composer 用 UTF-16 范围显示标记和建议，用户确认才替换。单次结果最多 256 项，内层 detail 循环也检查上限；无 UI 自检用 300 条有效 detail 验证截断。每个窗口分别锁定 Photos 和 grammar helper，因此打开图库不会阻塞按需语法检查。主进程以 process.getSystemVersion() 将所有 helper 入口限制为 macOS 13+。此路径补充按需语法检查，未实现输入时系统自动纠错，C51 仍为 partial。

## M06 Photos 和 M07 Continuity Camera

[`PHPickerViewController`](https://developer.apple.com/documentation/photosui/phpickerviewcontroller) 从 macOS 13 起可用。Apple 明确将 PHPicker 作为只访问用户选中照片、无需申请整个图库权限的 API；系统负责选择界面，应用无需调用 `PHPhotoLibrary.requestAuthorization`。[WWDC22 隐私说明](https://developer.apple.com/videos/play/wwdc2022/10096/?time=762)

公开文档不足以确认无 `Info.plist` 的裸 executable 能否完成 Photos picker 和 Continuity 菜单交互。[`Bundle.main`](https://developer.apple.com/documentation/foundation/bundle/main) 即使对未打包程序也可能返回 bundle 对象，不能据此证明应用身份完整；无 `Info.plist` 的未打包程序默认使用 [`prohibited`](https://developer.apple.com/documentation/appkit/nsapplication/activationpolicy-swift.enum/prohibited) 激活策略，不可创建窗口。Photos 和 Continuity 因此共用最小 `OpenMailPhotos.app`，以固定应用身份运行；这项工程选择不等于已证明裸 executable 必然失败。

helper 位于发行应用的 `Contents/Resources/native/OpenMailPhotos.app`，主进程直接调用其 `Contents/MacOS/photos`，保留 stdin／stdout 协议。`Contents/Info.plist` 定义 `CFBundleIdentifier=app.openmail.desktop.photos`、`CFBundleExecutable=photos`、`CFBundlePackageType=APPL`、名称、版本、`NSPrincipalClass=NSApplication` 和 `LSMinimumSystemVersion=13.0`；GUI 路径检查 bundle ID，并使用 `regular` 激活策略。该布局遵循 helper 自身的 [Apple 应用 bundle 结构](https://developer.apple.com/library/archive/documentation/CoreFoundation/Conceptual/CFBundles/BundleTypes/BundleTypes.html)，但外层 Resources 位置按本次任务要求保留。[Apple 签名说明](https://developer.apple.com/library/archive/technotes/tn2206/_index.html) 推荐嵌套代码放在 `Contents/Helpers` 等位置，放进 Resources 会同时作为资源封存。无 UI 自检和严格签名检查不能替代系统交互、Developer ID 签名及发行公证验收；这些仍待验证。

native/PhotosCLI.swift --photos 在用户点击附件入口后开启最小 AppKit 会话，以图片过滤器选择照片。只在 item-provider 回调有效期内读取选中内容，再从像素重新编码为 JPEG；最长边 4096，目标质量 0.85，传给新图像的属性为 nil，不复制原始 GPS、EXIF UserComment 等元数据。取第一帧，动画与透明通道不保留。输入表示最多 128 MiB，输出附件累计最多 30 MiB、最多 16 项；单项或累计超限时跳过该项并继续后续项，tooLarge 状态带回已接受文件和跳过数量。composer 保留这些文件，并显示十种语言的超限提示；取消返回空 ok，解码／读取失败返回 error。主进程再检查类型、数量、base64 和累计大小。

Photos app bundle 和 grammar executable 均为 arm64／x86_64 universal，分别用自身空 entitlements 进行 ad-hoc hardened-runtime 签名；发布 signer 为嵌套 Photos app 与其 executable 单独选用同一最小文件，不继承 Electron 的 JIT 或 Contacts 权限。无 UI 自检验证实际 Bundle.main 身份、24 MP 合成图片的 JPEG／尺寸上限与原 GPS 去除、批次超限跳过、错误状态及严格签名。真实图库选择、取消、Developer ID 成品仍未验收。

Continuity Camera 有公开 AppKit 接口，无需直接控制 iPhone 相机。Apple 要求 responder 实现 `validRequestor(forSendType:returnType:)`，使用 `NSServicesMenuRequestor.readSelection(from:)` 接收 pasteboard 数据；原生菜单项设置 `NSMenuItem.importFromDeviceIdentifier`，上下文菜单由 AppKit 插入。[Apple 集成说明](https://developer.apple.com/documentation/appkit/supporting-continuity-camera-in-your-mac-app)、[菜单标识符](https://developer.apple.com/documentation/appkit/nsmenuitem/importfromdeviceidentifier)

`PhotosCLI.swift --continuity` 按此方式提供原生接收视图。按 HEIC、JPEG、PNG、TIFF 顺序读取图片表示，避免先经 NSImage 膨胀成全尺寸 TIFF；图片走同一 JPEG 重编码路径。读取／解码失败会结束 helper 并返回错误状态，超限有独立状态，composer 会显示提示。扫描的 PDF 保留原文件字节，因此本次图片 GPS 去除的承诺不覆盖 PDF 元数据。手机、系统设置和设备连通决定菜单可用性；照片、扫描和草图的真实设备流程未验证，M07 保持 partial。

## M08 系统 Markup

AppKit 的 [`QLPreviewView`](https://developer.apple.com/documentation/quicklookui/qlpreviewview) 和 [`QLPreviewPanelDelegate`](https://developer.apple.com/documentation/quicklookui/qlpreviewpaneldelegate) 提供预览、事件及转场接口，公开 API 未提供启用 Markup 并返回编辑后文件的回调。Electron 的预览能力因此不能证明 composer 已能保存系统标注。

[`QLPreviewControllerDelegate`](https://developer.apple.com/documentation/quicklook/qlpreviewcontrollerdelegate) 确有 `editingModeFor`、`didUpdateContentsOf` 和 `didSaveEditedCopyOf`，但属于 UIKit 的 iOS／iPadOS／Mac Catalyst 路径，不能直接装进当前 AppKit helper。Mac Catalyst 的 API availability 本身也不构成实际 Markup 验收；[Quick Look 总览](https://developer.apple.com/documentation/quicklook) 只明确说明 iOS 的预览编辑，Catalyst 实现及文件写回尚未研究验证。

本次没有实现 Catalyst app、私有 Markup 服务或私有 selector。M08 保持 missing，原因限于当前 Electron／AppKit 集成，不能据此断言所有 macOS helper 都无法使用系统标注。启动 Preview 并重新导入文件可作为另行设计的外部编辑流程，但尚未实现，也不计入 M08。

验收必须区分编译／无 UI 自检与系统交互。本次不启动 Electron、Photos picker 或 Continuity Camera，不访问真实图库或手机；Writing Tools 的菜单出现、文字范围及写回，图库选中内容、设备照片／扫描／草图，以及签名成品均仍待人工验收。
