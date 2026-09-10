# Advanced Multi Column — 功能演示

> 在 VSCode 中按 `Cmd+Shift+V` 打开预览，逐项查看每个功能的渲染效果。
> 所有列块前后需保留空行（markdown-it 块解析要求）。

---

## 基础布局

- 两列等宽

%% col-start %%
%% col-break %%
## Left
左列内容

%% col-break %%
## Right
右列内容

%% col-end %%

- 自定义列宽比例

%% col-start %%
%% col-break:35 %%
## Left
- Item A
- Item B
%% col-break:65 %%
## Right
Write your main note here.
%% col-end %%

> 宽度总和超过 100% 时自动回退为等宽；也支持 `w:40` 写法。

---

## 背景色（b:）

%% col-start %%
%% col-break:b:secondary %%

secondary

%% col-break:b:accent-soft,ml:8 %%

accent-soft

%% col-break:b:green-soft,ml:8 %%

green-soft

%% col-end %%

可选值：`transparent` `primary` `secondary` `alt` `accent-soft` `red-soft` `orange-soft` `yellow-soft` `green-soft` `cyan-soft` `blue-soft` `pink-soft`

%% col-start %%
%% col-break:b:primary %%

primary

%% col-break:b:alt %%

alt

%% col-break:b:red-soft %%

red-soft

%% col-break:b:orange-soft %%

orange-soft

%% col-break:b:yellow-soft %%

yellow-soft

%% col-break:b:cyan-soft %%

cyan-soft

%% col-break:b:blue-soft %%

blue-soft

%% col-break:b:pink-soft %%

pink-soft

%% col-end %%

---

## 边框颜色（bc:）

%% col-start %%
%% col-break:bc:red %%

bc:red

%% col-break:bc:green %%

bc:green

%% col-break:bc:blue %%

bc:blue

%% col-end %%

可选值：`transparent` `gray` `accent` `muted` `text` `red` `orange` `yellow` `green` `cyan` `blue` `pink`

%% col-start %%

%% col-break:bc:transparent %%
transparent

%% col-break:bc:gray %%

gray

%% col-break:bc:accent %%

accent

%% col-break:bc:muted %%

muted

%% col-break:bc:orange %%

orange

%% col-break:bc:yellow %%

yellow

%% col-break:bc:cyan %%

cyan

%% col-break:bc:pink %%

pink

%% col-end %%

---

## 文字颜色（t: / tc:）与边框开关（sb:）

%% col-start %%
%% col-break:t:red,sb:1 %%

红色文字 + 显示边框

%% col-break:t:blue,sb:0 %%

蓝色文字 + 隐藏边框

%% col-end %%

> `sb:` 支持 `1/0`、`true/false`、`yes/no`、`on/off`。

---

## 文字对齐（ta:）

%% col-start %%
%% col-break:ta:left,b:secondary %%

左对齐 left

%% col-break:ta:center,b:secondary %%

居中对齐 center

%% col-break:ta:right,b:secondary %%

右对齐 right

%% col-end %%

> `ta:` 控制列内容的水平对齐（`left` / `center` / `right`）。
> 字号无需额外 token——直接使用 Markdown 标题（`#` / `##` / `###`）控制。

---

## 左边界模式（lb:，仿 callout）

%% col-start %%
%% col-break:lb:1,bc:accent %%

左边界强调（accent）

%% col-break:lb:1,bc:green %%

左边界强调（green）

%% col-break:lb:1,bc:pink %%

左边界强调（pink）

%% col-end %%

> 左边界默认 `3px`；可用 `bwl:`（或 `bw:`）覆盖宽度，如 `lb:1,bwl:5` = 5px 左边界。

---

## 分隔符（sep: / sc: / ss: / sw: / sx:）

%% col-start %%
%% col-break:sep:1,sc:red,ss:solid %%

A（solid 实线分隔符）

%% col-break %%

B

%% col-end %%

%% col-start %%
%% col-break:sep:1,sc:blue,ss:dashed %%

A（dashed 虚线）

%% col-break %%

B

%% col-end %%

%% col-start %%
%% col-break:sep:1,sc:green,ss:dotted %%

A（dotted 点线）

%% col-break %%

B

%% col-end %%

%% col-start %%
%% col-break:sep:1,sc:accent,ss:custom,sx:★ %%

A（custom 自定义字符 ★）

%% col-break %%

B

%% col-end %%

---

## 水平分隔线（hd:）与堆叠（stk:）

%% col-start %%
%% col-break:stk:1,hd:1 %%

堆叠行 1

%% col-break:stk:1,hd:1 %%

堆叠行 2

%% col-break:stk:1,hd:1 %%

堆叠行 3

%% col-break:60 %%

右侧宽列（60%）

%% col-end %%

> `stk:N` 将相邻列归入同一堆叠组（组内纵向排列，组宽取组内最大宽度）。

---

## 容器纵向布局（l:stack）

%% col-start:l:stack %%
%% col-break %%

上区块

%% col-break %%

下区块

%% col-end %%

---

## 嵌套列

%% col-start %%
%% col-break:40 %%

外层列 1

%% col-break:60 %%

