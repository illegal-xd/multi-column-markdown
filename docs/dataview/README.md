# Dataview in VSCode — usage, API surface, and Obsidian differences

This extension renders ```` ```dataview ```` (DQL) and ```` ```dataviewjs ````
blocks — plus inline `` `= expr` `` / `` `$= expr` `` queries — inside VSCode's
**built-in Markdown preview**. There is no custom editor
and no Obsidian runtime: the index, query engine, `dv` API, renderer and sandbox
are implemented in this repository and mapped onto VSCode's workspace/webview
APIs.

Verified against: `0.5.0` + Dataview subsystem (Step C integration).

---

## 1. Quick start

1. Build (or install the `.vsix`): `pnpm build`. `dist/dataviewWorker.js` and
   `dist/dataviewWebview.js` must exist — they are the sandbox worker and the
   preview enhancement script.
2. Open any Markdown file and run **“Open Markdown Preview (Columns)”** (or the
   built-in preview command). Blocks render after the index finishes building
   (first time only, then cached in memory for the session).
3. Inspect what is going on with **“Show Dataview Stats (index / cache /
   workers)”** — it prints index size, cache hit rate, job/timeout counters and
   the raw timing series to the *Multi Column: Dataview* output channel.

A block that is still running shows a skeleton; when its worker job finishes the
preview refreshes once (not once per block) and the rendered table replaces it.

## 2. Settings

| Setting | Default | Meaning |
|---|---|---|
| `multiColumnMarkdown.dataview.enabled` | `true` | Render `dataview`/`dataviewjs` fences at all. |
| `multiColumnMarkdown.dataview.timeoutMs` | `5000` | Per-block budget. On expiry the worker thread is **terminated** and respawned; the block shows an error, other blocks are unaffected. |
| `multiColumnMarkdown.dataview.maxRows` | `1000` | Rows per table/query before truncation (a notice is emitted). |
| `multiColumnMarkdown.dataview.workerPoolSize` | `2` | Sandbox threads. Blocks from one file are pinned to one thread. |
| `multiColumnMarkdown.dataview.cacheSize` | `500` | LRU entries of rendered blocks (key includes index version). |
| `multiColumnMarkdown.dataview.indexExclude` | `**/{node_modules,.git,dist,out,.obsidian,.trash}/**` | Files excluded from indexing. |
| `multiColumnMarkdown.dataview.renderNullAs` | `-` | Text for `null`/`undefined` cells (upstream `renderNullAs`). |
| `multiColumnMarkdown.dataview.dateFormat` | `yyyy-MM-dd` | Date cell format; a non-midnight value gets ` HH:mm` appended (upstream `defaultDateFormat`/`defaultDateTimeFormat`). |
| `multiColumnMarkdown.dataview.maxRenderDepth` | `3` | Nesting depth for array/object cells before `…` (upstream `maxRecursiveRenderDepth`). |
| `multiColumnMarkdown.dataview.showResultCount` | `false` | Append an upstream-style “N results” badge to tables/lists/task lists. |
| `multiColumnMarkdown.dataview.inlineQueries` | `true` | Render inline `` `= …` `` / `` `$= …` `` spans at all. |
| `multiColumnMarkdown.dataview.inlinePrefix` | `=` | DQL inline prefix (upstream `inlinePrefix`). |
| `multiColumnMarkdown.dataview.jsInlinePrefix` | `$=` | JS inline prefix (upstream `jsInlinePrefix`). |

## 3. Supported block syntax

````markdown
```dataview
TABLE file.name AS "File", status, due
FROM #project
WHERE status = "open"
SORT due ASC
LIMIT 20
```
````

* Query types: `TABLE`, `LIST`, `TASKS`, `CALENDAR`.
* Clauses: `FROM`, `WHERE`, `SORT` (multiple keys), `GROUP BY … AS "name"`,
  `FLATTEN … AS "name"` (repeatable), `LIMIT`, `WITHOUT ID` (TABLE/LIST — drops
  the implicit `File` column / bullet link).
