/**
 * RenderOp → HTML (B3). Class names are a previewScripts/CSS contract — do not rename.
 *
 * Escaping: every text fragment passes escapeHtml (src/preview/htmlEscape.ts), except
 * (a) t:"html" / kind:"html" — trusted dv.html() output; the Webview CSP still backstops it —
 * and (b) results of opts.renderInline (host markdown renderer output).
 */
import {escapeAttr, escapeHtml} from "../../preview/htmlEscape";
import type {CellValue, Link, RenderOp, TaskNode} from "../types";
import {formatDurationMs} from "../values";

export interface RenderOptions {
	/** Workspace-relative path of the block's page — link resolution base (posix). */
	basePath: string;
	/** Host inline-markdown renderer; absent → plain escaping for str/md cells. */
	renderInline?: (md: string) => string;
	/**
	 * Host BLOCK markdown renderer (`md.render`). Used where upstream renders
	 * block markdown into the container — `dv.markdown()` and `dv.el()` on a
	 * block-level tag — so fenced code, tables and lists inside that text are
	 * rendered by the preview's own markdown-it (same plugins/highlighting as the
	 * document body) instead of being escaped to plain text.
	 * Absent → inline fallback (tests without a host renderer keep working).
	 */
	renderMarkdownBlock?: (md: string) => string;
	/** Max data rows per table; default 1000. */
	maxRows?: number;
	/** Global cell budget across the block; default 20000. */
	maxCells?: number;
	/** 大结果集时在容器上嵌入预渲染分片（webview 侧窗口化用）；默认 100。0 = 禁用。 */
	payloadThreshold?: number;
	/** payload JSON 字节上限（超出则不嵌入，退回服务端截断 HTML）；默认 512 * 1024。 */
	payloadMaxBytes?: number;
	/** null/undefined 单元格的显示文本（内联 markdown 渲染）；默认 "-"。上游 renderNullAs。 */
	renderNullAs?: string;
	/** 日期单元格格式（午夜值只出日期，含时间时追加 " HH:mm"）；默认 "yyyy-MM-dd"。 */
	dateFormat?: string;
	/** 嵌套渲染深度上限，超出输出 "…"；默认 3。上游 maxRecursiveRenderDepth。 */
	maxRenderDepth?: number;
}

const DEFAULT_MAX_ROWS = 1000;
const DEFAULT_MAX_CELLS = 20000;
const DEFAULT_PAYLOAD_THRESHOLD = 100;
const DEFAULT_PAYLOAD_MAX_BYTES = 512 * 1024;
const PAYLOAD_MAX_ROWS = 3000;
const PAYLOAD_VERSION = 1;
const VOID_TAGS = new Set(["br", "hr"]);
const DEFAULT_RENDER_NULL_AS = "-";
const DEFAULT_DATE_FORMAT = "yyyy-MM-dd";
/** 午夜之外的日期只追加时间部分，保持上游 defaultDateFormat/defaultDateTimeFormat 的关系。 */
const DATE_TIME_SUFFIX = " HH:mm";
const DEFAULT_MAX_RENDER_DEPTH = 3;
/**
 * 深度超限标记。本项目约定用 U+2026（同 values.ts 的 MAX_CELL_DEPTH 占位符）；
 * 上游 renderValue 追加的是 ASCII "..." —— 差异已文档化。
 */
const DEPTH_MARKER = "…";
/** 新增类名（只增不改，保持 previewScripts/CSS 契约）。 */
const LIST_UL_CLASS = "dataview-list dataview-result-list-ul";
const OBJECT_UL_CLASS = "dataview-list dataview-result-object-ul";
const EMPTY_UL = '<ul class="dataview-list"></ul>';
/** 单元格展开模式：table 单元格 → 嵌套 ul；段落/内联 → 逗号连接（上游 expandList）。 */
type CellRenderMode = "cell" | "inline";
const DATE_TOKEN_RE = /yyyy|MM|dd|HH|mm|ss/g;

/** 大结果降级：cell 预算防 preview 卡死（跨 op 全局计数）。 */
class CellBudget {
	readonly max: number;
	left: number;

	constructor(max: number) {
		this.max = max;
		this.left = max;
	}

	/** Consume n cells; false (consuming nothing) when the budget would break. */
	tryConsume(n: number): boolean {
		if (n > this.left) return false;
		this.left -= n;
		return true;
	}
}