外层列 2（内含嵌套）

%% col-start %%
%% col-break %%

子列 1

%% col-break %%

子列 2

%% col-end %%

%% col-end %%

---

## 列头（!type: Title）

%% col-start %%
%% col-break %%

!note: 笔记

这是 note 列头

%% col-break %%

!tip: 提示

这是 tip 列头

%% col-break %%

!danger: 危险

这是 danger 列头

%% col-end %%

> 内置类型：`note` `info` `tip` `warning` `danger`；可在设置 `multiColumnMarkdown.headerTypes` 中自定义。

---

## Wikilink 与嵌入

### 链接、别名与 URL 锚点

%% col-start %%
%% col-break %%

- 普通链接：[[README]]
- 别名链接：[[README|项目说明]]
- 标题锚点：[[README#许可|跳到许可]]
- 块 URL：[[README^block-id|跳到块]]

%% col-break %%

```markdown
[[目标]]
[[目标|显示别名]]
[[目标#标题|跳到标题]]
[[目标^block-id|跳到块]]
```

%% col-end %%

### 图片嵌入 `![[...]]`

%% col-start %%
%% col-break %%

图片资源：

![[./logo.jpg]]

%% col-break %%

```markdown
![[图片.png]]
![[assets/logo.jpg]]
```

%% col-end %%

### Markdown 内容嵌入 `![[note.md]]`

下面示例会读取工作区中的 `README.md`，并将其 Markdown 内容原地渲染到当前预览中；嵌入内容中的标题、列表、Wikilink、任务列表和多栏语法仍会继续处理。

%% col-start %%
%% col-break %%

**Markdown 文件嵌入：**

![[preview/gurd.md|指南内容]]

%% col-break %%

```markdown
![[preview/gurd.md|指南内容]]
```

%% col-end %%

> - `[[目标]]` 渲染为可点击链接；`[[目标|别名]]` 显示别名；`[[目标#标题]]` / `[[目标^块ID]]` 附加 URL 锚点（Obsidian 风格）。
> - `![[图片.png]]` 渲染为 `<img>` 图片；`![[笔记]]` / `![[笔记.md]]` 读取并原地渲染整篇 Markdown。
> - Markdown 嵌入最多递归 8 层并防止循环引用；文件缺失或非 Markdown 目标回退为 `<img>`，别名在图片回退时作为 alt 文本。

---

## 任务列表

%% col-start %%
%% col-break %%

- [ ] 待办 A
- [x] 已完成 B
- [ ] 待办 C

%% col-break %%

1. 有序列表一
2. 有序列表二

%% col-end %%

> 列内 `- [ ]` / `- [x]` 渲染为 antd 风格 checkbox：未选中 16px 白底灰边框，hover 边框变蓝；选中项蓝色填充 + 白色对勾（暗色主题自动适配）。

---

## 内边距、外边距与边框宽度（pd: / m: / bw:）

%% col-start %%
%% col-break:pd:12,sb:1,b:secondary %%

默认 5px，此处 12px

%% col-break:m:16,sb:1,b:secondary %%

四周外边距统一 16px（m:16）

%% col-break:m:10 30,sb:1,b:secondary %%

上下 10px、左右 30px（m:10 30）

%% col-end %%

%% col-start %%
%% col-break:bw:2,bc:green,sb:1 %%

边框 2px（bw:2）

%% col-break:bw:0 2,bc:blue,sb:1 %%

仅左右边框 2px（bw:0 2）

%% col-break:bw:0,sb:1 %%

无边框（bw:0）

%% col-end %%

> 所有分栏默认 `padding: 5px`、`margin: 0`、边框宽度 `1px`。
> `pd:` / `m:` / `bw:` 均支持 CSS 简写（1–4 个值），**只传一个数值时四个方向统一**（如 `m:8` = 四方向 8px）；
> 数字自动加 `px`。旧的 `ml:/mt:/mr:/mb:` 方向写法仍可用，且优先于 `m:` 简写。

---

## 圆角（br:）

%% col-start %%
%% col-break:br:12,sb:1,b:secondary %%

圆角 12px

%% col-break:br:0,sb:1,b:secondary %%

直角（br:0）

%% col-break:br:16 4,sb:1,b:secondary %%

非对称 16px 4px

%% col-end %%

> `br:` 控制分栏圆角（默认 4px），支持任意 CSS 圆角值：`br:12`、`br:0.5em`、`br:4 8 12 16`（数字自动加 `px`）。
> 配合 `lb:1`（左边界模式）时圆角作用于右侧两角。

%% col-start %%
%% col-break:brl:16,sb:1,b:secondary %%

仅左边缘圆角 16px（brl:16）

%% col-break:brt:16,sb:1,b:secondary %%

仅顶部圆角 16px（brt:16）

%% col-break:brb:16,sb:1,b:secondary %%

仅底部圆角 16px（brb:16）

%% col-end %%

> 单边圆角：`brl:`（左=左上+左下）、`brt:`（上）、`brr:`（右）、`brb:`（下），优先于 `br:` 简写。

%% col-start %%
%% col-break:bwl:2,bwt:0,bwr:2,bwb:0,bc:blue,sb:1 %%

仅左右边框 2px（bwl/bwr:2）

%% col-break:bwt:3,bc:green,sb:1 %%

仅顶部边框 3px（bwt:3）

%% col-break:bwb:2,bc:red,sb:1 %%

仅底部边框 2px（bwb:2）

%% col-end %%

> 单边边框宽度：`bwl:` / `bwt:` / `bwr:` / `bwb:`，优先于 `bw:` 简写；未指定的方向保持 `0px`（无边框），仅指定方向显示边框。若希望四边都有边框再调整，请配合 `bw:` 简写或 `sb:1`。

---

## 自定义颜色（#hex）

%% col-start %%
%% col-break:b:#1f2937,bc:#3b82f6,t:#ffffffe6,sb:1,br:12 %%

深色卡片（b:#1f2937 + 白色文字）

%% col-break:b:#3b82f61f,bc:#3b82f6,sc:#ef4444cc,sep:1,sb:1 %%

半透明蓝底（#3b82f61f，8 位 hex 含 alpha）+ 自定义分隔符色

%% col-break:b:#fff,sc:#ef4444,tc:#000,sep:1,sb:1 %%

白底 + 黑字

%% col-end %%

> 颜色 token（`b:` / `bc:` / `t:` / `sc:`）在调色板之外支持任意 `#hex`（3/4/6/8 位，8 位含 alpha 通道），原样透传到 CSS。`rgba()` 暂不支持——需要透明度时用 8 位 hex（如 `#3b82f61f`）。

---

## 综合示例（组合多种能力）

%% col-start:b:orange-soft %%
%% col-break:30,stk:1 %%
![[./logo.jpg]]

%% col-break:t:pink,ta:center,stk:1 %%
### Linna
%% col-break:t:cyan,ta:center,stk:1 %%
2006 - Unknown

%% col-break:stk:1,pd:0 %%
%% col-start:b:transparent,bc:transparent %%
%% col-break:w:24,m:0,pd:0,t:red %%
Born:
%% col-break:w:76,m:0,pd:0,t:while %%
GuangDong Shenzhen
%% col-end %%

%% col-break:stk:1,pd:0 %%
%% col-start:b:transparent,bc:transparent %%
%% col-break:w:24,m:0,pd:0,t:red %%
Born:
%% col-break:w:76,m:0,pd:0,t:while %%
Unknown
%% col-end %%

%% col-break:stk:1,pd:0 %%
%% col-start:b:transparent,bc:transparent %%
%% col-break:w:24,m:0,pd:0,t:red %%
Fields:
%% col-break:w:76,m:0,pd:0,t:while %%
photography, daily life, emotion recording, casual aesthetics
✨Motto: "Enjoy every ordinary moment."
%% col-end %%

%% col-break:35 %%

%% col-start:b:transparent,bc:transparent %%
%% col-break:t:pink,stk:1 %%
### Biography
%% col-break:stk:1 %%
A young girl who loves to record fragments of life. She is good at capturing soft, subtle emotions in daily moments.
%% col-break:t:pink,stk:1 %%
### Early Life
%% col-break:stk:1 %%
Little is known about her exact background. She likes simple, plain‑style snapshots. Her photos show shy, gentle and casual side of youth.
%% col-break:b:cyan-soft,t:while,stk:1,br:0 %%
### Legacy
%% col-break:bc:gray,stk:1,mb:10 %%
Her photos reflect the subtle inner world of young people. Shy and playful, she records trivial and precious moments of ordinary youth.
%% col-break:stk:1 %%
> "Enjoy every ordinary moment."
%% col-end %%

%% col-break:35 %%
%% col-start:b:transparent,bc:transparent %%
%% col-break:t:pink,stk:1 %%
### Personal Traits & Hobbies
%% col-break:stk:1 %%
Her snapshots record soft fragments of youth, full of shy and playful atmosphere.
1. Photography — take casual film‑style photos, record daily moods
2. Aesthetics — love soft tone, simple and clean visual style
3. Emotion expression — show shy, playful feeling through gestures and eyes
4. Life observation — capture small, quiet moments in everyday life
%% col-end %%

%% col-end %%

---

## 模板命令速查

在编辑器中 `Cmd+Shift+P` 执行：

| 命令 | 说明 |
|---|---|
| `Advanced Multi Column: Insert 2-wide layout` | 两列等宽 |
| `Advanced Multi Column: Insert 3-wide layout` | 三列等宽 |
| `Advanced Multi Column: Insert 4-wide layout` | 四列等宽 |
| `Advanced Multi Column: Insert layout (custom count)` | 自定义列数（`defaultColumnCount`） |
| `Advanced Multi Column: Insert nested layout` | 嵌套布局 |
| `Advanced Multi Column: Insert sidebar + content` | 侧边栏 30/70 |
| `Advanced Multi Column: Insert stacked + wide` | 堆叠 + 宽列 |
| `Advanced Multi Column: Insert Cornell notes` | Cornell 笔记 |
| `Advanced Multi Column: Insert Kanban board` | 看板 |
| `Advanced Multi Column: Insert info card` | 信息卡片 |
