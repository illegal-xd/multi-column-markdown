# Advanced Multi Column (VSCode) — Markdown Multi-Column Preview Enhancement

> Enhances the **built-in Markdown preview** to render marker-based multi-column layouts. Editing stays 100% in
> VSCode's native Markdown editor — this extension only touches the preview.
>
> 中文文档：`README.zh-CN.md`（与 README.md 同目录）· Chinese docs: `README.zh-CN.md` (same directory).

Ported from the Obsidian plugin [`amatya-aditya/advanced-multi-column`](https://github.com/amatya-aditya/advanced-multi-column)
(v1.3.1, AGPL-3.0). The **marker syntax, rendering semantics, style tokens, templates and settings are 1:1** — documents
written for the Obsidian plugin render identically in the built-in preview.

> **Live demo**: the extension ships `test/preview.md`, a full walkthrough of every feature. Open it and press
> `Cmd+Shift+V` to see all options rendered side by side with their source.

---

## Features

- **Preview rendering** — `%% col-start %%` / `%% col-break %%` / `%% col-end %%` blocks render as column layouts in
  the built-in Markdown preview (`Cmd+Shift+V`).
- **Nested columns** — unlimited depth; build columns inside columns.
- **Width control** — `%% col-break:30 %%` sets percentage width (also `w:40`); sums over 100% fall back to equal widths.
- **Stack groups** — `stk:N` stacks adjacent columns vertically; container-level `l:stack` lays out the whole block top-to-bottom.
- **Style tokens (13)** — background `b:`, border color `bc:`, text color `t:`/`tc:`, border toggle `sb:`, horizontal
  dividers `h:`/`hd:`, left border `lb:`, separators `sep:`/`sc:`/`ss:`/`sw:`/`sx:`.
- **Column headers** — first line `!note: Title` renders as an icon header (built-in `note/info/tip/warning/danger`, customizable).
- **Wikilinks** — `[[note]]` renders as a clickable link, `![[image.png]]` as an embedded image.
- **Templates (10 commands)** — 2/3/4-wide, custom count, nested, sidebar, stacked, Cornell notes, Kanban board, info card.
- **Theming** — all colors map to VSCode theme tokens (light/dark safe).

---

## Quick Start

1. Open a Markdown file in the built-in editor.
2. Insert a layout: `Cmd+Shift+P` → **Advanced Multi Column: Insert 2-wide layout** (or right-click → Insert Column Layout).
3. Open the preview: `Cmd+Shift+P` → **Advanced Multi Column: Open Markdown Preview (Columns)**, or press `Cmd+Shift+V`.

### Basic example

```markdown
%% col-start %%
%% col-break %%
Left column
%% col-break %%
Right column
%% col-end %%
```

> - Content between `%% col-start %%` and the first `%% col-break %%` is ignored.
> - Column markers must be on their own line, with blank lines around the block (markdown-it block semantics).

---

## Syntax reference

### Markers

| Marker | Purpose |
|---|---|
| `%% col-start(:tokens) %%` | Begin a column block (container style/layout tokens) |
| `%% col-break(:tokens) %%` | Begin a new column (width + style tokens) |
| `%% col-end %%` | End the column block |

### Style tokens

| Token | Property | Values |
|---|---|---|
| `b:` | Background | `transparent` `primary` `secondary` `alt` `accent-soft` `red-soft` `orange-soft` `yellow-soft` `green-soft` `cyan-soft` `blue-soft` `pink-soft` |
| `bc:` | Border color | `gray` `accent` `muted` `text` `red` `orange` `yellow` `green` `cyan` `blue` `pink` |
| `t:` / `tc:` | Text color | Same as border color |
| `sb:` | Show border | `1/0`, `true/false`, `yes/no`, `on/off` |
| `h:` / `hd:` | Horizontal dividers | Same as toggle values |
| `lb:` | Left border (callout style) | Same as toggle values |
| `sep:` | Separator line | Same as toggle values |
| `sc:` | Separator color | Same as border color |
| `ss:` | Separator style | `solid` `dashed` `dotted` `double` `custom` |
| `sw:` | Separator width (px) | `1`–`8` |
| `sx:` | Custom separator char | 1–3 chars (with `ss:custom`) |
| `stk:` | Stack group id (col-break) | positive integer |
| `l:` | Container layout (col-start) | `row` (default) `stack` |

### Nested example

```markdown
%% col-start %%
%% col-break:40 %%
# Outer column 1
%% col-break:60 %%
# Outer column 2 (contains nested)

%% col-start %%
%% col-break %%
## Child 1
%% col-break %%
## Child 2
%% col-end %%
%% col-end %%
```

### Combined example

```markdown
%% col-start:bc:muted %%
%% col-break:30,stk:1,b:secondary,lb:1 %%
!note: Nav
- Home
- Docs
%% col-break:stk:1,b:secondary %%
!info: Status
Online
%% col-break:70,b:alt %%
!tip: Body
Main content with **bold**, `inline code`, etc.
%% col-end %%
```

---

## Commands

| Command | Description |
|---|---|
| Insert 2-wide layout | Two equal columns |
| Insert 3-wide layout | Three equal columns |
| Insert 4-wide layout | Four equal columns |
| Insert layout (custom count) | Uses `defaultColumnCount` |
| Insert nested layout | Parent with child columns |
| Insert sidebar + content | 30/70 layout |
| Insert stacked + wide | Stacked rows + wide column |
| Insert Cornell notes | Cornell template |
| Insert Kanban board | Kanban template |
| Insert info card | Info card template |
| Open Markdown Preview (Columns) | Open the built-in preview with column rendering |

---

## Settings

`multiColumnMarkdown.*` (search "multi column" in Settings):

- **General** — `defaultColumnCount`, `minColumnWidthPercent`, `inheritStyleOnAdd`
- **Appearance** — `containerBackground`, `showContainerBorder`, `containerBorderWidthPx`, `containerBorderColor`,
  `containerCornerRadiusPx`, `containerTextColor`, `verticalDividerWidthPx`, `verticalDividerStyle`, `verticalDividerColor`,
  `styleTargetMode` / `styleTargetColumnIndex`
- **Headers** — `enableHeaders` + `headerTypes` (JSON array; see package.json for the default presets)

---

## Differences from the Obsidian plugin

- **Preview rendering only**: editing happens on the marker text in the built-in editor (VSCode cannot render
  column layouts inside the source view — platform limitation); the preview is read-only (no drag-resize/style popover;
  edit width/style tokens instead).
- **Removed settings**: `enableReadingView` / `enableLivePreview` / `showDragHandles` (no effect in VSCode).
- **Not ported**: `foldNotePropertiesByDefault` (Obsidian note-properties UI), legacy callout syntax (`[!col]`).
- **Preview limitation**: markers must be on their own line with blank lines around the block (markdown-it block semantics).

---

## Development

```bash
npm install
npm run build      # type-check + esbuild bundle
npm run package    # build + vsce package
```

Architecture: `src/core/` (pure parsing/serialization/style mapping) + `src/preview/` (markdown-it plugin registered
via the official `markdown.markdownItPlugins` contribution + `extendMarkdownIt` API) + `src/completion.ts` (`[[` file
completion). No webview/custom editor — a single small extension-host bundle (~19 KB), minimal memory footprint.

---

## License

AGPL-3.0. A port of [advanced-multi-column](https://github.com/amatya-aditya/advanced-multi-column) (AGPL-3.0);
portions of the source (parser, style mapping, templates, renderer semantics) are derived from that project.
