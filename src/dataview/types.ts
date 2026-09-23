/**
 * Cross-module contracts for the Dataview port (golden contract file).
 *
 * Owned by the integrator (main agent). Builders MUST NOT edit this file;
 * contract gaps are reported back instead. Everything here is JSON-cloneable
 * unless marked otherwise, because values cross the worker boundary via
 * structured clone.
 */

// ---------------------------------------------------------------------------
// Primitive value model
// ---------------------------------------------------------------------------

/** Dataview-style wiki link (workspace-relative, posix, may include .md). */
export interface Link {
	path: string;
	display?: string;
	/** "#Heading" or "#^block-id" (kept verbatim, with leading #). */
	subpath?: string;
	embed: boolean;
	/** "file" | "header" | "block", derived from `subpath`. */
	readonly type?: "file" | "header" | "block";
	/** Non-Obsidian extension: marks `elink()` results (rendered as a plain anchor). */
	external?: boolean;
	// Optional in the type (plain `{path, embed}` literals predate the class
	// methods and are still valid Links), but ALWAYS present on links produced by
	// `createLink`/`linkFromMeta`, i.e. everything `dv.*` and the index hand out.
	withDisplay?(display: string): Link;
	withHeader?(header: string): Link;
	withBlock?(block: string): Link;
	withSubpath?(subpath: string | undefined): Link;
	asFile?(): Link;
	asEmbed?(embed: boolean): Link;
	toString?(): string;
	toObject?(): {path: string; display?: string; subpath?: string; embed: boolean};
	toJSON?(): {path: string; display?: string; subpath?: string; embed: boolean};
	equals?(other: unknown): boolean;
	/** `[[path#sub|display]]` — used by markdown exports. */
	markdown?(): string;
	/** `[display](path)` — plain markdown link form. */
	obsidianLink?(): string;
}

/**
 * Dataview `Duration`. Only `ms` is stored/serialized; every method is derived
 * (see query/datetime.ts createDuration) so the value stays JSON/structured-clone
 * safe across the worker boundary.
 * Unit factors follow Luxon's "casual" table: year=365d, quarter=91d, month=30d.
 */
export interface Duration {
	readonly ms: number;
	toMillis(): number;
	toSeconds(): number;
	as(unit: string): number;
	asMilliseconds(): number;
	asSeconds(): number;
	asMinutes(): number;
	asHours(): number;
	asDays(): number;
	asWeeks(): number;
	asMonths(): number;
	asYears(): number;
	valueOf(): number;
	toObject(): Record<string, number>;
	toString(): string;
	toISO(): string;
	/** Tokens y M w d h m s S; single quotes are literals, repeated tokens zero-pad. */
	toFormat(fmt: string): string;
	plus(other: Duration | DateDelta | number): Duration;
	minus(other: Duration | DateDelta | number): Duration;
	shiftTo(...units: string[]): Duration;
	normalize(): Duration;
	equals(other: unknown): boolean;
	readonly isValid: boolean;
	[Symbol.toPrimitive](hint: string): number | string;
}

export interface DateDelta {
	years?: number;
	months?: number;
	weeks?: number;
	days?: number;
	hours?: number;
	minutes?: number;
	seconds?: number;
	milliseconds?: number;
}

