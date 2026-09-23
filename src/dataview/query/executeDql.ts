/**
 * DQL execution pipeline (order per spec / Dataview query semantics):
 *
 *   1. FROM    → evaluate source expr (rewritten), pages = snapshot.pages
 *                .filter(matchSource(source || null))
 *   2. WHERE   → table/list: scope = buildPageScope(page), falsy → drop;
 *                tasks: scope = task object, drop ENTIRE subtree when a parent
 *                fails (approximation of Obsidian's task filtering — noted).
 *   3. FLATTEN → per declaration order: array/DataArray → one row per element
 *                (element bound as `this`, page fields stay); non-array → row
 *                unchanged.
 *   4. fields  → evaluate TABLE/LIST field exprs once per row (cells cache).
 *   5. SORT    → single decorate-sort over rows (Schwartzian): each sort key
 *                evaluated ONCE per row, compared via golden compareValues,
 *                stable via index tiebreak.
 *   6. GROUP BY (table only) → Map insertion order; each group emits a header
 *                placeholder row {group: toCell(key), cells: []} then members.
 *   7. LIMIT   → truncate final output rows/items/tasks.
 *   8. Render  → table/list/taskList ops; all values through golden toCell.
 *                opts.maxRows (default 10000) truncates + pushes a warn
 *                notice so million-row results can't blow up the renderer.
 *
 * Perf notes: clause ASTs are parsed ONCE, then evaluated per row on the
 * iterative evaluator (O(ast) per row, no per-node string building); WHERE's
 * and/or short-circuit avoids evaluating the right side once decided.
 */
import type {CellValue, DqlQuery, DvValue, IndexSnapshot, Link, PageMeta, RenderOp, TableRow, TaskMeta, TaskNode} from "../types";
import type {Expr} from "./expression";
import {evalExpr, evaluateExpression, ExpressionError, parseExpression} from "./expression";
import {compareValues} from "./dataArray";
import {rewriteSourceExpr} from "./parseDql";
import {matchSource} from "./source";
import {toArrayOrNull, truthy} from "./semantics";
import {buildPageScope} from "../page";
import {buildListItem, toCell} from "../values";
import {createLink} from "../link";

const DEFAULT_MAX_ROWS = 10000;

/**
 * Origin page for the running query — needed by `outgoing()`/`incoming()`
 * sources (upstream resolves them relative to the block's file). Set per
 * executeDql() call; queries are executed sequentially inside one worker job,
 * and a nested DQL never outlives its parent call.
 */
let currentPath = "";

interface Row {
	scope: Record<string, unknown>;
	cells: DvValue[]; // field values (step 4), filled before sort
}

interface RowEntry {
	row: Row;
	keys: DvValue[]; // decorated sort keys (step 5)
	idx: number;
}

function compile(src: string): Expr {
	return parseExpression(src);
}

function run(ast: Expr, scope: Record<string, unknown>): DvValue {
	return evalExpr(ast, scope);
}

/** Step 1: FROM (source sugar rewritten: #tag → string, [[x]] → link). */
function selectPages(q: DqlQuery, snapshot: IndexSnapshot): PageMeta[] {
	let sourceVal: DvValue = null;
	if (q.source.trim() !== "") {
		sourceVal = evaluateExpression(rewriteSourceExpr(q.source), Object.create(null) as Record<string, unknown>);
	}
	// Spec: matchSource(source值 || null) — falsy source ⇒ null ⇒ all pages.
	// ctx carries the page list + origin path so `outgoing(...)`/`incoming(...)`
	// sources can resolve link sets (upstream resolves them against the index).
	const ctx = {allPages: snapshot.pages, currentPath: currentPath};
	return snapshot.pages.filter((p) => matchSource(sourceVal || null, p, ctx));
}

function keepRow(v: DvValue): boolean {
	return truthy(v);
}

