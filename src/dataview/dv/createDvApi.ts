/**
 * dv API — port of Obsidian Dataview's `DataviewInlineApi`
 * (upstream `src/api/inline-api.ts` + `plugin-api.ts`, plus the Codeblock
 * Reference docs). Rendering methods record `RenderOp`s into the `OpSink`;
 * no HTML is produced here (that is render/html.ts).
 *
 * Source of every semantic below (no invented behaviour):
 *   - `fileLink(path, embed = false, display?)` / `sectionLink` / `blockLink`
 *     — upstream `inline-api.ts` `fileLink`/`sectionLink`/`blockLink`.
 *   - `el(tag, text, options)` with `DomElementInfo {cls, attr}` and the
 *     chainable `HTMLElement` surface Obsidian returns (`createEl`/`appendText`)
 *     — upstream `inline-api.ts` `el`, Obsidian `DomElementInfo`.
 *   - `header(level, text, options)` throws outside [1, 6] — upstream
 *     `inline-api.ts` `header` ("Header level must be in the range [1, 6].").
 *   - `taskList(tasks, groupByFile = true)` — upstream defaults to grouping by
 *     `task.path` and emits an `h4` file header before each group.
 *   - `io.load` returns `undefined` for a missing file (upstream
 *     `inline-api.ts` `io.load`), `io.normalize`/`io.csv` — upstream `io`.
 *   - `query`/`tryQuery`/`evaluate`/`execute`/`view` — upstream `inline-api.ts`
 *     (`Result<T, string>` never throws; `try*` throw the error string).
 *
 * Deliberate project extensions / documented gaps are called out inline.
 */
import type {
	AppShim,
	CellValue,
	DataArray,
	DqlQuery,
	Duration,
	DvApi,
	DvDate,
	DvElement,
	DvElOptions,
	DvHostConfig,
	DvQueryResult,
	DvResult,
	DvValue,
	DvValueUtils,
	Link,
	OpSink,
	PageMeta,
	PageObject,
	RenderOp,
	TableRow,
	TaskNode,
} from "../types";
import {createAppShim} from "../adapter/shim";
import {createLink} from "../link";
import {buildPageObject, buildPageScope} from "../page";
import {
	compareValues,
	createDataArray,
	evaluateExpression,
	executeDql,
	looseEquals,
	matchSource,
	parseDate,
	parseDql,
	parseDuration,
} from "../query";
import {createDuration, createDvDate} from "../query/datetime";
import {markdownList, markdownTable, markdownTaskList} from "../render/markdown";
import {cellToText, coerceStringField, fromJsonValue, isDataArray, isDvDate, isDuration, isLink, toCell} from "../values";

// ---------------------------------------------------------------------------
// Host capability extras (reported to the integrator as a types.ts patch)
// ---------------------------------------------------------------------------

/**
 * `DvHostConfig` fields this module consumes that are NOT (yet) in the frozen
 * contract in types.ts. Read through an `unknown` cast so this file compiles
 * both before and after the patch lands:
 *
 *   settings?: {renderNullAs?: string; dateFormat?: string;
 *               maxRenderDepth?: number; displayResultCount?: boolean};
 *   runNested?: (code: string, input: DvValue, depth: number) => Promise<DvValue | undefined>;
 *   execQuery?: (query: DqlQuery) => RenderOp[];
 */