/** 达到阈值才嵌入 payload；threshold === 0（或负数）视为禁用。 */
function payloadEnabled(opts: RenderOptions, count: number): boolean {
	const threshold = opts.payloadThreshold ?? DEFAULT_PAYLOAD_THRESHOLD;
	return threshold > 0 && count >= threshold;
}

/**
 * 把 v1 payload 编码成 ` data-dv-payload="…"` 属性；禁用或超出上限时返回 ""。
 * 消费方：src/dataview/webview/main.ts（窗口化/分页）。
 *
 * 字节估算：用 JSON.stringify(...).length（UTF-16 code units）作为字节数的保守近似 —
 * ASCII/转义后内容与字节数同量级；非 ASCII 文本会低估（每字符最多 3 字节），
 * 故表数据另有 PAYLOAD_MAX_ROWS 行数上限兜底。属性经 escapeHtml 后因引号转义实际更长。
 */
function encodePayload(payload: unknown, opts: RenderOptions): string {
	if ((opts.payloadThreshold ?? DEFAULT_PAYLOAD_THRESHOLD) <= 0) return "";
	const json = JSON.stringify(payload);
	if (json.length > (opts.payloadMaxBytes ?? DEFAULT_PAYLOAD_MAX_BYTES)) return "";
	return ` data-dv-payload="${escapeHtml(json)}"`;
}

function wrap(kind: string, extra: string, inner: string): string {
	return `<div class="dataview-container" data-dv-kind="${escapeHtml(kind)}"${extra}>${inner}</div>`;
}

function inlineText(opts: RenderOptions, s: string): string {
	return opts.renderInline ? opts.renderInline(s) : escapeHtml(s);
}

/**
 * Block-level markdown → HTML. `md.render` output already ends with "\n"; left
 * as-is so the produced markup stays byte-comparable to the preview body.
 */
function blockText(opts: RenderOptions, s: string): string {
	if (opts.renderMarkdownBlock) return opts.renderMarkdownBlock(s);
	return inlineText(opts, s);
}

/**
 * Tags whose content model is inline: markdown block constructs inside them
 * would be invalid HTML (a `<ul>` inside `<b>`), so they always use the inline
 * renderer. Everything else (`div`, `section`, `details`, `td`, …) gets block
 * markdown, matching upstream's `dv.el` behavior.
 */
const INLINE_TAGS = new Set([
	"a", "abbr", "b", "bdi", "bdo", "cite", "code", "data", "dfn", "em", "i",
	"kbd", "mark", "q", "s", "samp", "small", "span", "strong", "sub", "sup",
	"time", "u", "var",
	// Disclosure label: a <p> inside <summary> is legal but wrong-looking, so its
	// text is rendered inline (`dv.el("details").createEl("summary", "…")`).
	"summary",
]);

/** `dv.el(tag, text)` text renderer: inline for inline tags, block otherwise. */
function elText(opts: RenderOptions, tag: string, s: string): string {
	return INLINE_TAGS.has(tag.toLowerCase()) ? inlineText(opts, s) : blockText(opts, s);
}

function noticeDiv(level: "info" | "warn", message: string): string {
	return `<div class="dataview-notice dataview-notice-${level}">${escapeHtml(message)}</div>`;
}

function errorInner(message: string, detail?: string): string {
	const d = detail !== undefined && detail !== "" ? `<pre class="dataview-error-detail">${escapeHtml(detail)}</pre>` : "";
	return `<div class="dataview-error">${escapeHtml(message)}${d}</div>`;
}

/**
 * "#My Heading!" → "my-heading".
 *
 * VSCode's preview builds heading ids with a GitHub-style slugger, so heading
 * links coming out of dataview have to normalize the same way: leading "#"
 * stripped, lowercased, every whitespace run → one "-", punctuation dropped
 * while unicode letters/numbers stay. Duplicate headings get "-1"/"-2" suffixes
 * in VSCode — a link cannot know which duplicate it targets, so that case stays
 * approximate (documented).
 */
function slugify(subpath: string): string {
	return subpath
		.replace(/^#/, "")
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[^\p{L}\p{N}\-_]/gu, "");
}

function withMdExt(p: string): string {
	const seg = p.substring(p.lastIndexOf("/") + 1);
	return /\.[A-Za-z0-9]+$/.test(seg) ? p : p + ".md";
}