* Field aliases: `TABLE file.name AS "File", status` — quoted or bare.
* Clauses may be on separate lines (Obsidian's documented style) **or** on a
  single line: `TABLE rating FROM #games SORT rating DESC` parses identically.
* `FROM`: bare `#tag`, `"path/or/folder"`, `[[link]]`, `""`/absent = all pages;
  combinations with `and`/`or`, negation (`-#tag`, `!"folder"`) and the
  `incoming([[note]])` / `outgoing([[note]])` sources.
* `TABLE`/`LIST` include the implicit `File` column unless `WITHOUT ID` is given
  (upstream behaviour).
* Expressions: `==`/`=`/`!=`/`<`/`<=`/`>`/`>=`, `&&`/`||`/`!`, `and`/`or`/`not`,
  `=~` (regex), arithmetic `+ - * / %`, member access, indexing, object literals,
  array literals, **lambdas** (`(x) => x.field`, `list.filter(x => x > 1)`), and
  the 87-function library below.
* `=` is accepted as an alias of `==` (`WHERE status = "open"`), normalized by the
  parser — it is the form used throughout Obsidian's documentation.

### Inline queries

```markdown
Today is `= this.file.mtime` and 2 + 3 = `$= 2 + 3`.
```

* `` `= expr` `` runs a **DQL expression**, `` `$= expr` `` runs **JavaScript**
  (both prefixes configurable; see §2). Output is the expression's value, rendered
  with the same rules as a table cell.
* Execution context is the containing note (`this`/`file`), so
  `` `= this.rating` `` works like it does inside a `dataview` block.
* Inline results use the same worker pool, timeout, cache and error isolation as
  code blocks; a failing inline query renders an inline error and the sentence
  around it keeps rendering.
* A code span that is not prefixed (`npm run build`), an empty one (`` `=` ``),
  or inline code inside a fenced block is left untouched.

### Function library (`dv.func` / DQL expressions) — 87 functions

```
default choice contains concat join unique sort string fixed lower upper
replace regexreplace slice add sub mul div mod pow sqrt round floor ceil abs
min max log exp date dur year month day weekday hour minute second now today
link length object

typeof number list embed elink meta reduce product average minby maxby
icontains econtains containsword extract reverse nonnull firstvalue all any none
filter map flat regextest regexmatch split startswith endswith padleft padright
substring truncate display hash striptime dateformat durationformat
currencyformat localtime ldefault
```

Functions are **vectorized** the same way upstream is: containers are mapped
element-wise (`contains(list, "x")`, `round(dv.pages().rating)`), while
container-returning/text-shaping functions (`display`, `typeof`, `slice`) stay
scalar by design.

## 4. `dv` API surface

```ts
// data access
dv.current(path?)          dv.page(path?)         dv.pages(source?)
dv.pagePaths(source?)      dv.array(iterable)
dv.date(v)                 dv.duration(v)         dv.parse(text)     dv.literal(v)
dv.compare(a, b)           dv.equal(a, b)

// links
dv.fileLink(path, embed?, display?)    dv.sectionLink(path, section, embed?, display?)
dv.blockLink(path, blockId, embed?, display?)

// rendering
dv.paragraph(text)         dv.span(text)          dv.header(level, text)
dv.list(items, ordered?)   dv.table(headers, rows, groupByFile?)
dv.taskList(tasks, groupByFile?)
dv.el(tag, text?, {cls, attr, text})      dv.html(html)   dv.markdown(text)
dv.markdownTable(headers, values?)        dv.markdownList(values?)
dv.markdownTaskList(values)

// queries / execution
dv.query(source)           dv.tryQuery(source)    dv.queryMarkdown(source)
dv.tryQueryMarkdown(source)  dv.evaluate(expr, ctx?)   dv.tryEvaluate(expr, ctx?)
dv.execute(source)         dv.executeJs(code)     dv.view(path, input?)

// environment
dv.isArray(v) dv.isDataArray(v) dv.value.<isLink|isDate|isDuration|isNumber|…>
dv.currentFilePath         dv.app                 dv.settings            dv.func.<name>(...)
dv.io.load(source)         dv.io.read(path)       dv.io.normalize(path)  dv.io.csv(path)
```

`dv.fileLink(path, embed, display)` follows upstream argument order (the legacy
`(path, display, embed)` order is still accepted with a one-time warning).

Dates are Luxon-shaped (`DvDate`) and carry the full method surface:
`year/month/day/hour/minute/second/weekday`, `toISO` / `toMillis` / **`toJSDate`**,
`toFormat` / `toISODate` / `toISOTime` / `toISOWeekDate`, `plus`/`minus`/`set`,
`diff`/`until`/`hasSame`, `startOf`/`endOf`, `toRelative`/`toObject`,
`weekdayLong`/`monthLong`/`daysInMonth`, `equals`/`isValid`. `toJSDate()` returns a
native `Date` for the same instant — the bridge to use when handing a Dataview date
(`dv.date(...)`, `file.mtime`, a date-typed inline field) to non-Dataview code.

`dv.pages()`/`dv.page()` return **DataArray**s / page objects with the full
chainable surface:

```
length array total sum min max mean median any none every find findIndex
first last slice flatMap map where filter forEach groupBy groupIn join
unique distinct reverse sort ordered limit take flatten toJSON
swizzle (data.field) mutate concat indexOf includes some to expand avg
isEmpty
```

DataArrays are a **Proxy over a shared prototype** (upstream's swizzling model):
`dv.pages("#book").file.name` maps the field over the array, numeric indexes work
(`arr[0]`), and an unknown field yields an **empty DataArray** rather than
`undefined`, so chains stay safe. Field names win over method names the same way
upstream resolves them.

Page objects are `{ ...frontmatter ∪ inlineFields, file: {...} }`; `file` carries
`path, name, folder, ext, link, tags, etags, aliases, lists, tasks, inlinks,
outlinks, frontmatter, size, ctime/mtime/cday/mday (dates), starred`.
`file.lists` and `file.tasks` are upstream-shaped list items
(`text/status/checked/completed/fullyCompleted/visual/annotated/symbol/tags/line
/lineCount/path/section/blockId/link/children/subtasks/real/header`) with inline
fields (`t.due`, …) and nested `children`/`subtasks`.

Also available inside a block: `app` (partial `vscode`-mapped shim, §6),
`input` (the block's raw source), `console` (forwarded to the output channel),
`setTimeout`/`setInterval` (+ clear variants, released when the job settles).
`Promise`, `Map`, `Set`, `Intl`, `JSON`, `Math`, `Date`, `RegExp` come from the
sandbox's own realm.

`renderHeatmapCalendar(container, calendarData)` is a sandbox **global** too — the
[Heatmap Calendar](https://github.com/Richardsl/heatmap-calendar-obsidian) plugin's
dataviewjs helper — so existing snippets run unchanged:

```js
renderHeatmapCalendar(this.container, {
  year: 2022,
  colors: {orange: ["#ffa244", "#fd7f00", "#dd6f00", "#bf6000", "#9b4e00"]},
  entries: [{date: "2022-01-01", intensity: 3, content: "🏋️", color: "orange"}],
});
```

Accepted fields: `year` (default: current), `colors` (map of `name → [c0…c4]`, or a
string → the built-in green scale), `entries` (`{date, intensity, color, content}`,
filtered to `year`), `showCurrentDayBorder`, `defaultEntryIntensity` (4),
`intensityScaleStart`/`End` (default: min/max entry intensity). Intensities map
linearly onto the palette; `weekStartDay` is always Monday (upstream reads it from
its plugin settings). Documented deviations: `container` is ignored (the sandbox has
no DOM — the calendar renders into the block), a string `colors` falls back to the
default palette instead of looking the name up in plugin settings, and the `today`
border is only drawn when the rendered year **is** the current one.

## 5. Data index

Per page: frontmatter (YAML subset), inline fields, headings/sections nested
lists, tasks (nested, with tags + inline fields), outlinks/inlinks, `#tags` +
expanded parent tags, aliases, size/mtime.

Inline field syntaxes verified by test:

```markdown
Status:: open              <!-- line-start form -->
- [ ] task [due:: 2024-01-02]   <!-- bracketed form inside a task/list item -->
```

Inline fields win over frontmatter on conflict; a date-shaped value is typed as a
date (`dv.date(...)`-comparable).

Indexing is **incremental**: watcher events are coalesced per path (150 ms) and a
flush re-parses only the changed files and re-links their targets. Unchanged
files are skipped by an (mtime, size) short-circuit, and reverse indexes
(tag/folder/outlink) keep the update cost proportional to the changed file, not
to the repository.

## 6. Differences from Obsidian Dataview (honest list)

Everything here is a known deviation; nothing below is silently approximated.

### Sandbox capabilities

| Obsidian | Here | Alternative |
|---|---|---|
| Full browser globals (`fetch`, `URL`, …) | `fetch`/`URL`/`structuredClone`/`TextEncoder` are **undefined**; `require`, `process`, `module` too | No network access by design. Use the host IO bridge: `dv.io.read/load`, `app.vault.read` |
| `eval` / `new Function` work | **blocked** (`vm` context with `codeGeneration:{strings:false}`) | Compute inline; this also closes the classic `constructor.constructor` escape |
| `import()` / npm packages | **rejected** with a clear error | Inline the code, or fetch data through `dv.io` |
| Shared global object across blocks | fresh `vm` context per block — `globalThis.x` set in one block is invisible to the next | Pass values through frontmatter/index; this is a deliberate isolation guarantee |

The sandbox is a **timeout/DoS boundary**, not a hostile-code sandbox: worker
threads still have Node fs/net capability. Treat `dataviewjs` from an untrusted
repository like any other executable code in that workspace.

### API gaps

| Missing | Notes / alternative |
|---|---|
| `file.day` | Obsidian's Periodic Notes concept. Use `file.name`/`file.ctime` or an explicit frontmatter field. |
| `dv.span` / `dv.paragraph` / `dv.header` options | `{cls, attr}` are accepted then **dropped** for these three (their RenderOps carry text only). Use `dv.el(tag, text, {cls, attr})` when classes/attributes matter. |
| `dv.el` with arbitrary tags | Tag whitelist (div/span/p/h1-h6/a/strong/em/code/b/i/u/s/small/sub/sup/br/hr). Other tags degrade to a warning notice + `<span>`; `on*` attributes are stripped. |
| `dv.el` block/flex containers (`container`, `dv.container`) | No real DOM access from the sandbox — `dv.el` returns a chainable handle that appends into the emitted op tree, and `container:` is ignored. |
| `input` as a DOM container | See below: `input` here is the block's source text, so `dv.el(tag, text, {container: input})` does not apply. |
| `app` object | Partial shim only: `vault.getAbstractFileByPath/read/getFiles`, `metadataCache.getFileCache`, `workspace.getActiveFile`. No `TFolder` tree, no `resolvedLinks`, no attachment/media handling, no `app.plugins`. |
| `dv.io.load()` markdown rendering | Returns the **raw file text**, not rendered markdown. |
| `input` | Here it is the block's **source string** (per this project's contract), not a DOM container. Code doing `input.innerHTML = …` will not work — use `dv.*`. |
| Clickable task checkboxes | Dataview task checkboxes render **disabled**: toggling writes to files and is out of scope. |
| DQL lambdas | Supported: `(x) => x.field` and the `x => x.field` short form, with closure over the surrounding scope. |
| Task fields in `TASKS` queries | `WHERE !completed`, `t.checked`, `t.visual`, `t.symbol`, `t.children` all work — tasks are the same upstream-shaped list items exposed by `file.tasks`. |
| Non-file `FROM` sources (CSV/JSON, folder indexes) | Not implemented. |
| `#task`-style Obsidian-specific task syntax | Only Markdown task list items are indexed. |

### Rendering model

| Obsidian | Here |
|---|---|
| `dv.markdown()` / `dv.el(div, text)` render block markdown | Same: the preview's own markdown-it (`md.render`) renders that text, so fenced code, tables and lists inside it are highlighted/rendered like the document body. `dv.span`/`dv.paragraph`/`dv.header` stay **inline** markdown, because block constructs inside `<p>`/`<h1>` would be invalid HTML. |
| Heading links (`#Heading`) jump to Obsidian's own anchor slug | Anchors are normalized GitHub-style (`#My   Heading!` → `#my-heading`) to match the ids VSCode's preview generates. Duplicate headings get `-1`/`-2` suffixes in VSCode; a link cannot know which duplicate it means, so that stays approximate. Block references (`#^id`) have no VSCode anchor and degrade to a file link. |
| Dataview patches its own container in place | The built-in preview is re-rendered; the extension can only ask for a whole-document `markdown.preview.refresh`. Refreshes are coalesced (one per settled wave of blocks, ≥400 ms apart) and every block is served from the render cache on refresh, so no block re-executes twice for the same index version. |
| — | **Scroll anchoring.** VSCode restores the preview scroll after a refresh by *progress* (`scrollY / documentHeight`) and then syncs the editor to whatever source line sits at the top. A block that resolves (placeholder → long table) changes the document height, so that progress lands on another line and the editor got scrolled/selected to it while typing. The injected preview script now records the top-most `data-line` block (plus the offset into it) on every scroll and restores that same source line after a swap — one animation-frame pass plus one 150 ms settle pass, before the preview client's 200 ms sync-suppression window elapses, so usually no sync message is sent at all. Need the editor to *never* follow the preview? Set `markdown.preview.scrollEditorWithPreview` to `false` (VSCode setting, applies to every Markdown file). |
| Renders unlimited rows | `maxRows` (default 1000) per table/query, plus a 20 000-cell budget per block; both emit a visible notice. |
| — | Tables with ≥100 rows additionally embed a pre-rendered payload; the preview script virtualizes them (60-row window, rAF-throttled). Task lists >120 items paginate with a “Show N more” button. Payload is capped at 3000 rows / 512 KB; beyond that the server-rendered (truncated) table is used as-is. |
| Persisted index cache | Index is in-memory per window session, built lazily on the first dataview block. |
| Local vault only | Index reads via `workspace.fs` (works remotely). `dv.io`/`app.vault.read` go through the extension host's `node:fs` on the workspace-relative path, so **virtual filesystems (e.g. github.dev) can't read files** —  index and rendering still work. |

## 7. Examples (all exercised by the test suite)

Inline:

```markdown
Rating: `= this.rating` · files: `$= dv.pages("#book").length`
```

````markdown
```dataviewjs
// Table of open notes with a link, from frontmatter + index fields
dv.table(
  ["File", "Status", "Due"],
  dv.pages("#note")
    .where(p => p.status === "open")
    .sort(p => p.due, "asc")
    .limit(50)
    .map(p => [p.file.link, p.status, p.due])
);
```

```dataviewjs
// Async file access is allowed; the block simply awaits it
const text = await dv.io.read("notes/raw.md");
dv.paragraph(`README length: ${text.length} characters`);
```

```dataviewjs
// Tasks from the current page, grouped by file
dv.taskList(dv.current().file.tasks.where(t => t.status !== "x"), true);
```

```dataviewjs
// Grouping via DataArray
for (const group of dv.pages("#note").groupBy(p => p.status)) {
  dv.header(4, `${group.key} (${group.rows.length})`);
  dv.list(group.rows.map(p => p.file.link));
}
```
````

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Block stuck on the skeleton | Index still bootstrapping, or the worker script is missing. Check the *Multi Column: Dataview* output channel; run `pnpm build` so `dist/dataviewWorker.js` exists. |
| `Dataview worker unavailable` | Worker entry failed to load repeatedly (3 spawn failures disable that slot). Check the bundle and the output channel. |
| `timed out after Nms` | Block exceeded `dataview.timeoutMs`; raise it for heavy queries, or narrow the query. |
| `EvalError: Code generation from strings disallowed` | `eval`/`new Function` use — not supported. |
| Table shows “Showing first N of M rows” | `dataview.maxRows`. |
| Edits don't appear | The index flushes ~150 ms after the save; the preview then refreshes automatically. |
