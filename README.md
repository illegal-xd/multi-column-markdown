# Advanced Multi Column (VSCode) — Markdown Multi-Column Preview Enhancement

> Enhances the **built-in Markdown preview** to render marker-based multi-column layouts. Editing stays 100% in
> VSCode's native Markdown editor — this extension only touches the preview.
>
> 中文文档：`README.zh-CN.md`（与 README.md 同目录）· Chinese docs: `README.zh-CN.md` (same directory).

Ported from the Obsidian plugin [`amatya-aditya/advanced-multi-column`](https://github.com/amatya-aditya/advanced-multi-column)
(v1.3.1, AGPL-3.0). The **marker syntax, rendering semantics, style tokens, templates and settings are 1:1** — documents
written for the Obsidian plugin render identically in the built-in preview.

> **Live demo**: the extension ships `preview/preview.md`, a full walkthrough of every feature. Open it and press
> `Cmd+Shift+V` to see all options rendered side by side with their source.

---

## Features

- **Preview rendering** — `%% col-start %%` / `%% col-break %%` / `%% col-end %%` blocks render as column layouts in
  the built-in Markdown preview (`Cmd+Shift+V`).
- **Nested columns** — unlimited depth; build columns inside columns.
- **Width control** — `%% col-break:30 %%` sets percentage width (also `w:40`); sums over 100% fall back to equal widths.
- **Responsive columns** — add the `responsive` token to `%% col-start %%`: columns keep their widths side-by-side on a
  wide preview, and stack full-width below 640px. Pure CSS — layout behaviour only, never rewrites the widths you wrote.
- **Stack groups** — `stk:N` stacks adjacent columns vertically; container-level `l:stack` lays out the whole block top-to-bottom.
- **Style tokens (22)** — background `b:`, border color `bc:` (incl. `transparent`), border width `bw:`/`bwl:`/`bwt:`/`bwr:`/`bwb:`, border radius `br:`/`brl:`/`brt:`/`brr:`/`brb:`, text color `t:`/`tc:`, border toggle `sb:`, horizontal
  dividers `h:`/`hd:`, left border `lb:`, separators `sep:`/`sc:`/`ss:`/`sw:`/`sx:`, text alignment `ta:`, margin shorthand `m:`.
- **Wikilinks & embeds** — `[[note]]` renders as a clickable link; `[[note|alias]]` shows an alias and `[[note#Heading]]` / `[[note^block]]` add Obsidian-style URL fragments; `![[image.png]]` embeds an image and `![[note]]` / `![[note.md]]` embeds the rendered Markdown content (depth-limited, cycle-safe, falls back to `<img>` when the file is missing).
- **Templates (11 commands)** — 2/3/4-wide, custom count, nested, sidebar, responsive sidebar, stacked, Cornell notes, Kanban board, info card.
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
> - Token separators accept commas (half/full width) or spaces (e.g. `b:secondary ml:10`); multi-value spacing like `pd:4 8` is preserved.


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
| `b:` | Background (custom `#hex` allowed) | `transparent` `primary` `secondary` `alt` `accent-soft` `red-soft` `orange-soft` `yellow-soft` `green-soft` `cyan-soft` `blue-soft` `pink-soft`, or `#1f2937`, `#3b82f61f` (8-digit with alpha) |
| `bc:` | Border color (custom `#hex` allowed) | Same palette as `b:` plus `#3b82f6` |
| `t:` / `tc:` | Text color | Same as border color |
| `sb:` | Show border | `1/0`, `true/false`, `yes/no`, `on/off` |
| `h:` / `hd:` | Horizontal dividers | Same as toggle values |
| `lb:` | Left border (callout style) | Same as toggle values |
| `sep:` | Separator line | Same as toggle values |
| `sc:` | Separator color | Same as border color |
| `ss:` | Separator style | `solid` `dashed` `dotted` `double` `custom` |
| `sw:` | Separator width (px) | `1`–`8` |
| `sx:` | Custom separator char | 1–3 chars (with `ss:custom`) |
| `ta:` | Column content text alignment | `left` `center` `right` |
| `pd:` | Column padding (default `5px`) | CSS spacing 1–4 values: `8`, `4 8`, `0.5em`, `10%` (numbers → px); a single value applies to all four sides |
| `br:` | Column border radius (default `0`/square unless set) | CSS spacing: `12`, `0.5em`, `4 8 12 16` (numbers → px) |
| `brl:` / `brt:` / `brr:` / `brb:` | Per-edge border radius (l=left edge, covers top-left+bottom-left; overrides `br:`) | CSS spacing, same as `br:` |
| `m:` | Column margin shorthand (default `0`) | CSS spacing 1–4 values: `8`, `4 8`, `4 8 12 16`; a single value applies to all four sides |
| `ml:` / `mt:` / `mr:` / `mb:` | Directional margin (legacy, overrides `m:`) | CSS spacing, same as `pd:` |
| `bw:` | Border width (default `1px` when shown; col-start & col-break) | CSS spacing 1–4 values: `1`, `1 0`, `0.5em`; a single value applies to all four sides |
| `bwl:` / `bwt:` / `bwr:` / `bwb:` | Per-side border width (overrides `bw:`; unspecified sides stay `0px`/no border) | CSS spacing, same as `bw:` |
| `g:` | Container gap between columns (default `5px`, col-start) | CSS spacing: `8`, `0.5em`, `10%` (numbers → px) |
| `stk:` | Stack group id (col-break) | positive integer |
| `l:` | Container layout (col-start) | `row` (default) `stack` |
| `responsive` | Responsive layout (col-start, bare token) | present ⇒ stacks below the 640px breakpoint |

> Stacked spacing: every vertically-stacked state (`l:stack`, `stk:N` groups, and the responsive collapse below 640px)
> shares the `--columns-stacked-gap` variable (default `8px`, slightly relaxed from the 5px row gap). An explicit `g:`
> token still controls that spacing, because the CSS fallback chain reads `--columns-block-gap` first.

### Responsive example

```markdown
%% col-start:responsive %%
%% col-break:30 %%
Sidebar
%% col-break:70 %%
Content
%% col-end %%
```

- **Wide preview** — the container keeps the authored widths (`30% | 70%`).
- **Narrow preview** — every column becomes `100%` wide and stacks vertically.
- Responsive is **layout behaviour only**: your `widthPercent` values are never rewritten; `l:stack` blocks are already
  vertical and are unaffected.
- Scoped to the `.columns-responsive` class with direct-child selectors — a nested container that does **not** carry the
  token keeps its own authored layout even inside a responsive parent.
- Breakpoint is a fixed CSS `@media (max-width: 640px)` evaluated against the preview webview width (no JS resize
  listeners, parser is viewport-agnostic). A container nested inside a narrow column does **not** collapse on its own —
  only the viewport breakpoint triggers the change.
- A bare `responsive` token only. `responsive:1` / `rs:` / typos are ignored — a malformed token must never silently
  change a document's layout.

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
**Nav**
- Home
- Docs
%% col-break:stk:1,b:secondary %%
**Status**
Online
%% col-break:70,b:alt %%
**Body**
Main content with **bold**, `inline code`, etc.
%% col-end %%
```

### Wikilinks & embeds

```markdown
[[docs/Guide]]                → link to docs/Guide.md
[[docs/Guide|Read guide]]     → link with alias
[[docs/Guide#Install|Setup]]  → link with heading anchor  (#install)
[[note^abc123]]               → link with block URL fragment (#abc123)
![[image.png]]                → embedded image
![[docs/guide]]               → embedded Markdown (docs/guide.md rendered in place)
![[docs/guide.md|Guide]]      → embedded Markdown with caption alias
```

> Markdown embeds run through the same markdown-it pipeline (columns, wikilinks, task lists included), capped at
> 8 nesting levels with cycle protection. Non-Markdown targets (`png/jpg/pdf/mp3/mp4/…`) render as `<img>` with the
> alias used as alt text; a missing file also falls back to `<img>`.

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
| Insert responsive sidebar | 30/70 layout, stacks full-width below 640px |
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

---

## Dataview blocks (`dataview` / `dataviewjs`)

The preview also renders Dataview-style code blocks — DQL queries and full
`dataviewjs` scripts — plus inline `` `= expr` `` / `` `$= expr` `` queries, backed
by an incremental workspace index and a worker-thread sandbox:

````markdown
```dataview
TABLE file.name AS "File", status
FROM #project
WHERE status = "open"
SORT due ASC
```

Rating: `= this.rating` · `$= dv.pages("#project").length` files
````

- **Index** — frontmatter, inline fields, tasks, lists, sections, links, tags/aliases; incremental updates on file
  change (a one-file save costs ~0.1 ms against ~126 ms for a full 1000-file index).
- **Sandbox** — each block and inline query runs in a `node:vm` context inside a worker thread, with a per-block
  timeout that terminates and respawns the thread; one failing block never affects the rest of the document.
- **Batched rendering** — blocks execute through a task queue: at most 3 blocks of one file run at once, the rest wait
  their turn, and each finished batch refreshes the preview instead of blocking the document until the last block.
- **Performance** — rendered blocks are cached by content hash + index version, preview refreshes are coalesced, and
  large tables/task lists are virtualized/paginated in the preview.
- **Stable scroll** — refreshes re-anchor the preview to the `data-line` block that was at the top, so resolving a
  block no longer scrolls the editor away while you type.
- **Heatmap calendars** — the Heatmap Calendar plugin's `renderHeatmapCalendar(this.container, {...})` works as a
  sandbox global (year grid, palettes, per-entry intensity/colour/content), rendered as native preview markup.
- **Docs:** [usage, API surface & Obsidian differences](docs/dataview/README.md) ·
  [architecture](docs/dataview/architecture.md) · [performance report](docs/dataview/performance.md)

Run **“Show Dataview Stats (index / cache / workers)”** to inspect index size, cache hit rate and worker counters.

---

## Differences from the Obsidian plugin

- **Preview rendering only**: editing happens on the marker text in the built-in editor (VSCode cannot render
  column layouts inside the source view — platform limitation); the preview is read-only — edit width/style
  tokens in the source text instead.
- **Removed settings**: `enableReadingView` / `enableLivePreview` (no effect in VSCode).
- **Not ported**: `foldNotePropertiesByDefault` (Obsidian note-properties UI), legacy callout syntax (`[!col]`).
- **Embed scope**: `![[note]]` / `![[note.md]]` embeds the **whole** Markdown file (same pipeline, `≤ 8` levels, cycle-safe). Heading/block-scoped embeds (`![[note#Heading]]`, `![[note^block]]`), image sizing (`![[img.png|300]]`) and audio/video/PDF embeds are not ported yet; non-Markdown targets and missing files render as a plain `<img>`.
- **Preview limitation**: markers must be on their own line with blank lines around the block (markdown-it block semantics).

---

## Development

```bash
pnpm install
pnpm build      # type-check + esbuild bundle
pnpm test       # unit tests (parser, preview rendering, wikilinks)
pnpm benchmark  # parser-cache performance baseline
pnpm package    # build + vsce package
```

> Package manager is pnpm (pinned via `packageManager` in `package.json`; the lockfile is `pnpm-lock.yaml`).
> `pnpm-workspace.yaml` holds the `allowBuilds` list — pnpm 10+ blocks dependency postinstall scripts by default,
> and `esbuild` needs its postinstall to fetch the platform binary.

Architecture: `src/core/` (pure logic: `parser.ts` / `serializer.ts` / `style.ts` / `templates.ts` / `wikilink.ts`)
+ `src/preview/` (markdown-it plugin registered via the official `markdown.markdownItPlugins` contribution +
`extendMarkdownIt` API) + `src/completion.ts` (`[[` file completion). No webview/custom editor — a single small
extension-host bundle (~27 KB), minimal memory footprint.

Performance: column parsing results are cached per document text (bounded cache), the Markdown file list is fetched
via `workspace.findFiles()` with a promise-level cache invalidated by a file watcher, and Markdown embeds are capped
at 8 levels — repeated preview refreshes stay cheap.

---

## License

AGPL-3.0. A port of [advanced-multi-column](https://github.com/amatya-aditya/advanced-multi-column) (AGPL-3.0);
portions of the source (parser, style mapping, templates, renderer semantics) are derived from that project.
