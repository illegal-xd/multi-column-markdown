# Advanced Multi Column — 功能演示

> 在 VSCode 中按 `Cmd+Shift+V` 打开预览，逐项查看每个功能的渲染效果。
> 所有列块前后需保留空行（markdown-it 块解析要求）。

---

## 1. 基础布局：两列等宽

```markdown
%% col-start %%
%% col-break %%
左列内容
%% col-break %%
右列内容
%% col-end %%
```

%% col-start %%
%% col-break %%

左列内容

%% col-break %%

右列内容

%% col-end %%

---

## 2. 宽度控制

```markdown
%% col-start %%
%% col-break:30 %%
侧边栏（30%）
%% col-break:70 %%
主内容（70%）
%% col-end %%
```

%% col-start %%
%% col-break:30 %%

侧边栏（30%）

%% col-break:70 %%

主内容（70%）

%% col-end %%

> 宽度总和超过 100% 时自动回退为等宽；也支持 `w:40` 写法。

---

## 3. 背景色（b:）

```markdown
%% col-start %%
%% col-break:b:secondary %%
secondary
%% col-break:b:accent-soft %%
accent-soft
%% col-break:b:green-soft %%
green-soft
%% col-end %%
```

%% col-start %%
%% col-break:b:secondary %%

secondary

%% col-break:b:accent-soft %%

accent-soft

%% col-break:b:green-soft %%

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

## 4. 边框颜色（bc:）

```markdown
%% col-start %%
%% col-break:bc:red %%
bc:red
%% col-break:bc:green %%
bc:green
%% col-break:bc:blue %%
bc:blue
%% col-end %%
```

%% col-start %%
%% col-break:bc:red %%

bc:red

%% col-break:bc:green %%

bc:green

%% col-break:bc:blue %%

bc:blue

%% col-end %%

可选值：`gray` `accent` `muted` `text` `red` `orange` `yellow` `green` `cyan` `blue` `pink`

%% col-start %%
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

## 5. 文字颜色（t: / tc:）与边框开关（sb:）

```markdown
%% col-start %%
%% col-break:t:red,sb:1 %%
红色文字 + 显示边框
%% col-break:t:blue,sb:0 %%
蓝色文字 + 隐藏边框
%% col-end %%
```

%% col-start %%
%% col-break:t:red,sb:1 %%

红色文字 + 显示边框

%% col-break:t:blue,sb:0 %%

蓝色文字 + 隐藏边框

%% col-end %%

> `sb:` 支持 `1/0`、`true/false`、`yes/no`、`on/off`。

---

## 6. 左边界模式（lb:，仿 callout）

```markdown
%% col-start %%
%% col-break:lb:1,bc:accent %%
左边界强调（accent）
%% col-break:lb:1,bc:green %%
左边界强调（green）
%% col-break:lb:1,bc:pink %%
左边界强调（pink）
%% col-end %%
```

%% col-start %%
%% col-break:lb:1,bc:accent %%

左边界强调（accent）

%% col-break:lb:1,bc:green %%

左边界强调（green）

%% col-break:lb:1,bc:pink %%

左边界强调（pink）

%% col-end %%

---

## 7. 分隔符（sep: / sc: / ss: / sw: / sx:）

```markdown
%% col-start %%
%% col-break:sep:1,sc:red,ss:solid %%   ← 左列携带分隔符样式
A
%% col-break %%
B
%% col-end %%
```

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

## 8. 水平分隔线（hd:）与堆叠（stk:）

```markdown
%% col-start %%
%% col-break:stk:1,hd:1 %%
堆叠行 1
%% col-break:stk:1,hd:1 %%
堆叠行 2
%% col-break:stk:1,hd:1 %%
堆叠行 3
%% col-break:60 %%
右侧宽列
%% col-end %%
```

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

## 9. 容器纵向布局（l:stack）

```markdown
%% col-start:l:stack %%
%% col-break %%
上区块
%% col-break %%
下区块
%% col-end %%
```

%% col-start:l:stack %%
%% col-break %%

上区块

%% col-break %%

下区块

%% col-end %%

---

## 10. 嵌套列

```markdown
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
```

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

## 11. 列头（!type: Title）

```markdown
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
```

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

## 12. Wikilink 与图片

```markdown
%% col-start %%
%% col-break %%
链接：[[README]] 或 [[README|带别名]]
%% col-break %%
图片：![[icon.png]]
%% col-end %%
```

%% col-start %%
%% col-break %%

链接：[[README]] 或 [[README|带别名]]

%% col-break %%

图片：![[icon.png]]

%% col-end %%

> `[[路径]]` 渲染为可点击链接（相对当前文档解析）；`![[图片.png]]` 渲染为内嵌图片。

---

## 13. 任务列表

```markdown
%% col-start %%
%% col-break %%
- [ ] 待办 A
- [x] 已完成 B
- [ ] 待办 C
%% col-break %%
1. 有序列表一
2. 有序列表二
%% col-end %%
```

%% col-start %%
%% col-break %%

- [ ] 待办 A
- [x] 已完成 B
- [ ] 待办 C

%% col-break %%

1. 有序列表一
2. 有序列表二

%% col-end %%

---

## 14. 综合示例（组合多种能力）

```markdown
%% col-start:bc:muted %%   ← 容器边框
%% col-break:30,stk:1,b:secondary,lb:1 %%
!note: 导航
- 首页
- 文档
- 关于
%% col-break:stk:1,b:secondary %%
!info: 状态
在线
%% col-break:70,b:alt %%
!tip: 正文
主内容区，支持 **粗体**、[链接](https://example.com)、`行内代码` 等。
%% col-end %%
```

%% col-start:bc:muted %%
%% col-break:30,stk:1,b:secondary,lb:1 %%

!note: 导航

- 首页
- 文档
- 关于

%% col-break:stk:1,b:secondary %%

!info: 状态

在线

%% col-break:70,b:alt %%

!tip: 正文

主内容区，支持 **粗体**、[链接](https://example.com)、`行内代码` 等。

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