/** Luxon-lite date wrapper produced by query/datetime.ts. */
export interface DvDate {
	readonly iso: string;
	readonly year: number;
	readonly month: number; // 1-12
	readonly day: number; // 1-31
	readonly hour: number;
	readonly minute: number;
	readonly second: number;
	readonly weekday: number; // ISO 1=Mon .. 7=Sun
	toFormat(fmt: string): string;
	toISO(): string;
	toMillis(): number;
	/** Luxon bridge: the same instant as a native `Date` (DataviewJS passes these to other libraries). */
	toJSDate(): Date;
	plus(delta: DateDelta): DvDate;
	minus(delta: DateDelta): DvDate;
	startOf(unit: "second" | "minute" | "hour" | "day" | "week" | "month" | "year"): DvDate;
	endOf(unit: "second" | "minute" | "hour" | "day" | "week" | "month" | "year"): DvDate;
	/** Calendar-field replacement; `day` is clamped to the target month's length. */
	set(parts: {
		year?: number;
		month?: number;
		day?: number;
		hour?: number;
		minute?: number;
		second?: number;
		millisecond?: number;
	}): DvDate;
	/** `this - other` in ms (`unit` accepted for Luxon parity; see diff notes). */
	diff(other: DvDate, unit?: string): Duration;
	until(other: DvDate): Duration;
	hasSame(other: DvDate, unit: "second" | "minute" | "hour" | "day" | "week" | "month" | "year"): boolean;
	toISODate(): string;
	toISOTime(): string;
	toISOWeekDate(): string;
	/** Deterministic English ("in 3 days", "2 hours ago"); `base` defaults to now. */
	toRelative(base?: DvDate | {base?: DvDate}): string;
	toObject(): Record<string, number>;
	weekdayLong(): string;
	monthLong(): string;
	daysInMonth(): number;
	readonly isValid: boolean;
	equals(other: DvDate): boolean;
}

// ---------------------------------------------------------------------------
// JSON-safe stored values (index layer output)
// ---------------------------------------------------------------------------

export type TaggedValue =
	| {__dv: "date"; iso: string}
	| {__dv: "dur"; ms: number}
	| {__dv: "link"; link: Link};

export type JsonValue = null | boolean | number | string | JsonValue[] | {[k: string]: JsonValue} | TaggedValue;

// ---------------------------------------------------------------------------
// Render protocol (worker output → host HTML)
// ---------------------------------------------------------------------------

export type CellValue =
	| {t: "null"}
	| {t: "bool"; v: boolean}
	| {t: "num"; v: number}
	| {t: "str"; v: string}
	| {t: "date"; iso: string}
	| {t: "dur"; ms: number}
	| {t: "link"; link: Link}
	| {t: "arr"; v: CellValue[]}
	| {t: "obj"; v: Record<string, CellValue>}
	| {t: "html"; v: string}
	| {t: "md"; v: string};

export interface TableRow {
	/** Spanning group header row (GROUP BY) rendered before `cells`. */
	group?: CellValue;
	cells: CellValue[];
}

/** Task tree as rendered (dv.taskList). */
/**
 * Task / list-item as seen by user code (`dv.taskList`, `TASKS` queries,
 * `page.file.tasks`). Field set mirrors upstream `STask`/`SListItemBase` so the
 * canonical docs idioms work: `t => !t.completed`, `t.subtasks`, `t.link`,
 * `t.visual`, `t.lineCount`, and inline fields spread directly (`t.due`).
 */
export interface ListItemNode {
	/** True for tasks (`- [ ]`), false for plain list entries. */
	task: boolean;
	/** Item text without the checkbox/marker. */
	text: string;
	/**
	 * Display override (upstream `visual`). Equals `text` for tasks — it does NOT
	 * include the checkbox; task views prepend the status themselves.
	 */
	visual: string;
	/** "" = open, "x"/"X" = done, other chars = custom status. */
	status: string;
	/** Status is not blank (upstream `checked`). */
	checked: boolean;
	/** Status is explicitly `x`/`X`. */
	completed: boolean;
	/** This task AND every descendant task are completed. */
	fullyCompleted: boolean;
	/** Item carries inline-field annotations. */
	annotated: boolean;
	symbol: string;
	path: string;
	line: number;
	lineCount: number;
	/** Line of the outermost item of the list this item belongs to. */
	list: number;
	parent?: number;
	blockId?: string;
	/** Link to the closest addressable unit (block if it has an id, else the section). */
	link: Link;
	section: Link;
	tags: string[];
	outlinks: Link[];
	/** Nested items (may mix tasks and plain entries). */
	children: ListItemNode[];
	// Deprecated upstream aliases — kept so old snippets keep working.
	subtasks: ListItemNode[];
	real: boolean;
	header: Link;
	/** Inline-field metadata, ALSO spread onto this object (`t.due`, `t.scheduled`). */
	fields: Record<string, JsonValue>;
	/** Spread inline fields / any extra annotation key. */
	[k: string]: unknown;
}

/** Back-compat alias: the render/dv task shape used to be called TaskNode. */
export type TaskNode = ListItemNode;

