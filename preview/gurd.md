## gurd

Test Text

---

## Responsive Columns

宽屏并排、窄屏（预览宽度 < 640px）自动纵向堆叠。下面每个带 `responsive` token 的区块，在窄预览下所有列都会变成全宽堆叠，并切换到 `--columns-stacked-gap`（默认 8px）的宽松纵向间距。

### 基础响应式（30 / 70）

%% col-start:responsive %%
%% col-break:30 %%
**Sidebar**

- Item A
- Item B

%% col-break:70 %%
**Main content**

This column keeps the 30/70 split while the preview is wide, and stacks below 640px.

%% col-end %%

### 三列响应式

%% col-start:responsive %%
%% col-break:20 %%
Left

%% col-break:30 %%
Center

%% col-break:50 %%
Right

%% col-end %%

### 响应式 + 堆叠组（stk:1）

%% col-start:responsive %%
%% col-break:40,stk:1 %%
Stacked A

%% col-break:stk:1 %%
Stacked B

%% col-break:60 %%
Wide column

%% col-end %%

### 响应式 + 样式 token

%% col-start:responsive %%
%% col-break:33,b:secondary,sb:1 %%
Card 1

%% col-break:34,b:alt,sb:1 %%
Card 2

%% col-break:33,b:cyan-soft,sb:1 %%
Card 3

%% col-end %%

### 嵌套：响应式外层 + 普通内层

%% col-start:responsive %%
%% col-break:50 %%
Outer left

%% col-break:50 %%
%% col-start %%
%% col-break %%
Inner 1

%% col-break %%
Inner 2

%% col-end %%

%% col-end %%

---

## 堆叠态间距（--columns-stacked-gap）

所有纵向堆叠形态共用默认 `8px` 间距（比横向 5px 更宽松）：`l:stack` 整体堆叠、`stk:N` 组内堆叠、以及上面的响应式折叠都是同一变量。

### l:stack 整体堆叠

%% col-start:l:stack %%
%% col-break %%
Row one — full width

%% col-break %%
Row two — full width

%% col-break %%
Row three — full width

%% col-end %%

### stk:N 堆叠组

%% col-start %%
%% col-break:40,stk:1 %%
Stacked 1

%% col-break:stk:1 %%
Stacked 2

%% col-break:stk:1 %%
Stacked 3

%% col-break:60 %%
Wide

%% col-end %%

---

## 响应式侧边栏模板

`%% col-start:responsive %%` 的 30/70 侧边栏——命令面板搜索 **Insert responsive sidebar layout** 一键插入。

%% col-start:responsive %%
%% col-break:30,b:secondary %%
**Sidebar**

- Home
- Docs
- About

%% col-break:70,b:secondary %%
**Main content**

Sidebar stays at 30% while the preview is wide; below 640px the two columns stack.

%% col-end %%

---

## 对照：普通布局不受影响

没有 `responsive` token 的区块在窄预览下保持原样，不自动堆叠。

%% col-start %%
%% col-break:30 %%
Still 30%

%% col-break:70 %%
Still 70%

%% col-end %%