/** Steps 2–4 for table/list: WHERE → FLATTEN → field evaluation. */
function buildRows(q: DqlQuery, pages: PageMeta[]): Row[] {
	let rows: Row[] = pages.map((page) => ({scope: buildPageScope(page), cells: []}));
	if (q.where !== undefined) {
		const whereAst = compile(q.where);
		rows = rows.filter((r) => keepRow(run(whereAst, r.scope)));
	}
	// FLATTEN in declaration order; each may multiply rows (spec step 3).
	for (const f of q.flatten) {
		const ast = compile(f);
		const next: Row[] = [];
		for (const row of rows) {
			const v = run(ast, row.scope);
			const items = toArrayOrNull(v);
			if (items === null) {
				next.push(row); // non-array → keep row as-is
			} else {
				for (const el of items) {
					next.push({scope: {...row.scope, this: el}, cells: []});
				}
			}
		}
		rows = next;
	}
	// Field evaluation once per row (step 4) — cached for render + group phases.
	const fieldAsts = (q.fields ?? []).map((f) => compile(f.expr));
	for (const row of rows) {
		row.cells = fieldAsts.map((ast) => run(ast, row.scope));
	}
	return rows;
}

/** Step 5: decorate-sort — keys evaluated once per row, stable ordering. */
function sortRows(q: DqlQuery, rows: Row[]): RowEntry[] {
	const entries: RowEntry[] = rows.map((row, idx) => ({row, keys: [], idx}));
	if (q.sort.length === 0) return entries;
	const sortAsts = q.sort.map((s) => compile(s.expr));
	for (const e of entries) e.keys = sortAsts.map((ast) => run(ast, e.row.scope));
	const dirs = q.sort.map((s) => (s.dir === "desc" ? -1 : 1));
	entries.sort((a, b) => {
		for (let k = 0; k < dirs.length; k++) {
			const c = compareValues(a.keys[k], b.keys[k]) * dirs[k]!;
			if (c !== 0) return c;
		}
		return a.idx - b.idx; // stability tiebreak
	});
	return entries;
}

/**
 * The implicit id column every TABLE query carries unless `WITHOUT ID`
 * (upstream `TABLE` shows the file link as its first column). Read from the
 * row scope so grouping/sorting cannot lose it.
 */
function fileLinkOf(e: RowEntry): DvValue {
	const file = e.row.scope["file"] as {link?: DvValue} | undefined;
	return file?.link ?? null;
}

/** Step 6: GROUP BY (table only) → group header placeholder + member rows. */
function groupTableRows(q: DqlQuery, entries: RowEntry[], includeFileId: boolean): TableRow[] {
	const cellsOf = (e: RowEntry): CellValue[] => {
		const own = e.row.cells.map((v) => toCell(v));
		return includeFileId ? [toCell(fileLinkOf(e)), ...own] : own;
	};
	if (q.groupBy === undefined) return entries.map((e) => ({cells: cellsOf(e)}));
	const keyAst = compile(q.groupBy);
	const groups = new Map<DvValue, RowEntry[]>();
	for (const e of entries) {
		const key = run(keyAst, e.row.scope);
		const slot = groups.get(key);
		if (slot) slot.push(e);
		else groups.set(key, [e]);
	}
	const out: TableRow[] = [];
	for (const [key, members] of groups) {
		out.push({group: toCell(key), cells: []}); // placeholder row (renderer colspans)
		for (const e of members) out.push({cells: cellsOf(e)});
	}
	return out;
}

/** Step 7/8 guard: cap output size so the renderer never sees huge results. */
function limitRows<T>(items: T[], maxRows: number): {items: T[]; truncated: boolean} {
	if (items.length <= maxRows) return {items, truncated: false};
	return {items: items.slice(0, maxRows), truncated: true};
}

function pushNotice(ops: RenderOp[], truncated: boolean, maxRows: number): void {
	if (truncated) ops.push({kind: "notice", level: "warn", message: `Row limit reached (${maxRows}) — truncated`});
}

function executeTable(q: DqlQuery, pages: PageMeta[], maxRows: number): RenderOp[] {
	const rows = buildRows(q, pages);
	const entries = sortRows(q, rows);
	const includeFileId = q.withoutId !== true;
	let tableRows = groupTableRows(q, entries, includeFileId);
	if (q.limit !== undefined) tableRows = tableRows.slice(0, q.limit);
	const userHeaders = (q.fields ?? []).map((f) => f.name);
	const headers = includeFileId ? ["File", ...userHeaders] : userHeaders;
	const lim = limitRows(tableRows, maxRows);
	const ops: RenderOp[] = [{kind: "table", headers, rows: lim.items}];
	pushNotice(ops, lim.truncated, maxRows);
	return ops;
}