/** Posix relative href from basePath's directory to target; always "./" or "../" prefixed. */
function relativeHref(basePath: string, target: string): string {
	const from = basePath.replace(/\\/g, "/").split("/");
	from.pop(); // dir segments only
	const to = target.replace(/\\/g, "/").split("/");
	let i = 0;
	while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
	const parts: string[] = [];
	for (let k = 0; k < from.length - i; k++) parts.push("..");
	parts.push(...to.slice(i));
	const rel = parts.join("/");
	return rel.startsWith("../") ? rel : "./" + rel;
}

function renderLink(link: Link, opts: RenderOptions): string {
	const text = link.display ?? link.path;
	// 上游 elink()/external widget：直出 url，不做相对路径解析与 #slug。
	if (link.external === true) {
		return `<a href="${escapeHtml(link.path)}" target="_blank" rel="noopener">${escapeHtml(text)}</a>`;
	}
	const raw = link.path.replace(/\\/g, "/").replace(/^\.\//, "");
	// Block references ("#^id") have no anchor in VSCode's preview (they are an
	// Obsidian-only concept), so they degrade to a link to the file: a working
	// jump to the top of the note beats a dead "#id" anchor.
	const subpath = link.subpath ?? "";
	// `subpath` keeps its "#" (the Link contract mirrors Obsidian), so strip it
	// before deciding whether this is a block reference.
	const bare = subpath.replace(/^#/, "");
	const anchor = bare === "" || bare.startsWith("^") ? "" : "#" + slugify(subpath);
	const href = relativeHref(opts.basePath, withMdExt(raw)) + anchor;
	return `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
}

/**
 * 日期单元格 → `dateFormat`（默认 "yyyy-MM-dd"）；非午夜值追加 " HH:mm"（上游
 * renderMinimalDate：午夜用 defaultDateFormat，否则 defaultDateTimeFormat）。
 * 用 UTC 分量格式化，保证跨时区确定性；上游用本地时区 —— 差异已文档化。
 */
function formatDateCell(iso: string, dateFormat: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	const pad = (n: number): string => (n < 10 ? "0" + n : String(n));
	const midnight =
		d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
	// 格式串已自带时间 token 时不再追加，避免重复。
	const fmt = midnight || /H/.test(dateFormat) ? dateFormat : dateFormat + DATE_TIME_SUFFIX;
	return fmt.replace(DATE_TOKEN_RE, (token) => {
		switch (token) {
			case "yyyy":
				return String(d.getUTCFullYear());
			case "MM":
				return pad(d.getUTCMonth() + 1);
			case "dd":
				return pad(d.getUTCDate());
			case "HH":
				return pad(d.getUTCHours());
			case "mm":
				return pad(d.getUTCMinutes());
			case "ss":
				return pad(d.getUTCSeconds());
			default:
				return token;
		}
	});
}

/** 单元格模式：数组 → 嵌套项目符号列表（空数组 → 空 ul，上游 expandList 分支）。 */
function renderCellArray(items: CellValue[], opts: RenderOptions, depth: number): string {
	if (items.length === 0) return EMPTY_UL;
	const kids = items
		.map((k) => `<li class="dataview-result-list-li">${renderCell(k, opts, "cell", depth + 1)}</li>`)
		.join("");
	return `<ul class="${LIST_UL_CLASS}">${kids}</ul>`;
}

/** 内联模式：数组 → 逗号连接（空数组 → 字面 `<empty list>`，上游非 expandList 分支）。 */
function renderInlineArray(items: CellValue[], opts: RenderOptions, depth: number): string {
	if (items.length === 0) return escapeHtml("<empty list>");
	return items.map((k) => renderCell(k, opts, "inline", depth + 1)).join(", ");
}

/** 单元格模式：对象 → 嵌套 ul，每项 `key: value`（空对象 → 空 ul）。 */
function renderCellObject(fields: Record<string, CellValue>, opts: RenderOptions, depth: number): string {
	const keys = Object.keys(fields);
	if (keys.length === 0) return EMPTY_UL;
	const kids = keys
		.map(
			(k) =>
				`<li class="dataview-result-object-li">${escapeHtml(k)}: ` +
				`${renderCell(fields[k]!, opts, "cell", depth + 1)}</li>`,
		)
		.join("");
	return `<ul class="${OBJECT_UL_CLASS}">${kids}</ul>`;
}

/** 内联模式：对象 → `k: v, k2: v2`（空对象 → 字面 `<empty object>`）。 */
function renderInlineObject(fields: Record<string, CellValue>, opts: RenderOptions, depth: number): string {
	const keys = Object.keys(fields);
	if (keys.length === 0) return escapeHtml("<empty object>");
	return keys.map((k) => `${escapeHtml(k)}: ${renderCell(fields[k]!, opts, "inline", depth + 1)}`).join(", ");
}

function renderCell(c: CellValue, opts: RenderOptions, mode: CellRenderMode, depth = 0): string {
	// 上游 renderValue：depth > maxRecursiveRenderDepth 时输出占位符（防递归爆炸）。
	if (depth > (opts.maxRenderDepth ?? DEFAULT_MAX_RENDER_DEPTH)) return DEPTH_MARKER;
	switch (c.t) {
		case "null":
			return inlineText(opts, opts.renderNullAs ?? DEFAULT_RENDER_NULL_AS);
		case "bool":
		case "num":
			return escapeHtml(String(c.v));
		case "str":
			return inlineText(opts, c.v);
		case "date":
			return escapeHtml(formatDateCell(c.iso, opts.dateFormat ?? DEFAULT_DATE_FORMAT));
		case "dur":
			return escapeHtml(formatDurationMs(c.ms));
		case "link":
			return renderLink(c.link, opts);
		case "arr":
			return mode === "cell" ? renderCellArray(c.v, opts, depth) : renderInlineArray(c.v, opts, depth);
		case "obj":
			return mode === "cell" ? renderCellObject(c.v, opts, depth) : renderInlineObject(c.v, opts, depth);
		case "html":
			// dv.html 本就是信任输出；Webview CSP 仍兜底。
			return c.v;
		case "md":
			return inlineText(opts, c.v);
	}
}

function noticeRow(colspan: number, message: string): string {
	return `<tr class="dataview-notice-row"><td colspan="${colspan}">${noticeDiv("warn", message)}</td></tr>`;
}

/**
 * v1 table payload（webview 窗口化用）。cells/group 里是完整 <td> 片段，复用 renderCell —
 * 转义与链接行为与主 HTML 完全一致（同一 cell 被渲染两次，只对超阈值结果生效）。
 * payload 渲染不消耗 CellBudget —— 不得影响主 HTML 的截断行为。
 */
function tablePayloadAttr(op: Extract<RenderOp, {kind: "table"}>, opts: RenderOptions): string {
	const rows = op.rows;
	if (!payloadEnabled(opts, rows.length)) return "";
	// 大结果降级：payload 最多带 PAYLOAD_MAX_ROWS 行，超出置 truncated:true。
	const truncated = rows.length > PAYLOAD_MAX_ROWS;
	const slice = truncated ? rows.slice(0, PAYLOAD_MAX_ROWS) : rows;
	const payload: {
		v: number;
		kind: string;
		headers: string[];
		rows: Array<{cells: string[]; group: string | null}>;
		total: number;
		truncated?: boolean;
	} = {
		v: PAYLOAD_VERSION,
		kind: "table",
		headers: op.headers.map((h) => `<th>${escapeHtml(h)}</th>`),
		rows: slice.map((row) => ({
			cells: row.cells.map((c) => `<td>${renderCell(c, opts, "cell")}</td>`),
			group:
				row.group !== undefined
					? `<td colspan="${op.headers.length}">${renderCell(row.group, opts, "cell")}</td>`
					: null,
		})),
		total: rows.length,
	};
	if (truncated) payload.truncated = true;
	return encodePayload(payload, opts);
}

function renderTable(op: Extract<RenderOp, {kind: "table"}>, opts: RenderOptions, budget: CellBudget): string {
	const total = op.rows.length;
	const extra = ` data-dv-total-rows="${total}"`;
	if (total === 0) {
		return wrap("table", extra, `<div class="dataview-empty">No results.</div>`);
	}
	// 大结果降级：超过 maxRows 只渲染前 N 行 + 尾部 notice 行。
	const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
	const capped = total > maxRows ? op.rows.slice(0, maxRows) : op.rows;
	const rowTruncated = capped.length < total;
	const headers = op.headers;
	const body: string[] = [];
	let cellTruncated = false;
	for (const row of capped) {
		const cost = row.cells.length + (row.group !== undefined ? 1 : 0);
		if (!budget.tryConsume(cost)) {
			cellTruncated = true;
			break;
		}
		if (row.group !== undefined) {
			body.push(
				`<tr class="dataview-group-row"><td colspan="${headers.length}">${renderCell(row.group, opts, "cell")}</td></tr>`,
			);
		}
		body.push(
			`<tr class="dataview-row">${row.cells.map((c) => `<td>${renderCell(c, opts, "cell")}</td>`).join("")}</tr>`,
		);
	}
	if (cellTruncated) {
		body.push(noticeRow(headers.length, `Cell limit reached — output truncated at ${budget.max} cells.`));
	} else if (rowTruncated) {
		body.push(noticeRow(headers.length, `Showing first ${maxRows} of ${total} rows.`));
	}
	const head = `<thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>`;
	const payloadAttr = tablePayloadAttr(op, opts);
	return wrap("table", extra + payloadAttr, `<table class="dataview-table">${head}<tbody>${body.join("")}</tbody></table>`);
}

function renderListItem(
	c: CellValue,
	opts: RenderOptions,
	budget: CellBudget,
	ctx: {truncated: boolean},
	depth = 0,
): string {
	if (!budget.tryConsume(1)) {
		ctx.truncated = true;
		return "";
	}
	// 深度超限：沿用嵌套 ul 的形状，只把内层换成占位符。
	if (depth > (opts.maxRenderDepth ?? DEFAULT_MAX_RENDER_DEPTH)) return `<li>${DEPTH_MARKER}</li>`;
	// list op 元素保持既有行为：数组 → 嵌套 ul（内联模式留给标量/对象）。
	if (c.t === "arr") {
		const kids = c.v.map((k) => renderListItem(k, opts, budget, ctx, depth + 1)).join("");
		return `<li><ul class="dataview-list">${kids}</ul></li>`;
	}
	return `<li>${renderCell(c, opts, "inline", depth)}</li>`;
}

function renderList(op: Extract<RenderOp, {kind: "list"}>, opts: RenderOptions, budget: CellBudget): string {
	const ctx = {truncated: false};
	const items = op.items.map((c) => renderListItem(c, opts, budget, ctx)).join("");
	const tag = op.ordered ? "ol" : "ul";
	let inner = `<${tag} class="dataview-list">${items}</${tag}>`;
	if (ctx.truncated) inner += noticeDiv("warn", `Cell limit reached — output truncated at ${budget.max} cells.`);
	return wrap("list", "", inner);
}

function renderTask(t: TaskNode, opts: RenderOptions, budget: CellBudget, ctx: {truncated: boolean}): string {
	if (!budget.tryConsume(1)) {
		ctx.truncated = true;
		return "";
	}
	const status = typeof t.status === "string" ? t.status : "";
	const text = typeof t.text === "string" ? t.text : "";
	// types.ts: "x"/"X" = done → checkbox 以 status 小写判定。
	const checked = status.toLowerCase() === "x" ? " checked" : "";
	let html =
		`<li class="dataview-task" data-dv-status="${escapeHtml(status)}">` +
		`<input type="checkbox" class="dataview-task-checkbox" disabled${checked}>` +
		`<span class="dataview-task-text">${inlineText(opts, text)}</span>`;
	const kids = Array.isArray(t.children) ? t.children : [];
	if (kids.length > 0) {
		html += `<ul class="dataview-task-list">${kids.map((k) => renderTask(k, opts, budget, ctx)).join("")}</ul>`;
	}
	return html + `</li>`;
}

/** 含嵌套子任务的任务总数（taskList payload 阈值/total 用）。 */
function countTasks(tasks: TaskNode[]): number {
	let n = 0;
	for (const t of tasks) {
		n++;
		const kids = Array.isArray(t.children) ? t.children : [];
		if (kids.length > 0) n += countTasks(kids);
	}
	return n;
}

/**
 * v1 taskList payload：items 是顶层任务渲染出的完整 <li> 片段（复用 renderTask），
 * total 为含嵌套子任务的任务总数。用独立 CellBudget，不影响主 HTML 的截断。
 */
function taskListPayloadAttr(op: Extract<RenderOp, {kind: "taskList"}>, opts: RenderOptions): string {
	const tasks = Array.isArray(op.tasks) ? op.tasks : [];
	const total = countTasks(tasks);
	if (!payloadEnabled(opts, total)) return "";
	const ctx = {truncated: false};
	const budget = new CellBudget(opts.maxCells ?? DEFAULT_MAX_CELLS);
	const items = tasks.map((t) => renderTask(t, opts, budget, ctx)).filter((s) => s !== "");
	const payload: {v: number; kind: string; items: string[]; total: number} = {
		v: PAYLOAD_VERSION,
		kind: "taskList",
		items,
		total,
	};
	return encodePayload(payload, opts);
}

function renderTaskList(op: Extract<RenderOp, {kind: "taskList"}>, opts: RenderOptions, budget: CellBudget): string {
	const ctx = {truncated: false};
	const tasks = Array.isArray(op.tasks) ? op.tasks : [];
	const items = tasks.map((t) => renderTask(t, opts, budget, ctx)).join("");
	let inner = `<ul class="dataview-task-list">${items}</ul>`;
	if (ctx.truncated) inner += noticeDiv("warn", `Cell limit reached — output truncated at ${budget.max} cells.`);
	return wrap("taskList", taskListPayloadAttr(op, opts), inner);
}

function renderAttrs(attrs: Record<string, string> | undefined): string {
	if (attrs === undefined) return "";
	let out = "";
	for (const [name, value] of Object.entries(attrs)) {
		// 防注入：非法属性名与 on* 内联事件处理器丢弃（Webview CSP 兜底）。
		if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) continue;
		if (/^on/i.test(name)) continue;
		out += ` ${name}="${escapeHtml(value)}"`;
	}
	return out;
}

/** `cls` (dv.el's DomElementInfo.class) → a class attribute; names are whitelisted. */
function renderCls(cls: string[] | undefined): string {
	if (!cls || cls.length === 0) return "";
	const safe = cls.filter((c) => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(c));
	return safe.length === 0 ? "" : ` class="${escapeHtml(safe.join(" "))}"`;
}

function renderEl(op: Extract<RenderOp, {kind: "el"}>, opts: RenderOptions): string {
	const attrs = renderAttrs(op.attrs);
	// `class` from attrs is merged with `cls` so both upstream spellings work.
	const cls = renderCls(op.cls);
	const classAttr = cls !== "" && /\bclass=/.test(attrs) ? "" : cls;
	const open = `<${op.tag}${attrs}${classAttr}>`;
	if (VOID_TAGS.has(op.tag)) {
		return wrap("el", "", open); // br/hr are void — text ignored
	}
	const textHtml = op.text !== undefined ? elText(opts, op.tag, op.text) : "";
	const kids = (op.children ?? [])
		.map((ch) => renderOp(ch, opts, new CellBudget(DEFAULT_MAX_CELLS)))
		.join("");
	return wrap("el", "", `${open}${textHtml}${kids}</${op.tag}>`);
}

/**
 * CALENDAR op：**非交互式** 渲染 —— 按 `date.slice(0,7)`（YYYY-MM）分组，每组
 * `<h4>YYYY-MM</h4>` + `<ul>`，条目 `<li>` = 链接 + 两位“日” +（可选）`: value`。
 * 上游是可点击的月份网格（calendar-view.ts，按天定位 + 弹层）；此处为静态替代，
 * 差异已文档化（同 types.ts `calendar` op 注释：rendered as a month-grouped list）。
 */
function renderCalendar(op: Extract<RenderOp, {kind: "calendar"}>, opts: RenderOptions, budget: CellBudget): string {
	const groups = new Map<string, string[]>();
	let truncated = false;
	for (const entry of op.entries) {
		if (!budget.tryConsume(1)) {
			truncated = true;
			break;
		}
		const month = typeof entry.date === "string" ? entry.date.slice(0, 7) : "";
		const day = typeof entry.date === "string" ? entry.date.slice(8, 10) : "";
		const valueHtml = entry.value !== undefined ? `: ${renderCell(entry.value, opts, "inline")}` : "";
		const li = `<li>${renderLink(entry.link, opts)}${escapeHtml(day)}${valueHtml}</li>`;
		const bucket = groups.get(month);
		if (bucket === undefined) groups.set(month, [li]);
		else bucket.push(li);
	}
	let inner = "";
	for (const [month, items] of groups) {
		inner += `<h4>${escapeHtml(month)}</h4><ul class="dataview-list dataview-calendar-list">${items.join("")}</ul>`;
	}
	if (truncated) inner += noticeDiv("warn", `Cell limit reached — output truncated at ${budget.max} cells.`);
	return wrap("calendar", "", inner);
}

/** Column header of the heatmap grid — upstream hardcodes the same 12 labels. */
const HEATMAP_MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * `renderHeatmapCalendar` output. Markup + class names mirror the Obsidian
 * Heatmap Calendar plugin (`.heatmap-calendar-graph|-year|-months|-days|-boxes|
 * -content`) so the layout CSS and user snippets behave the same; the only
 * addition is the `dataview-container` wrapper every op gets. Size is bounded by
 * construction (≤ 6 leading blanks + 366 days), so no cell budget is consumed.
 */
function renderHeatmap(op: Extract<RenderOp, {kind: "heatmap"}>): string {
	const months = HEATMAP_MONTH_LABELS.map((m) => `<li>${m}</li>`).join("");
	const weekdays = op.weekdays.map((d) => `<li>${escapeHtml(d)}</li>`).join("");
	const boxes = op.boxes
		.map((box) => {
			const cls = box.classes.length > 0 ? ` class="${escapeAttr(box.classes.join(" "))}"` : "";
			const date = box.date === undefined ? "" : ` data-date="${escapeAttr(box.date)}"`;
			const color = box.color === undefined ? "" : ` style="background-color: ${escapeAttr(box.color)}"`;
			const content = box.content === undefined ? "" : escapeHtml(box.content);
			return `<li${cls}${date}${color}><span class="heatmap-calendar-content">${content}</span></li>`;
		})
		.join("");
	const inner =
		`<div class="heatmap-calendar-graph">` +
		`<div class="heatmap-calendar-year">${escapeHtml(String(op.year).slice(2))}</div>` +
		`<ul class="heatmap-calendar-months">${months}</ul>` +
		`<ul class="heatmap-calendar-days">${weekdays}</ul>` +
		`<ul class="heatmap-calendar-boxes">${boxes}</ul>` +
		`</div>`;
	return wrap("heatmap", "", inner);
}

function renderOp(op: RenderOp, opts: RenderOptions, budget: CellBudget): string {
	switch (op.kind) {
		case "table":
			return renderTable(op, opts, budget);
		case "list":
			return renderList(op, opts, budget);
		case "taskList":
			return renderTaskList(op, opts, budget);
		case "paragraph":
			return wrap("paragraph", "", `<p>${inlineText(opts, op.text)}</p>`);
		case "header": {
			const lv = Number.isFinite(op.level) ? Math.min(6, Math.max(1, Math.floor(op.level))) : 1;
			return wrap("header", "", `<h${lv}>${inlineText(opts, op.text)}</h${lv}>`);
		}
		case "span":
			return wrap("span", "", `<span>${inlineText(opts, op.text)}</span>`);
		case "el":
			return renderEl(op, opts);
		case "html":
			// dv.html 本就是信任输出；Webview CSP 仍兜底。
			return wrap("html", "", op.html);
		case "markdown":
			// `dv.markdown(text)`: block-level by contract (upstream renders it as a
			// markdown document, not a single inline line).
			return wrap("markdown", "", blockText(opts, op.text));
		case "error":
			return wrap("error", "", errorInner(op.message, op.detail));
		case "notice":
			return wrap("notice", "", noticeDiv(op.level, op.message));
		case "empty":
			return wrap("empty", "", `<div class="dataview-empty">${escapeHtml(op.message)}</div>`);
		case "calendar":
			return renderCalendar(op, opts, budget);
		case "heatmap":
			return renderHeatmap(op);
		case "badge":
			return wrap("badge", "", `<div class="dataview-badge">${escapeHtml(op.text)}</div>`);
	}
}

export function renderOpsToHtml(ops: RenderOp[], opts: RenderOptions): string {
	const budget = new CellBudget(opts.maxCells ?? DEFAULT_MAX_CELLS);
	const out: string[] = [];
	for (const op of ops) out.push(renderOp(op, opts, budget));
	return out.join("");
}

/** Async-block placeholder (BlockState pending) — service embeds this immediately. */
export function renderPlaceholderHtml(kind: string, hash: string): string {
	return (
		`<div class="dataview-container dataview-pending" data-dv-kind="${escapeHtml(kind)}` +
		`" data-dv-hash="${escapeHtml(hash)}"></div>`
	);
}

/** Standalone error block for BlockState {status:"error"}. */
export function renderErrorHtml(message: string, detail?: string): string {
	return wrap("error", "", errorInner(message, detail));
}