/** One day cell of a `heatmap` RenderOp (upstream Heatmap Calendar `<li>`). */
export interface HeatmapBox {
	/** Inline `background-color` (palette entry, or `transparent` for the leading blanks). */
	color?: string;
	/** `YYYY-MM-DD` for days that have an entry. */
	date?: string;
	/** Text drawn inside the box (emoji/short label). */
	content?: string;
	/** Upstream class markers: `month-<mon>`, `today`, `hasData` / `isEmpty`. */
	classes: string[];
}

export type RenderOp =
	| {kind: "table"; headers: string[]; rows: TableRow[]}
	| {kind: "list"; items: CellValue[]; ordered?: boolean}
	| {kind: "taskList"; tasks: TaskNode[]; groupByFile?: boolean}
	| {kind: "paragraph"; text: string}
	| {kind: "header"; level: number; text: string}
	| {kind: "span"; text: string}
	| {kind: "el"; tag: string; cls?: string[]; attrs?: Record<string, string>; text?: string; children?: RenderOp[]}
	| {kind: "html"; html: string}
	| {kind: "markdown"; text: string}
	| {kind: "error"; message: string; detail?: string}
	| {kind: "notice"; level: "info" | "warn"; message: string}
	| {kind: "empty"; message: string}
	/** CALENDAR query output: date-grouped entries (rendered as a month-grouped list). */
	| {kind: "calendar"; entries: Array<{date: string; link: Link; value?: CellValue}>}
	/**
	 * `renderHeatmapCalendar(...)`: a year grid of daily boxes (upstream Heatmap
	 * Calendar markup). `boxes` holds the leading blanks plus one box per day;
	 * `classes` carry upstream's `month-<mon>` / `today` / `hasData` / `isEmpty`.
	 */
	| {kind: "heatmap"; year: number; weekdays: string[]; boxes: HeatmapBox[]}
	/** Result-count / timing badge (UX, opt-in via settings.showResultCount). */
	| {kind: "badge"; text: string};

// ---------------------------------------------------------------------------
// Index layer
// ---------------------------------------------------------------------------

export interface HeadingMeta {
	level: number;
	text: string;
	line: number;
}

export interface SectionMeta {
	heading: HeadingMeta;
	/** [startLine, endLine) within the file body (0-based, fence-aware). */
	range: [number, number];
}

/**
 * Fields shared by every list item — mirrors upstream `SListItemBase`
 * (data-model/serialized/markdown.ts). Nested `children` may mix tasks and
 * plain items, exactly like upstream.
 */
export interface ListItemBaseMeta {
	/** List marker as written ("-", "*", "+", "1."). */
	symbol: string;
	/** True for `- [ ]` / `- [x]` items; false for plain list entries. */
	task: boolean;
	/** Item text with the checkbox/marker removed. */
	text: string;
	/** Raw item text including the checkbox — upstream `visual`. */
	visual: string;
	/** Any inline-field annotation present (`[due:: …]`, `key:: value`). */
	annotated: boolean;
	line: number;
	/** Number of source lines this item spans (>= 1). */
	lineCount: number;
	indent: number;
	/** Line of the parent item, when nested. */
	parent?: number;
	/** Line of the outermost item of the list this item belongs to. */
	list: number;
	/** `^block-id` trailing the item, when present. */
	blockId?: string;
	/** Enclosing heading as a link (`page#Heading`), when the item is under one. */
	section?: LinkMeta;
	tags: string[];
	fields: Record<string, JsonValue>;
	/** Links written inside the item. */
	outlinks: LinkMeta[];
	children: ListItemMeta[];
}

/** A plain list entry (`- foo`). */
export interface ListMeta extends ListItemBaseMeta {
	task: false;
}

/** A task (`- [ ] foo`) — upstream STask. */
export interface TaskMeta extends ListItemBaseMeta {
	task: true;
	/** "" open, "x" done, other = custom. */
	status: string;
	checked: boolean;
}

export type ListItemMeta = TaskMeta | ListMeta;

export interface LinkMeta {
	/** Target path without leading "./" (extension kept as written). */
	path: string;
	display?: string;
	subpath?: string;
	embed: boolean;
	line: number;
}

