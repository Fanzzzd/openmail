# 图标参考笔记

`refs/` 里的图只用于本地对比，不进 git（见本目录 `.gitignore`）。来源有两种。系统和本机已装的 app 用 `NSWorkspace.icon(forFile:)` 渲染，拿到的是 macOS 26 实际显示的样子。第三方邮件 app 从 Mac App Store 的 iTunes Search API 取 512px 图，Mimestream 取官网的 apple-touch-icon。

看过的图标：Apple Mail、Notes、Reminders、Passwords、Journal（macOS 26 版），Spark、Airmail、Canary、Mimestream、Outlook，Linear、Raycast、Arc、Notion、Things。Superhuman、HEY、Shortwave、Notion Mail、Proton Mail、Fastmail 在 Mac App Store 查不到桌面版图标，没有下载。

## 显得新的做法

- 一个主体。Apple Mail 只有一只信封，Linear 只有一个圆，Spark 只有一架纸飞机。主体占 body 宽度的 60% 到 75%。
- 主体是磨砂玻璃：白色，上亮下略暗，边缘一圈细的高光描边，顶部亮、底部弱。
- 主体下面有一层柔和的投影，颜色取背景的深色，不用纯黑。这一层给出前后两层的深度。
- 背景是同色系的竖向渐变，上浅下深，左上角有一团散开的亮光。squircle 内边缘有一道很细的 rim light。
- 重叠的半透明层让颜色互相混合（Journal 的蝴蝶），这是 Liquid Glass 的核心手法。
- 配色少。背景一个色相，主体白色或一个强调色，最多再加一个点缀。
- 形状圆润。Apple 的 Icon Composer 文档要求避免尖角，光在圆角上表现更好。
- 没有文字，没有细线装饰，没有多个小物件。

## 显得旧的做法

- 平涂色块加粗描边，像 2015 年的扁平图标。
- 高饱和纯色背景没有任何光照，看起来像占位图。
- 一个画面里放三四个小物件（格子柜、数据库圆柱、虚线框），32px 下变成噪点。
- 写实材质（火漆、纸纹、木纹）和拟物阴影。
- 主体太小，四周留白过多。
- 硬黑投影。

## v1 失败的原因

v1 七个方案都是平涂加 clip-art 式图形。背景没有光照，主体没有材质，投影是统一的黑色模糊。04 的黑色粗描边和 05、06 的多物件构图在 Dock 里显得过时。

## 第二轮参考

第二轮补了 Apple 自家的 Games、Messages、Shortcuts、Image Playground、Preview、Photos、Freeform、Contacts，第三方的 Bear、Things、Mela、Tot、Day One、Cardhop，AI 类的 Claude、ChatGPT、Dia，以及 Ghostty、Zed、Xcode、Icon Composer。Flighty、Craft、Ivory、Parcel 在商店里只有 iOS 方形图，已删。

逐个看下来，和第一轮的差距有四点：

- 主体更大。Messages 的气泡约占 body 宽度的 80%，Bear 直接从底边出血。
- 主体玻璃上白下透。顶部接近不透明的白，往下逐渐透出背景色，底边有一道折射亮线。
- 投影很淡，而且带背景色相。深度靠玻璃的透明度变化给出，不靠投影。
- 背景是系统级高饱和色（Games 红、Messages 绿、Shortcuts 紫），不是灰调的渐变。

两层彩色玻璃重叠混色（Shortcuts）和黑底玻璃透镜加彩色折射（Image Playground）是 Liquid Glass 最有辨识度的两种手法。第二轮各做了一个。

## 第四轮：对标 Plany、Notion、Tailscale

Plany 和 Notion 显得"是自己的"，靠的是这几点：

- 用品牌标记，不用比喻图形。Plany 是两道斜线加一个点，Notion 是 N 立方体，Tailscale 是 3×3 点阵。看到图标就想到这个产品，而不是想到这一类产品。
- 标记大。Notion 的立方体约占 body 宽度的 75%，Plany 约 70%。前三轮的信封只有 45% 左右，在 Dock 里显得小。
- 克制。黑白两色，最多再加一个点缀色。没有渐变主体，没有多层叠放。
- 几何简单。32px 下 Plany 还是"斜线加点"，Notion 还是"方框里一个 N"。
- 材质交给系统。Plany 在 macOS 26 下由系统加玻璃，黑色标记变成带高光的深灰玻璃，本身的图形不变。

openmail 要避免"又一个信封"，需要一个自己的标记。第四轮所有方案都从字母 o 出发。Badge o 是 o 加一个未读圆点，At o 是最简化的 @。珊瑚色作为唯一的点缀色，Dock 里的邮件 app 都是蓝色，珊瑚色能分开。

## 第五轮：对标 opencode

opencode 的桌面图标（`refs/opencode-prod.png`，取自 sst/opencode 仓库的 `apps/desktop/build/icon.icon`）是一个像素风的方形 o：

- 一个字母就是整个标记。粗方框，直角，没有圆角也没有装饰。
- 黑白单色，材质交给系统，白色标记在深色底上变成带高光的银色。
- 内洞下半截填了一块灰，像终端里的块状光标。字母给出品牌，内洞里的这个细节给出含义。
- beta 和 dev 版本只换底色（浅灰网格、蓝色），标记不变。一个标记撑起整套变体。

用到邮件上的原则：标记同时是 o 和一个邮件记号，内洞或边框负责表达邮件。第四轮的 o 缺了这一半，只有品牌没有语义。

第五轮一共画了 21 个，删掉 9 个：

- Open top 和 M fold 会读成 Gmail 的 M 信封。
- Round fold 和 Airmail 太像。
- Inbox folds 读成向下箭头。
- o flap 像表情。
- Square @ 像分栏窗口图标。
- Letter out 和 Mail slot 像打印机。
- Postcard 像侧边栏图标。