function executeList(q: DqlQuery, pages: PageMeta[], maxRows: number): RenderOp[] {
	const rows = buildRows(q, pages);
	const entries = sortRows(q, rows);
	// LIST uses the single field (implicit `this` when none given).
	const ast = q.fields && q.fields.length > 0 ? compile(q.fields[0]!.expr) : compile("this");
	let items: CellValue[] = entries.map((e) => toCell(run(ast, e.row.scope)));
	if (q.limit !== undefined) items = items.slice(0, q.limit);
	const lim = limitRows(items, maxRows);
	const ops: RenderOp[] = [{kind: "list", items: lim.items}];
	pushNotice(ops, lim.truncated, maxRows);
	return ops;
}

/**
 * TASKS mode: WHERE runs against a per-task scope {text,status,path,line,tags,this}.
 * A failing parent drops its whole subtree (approximation vs Obsidian — noted
 * in the differences list). FLATTEN/SORT/GROUP BY are ignored for tasks.
 */
function executeTasks(q: DqlQuery, pages: PageMeta[], maxRows: number): RenderOp[] {
	const whereAst = q.where !== undefined ? compile(q.where) : null;
	const out: TaskNode[] = [];
	/**
	 * WHERE runs against the item NODE, so every upstream field is in scope:
	 * `!completed`, `due`, `annotated`, `childCount`-style idioms all work.
	 * Filtering happens on a shallow copy whose children were already filtered —
	 * a failing parent drops its whole subtree (upstream behaviour).
	 */
	const filterTree = (list: TaskMeta[], path: string): TaskNode[] => {
		const kept: TaskNode[] = [];
		for (const t of list) {
			const children = filterTree(t.children as TaskMeta[], path);
			const node = buildListItem({...t, children: t.children} as TaskMeta, path);
			node.children = children;
			node.subtasks = children;
			if (whereAst !== null) {
				const scope: Record<string, unknown> = {...node, this: node};
				if (!truthy(run(whereAst, scope))) continue; // parent fails → subtree dropped
			}
			kept.push(node);
		}
		return kept;
	};
	for (const page of pages) {
		for (const t of filterTree(page.tasks, page.path)) out.push(t);
	}
	let tasks = out;
	if (q.limit !== undefined) tasks = tasks.slice(0, q.limit);
	const lim = limitRows(tasks, maxRows);
	const ops: RenderOp[] = [{kind: "taskList", tasks: lim.items}];
	pushNotice(ops, lim.truncated, maxRows);
	return ops;
}

/**
 * CALENDAR: one entry per page whose field evaluates to a date, sorted by date.
 * Rendered as a month-grouped list (see render/html.ts renderCalendar) — the
 * interactive month grid is an Obsidian UI feature we do not port (documented).
 */
function executeCalendar(q: DqlQuery, pages: PageMeta[], maxRows: number): RenderOp[] {
	const ast = q.fields && q.fields.length > 0 ? compile(q.fields[0]!.expr) : compile("file.mtime");
	const entries: Array<{date: string; link: Link; value?: CellValue}> = [];
	for (const page of pages) {
		const scope = buildPageScope(page);
		const value = run(ast, scope);
		const date = value instanceof Date ? {toISO: () => value.toISOString()} : (value as {toISO?: () => string} | null);
		if (date === null || date === undefined || typeof date.toISO !== "function") continue;
		entries.push({date: date.toISO(), link: createLink({path: page.path, embed: false})});
	}
	entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
	const lim = limitRows(entries, maxRows);
	const ops: RenderOp[] = [{kind: "calendar", entries: lim.items}];
	pushNotice(ops, lim.truncated, maxRows);
	return ops;
}

export function executeDql(q: DqlQuery, snapshot: IndexSnapshot, opts?: {maxRows?: number; currentPath?: string}): RenderOp[] {
	const maxRows = opts?.maxRows ?? DEFAULT_MAX_ROWS;
	currentPath = opts?.currentPath ?? "";
	const pages = selectPages(q, snapshot);
	if (q.type === "table") return executeTable(q, pages, maxRows);
	if (q.type === "list") return executeList(q, pages, maxRows);
	if (q.type === "calendar") return executeCalendar(q, pages, maxRows);
	return executeTasks(q, pages, maxRows);
}

// ExpressionError re-exported for callers that execute expressions directly.
export {ExpressionError};