export interface PageMeta {
	/** Workspace-relative posix path, e.g. "notes/a.md". */
	path: string;
	name: string;
	/** Parent folder posix path, "" for root. */
	folder: string;
	ext: string;
	ctime: number;
	mtime: number;
	size: number;
	frontmatter: Record<string, JsonValue>;
	inlineFields: Record<string, JsonValue>;
	/** frontmatter ∪ inlineFields (inline wins) — merged field view. */
	fields: Record<string, JsonValue>;
	/** Exact tags as written, "#" prefixed (frontmatter + body inline). */
	tags: string[];
	/** Expanded tags incl. all parents ("#a" present for "#a/b"). */
	etags: string[];
	aliases: string[];
	headings: HeadingMeta[];
	sections: SectionMeta[];
	lists: ListMeta[];
	/** All list-item roots in document order (tasks AND plain items) — `file.lists`. */
	listItems: ListItemMeta[];
	/** Root tasks; children nested by indentation. */
	tasks: TaskMeta[];
	inlinks: LinkMeta[];
	outlinks: LinkMeta[];
}

export interface IndexSnapshot {
	version: number;
	/** Sorted by path (deterministic structured clone). */
	pages: PageMeta[];
	generatedAt: number;
}

export interface IndexStats {
	files: number;
	version: number;
	/** Rolling counters since store creation. */
	parseCalls: number;
	lastIncrementalMs?: number;
	lastSnapshotMs?: number;
}

export interface IndexStore {
	readonly version: number;
	upsertFile(path: string, content: string, mtime: number, size: number): void;
	removeFile(path: string): void;
	getPage(path: string): PageMeta | undefined;
	allPages(): readonly PageMeta[];
	snapshot(): IndexSnapshot;
	/** Inverted index: pages whose etags contain `tag` exactly. */
	byTag(tag: string): readonly string[];
	byFolder(folder: string): readonly string[];
	stats(): IndexStats;
}

// ---------------------------------------------------------------------------
// Values / page objects
// ---------------------------------------------------------------------------

/** Runtime value seen by expressions and the dv API. */
export type DvValue =
	| null
	| undefined
	| boolean
	| number
	|string
	| Date
	| DvDate
	| Duration
	| Link
	| DvValue[]
	| DataArray<DvValue>
	| PageObject
	| {[k: string]: DvValue}
	| ((...args: DvValue[]) => DvValue);

/** A page as exposed by dv.page()/dv.pages(): fields + `file` metadata. */
export interface PageObject {
	file: PageFile;
	[k: string]: DvValue | PageFile;
}

export interface PageFile {
	path: string;
	name: string;
	folder: string;
	ext: string;
	link: Link;
	tags: string[];
	etags: string[];
	aliases: string[];
	/** All list items (tasks + plain), nested — upstream `file.lists`. */
	lists: ListItemNode[];
	/** Root-level tasks of the page (nested via children). */
	tasks: ListItemNode[];
	inlinks: Link[];
	outlinks: Link[];
	frontmatter: Record<string, JsonValue>;
	/** Creation time. Index has no birth time → equals `mtime` (documented gap). */
	ctime: DvDate;
	mtime: DvDate;
	/** Date-only variants (upstream cday/mday). */
	cday: DvDate;
	mday: DvDate;
	/** File size in bytes — upstream is a plain number. */
	size: number;
	/** Whether the file is starred (Obsidian bookmark) — always false in VSCode. */
	starred: boolean;
	// Intentionally no `day` (Obsidian daily-note plugin concept) — documented gap.
}

export type FieldSpec<T> = string | ((v: T, i: number) => unknown);

/** Obsidian Dataview DataArray surface (implemented in query/dataArray.ts). */
/**
 * Obsidian Dataview DataArray surface (implemented in query/dataArray.ts).
 *
 * Upstream is a Proxy over a JS array, which is why this interface also
 * declares the two indexing behaviours user code relies on:
 *   - `arr[0]`      → numeric indexing
 *   - `arr.field`   → "swizzling": map `field` over every element and flatten
 *                     (this is what makes `dv.pages().file.name` work)
 * Both are provided by our Proxy implementation, so the index signatures below
 * describe real runtime behaviour rather than a lie to the type checker.
 */
