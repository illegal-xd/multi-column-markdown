# Advanced Multi Column（VSCode）— Markdown 多栏渲染增强

> 增强 VSCode **内置 Markdown 预览**，将 marker 语法渲染为多栏（多列）布局。
> 编辑完全使用 VSCode 原生 Markdown 编辑器，本扩展只增强预览渲染。
>
> English docs: `README.md`（同目录）

本项目移植自 Obsidian 插件
[`amatya-aditya/advanced-multi-column`](https://github.com/amatya-aditya/advanced-multi-column)（v1.3.1，AGPL-3.0）。
**标记语法、渲染语义、样式 token、模板与设置均为 1:1 移植**——为 Obsidian 插件编写的文档在本扩展的预览中渲染效果一致。

> **功能演示**：扩展包内附带 `test/preview.md` 完整演示文件（安装后位于扩展目录 `test/preview.md`），
> 打开后按 `Cmd+Shift+V` 即可逐项查看全部功能的渲染效果。

---

## 功能特性

- **预览渲染** — `%% col-start %%` / `%% col-break %%` / `%% col-end %%` 标记块在 VSCode 内置预览中渲染为多栏布局（`Cmd+Shift+V` 打开预览）
- **嵌套列** — 无限深度嵌套，列内再建列
- **宽度控制** — `%% col-break:30 %%` 指定百分比宽度（也支持 `w:40` 写法）；总和超 100% 自动回退等宽
- **堆叠组** — `stk:N` 将相邻列纵向堆叠；容器级 `l:stack` 整体纵向布局
- **样式 token（13 种）** — 背景 `b:`、边框色 `bc:`、文字色 `t:`/`tc:`、边框开关 `sb:`、水平分隔线 `h:`/`hd:`、左边界 `lb:`、分隔符 `sep:`/`sc:`/`ss:`/`sw:`/`sx:`
- **列头** — 列内容首行 `!note: 标题` 渲染为带图标的列头（内置 `note/info/tip/warning/danger`，可自定义）
- **Wikilink** — `[[笔记]]` 渲染为可点击链接，`![[图片.png]]` 渲染为内嵌图片
- **模板命令（10 个）** — 两列/三列/四列/自定义列数/嵌套/侧边栏/堆叠/Cornell 笔记/看板/信息卡片
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
| `b:` | 背景色 | `transparent` `primary` `secondary` `alt` `accent-soft` `red-soft` `orange-soft` `yellow-soft` `green-soft` `cyan-soft` `blue-soft` `pink-soft` |
| `bc:` | 边框颜色 | `gray` `accent` `muted` `text` `red` `orange` `yellow` `green` `cyan` `blue` `pink` |
| `t:` / `tc:` | 文字颜色 | 同边框颜色 |
| `sb:` | 显示边框 | `1/0`、`true/false`、`yes/no`、`on/off` |
| `h:` / `hd:` | 水平分隔线 | 同开关取值 |
| `lb:` | 左边界（callout 风格） | 同开关取值 |
| `sep:` | 启用列间分隔符 | 同开关取值 |
| `sc:` | 分隔符颜色 | 同边框颜色 |
| `ss:` | 分隔符样式 | `solid` `dashed` `dotted` `double` `custom` |
| `sw:` | 分隔符宽度（px） | `1`–`8` |
| `sx:` | 自定义分隔符字符 | 1–3 个字符（配合 `ss:custom`） |
| `stk:` | 堆叠组 ID（col-break） | 正整数 |
| `l:` | 容器布局（col-start） | `row`（默认）`stack` |

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
!note: 导航
- 首页
- 文档
%% col-break:stk:1,b:secondary %%
!info: 状态
在线
%% col-break:70,b:alt %%
!tip: 正文
主内容区，支持 **粗体**、`行内代码` 等。
%% col-end %%
```

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
- **列头**：`enableHeaders` + `headerTypes`（JSON 数组，参考 package.json 默认预设）

---

## 与 Obsidian 原版的差异

- **仅预览渲染**：编辑在 VSCode 原生编辑器中以 marker 文本方式进行（VSCode 无法在源码视图内渲染列布局——平台限制）；预览为只读（不支持拖拽调整/右键样式弹窗，请直接编辑宽度与样式 token）
- **已移除设置**：`enableReadingView` / `enableLivePreview` / `showDragHandles`（在 VSCode 中无实际作用）
- **未移植**：`foldNotePropertiesByDefault`（Obsidian 属性面板专属）、legacy callout 语法（`[!col]`）
- **预览限制**：列标记需独占一行且块前后有空行（markdown-it 块解析语义）

---

## 开发

```bash
npm install
npm run build      # 类型检查 + esbuild 打包
npm run package    # 打包为 vsix
```

架构：`src/core/`（解析/序列化/样式映射，纯逻辑）+ `src/preview/`（markdown-it 插件，通过官方
`markdown.markdownItPlugins` + `extendMarkdownIt` API 注册到内置预览）+ `src/completion.ts`（`[[` 文件补全）。
无 webview/自定义编辑器，扩展宿主单 bundle（约 19KB），内存占用极小。

---

## 许可

AGPL-3.0。本项目为 [advanced-multi-column](https://github.com/amatya-aditya/advanced-multi-column)（AGPL-3.0）的移植；
其中解析器、样式映射、模板、渲染语义等部分源码衍生自该项目。