interface DvHostConfigExt {
	settings?: {
		renderNullAs?: string;
		dateFormat?: string;
		maxRenderDepth?: number;
		displayResultCount?: boolean;
	};
	runNested?: (code: string, input: DvValue, depth: number) => Promise<DvValue | undefined>;
	execQuery?: (query: DqlQuery) => RenderOp[];
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** dv.io / lookup normalization: posix slashes, leading "./" stripped. */
function normalizeRel(p: string): string {
	return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Page lookup key: normalized path with case-insensitive ".md" suffix removed. */
function pathKey(p: string): string {
	const s = normalizeRel(p);
	return /\.md$/i.test(s) ? s.slice(0, -3) : s;
}

/** Folder of a posix path ("notes/a.md" → "notes"); "" at the root. */
function dirOf(p: string): string {
	const i = p.lastIndexOf("/");
	return i < 0 ? "" : p.slice(0, i);
}

/** Collapse "." / ".." segments (posix); a leading "/" is dropped (workspace-relative). */
function collapsePosix(p: string): string {
	const out: string[] = [];
	for (const seg of p.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") {
			if (out.length > 0) out.pop();
			continue;
		}
		out.push(seg);
	}
	return out.join("/");
}

// ---------------------------------------------------------------------------
// Value formatting / coercion
// ---------------------------------------------------------------------------

/** Dataview renderValue approximation: Link → display/path, array → "[a, b]", … */
function prettify(v: DvValue): string {
	return cellToText(toCell(v));
}

function toArray(v: DvValue): DvValue[] {
	if (Array.isArray(v)) return v;
	if (isDataArray(v)) return v.array();
	return [v];
}

/** Mixed task input: flatten arrays/DataArrays, drop null/undefined, keep nodes. */
function collectTasks(input: DvValue): TaskNode[] {
	const out: TaskNode[] = [];
	const walk = (v: DvValue): void => {
		if (v === null || v === undefined) return;
		if (Array.isArray(v)) {
			for (const x of v) walk(x);
			return;
		}
		if (isDataArray(v)) {
			for (const x of v.array()) walk(x);
			return;
		}
		out.push(v as unknown as TaskNode);
	};
	walk(input);
	return out;
}

/** Guard for pathological recursion in `literal`/`clone`/`value.deepCopy`. */
const MAX_DEPTH = 16;

/** `dv.value.typeOf` — upstream `Values.typeOf`. */
function dvTypeOf(v: unknown): string {
	if (v === null || v === undefined) return "null";
	if (isLink(v)) return "link";
	if (isDuration(v)) return "duration";
	if (v instanceof Date || isDvDate(v)) return "date";
	if (Array.isArray(v)) return "array";
	const t = typeof v;
	if (t === "number" || t === "string" || t === "boolean" || t === "function") return t;
	return "object";
}

/** JS value → Dataview value (upstream `dv.literal`). */
function literalValue(value: unknown, depth: number): DvValue {
	if (value === null || value === undefined) return null;
	const t = typeof value;
	if (t === "number") return value as number;
	if (t === "boolean") return value as boolean;
	// Dataview literal strings are parsed so "[[x]]"/"2024-01-15"/"2h" become
	// real link/date/duration values — same path as dv.parse.
	if (t === "string") return fromJsonValue(coerceStringField(value as string));
	if (t === "function") return value as DvValue;
	if (t === "bigint") return Number(value);
	if (value instanceof Date) return parseDate(value) ?? null;
	if (isDvDate(value) || isDuration(value) || isLink(value)) return value as DvValue;
	if (depth >= MAX_DEPTH) return null;
	if (Array.isArray(value)) return value.map((x) => literalValue(x, depth + 1));
	if (isDataArray(value)) return createDataArray(value.array().map((x) => literalValue(x, depth + 1)));
	const out: Record<string, DvValue> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = literalValue(v, depth + 1);
	return out;
}

/**
 * Deep copy (upstream `dv.clone`). Arrays/objects/DataArrays rebuild
 * structurally; Link/Duration/DvDate go through their factories so the
 * non-enumerable method surface survives (a structured clone would drop it).
 */
function cloneValue(value: unknown, seen: WeakMap<object, unknown>, depth: number): unknown {
	if (value === null || typeof value !== "object") return value;
	if (depth >= MAX_DEPTH) return value;
	const obj = value as object;
	const cached = seen.get(obj);
	if (cached !== undefined) return cached;
	if (value instanceof Date) return new Date(value.getTime());
	if (isLink(value)) {
		return createLink({
			path: value.path,
			display: value.display,
			subpath: value.subpath,
			embed: value.embed,
			external: value.external,
		});
	}
	if (isDuration(value)) return createDuration(value.ms);
	if (isDvDate(value)) return createDvDate(value.toMillis());
	if (Array.isArray(value)) {
		const out: unknown[] = [];
		seen.set(obj, out);
		for (const item of value) out.push(cloneValue(item, seen, depth + 1));
		return out;
	}
	if (isDataArray(value)) {
		const items = value.array().map((x) => cloneValue(x, seen, depth + 1));
		const out = createDataArray(items);
		seen.set(obj, out);
		return out;
	}
	const out: Record<string, unknown> = {};
	seen.set(obj, out);
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = cloneValue(v, seen, depth + 1);
	return out;
}

/** CellValue (render protocol) → DvValue. Only used by `dv.query`. */
function cellToValue(c: CellValue): DvValue {
	switch (c.t) {
		case "null":
			return null;
		case "bool":
			return c.v;
		case "num":
			return c.v;
		case "str":
			return c.v;
		case "html":
			return c.v;
		case "md":
			return c.v;
		case "date":
			return parseDate(c.iso) ?? null;
		case "dur":
			return createDuration(c.ms);
		case "link":
			return createLink({
				path: c.link.path,
				display: c.link.display,
				subpath: c.link.subpath,
				embed: c.link.embed,
				external: c.link.external,
			});
		case "arr":
			return c.v.map(cellToValue);
		case "obj": {
			const out: Record<string, DvValue> = {};
			for (const [k, v] of Object.entries(c.v)) out[k] = cellToValue(v);
			return out;
		}
	}
}

/** Error text across the vm realm boundary (`instanceof Error` does not hold there). */
function errorMessage(e: unknown): string {
	const m = (e as {message?: unknown} | null)?.message;
	return typeof m === "string" ? m : String(e);
}

// ---------------------------------------------------------------------------
// el / header / span / paragraph → chainable DvElement
// ---------------------------------------------------------------------------

const ALLOWED_EL_TAGS = new Set([
	"div", "span", "p", "a", "strong", "em", "code", "b", "i", "u", "s", "small", "sub", "sup",
	"br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
	// Native disclosure: the one interaction that needs no JS, so it is what the
	// addEventListener warning points users at (see reportUnsupportedEvent).
	"details", "summary",
]);

type ElOp = Extract<RenderOp, {kind: "el"}>;
type TextualOp = Extract<RenderOp, {kind: "el" | "span" | "paragraph" | "header"}>;

/** Obsidian `DomElementInfo` is an object; anything else (legacy string form) is ignored. */
function asOptions(options: unknown): DvElOptions | undefined {
	return typeof options === "object" && options !== null ? (options as DvElOptions) : undefined;
}

/** `cls` (string | string[]) → the op's own `cls` array. */
function normalizeCls(cls: string | string[] | undefined): string[] | undefined {
	if (cls === undefined) return undefined;
	// Obsidian's DomElementInfo.class accepts both forms and treats a string as a
	// SPACE-SEPARATED list ("dataview dataview-class" ⇒ two classes, per the docs).
	const arr = (Array.isArray(cls) ? cls.map(String) : [String(cls)])
		.flatMap((entry) => entry.split(/\s+/))
		.filter((entry) => entry !== "");
	return arr.length > 0 ? arr : undefined;
}

/**
 * `attr` (+ the `href`/`title` shorthands of Obsidian's DomElementInfo) →
 * op attrs. `on*` inline handlers are dropped here; render/html.ts re-checks
 * attribute-name validity as the final gate.
 */
function elAttrs(options: DvElOptions | undefined): Record<string, string> | undefined {
	if (options === undefined) return undefined;
	const raw: Record<string, string> = {};
	if (options.attr !== undefined && typeof options.attr === "object" && options.attr !== null) {
		for (const [k, v] of Object.entries(options.attr)) raw[k] = String(v);
	}
	if (options.href !== undefined) raw["href"] = String(options.href);
	if (options.title !== undefined) raw["title"] = String(options.title);
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(raw)) {
		if (/^on/i.test(k)) continue;
		out[k] = v;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/** Second positional text wins; `options.text` is the fallback (upstream `el`). */
function optionText(text: DvValue | undefined, options: DvElOptions | undefined): string {
	if (text !== undefined && text !== null) return prettify(text);
	const t = asOptions(options)?.text;
	return typeof t === "string" ? t : "";
}

function makeElOp(tag: string, text: string, options: DvElOptions | undefined): ElOp {
	const op: ElOp = {kind: "el", tag, text};
	const cls = normalizeCls(options?.cls);
	if (cls !== undefined) op.cls = cls;
	const attrs = elAttrs(options);
	if (attrs !== undefined) op.attrs = attrs;
	return op;
}

interface ElContext {
	sink: OpSink;
	/** When set, new elements become children of this el op instead of new ops. */
	parent?: ElOp;
}

function pushChildOp(ctx: ElContext, op: RenderOp): void {
	const parent = ctx.parent;
	if (parent === undefined) {
		ctx.sink.push(op);
		return;
	}
	if (parent.children === undefined) parent.children = [];
	parent.children.push(op);
}

/**
 * `el.addEventListener(...)` — the sandbox has no DOM and the built-in preview
 * is static HTML: the only channel to the host is a whole-document
 * `markdown.preview.refresh`, so no event can reach a block handler (upstream
 * runs inside the Obsidian app, where a handler can re-render on the spot).
 * The call is accepted, reported once per listener type *per block* (a silent
 * no-op would hide the limitation), and never dispatched.
 */
const reportedEvents = new WeakMap<OpSink, Set<string>>();

function reportUnsupportedEvent(sink: OpSink, type: string): void {
	let seen = reportedEvents.get(sink);
	if (seen === undefined) {
		seen = new Set();
		reportedEvents.set(sink, seen);
	}
	if (seen.has(type)) return;
	seen.add(type);
	sink.push({
		kind: "notice",
		level: "warn",
		message:
			`dv.el: addEventListener("${type}") cannot run — the dataview sandbox has no DOM and the VSCode ` +
			`preview is static HTML. Use a link/anchor, <details>+<summary> for disclosure, or let the block ` +
			`re-render when the index changes.`,
	});
}

/**
 * Obsidian elements are chainable: `dv.el("div", "").createEl("b", "hi")`.
 * `appendText` appends to the element's own text (RenderOp.el has one `text`
 * plus `children`, so interleaved text/child order is not representable —
 * text renders first, documented approximation).
 */
function elementHandle(tag: string, op: TextualOp, ctx: ElContext): DvElement {
	const handle: DvElement = {
		tag,
		appendText(text: string): DvElement {
			op.text = (op.text ?? "") + text;
			return handle;
		},
		createEl(childTag: string, text?: string, options?: DvElOptions): DvElement {
			return createElInto(ctx, childTag, text, asOptions(options));
		},
		addEventListener(type: string): void {
			reportUnsupportedEvent(ctx.sink, String(type));
		},
		removeEventListener(): void {
			// Nothing was ever registered (see addEventListener) — nothing to undo.
		},
	};
	return handle;
}

/** Inert handle returned for non-whitelisted tags (their children are dropped). */
function noopHandle(tag: string): DvElement {
	const handle: DvElement = {
		tag,
		appendText(): DvElement {
			return handle;
		},
		createEl(): DvElement {
			return noopHandle(tag);
		},
		addEventListener(): void {
			// The tag itself already produced an "not allowed" warning: one notice is enough.
		},
		removeEventListener(): void {},
	};
	return handle;
}

function createElInto(ctx: ElContext, rawTag: string, text: string | undefined, options: DvElOptions | undefined): DvElement {
	const tag = String(rawTag).toLowerCase();
	if (!ALLOWED_EL_TAGS.has(tag)) {
		// 防注入：白名单外标签不得进入 HTML 流，降级为 warn notice + span。
		ctx.sink.push({kind: "notice", level: "warn", message: `dv.el: tag "${rawTag}" is not allowed; rendered as span.`});
		ctx.sink.push({kind: "span", text: text ?? ""});
		return noopHandle(tag);
	}
	const op = makeElOp(tag, text ?? "", options);
	pushChildOp(ctx, op);
	return elementHandle(tag, op, {sink: ctx.sink, parent: op});
}

/** Upstream `header` rejects levels outside [1, 6]; fractional levels are floored. */
function headerLevel(level: number): number {
	if (!Number.isFinite(level) || level < 1 || level > 6) {
		throw new Error("Header level must be in the range [1, 6].");
	}
	return Math.floor(level);
}

/** Group header text for `taskList(..., groupByFile = true)` — a file link. */
function taskGroupHeader(path: string): string {
	return path === "" ? "" : `[[${path}]]`;
}

// ---------------------------------------------------------------------------
// dv.table row normalization (project extension, kept from the previous build)
// ---------------------------------------------------------------------------

interface NormRow {
	values: DvValue[];
	filePath?: string;
}

/** Plain object row (page-like) vs scalar/special values (Date/Link/Duration/…). */
function isPlainRowObject(v: DvValue): v is Record<string, DvValue> {
	return (
		typeof v === "object" &&
		v !== null &&
		!Array.isArray(v) &&
		!(v instanceof Date) &&
		!isDvDate(v) &&
		!isDuration(v) &&
		!isLink(v) &&
		!isDataArray(v)
	);
}

function filePathOf(o: Record<string, DvValue>): string | undefined {
	const f = o["file"];
	if (typeof f === "object" && f !== null && "path" in f && typeof (f as {path: unknown}).path === "string") {
		return (f as {path: string}).path;
	}
	return undefined;
}

/** rows → normalized: DvValue[][] / DataArray (array or object rows) / single object / scalar. */
function normalizeTableRows(rows: DvValue, headers: string[]): NormRow[] {
	const out: NormRow[] = [];
	for (const row of toArray(rows)) {
		if (Array.isArray(row)) {
			out.push({values: row});
		} else if (isDataArray(row)) {
			out.push({values: row.array()});
		} else if (isPlainRowObject(row)) {
			out.push({values: headers.map((h) => row[h] ?? null), filePath: filePathOf(row)});
		} else {
			out.push({values: [row]});
		}
	}
	return out;
}

/** groupByFile: first row per file path carries a spanning group placeholder. */
function buildTableRows(norm: NormRow[], groupByFile: boolean): TableRow[] {
	const toRow = (r: NormRow): TableRow => ({cells: r.values.map((v) => toCell(v))});
	if (!groupByFile || !norm.every((r) => r.filePath !== undefined)) {
		// 无分组请求，或行缺 file 元数据（纯数组行）→ 原样输出。
		return norm.map(toRow);
	}
	const seen = new Set<string>();
	return norm.map((r): TableRow => {
		const row = toRow(r);
		const filePath = r.filePath!;
		if (seen.has(filePath)) return row;
		seen.add(filePath);
		return {cells: row.cells, group: {t: "str", v: filePath}};
	});
}

// ---------------------------------------------------------------------------
// RFC 4180 subset CSV
// ---------------------------------------------------------------------------

/**
 * Dataview `io.csv` parser subset: comma-separated, double-quote quoting with
 * `""` escaping, `\r\n`/`\n` records, blank lines skipped. Quoted fields may
 * contain newlines. Every value stays a string ("" stays "").
 */
function parseCsvRows(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let inQuotes = false;
	let i = 0;
	while (i < text.length) {
		const c = text[i]!;
		if (inQuotes) {
			if (c === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				inQuotes = false;
				i++;
				continue;
			}
			field += c;
			i++;
			continue;
		}
		if (c === '"') {
			inQuotes = true;
			i++;
			continue;
		}
		if (c === ",") {
			row.push(field);
			field = "";
			i++;
			continue;
		}
		if (c === "\r") {
			i++;
			continue;
		}
		if (c === "\n") {
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
			i++;
			continue;
		}
		field += c;
		i++;
	}
	if (field !== "" || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows;
}

function csvToRecords(text: string): Record<string, DvValue>[] {
	// Blank records ("", from empty lines) are skipped; the first kept row is the header.
	const rows = parseCsvRows(text).filter((r) => !(r.length === 1 && r[0] === ""));
	if (rows.length === 0) return [];
	const headers = rows[0]!;
	const out: Record<string, DvValue>[] = [];
	for (let i = 1; i < rows.length; i++) {
		const row = rows[i]!;
		const rec: Record<string, DvValue> = {};
		for (let c = 0; c < headers.length; c++) rec[headers[c]!] = row[c] ?? "";
		out.push(rec);
	}
	return out;
}

// ---------------------------------------------------------------------------
// dv.query result mapping
// ---------------------------------------------------------------------------

/** RenderOps emitted by executeDql → the structured `DvQueryResult` shape. */
function opsToQueryResult(type: DqlQuery["type"], ops: RenderOp[]): DvQueryResult {
	if (type === "table") {
		const op = ops.find((o) => o.kind === "table");
		if (op === undefined || op.kind !== "table") return {type: "table", headers: [], values: []};
		return {type: "table", headers: op.headers.slice(), values: op.rows.map((r) => r.cells.map(cellToValue))};
	}
	if (type === "list") {
		const op = ops.find((o) => o.kind === "list");
		if (op === undefined || op.kind !== "list") return {type: "list", values: []};
		return {type: "list", values: op.items.map(cellToValue)};
	}
	if (type === "tasks") {
		const op = ops.find((o) => o.kind === "taskList");
		if (op === undefined || op.kind !== "taskList") return {type: "task", values: []};
		return {type: "task", values: op.tasks};
	}
	const op = ops.find((o) => o.kind === "calendar");
	if (op === undefined || op.kind !== "calendar") return {type: "calendar", values: []};
	return {
		type: "calendar",
		values: op.entries.map((e) => {
			const date = parseDate(e.date) ?? createDvDate(0);
			return e.value !== undefined
				? {date, link: e.link, value: [cellToValue(e.value)]}
				: {date, link: e.link};
		}),
	};
}

/**
 * `dv.markdownTable` values accept a plain matrix, a DataArray of rows, or a
 * DataArray of row-DataArrays (all three appear in dataviewjs snippets).
 */
function asRowMatrix(values: DvValue[][] | DataArray<DvValue>): DvValue[][] {
	const raw: unknown = values;
	if (!isDataArray(raw)) return raw as DvValue[][];
	return (raw as DataArray<unknown>).array().map((row): DvValue[] => {
		if (isDataArray(row)) return (row as DataArray<DvValue>).array();
		return Array.isArray(row) ? (row as DvValue[]) : [row as DvValue];
	});
}

function queryResultToMarkdown(v: DvQueryResult): string {
	if (v.type === "table") return markdownTable(v.headers, v.values);
	if (v.type === "list") return markdownList(v.values);
	if (v.type === "task") return markdownTaskList(v.values);
	// CALENDAR has no upstream markdown exporter; entries degrade to a bullet list.
	return markdownList(v.values.map((e) => (e.link ?? e.date) as DvValue));
}

// ---------------------------------------------------------------------------
// dv API
// ---------------------------------------------------------------------------

/** Recursion guard for `dv.view` (upstream nests through the same context). */
const MAX_VIEW_DEPTH = 8;

/** `dv.fileLink(path, display, embed)` deprecation notice fires once per module. */
let legacyFileLinkWarned = false;

export function createDvApi(config: DvHostConfig, sink: OpSink): DvApi {
	const host = config as unknown as DvHostConfigExt;

	// 性能点：path → PageMeta 的 O(1) 查找表，createDvApi 时构建一次（每 job 一个 dv 实例）。
	const byPath = new Map<string, PageMeta>();
	for (const meta of config.index.pages) byPath.set(pathKey(meta.path), meta);

	/** Link-aware source context: required for `FROM outgoing(...)`/`incoming(...)`. */
	const sourceCtx = {allPages: config.index.pages, currentPath: config.filePath};

	const pageAtPath = (path: string | Link): PageObject | undefined => {
		const meta = byPath.get(pathKey(typeof path === "string" ? path : path.path));
		return meta ? buildPageObject(meta) : undefined;
	};

	const settingsSnapshot: Readonly<Record<string, DvValue>> = {
		renderNullAs: host.settings?.renderNullAs ?? "-",
		dateFormat: host.settings?.dateFormat ?? "yyyy-MM-dd",
		maxRenderDepth: host.settings?.maxRenderDepth ?? 3,
		displayResultCount: host.settings?.displayResultCount ?? false,
	};

	let appShim: AppShim | undefined;
	/** Nesting depth of `dv.view` calls in flight (per dv instance = per job). */
	let nestDepth = 0;

	/**
	 * Relative path → workspace-relative path. Resolution rules:
	 *   - "…/…" is always collapsed against the origin folder;
	 *   - otherwise the origin-relative candidate wins only when it resolves to
	 *     an indexed page ("same-dir priority"), else the path as written wins;
	 *   - unresolvable paths are returned as written.
	 */
	const normalizePath = (path: string | Link, originFile?: string): string => {
		const raw = normalizeRel(typeof path === "string" ? path : path.path);
		if (raw.startsWith("/")) return collapsePosix(raw);
		const origin = normalizeRel(originFile !== undefined ? originFile : config.filePath);
		const dir = origin === "" ? "" : dirOf(origin) + "/";
		if (raw.startsWith("../")) return collapsePosix(dir + raw);
		const candidate = collapsePosix(dir + raw);
		if (candidate !== raw && byPath.has(pathKey(candidate))) return candidate;
		return raw;
	};

	const runQuery = async (source: string): Promise<DvResult<DvQueryResult>> => {
		try {
			const parsed = parseDql(source);
			const ops = host.execQuery ? host.execQuery(parsed) : executeDql(parsed, config.index);
			return {successful: true, value: opsToQueryResult(parsed.type, ops)};
		} catch (e) {
			return {successful: false, error: errorMessage(e)};
		}
	};

	const runQueryMarkdown = async (source: string): Promise<DvResult<string>> => {
		const result = await runQuery(source);
		if (!result.successful) return result;
		try {
			return {successful: true, value: queryResultToMarkdown(result.value)};
		} catch (e) {
			return {successful: false, error: errorMessage(e)};
		}
	};

	const runEvaluate = (expression: string, context?: Record<string, DvValue>): DvResult<DvValue> => {
		try {
			// Scope = current page fields + `this` (buildPageScope adds both),
			// then the caller's context overrides.
			const scope: Record<string, unknown> = config.current ? buildPageScope(config.current) : {};
			if (context !== undefined) for (const [k, v] of Object.entries(context)) scope[k] = v;
			return {successful: true, value: evaluateExpression(expression, scope)};
		} catch (e) {
			return {successful: false, error: errorMessage(e)};
		}
	};

	const pushQuery = async (source: string): Promise<void> => {
		const parsed = parseDql(source);
		const ops = host.execQuery ? host.execQuery(parsed) : executeDql(parsed, config.index);
		for (const op of ops) sink.push(op);
	};

	const executeJs = async (code: string): Promise<void> => {
		if (host.runNested === undefined) throw new Error("dv.executeJs is not available in this runtime.");
		await host.runNested(code, undefined, nestDepth);
	};

	const runView = async (path: string, input?: DvValue): Promise<void> => {
		const base = normalizeRel(path);
		const depth = nestDepth + 1;
		if (depth > MAX_VIEW_DEPTH) {
			sink.push({kind: "error", message: `Dataview: view recursion depth exceeded (${MAX_VIEW_DEPTH}).`});
			return;
		}
		const jsPath = base + ".js";
		const viewDir = base.endsWith("/") ? base : base + "/";
		const nestedJs = viewDir + "view.js";
		let scriptPath: string | undefined;
		if (await config.io.exists(jsPath)) scriptPath = jsPath;
		else if (await config.io.exists(nestedJs)) scriptPath = nestedJs;
		if (scriptPath === undefined) {
			sink.push({kind: "error", message: `Dataview: custom view not found for '${base}.js' or '${base}/view.js'.`});
			return;
		}
		// CSS injection is unsupported: skip a same-named stylesheet instead of failing.
		const cssCandidates = [base + ".css", viewDir + "view.css"];
		for (const css of cssCandidates) {
			if (await config.io.exists(css)) {
				sink.push({
					kind: "notice",
					level: "info",
					message: `Dataview: view stylesheet '${css}' ignored (CSS injection is not supported).`,
				});
				break;
			}
		}
		if (host.runNested === undefined) {
			sink.push({kind: "error", message: "Dataview: nested view execution is not available in this runtime."});
			return;
		}
		const code = await config.io.read(scriptPath);
		nestDepth = depth;
		try {
			await host.runNested(code, input === undefined ? null : input, depth);
		} finally {
			nestDepth = depth - 1;
		}
	};

	const valueUtils: DvValueUtils = {
		isLink: (v: unknown): boolean => isLink(v),
		isDate: (v: unknown): boolean => v instanceof Date || isDvDate(v),
		isDuration: (v: unknown): boolean => isDuration(v),
		isNumber: (v: unknown): boolean => typeof v === "number",
		isString: (v: unknown): boolean => typeof v === "string",
		isBoolean: (v: unknown): boolean => typeof v === "boolean",
		// Upstream `Values.isArray` is Array.isArray — DataArrays are NOT arrays.
		isArray: (v: unknown): boolean => Array.isArray(v),
		isObject: (v: unknown): boolean => typeof v === "object" && v !== null,
		isFunction: (v: unknown): boolean => typeof v === "function",
		isNull: (v: unknown): boolean => v === null,
		isNullOrUndefined: (v: unknown): boolean => v === null || v === undefined,
		typeOf: (v: unknown): string => dvTypeOf(v),
		compareValue: (a: unknown, b: unknown): number => compareValues(a, b),
		deepCopy: <T>(v: T): T => cloneValue(v, new WeakMap(), 0) as T,
	};

	return {
		// ── host/context ────────────────────────────────────────────────────
		get app(): AppShim {
			// Lazy: building the shim scans the snapshot, so a block that never
			// touches `app` must not pay for it.
			if (appShim === undefined) appShim = createAppShim(config);
			return appShim;
		},
		currentFilePath: config.filePath,
		settings: settingsSnapshot,
		func: config.funcs,
		value: valueUtils,
		io: {
			async load(source: string | Link, originFile?: string): Promise<string | undefined> {
				// Upstream io.load: a missing file resolves to undefined (no throw).
				const path = normalizePath(source, originFile);
				if (!(await config.io.exists(path))) return undefined;
				return config.io.read(path);
			},
			async csv(path: string | Link, originFile?: string): Promise<DataArray<Record<string, DvValue>> | undefined> {
				const resolved = normalizePath(path, originFile);
				if (!(await config.io.exists(resolved))) return undefined;
				const text = await config.io.read(resolved);
				return createDataArray(csvToRecords(text));
			},
			normalize(path: string | Link, originFile?: string): string {
				return normalizePath(path, originFile);
			},
			read(path: string): Promise<string> {
				// Project extension: raw read, throws when missing (unlike `load`).
				return config.io.read(normalizeRel(path));
			},
		},

		// ── query ───────────────────────────────────────────────────────────
		current(path?: string | Link): PageObject | undefined {
			if (path === undefined) return config.current ? buildPageObject(config.current) : undefined;
			return pageAtPath(path);
		},
		page(path?: string | Link): PageObject | undefined {
			// 判定：nullish → undefined（page 按 path 精确匹配；无参语义与 current() 分开）。
			if (path === undefined) return undefined;
			return pageAtPath(path);
		},
		pages(source?: DvValue): DataArray<PageObject> {
			const out: PageObject[] = [];
			for (const meta of config.index.pages) {
				// 第三个 ctx 参数必须传：FROM outgoing(...) 需要 allPages/currentPath。
				if (matchSource(source, meta, sourceCtx)) out.push(buildPageObject(meta));
			}
			return createDataArray(out);
		},
		pagePaths(source?: DvValue): DataArray<string> {
			const out: string[] = [];
			for (const meta of config.index.pages) {
				if (matchSource(source, meta, sourceCtx)) out.push(meta.path);
			}
			return createDataArray(out);
		},

		// ── utility ─────────────────────────────────────────────────────────
		array<V>(arr: V[] | DataArray<V> | Iterable<V> | V): DataArray<V> {
			if (Array.isArray(arr)) return createDataArray(arr as V[]);
			if (isDataArray(arr)) return arr as DataArray<V>;
			if (typeof arr === "object" && arr !== null && Symbol.iterator in (arr as object)) {
				return createDataArray(Array.from(arr as Iterable<V>));
			}
			return createDataArray([arr as V]);
		},
		isArray(v: unknown): boolean {
			return Array.isArray(v);
		},
		isDataArray(v: unknown): boolean {
			return isDataArray(v);
		},
		fileLink(path: string, embed: boolean = false, display?: string): Link {
			let emb: boolean = embed;
			let disp: string | undefined = display;
			// 向后兼容：旧形态 fileLink(path, display, embed)。第 2 参是 string
			// 且第 3 参是 boolean → 按旧语义解释并只警告一次。
			if ((typeof (embed as unknown) === "string" && typeof (display as unknown) === "boolean")) {
				emb = display as unknown as boolean;
				disp = embed as unknown as string;
				if (!legacyFileLinkWarned) {
					legacyFileLinkWarned = true;
					console.warn("dv.fileLink(path, display, embed) is deprecated; use dv.fileLink(path, embed, display).");
				}
			}
			return createLink({path, embed: emb, display: disp});
		},
		sectionLink(path: string, section: string, embed: boolean = false, display?: string): Link {
			const subpath = section.startsWith("#") ? section : "#" + section;
			return createLink({path, subpath, embed, display});
		},
		blockLink(path: string, blockId: string, embed: boolean = false, display?: string): Link {
			const subpath = blockId.startsWith("#^") ? blockId : "#^" + blockId;
			return createLink({path, subpath, embed, display});
		},
		date(v: string | number | Date | DvDate | Link | null | undefined): DvDate | null {
			if (v === null || v === undefined) return null;
			if (isLink(v)) return null;
			return parseDate(v);
		},
		duration(v: string | number | Duration | null | undefined): Duration | null {
			if (v === null || v === undefined) return null;
			if (isDuration(v)) return createDuration(v.ms);
			return parseDuration(v);
		},
		parse(value: string): DvValue {
			// values.coerceStringField already tags [[link]] / ISO date / "2h".
			return fromJsonValue(coerceStringField(typeof value === "string" ? value : String(value)));
		},
		literal(value: unknown): DvValue {
			return literalValue(value, 0);
		},
		clone<T>(value: T): T {
			return cloneValue(value, new WeakMap(), 0) as T;
		},
		compare(a: unknown, b: unknown): number {
			return compareValues(a, b);
		},
		equal(a: unknown, b: unknown): boolean {
			return looseEquals(a as DvValue, b as DvValue);
		},

		// ── query evaluation ────────────────────────────────────────────────
		query(source: string): Promise<DvResult<DvQueryResult>> {
			return runQuery(source);
		},
		async tryQuery(source: string): Promise<DvQueryResult> {
			const result = await runQuery(source);
			if (!result.successful) throw new Error(result.error);
			return result.value;
		},
		queryMarkdown(source: string): Promise<DvResult<string>> {
			return runQueryMarkdown(source);
		},
		async tryQueryMarkdown(source: string): Promise<string> {
			const result = await runQueryMarkdown(source);
			if (!result.successful) throw new Error(result.error);
			return result.value;
		},
		evaluate(expression: string, context?: Record<string, DvValue>): DvResult<DvValue> {
			return runEvaluate(expression, context);
		},
		tryEvaluate(expression: string, context?: Record<string, DvValue>): DvValue {
			const result = runEvaluate(expression, context);
			if (!result.successful) throw new Error(result.error);
			return result.value;
		},

		// ── rendering ───────────────────────────────────────────────────────
		el(tag: string, text?: DvValue, options?: DvElOptions): DvElement {
			const normalized = String(tag).toLowerCase();
			if (!ALLOWED_EL_TAGS.has(normalized)) {
				sink.push({kind: "notice", level: "warn", message: `dv.el: tag "${tag}" is not allowed; rendered as span.`});
				sink.push({kind: "span", text: optionText(text, options)});
				return noopHandle(normalized);
			}
			const op = makeElOp(normalized, optionText(text, options), asOptions(options));
			sink.push(op);
			return elementHandle(normalized, op, {sink, parent: op});
		},
		header(level: number, text: DvValue, options?: DvElOptions): DvElement {
			const lv = headerLevel(level);
			const body = text === null || text === undefined ? asOptions(options)?.text ?? "" : prettify(text);
			const op: Extract<RenderOp, {kind: "header"}> = {kind: "header", level: lv, text: body};
			sink.push(op);
			return elementHandle(`h${lv}`, op, {sink});
		},
		paragraph(text: DvValue, options?: DvElOptions): DvElement {
			const op: Extract<RenderOp, {kind: "paragraph"}> = {kind: "paragraph", text: optionText(text, options)};
			sink.push(op);
			return elementHandle("p", op, {sink});
		},
		span(text: DvValue, options?: DvElOptions): DvElement {
			const op: Extract<RenderOp, {kind: "span"}> = {kind: "span", text: optionText(text, options)};
			sink.push(op);
			return elementHandle("span", op, {sink});
		},
		list(items: DvValue, ordered?: boolean): void {
			const cells = toArray(items).map((v) => toCell(v));
			sink.push(ordered ? {kind: "list", items: cells, ordered: true} : {kind: "list", items: cells});
		},
		table(headers: string[], rows: DvValue[][] | DataArray<DvValue> | DvValue, groupByFile?: boolean): void {
			const hs = headers.map((h) => String(h));
			const norm = normalizeTableRows(rows, hs);
			sink.push({kind: "table", headers: hs, rows: buildTableRows(norm, groupByFile === true)});
		},
		taskList(tasks: DvValue, groupByFile: boolean = true): void {
			const flat = collectTasks(tasks);
			if (!groupByFile) {
				sink.push({kind: "taskList", tasks: flat});
				return;
			}
			// 上游默认按 task.path 分组，每组输出 h4 文件链接 + 一个 taskList op。
			const order: string[] = [];
			const groups = new Map<string, TaskNode[]>();
			for (const t of flat) {
				const p = typeof t.path === "string" ? t.path : "";
				const slot = groups.get(p);
				if (slot) slot.push(t);
				else {
					groups.set(p, [t]);
					order.push(p);
				}
			}
			for (const p of order) {
				sink.push({kind: "header", level: 4, text: taskGroupHeader(p)});
				sink.push({kind: "taskList", tasks: groups.get(p)!});
			}
		},
		execute(source: string): Promise<void> {
			return pushQuery(source);
		},
		executeJs(code: string): Promise<void> {
			return executeJs(code);
		},
		html(html: string): void {
			sink.push({kind: "html", html});
		},
		markdown(text: string): void {
			sink.push({kind: "markdown", text: prettify(text)});
		},
		view(path: string, input?: DvValue): Promise<void> {
			return runView(path, input);
		},

		// ── markdown export ─────────────────────────────────────────────────
		markdownTable(headers: string[], values?: DvValue[][] | DataArray<DvValue>): string {
			return markdownTable(headers, values === undefined ? [] : asRowMatrix(values));
		},
		markdownList(values?: DvValue[] | DataArray<DvValue>): string {
			const raw: unknown = values;
			if (raw === undefined) return markdownList([]);
			if (isDataArray(raw)) return markdownList((raw as DataArray<DvValue>).array());
			return markdownList(raw as DvValue[]);
		},
		markdownTaskList(values: DvValue): string {
			const tasks = collectTasks(values);
			return markdownTaskList(tasks);
		},
	};
}