export interface DataArray<T = unknown> extends Iterable<T> {
	readonly length: number;
	/** Numeric indexing (arr[0]). */
	[index: number]: T;
	/** Field swizzling + method access (arr.field, arr.where). */
	[key: string]: unknown;
	where(pred: (v: T, i: number, arr: T[]) => boolean): DataArray<T>;
	filter(pred: (v: T, i: number, arr: T[]) => boolean): DataArray<T>;
	map<U>(fn: (v: T, i: number, arr: T[]) => U): DataArray<U>;
	flatMap<U>(fn: (v: T, i: number, arr: T[]) => U[] | DataArray<U>): DataArray<U>;
	/** Mutate each element in place and return the same array (upstream `mutate`). */
	mutate(fn: (v: T, i: number, arr: T[]) => unknown): DataArray<unknown>;
	limit(n: number): DataArray<T>;
	slice(start?: number, end?: number): DataArray<T>;
	concat(other: Iterable<T>): DataArray<T>;
	indexOf(element: T, fromIndex?: number): number;
	includes(element: T): boolean;
	find(pred: (v: T, i: number, arr: T[]) => boolean): T | undefined;
	findIndex(pred: (v: T, i: number, arr: T[]) => boolean, fromIndex?: number): number;
	join(sep?: string): string;
	sort<U = T>(key?: FieldSpec<T> | ((v: T, i: number) => U), direction?: "asc" | "desc", comparator?: (a: U, b: U) => number): DataArray<T>;
	groupBy<U = unknown>(key: FieldSpec<T> | ((v: T, i: number) => U), comparator?: (a: U, b: U) => number): DataArray<{key: U; rows: DataArray<T>}>;
	groupIn(): DataArray<{key: unknown; rows: DataArray<T>}>;
	distinct<U = T>(key?: (v: T, i: number) => U, comparator?: (a: U, b: U) => number): DataArray<T>;
	unique(): DataArray<T>;
	every(pred: (v: T, i: number) => boolean): boolean;
	some(pred: (v: T, i: number) => boolean): boolean;
	any(pred?: (v: T, i: number) => boolean): boolean;
	none(pred?: (v: T, i: number) => boolean): boolean;
	first(): T | undefined;
	last(): T | undefined;
	/** Swizzle `key` over elements and flatten (upstream `to`). */
	to(key: string): DataArray<unknown>;
	/** Recursively expand `key`, flattening a tree (e.g. `expand("children")`). */
	expand(key: string): DataArray<unknown>;
	forEach(fn: (v: T, i: number, arr: T[]) => void): void;
	sum(field?: FieldSpec<T>): number;
	total(): number;
	/** Upstream name for the arithmetic mean. */
	avg(field?: FieldSpec<T>): number;
	mean(field?: FieldSpec<T>): number;
	median(field?: FieldSpec<T>): number;
	min(field?: FieldSpec<T>): number;
	max(field?: FieldSpec<T>): number;
	reverse(): DataArray<T>;
	/** Alias of sort() kept for compatibility with earlier builds. */
	ordered(key?: FieldSpec<T>, direction?: "asc" | "desc"): DataArray<T>;
	take(n: number): DataArray<T>;
	flatten(): DataArray<unknown>;
	array(): T[];
	/** True when the array holds no elements (convenience helper). */
	isEmpty?(): boolean;
	toJSON(): T[];
}

// ---------------------------------------------------------------------------
// Sandbox execution protocol (host ⇄ worker)
// ---------------------------------------------------------------------------

export interface ExecJob {
	id: string;
	/**
	 * "dql"/"dataviewjs" = code blocks; "inline-dql"/"inline-js" = inline
	 * `` `= expr ` `` / `` `$= expr ` `` expressions rendered in place.
	 */
	kind: "dataviewjs" | "dql" | "inline-dql" | "inline-js";
	/** Raw block source. */
	code: string;
	/** Workspace-relative path of the page containing the block ("" if unknown). */
	pagePath: string;
	indexVersion: number;
	/** 0-based ordinal of the block within the page (error messages). */
	blockIndex: number;
	timeoutMs: number;
}

