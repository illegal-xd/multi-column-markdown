# Advanced Multi Column（VSCode）— Markdown 多栏渲染增强

> 增强 VSCode **内置 Markdown 预览**，将 marker 语法渲染为多栏（多列）布局。
> 编辑完全使用 VSCode 原生 Markdown 编辑器，本扩展只增强预览渲染。
>
> English docs: `README.md`（同目录）

本项目移植自 Obsidian 插件
[`amatya-aditya/advanced-multi-column`](https://github.com/amatya-aditya/advanced-multi-column)（v1.3.1，AGPL-3.0）。
**标记语法、渲染语义、样式 token、模板与设置均为 1:1 移植**——为 Obsidian 插件编写的文档在本扩展的预览中渲染效果一致。

> **功能演示**：扩展包内附带 `preview/preview.md` 完整演示文件（安装后位于扩展目录 `preview/preview.md`），
> 打开后按 `Cmd+Shift+V` 即可逐项查看全部功能的渲染效果。

---

## 功能特性

- **预览渲染** — `%% col-start %%` / `%% col-break %%` / `%% col-end %%` 标记块在 VSCode 内置预览中渲染为多栏布局（`Cmd+Shift+V` 打开预览）
- **嵌套列** — 无限深度嵌套，列内再建列
- **宽度控制** — `%% col-break:30 %%` 指定百分比宽度（也支持 `w:40` 写法）；总和超 100% 自动回退等宽
- **响应式列** — 在 `%% col-start %%` 上附加 `responsive` token：预览宽度充足时保持列宽并排展示，宽度不足 640px 时自动纵向堆叠。纯 CSS 实现，只是布局行为，绝不改写你写的宽度值
- **堆叠组** — `stk:N` 将相邻列纵向堆叠；容器级 `l:stack` 整体纵向布局
- **样式 token（22 种）** — 背景 `b:`、边框色 `bc:`（含 `transparent`）、边框宽度 `bw:`/`bwl:`/`bwt:`/`bwr:`/`bwb:`、圆角 `br:`/`brl:`/`brt:`/`brr:`/`brb:`、文字色 `t:`/`tc:`、边框开关 `sb:`、水平分隔线 `h:`/`hd:`、左边界 `lb:`、分隔符 `sep:`/`sc:`/`ss:`/`sw:`/`sx:`、文字对齐 `ta:`、外边距简写 `m:`
- **Wikilink 与嵌入** — `[[笔记]]` 渲染为可点击链接；`[[笔记|别名]]` 显示别名，`[[笔记#标题]]` / `[[笔记^块ID]]` 支持 Obsidian 风格 URL 锚点；`![[图片.png]]` 内嵌图片，`![[笔记]]` / `![[笔记.md]]` 直接内嵌渲染整篇 Markdown（有深度上限与循环保护，文件缺失时回退为 `<img>`）
- **模板命令（11 个）** — 两列/三列/四列/自定义列数/嵌套/侧边栏/响应式侧边栏/堆叠/Cornell 笔记/看板/信息卡片
- **主题适配** — 全部颜色映射 VSCode 主题变量（明暗主题自适应）

---

## 快速开始

1. 用内置编辑器打开一个 Markdown 文件
2. 插入布局：`Cmd+Shift+P` → **Advanced Multi Column: Insert 2-wide layout**（或在编辑器右键 → Insert Column Layout）
3. 打开预览：`Cmd+Shift+P` → **Advanced Multi Column: Open Markdown Preview (Columns)**，或直接按 `Cmd+Shift+V`

### 基础示例

```markdown
%% col-start %%
%% col-break %%
左列内容
%% col-break %%
右列内容
%% col-end %%
```

> - `%% col-start %%` 与第一个 `%% col-break %%` 之间的内容会被忽略
> - 预览渲染要求列标记**独占一行**，且列块前后**保留空行**（markdown-it 块解析语义）

---

## 语法参考

### 列标记

| 标记 | 作用 |
|---|---|
| `%% col-start(:tokens) %%` | 开始列块（可携带容器样式与布局 token） |
| `%% col-break(:tokens) %%` | 开始新列（可携带宽度与样式 token） |
| `%% col-end %%` | 结束列块 |

### 样式 token 全表

| Token | 属性 | 可选值 |
|---|---|---|
| `b:` | 背景色（支持 `#hex` 自定义色） | `transparent` `primary` `secondary` `alt` `accent-soft` `red-soft` `orange-soft` `yellow-soft` `green-soft` `cyan-soft` `blue-soft` `pink-soft`，或 `#1f2937`、`#3b82f61f`（8 位含 alpha） |
| `bc:` | 边框颜色（支持 `#hex` 自定义色） | 调色板同 `b:` 之外，可写 `#3b82f6` |
| `t:` / `tc:` | 文字颜色 | 同边框颜色 |
| `sb:` | 显示边框 | `1/0`、`true/false`、`yes/no`、`on/off` |
| `h:` / `hd:` | 水平分隔线 | 同开关取值 |
| `lb:` | 左边界（callout 风格） | 同开关取值 |
| `sep:` | 启用列间分隔符 | 同开关取值 |
| `sc:` | 分隔符颜色 | 同边框颜色 |
| `ss:` | 分隔符样式 | `solid` `dashed` `dotted` `double` `custom` |
| `sw:` | 分隔符宽度（px） | `1`–`8` |
| `sx:` | 自定义分隔符字符 | 1–3 个字符（配合 `ss:custom`） |
| `ta:` | 列内容文字对齐 | `left` `center` `right` |
| `pd:` | 分栏内边距（默认 `5px`） | CSS 间距 1–4 值：`8`、`4 8`、`0.5em`、`10%`（数字自动加 px）；单值四个方向统一 |
| `br:` | 分栏圆角（默认 `0`，未配置为直角） | CSS 间距：`12`、`0.5em`、`4 8 12 16`（数字自动加 px） |
| `brl:` / `brt:` / `brr:` / `brb:` | 分栏单边圆角（l=左边，覆盖左上+左下；优先于 `br:`） | CSS 间距，同 `br:` |
| `m:` | 分栏外边距简写（默认 `0`） | CSS 间距 1–4 值：`8`、`4 8`、`4 8 12 16`；单值四个方向统一 |
| `ml:` / `mt:` / `mr:` / `mb:` | 分栏方向外边距（旧写法，优先于 `m:`） | CSS 间距，同 `pd:` |
| `bw:` | 边框宽度（显示时默认 `1px`；col-start 容器与 col-break 分栏均支持） | CSS 间距 1–4 值：`1`、`1 0`、`0.5em`；单值四个方向统一 |
| `bwl:` / `bwt:` / `bwr:` / `bwb:` | 分栏单边边框宽度（优先于 `bw:`；未指定的方向保持 `0px` 无边框） | CSS 间距，同 `bw:` |
| `g:` | 分栏间距（默认 `5px`，col-start 容器级） | CSS 间距：`8`、`0.5em`、`10%`（数字自动加 px） |
| `stk:` | 堆叠组 ID（col-break） | 正整数 |
| `l:` | 容器布局（col-start） | `row`（默认）`stack` |
| `responsive` | 响应式布局（col-start，裸 token） | 出现即表示窄于 640px 断点自动堆叠 |

> 堆叠态间距：所有纵向堆叠形态（`l:stack`、`stk:N` 堆叠组、以及窄于 640px 的响应式折叠）共用
> `--columns-stacked-gap` 变量（默认 `8px`，比横向 5px 行间距略宽松）。显式 `g:` token 依然生效，
> 因为 CSS 回退链会优先读取 `--columns-block-gap`。

### 响应式示例

```markdown
%% col-start:responsive %%
%% col-break:30 %%
侧边栏
%% col-break:70 %%
正文内容
%% col-end %%
```

- **预览宽度充足** — 保持你写的宽度（`30% | 70%`）横向并排
- **预览宽度不足** — 每列变为 `100%` 宽度，纵向堆叠
- 响应式**只是布局行为**：你的 `widthPercent` 永远不会被改写；`l:stack` 块本来就是纵向布局，不受影响
- 作用域限定在 `.columns-responsive` class + 直接子代选择器——即使父容器是响应式的，**未**携带 token 的嵌套容器仍保持自己的布局
- 断点是固定的 CSS `@media (max-width: 640px)`，按预览 webview 宽度计算（无 JS resize 监听，parser 不感知视口）。嵌套在窄列里的容器不会自行折叠——只有视口断点触发变化
- 只认**裸 `responsive` token**。`responsive:1` / `rs:` / 拼写错误一律忽略——畸形 token 绝不能悄悄改变文档布局

### 嵌套示例

```markdown
%% col-start %%
%% col-break:40 %%
# 外层列 1
%% col-break:60 %%
# 外层列 2（内含嵌套）

%% col-start %%
%% col-break %%
## 子列 1
%% col-break %%
## 子列 2
%% col-end %%
%% col-end %%
```

### 综合示例

```markdown
%% col-start:bc:muted %%
%% col-break:30,stk:1,b:secondary,lb:1 %%
**导航**
- 首页
- 文档
%% col-break:stk:1,b:secondary %%
**状态**
在线
%% col-break:70,b:alt %%
**正文**
主内容区，支持 **粗体**、`行内代码` 等。
%% col-end %%
```

### Wikilink 与嵌入示例

```markdown
[[docs/Guide]]              → 链接到 docs/Guide.md
[[docs/Guide|阅读指南]]     → 带别名的链接
[[docs/Guide#安装|安装说明]] → 带标题锚点的链接（URL fragment）
[[note^abc123]]             → 带块 ID 的 URL fragment
![[image.png]]              → 内嵌图片
![[docs/guide]]             → 内嵌 Markdown（原地渲染 docs/guide.md）
![[docs/guide.md|指南]]     → 内嵌 Markdown + 说明别名
```

> Markdown 嵌入走同一套 markdown-it 渲染管线（含列布局、Wikilink、任务列表），最多嵌套 8 层并防止循环引用；
> 非 Markdown 目标（`png/jpg/pdf/mp3/mp4/…`）渲染为 `<img>`，别名作为 alt 文本；文件缺失时同样回退为 `<img>`。

---

## 命令

| 命令 | 说明 |
|---|---|
| Insert 2-wide layout | 两列等宽 |
| Insert 3-wide layout | 三列等宽 |
| Insert 4-wide layout | 四列等宽 |
| Insert layout (custom count) | 自定义列数（使用设置 `defaultColumnCount`） |
| Insert nested layout | 嵌套布局 |
| Insert sidebar + content | 侧边栏 30/70 |
| Insert responsive sidebar | 侧边栏 30/70，窄于 640px 时纵向堆叠 |
| Insert stacked + wide | 堆叠 + 宽列 |
| Insert Cornell notes | Cornell 笔记模板 |
| Insert Kanban board | 看板模板 |
| Insert info card | 信息卡片模板 |
| Open Markdown Preview (Columns) | 打开带列渲染的内置预览 |

---

## 设置

`multiColumnMarkdown.*`（设置面板搜索 "multi column"）：

- **通用**：`defaultColumnCount`（自定义布局默认列数）、`minColumnWidthPercent`（最小列宽 %）、`inheritStyleOnAdd`
- **外观**：容器背景 `containerBackground`、边框 `showContainerBorder`/`containerBorderWidthPx`/`containerBorderColor`、圆角 `containerCornerRadiusPx`、文字色 `containerTextColor`、分隔线 `verticalDividerWidthPx`/`verticalDividerStyle`/`verticalDividerColor`、`styleTargetMode`/`styleTargetColumnIndex`

---

## 与 Obsidian 原版的差异

- **仅预览渲染**：编辑在 VSCode 原生编辑器中以 marker 文本方式进行（VSCode 无法在源码视图内渲染列布局——平台限制）；预览为只读——请直接编辑源码中的宽度与样式 token。
- **已移除设置**：`enableReadingView` / `enableLivePreview`（在 VSCode 中无实际作用）。
- **嵌入范围**：`![[笔记]]` / `![[笔记.md]]` 内嵌整篇 Markdown（同一渲染管线，≤ 8 层，防循环）；标题/块级嵌入（`![[笔记#标题]]`、`![[笔记^块ID]]`）、图片尺寸语法（`![[图片.png|300]]`）以及音视频/PDF 嵌入尚未移植；非 Markdown 目标与缺失文件回退为普通 `<img>`
- **预览限制**：列标记需独占一行且块前后有空行（markdown-it 块解析语义）

---

## 开发

```bash
pnpm install
pnpm build      # 类型检查 + esbuild 打包
pnpm test       # 单元测试（解析器、预览渲染、Wikilink）
pnpm benchmark  # 解析缓存性能基线
pnpm package    # 打包为 vsix
```

> 包管理器为 pnpm（版本由 `package.json` 的 `packageManager` 固定，锁文件为 `pnpm-lock.yaml`）。
> `pnpm-workspace.yaml` 保存 `allowBuilds` 白名单——pnpm 10+ 默认阻止依赖的 postinstall 脚本，
> 而 `esbuild` 需要该脚本下载平台原生二进制。

架构：`src/core/`（纯逻辑：`parser.ts` / `serializer.ts` / `style.ts` / `templates.ts` / `wikilink.ts`）+ `src/preview/`
（markdown-it 插件，通过官方 `markdown.markdownItPlugins` + `extendMarkdownIt` API 注册到内置预览）+
`src/completion.ts`（`[[` 文件补全）。无 webview/自定义编辑器，扩展宿主单 bundle（约 27KB），内存占用极小。

性能：列解析结果按文档文本做有界缓存；Markdown 文件清单通过 `workspace.findFiles()` 获取，Promise 级缓存并由
文件监听失效；Markdown 嵌入限制 8 层——预览反复刷新开销极低。

---

## 许可

AGPL-3.0。本项目为 [advanced-multi-column](https://github.com/amatya-aditya/advanced-multi-column)（AGPL-3.0）的移植；
其中解析器、样式映射、模板、渲染语义等部分源码衍生自该项目。