export interface ExecResult {
	id: string;
	ok: boolean;
	ops: RenderOp[];
	error?: {message: string; detail?: string};
	durationMs: number;
	indexVersion: number;
}

export type HostToWorker =
	| {t: "syncIndex"; version: number; snapshot: IndexSnapshot}
	| {t: "run"; job: ExecJob}
	| {t: "cancel"; id: string}
	| {t: "ioResult"; id: string; ok: true; value: string}
	| {t: "ioResult"; id: string; ok: false; error: string}
	| {t: "shutdown"};

export type WorkerToHost =
	| {t: "ready"; indexVersion: number}
	| {t: "done"; result: ExecResult}
	| {t: "io"; id: string; op: "read" | "exists"; path: string}
	| {t: "log"; level: "info" | "warn" | "error"; message: string; jobId?: string};

/** Async file access exposed to user code (dv.io / app.vault.read). */
export interface IoBridge {
	read(path: string): Promise<string>;
	exists(path: string): Promise<boolean>;
}

/** Host-side IO implementation injected into ExecService (tests provide fakes). */
export interface HostIo {
	read(path: string): Promise<string>;
	exists(path: string): Promise<boolean>;
}

/** Dependency injection point for workerRuntime.ts (keeps exec/ independent). */
export interface WorkerRuntimeDeps {
	runJob(job: ExecJob, snapshot: IndexSnapshot, io: IoBridge): Promise<ExecResult>;
	onLog?(level: "info" | "warn" | "error", message: string, jobId?: string): void;
}

export interface ExecServiceOptions {
	/** Absolute path to the bundled worker script (dist/dataviewWorker.js). */
	workerPath: string;
	poolSize?: number;
	defaultTimeoutMs?: number;
	/** Reject jobs whose queue depth exceeds this (backpressure). */
	maxQueue?: number;
	hostIo?: HostIo;
	maxCodeBytes?: number;
}

export interface ExecStats {
	poolSize: number;
	queued: number;
	running: number;
	completed: number;
	timeouts: number;
	cancelled: number;
	respawns: number;
}

export interface ExecService {
	ensureIndex(snapshot: IndexSnapshot): void;
	run(job: ExecJob): Promise<ExecResult>;
	cancel(jobId: string): void;
	stats(): ExecStats;
	dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// dv API (implemented by dv/createDvApi.ts)
// ---------------------------------------------------------------------------

export interface OpSink {
	push(op: RenderOp): void;
}

export interface DvHostConfig {
	/** Snapshot this job runs against. */
	index: IndexSnapshot;
	/** Current page meta (page containing the block), if known. */
	current: PageMeta | undefined;
	/** Raw block source (exposed as `input`). */
	input: string;
	/** Workspace-relative path of the block's page. */
	filePath: string;
	io: IoBridge;
	/** Built-in function table (query/functions.ts DvFunctions) — injected by workerRuntime. */
	funcs: Record<string, (...args: DvValue[]) => DvValue>;
	/** Read-only settings snapshot exposed as `dv.settings` (render defaults). */
	settings?: {
		renderNullAs?: string;
		dateFormat?: string;
		maxRenderDepth?: number;
		displayResultCount?: boolean;
	};
	/**
	 * Runs a nested script (dv.view / dv.executeJs) in the SAME vm context,
	 * with the same `dv` instance (so the view-depth counter stays enforced).
	 */
	runNested?: (code: string, input: DvValue, depth: number) => Promise<DvValue | undefined>;
	/** Optional DQL execution injection; falls back to executeDql when absent. */
	execQuery?: (query: DqlQuery) => RenderOp[];
}

/** Upstream `Result<T, string>`: `dv.query`/`dv.evaluate` never throw. */
export type DvResult<T> = {successful: true; value: T} | {successful: false; error: string};

/** Structured result of `dv.query()` — mirrors upstream TableResult/ListResult/TaskResult. */
export type DvQueryResult =
	| {type: "table"; headers: string[]; values: DvValue[][]; idMeaning?: string}
	| {type: "list"; values: DvValue[]}
	| {type: "task"; values: ListItemNode[]}
	| {type: "calendar"; values: Array<{date: DvDate; link: Link; value?: DvValue[]}>};

/** `dv.el(tag, text, {cls, attr, container})` — upstream DomElementInfo subset. */
export interface DvElOptions {
	cls?: string | string[];
	attr?: Record<string, string>;
	text?: string;
	href?: string;
	title?: string;
}

/**
 * Handle returned by `dv.el/span/paragraph/header` so Obsidian-style chaining
 * works: `dv.el("div", "").createEl("b", "hi")`.
 */
export interface DvElement {
	readonly tag: string;
	appendText(text: string): DvElement;
	createEl(tag: string, text?: string, options?: DvElOptions): DvElement;
	/**
	 * Upstream returns a real `HTMLElement`; here the sandbox has no DOM and the
	 * built-in preview is static HTML (the only channel to the host is a
	 * whole-document `markdown.preview.refresh`), so a registered listener can
	 * never run. The call is accepted and reported once per listener type as a
	 * warning notice instead of failing silently (see docs/dataview/README.md §6).
	 */
	addEventListener(type: string, listener?: unknown, options?: unknown): void;
	/** Counterpart of {@link addEventListener}: nothing is registered, so nothing is removed. */
	removeEventListener(type: string, listener?: unknown, options?: unknown): void;
}

/** `dv.value` — upstream re-exports its Values helper namespace here. */
export interface DvValueUtils {
	isLink(v: unknown): boolean;
	isDate(v: unknown): boolean;
	isDuration(v: unknown): boolean;
	isNumber(v: unknown): boolean;
	isString(v: unknown): boolean;
	isBoolean(v: unknown): boolean;
	isArray(v: unknown): boolean;
	isObject(v: unknown): boolean;
	isFunction(v: unknown): boolean;
	isNull(v: unknown): boolean;
	isNullOrUndefined(v: unknown): boolean;
	typeOf(v: unknown): string;
	compareValue(a: unknown, b: unknown): number;
	deepCopy<T>(v: T): T;
}

export interface DvApi {
	// ── host/context (upstream DataviewInlineApi fields) ──────────────────────
	readonly app: AppShim;
	readonly currentFilePath: string;
	readonly settings: Readonly<Record<string, DvValue>>;
	readonly func: Record<string, (...args: DvValue[]) => DvValue>;
	readonly value: DvValueUtils;
	readonly io: {
		load(source: string | Link, originFile?: string): Promise<string | undefined>;
		csv(path: string | Link, originFile?: string): Promise<DataArray<Record<string, DvValue>> | undefined>;
		normalize(path: string | Link, originFile?: string): string;
		/** Project extension: raw read (throws when missing, unlike `load`). */
		read(path: string): Promise<string>;
	};

	// ── query ────────────────────────────────────────────────────────────────
	current(path?: string | Link): PageObject | undefined;
	page(path?: string | Link): PageObject | undefined;
	pages(source?: DvValue): DataArray<PageObject>;
	pagePaths(source?: DvValue): DataArray<string>;

	// ── utility ──────────────────────────────────────────────────────────────
	array<V>(arr: V[] | DataArray<V> | Iterable<V> | V): DataArray<V>;
	isArray(v: unknown): boolean;
	isDataArray(v: unknown): boolean;
	fileLink(path: string, embed?: boolean, display?: string): Link;
	sectionLink(path: string, section: string, embed?: boolean, display?: string): Link;
	blockLink(path: string, blockId: string, embed?: boolean, display?: string): Link;
	date(v: string | number | Date | DvDate | Link | null | undefined): DvDate | null;
	duration(v: string | number | Duration | null | undefined): Duration | null;
	parse(value: string): DvValue;
	literal(value: unknown): DvValue;
	clone<T>(value: T): T;
	compare(a: unknown, b: unknown): number;
	equal(a: unknown, b: unknown): boolean;

	// ── query evaluation ────────────────────────────────────────────────────
	query(source: string): Promise<DvResult<DvQueryResult>>;
	tryQuery(source: string): Promise<DvQueryResult>;
	queryMarkdown(source: string): Promise<DvResult<string>>;
	tryQueryMarkdown(source: string): Promise<string>;
	evaluate(expression: string, context?: Record<string, DvValue>): DvResult<DvValue>;
	tryEvaluate(expression: string, context?: Record<string, DvValue>): DvValue;

	// ── rendering ───────────────────────────────────────────────────────────
	el(tag: string, text?: DvValue, options?: DvElOptions): DvElement;
	header(level: number, text: DvValue, options?: DvElOptions): DvElement;
	paragraph(text: DvValue, options?: DvElOptions): DvElement;
	span(text: DvValue, options?: DvElOptions): DvElement;
	list(items: DvValue, ordered?: boolean): void;
	table(headers: string[], rows: DvValue[][] | DataArray<DvValue> | DvValue, groupByFile?: boolean): void;
	taskList(tasks: DvValue, groupByFile?: boolean): void;
	execute(source: string): Promise<void>;
	executeJs(code: string): Promise<void>;
	/** Project extensions (not upstream): trusted HTML / markdown block output. */
	html(html: string): void;
	markdown(text: string): void;
	/** Upstream `dv.view(path, input)` — runs a vault JS file in the worker sandbox. */
	view(path: string, input?: DvValue): Promise<void>;

	// ── markdown export ─────────────────────────────────────────────────────
	markdownTable(headers: string[], values?: DvValue[][] | DataArray<DvValue>): string;
	markdownList(values?: DvValue[] | DataArray<DvValue>): string;
	markdownTaskList(values: DvValue): string;
}

/** VSCode-side shim exposed as `app` inside dataviewjs (partial by design). */
export interface AppShim {
	vault: {
		getAbstractFileByPath(path: string): {path: string; name: string; basename?: string} | null;
		read(path: string): Promise<string>;
		getFiles(): {path: string; name: string; basename?: string}[];
	};
	metadataCache: {
		getFileCache(path: string): {frontmatter?: Record<string, JsonValue>; headings?: HeadingMeta[]} | null;
	};
	workspace: {
		getActiveFile(): {path: string} | null;
	};
	/** Escape hatch; documented as partial vs Obsidian. */
	meta: {adapter: "vscode"; version: 1};
}

// ---------------------------------------------------------------------------
// Preview integration (markdown-it side; no vscode import allowed here)
// ---------------------------------------------------------------------------

export type BlockState =
	| {status: "ready"; html: string}
	| {status: "pending"; html: string}
	| {status: "error"; html: string};

/**
 * Implemented by dataview/service.ts; consumed by preview fence renderer.
 * Must be sync (markdown-it render is sync) — enqueue happens inside.
 */
export interface BlockResultProvider {
	getBlock(env: DataviewRenderEnv, kind: "dataview" | "dataviewjs", code: string): BlockState;
	/** Inline form (same kind vocabulary as getBlock); absent → inlines stay literal. */
	getInline?(env: DataviewRenderEnv, kind: "dataview" | "dataviewjs", code: string): BlockState;
}

/** Subset of markdown-it render env we rely on (set by VSCode engine). */
export interface DataviewRenderEnv {
	currentDocument?: {toString(): string; fsPath?: string};
	[key: string]: unknown;
}

// ---------------------------------------------------------------------------
// DQL (parsed shape produced by query/parseDql.ts)
// ---------------------------------------------------------------------------

export interface DqlField {
	name: string;
	expr: string;
}

export interface DqlQuery {
	/** "calendar" added for CALENDAR queries (executed as a month-grouped list). */
	type: "table" | "list" | "tasks" | "calendar";
	/** null = implicit single column for list/tasks. */
	fields: DqlField[] | null;
	/** Raw FROM expression ("" = all pages). */
	source: string;
	where?: string;
	sort: Array<{expr: string; dir: "asc" | "desc"}>;
	groupBy?: string;
	/** GROUP BY `expr AS name` — display name for the group key column. */
	groupByAlias?: string;
	flatten: string[];
	/** Parallel to `flatten`; undefined where no alias was given. */
	flattenAliases?: Array<string | undefined>;
	/** TABLE/LIST WITHOUT ID — suppress the implicit file column/prefix. */
	withoutId?: boolean;
	limit?: number;
}
