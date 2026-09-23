/**
 * Dataview markdown exports — the equivalent of upstream `ui/export/markdown.ts`.
 * Pure module: no vscode, no DOM. Backs `dv.markdownTable` / `dv.markdownList` /
 * `dv.markdownTaskList` and any "copy as markdown" path.
 *
 * Documented deviations from upstream:
 *  - `markdownTable` emits unpadded GFM rows (`| a | b |`) and inline `a, b` /
 *    `k: v` text; upstream pads each column to its widest cell and wraps
 *    array/object cells in `<ul><li>` HTML (its `allowHtml` default is true).
 *  - durations reuse the compact `formatDurationMs` ("1h 30m") used by the HTML
 *    renderer; upstream `renderMinimalDuration` prints "1 hour 30 minutes".
 *  - dates are formatted from UTC components (deterministic in tests); upstream
 *    formats in the local timezone.
 *  - task groups (`Groupings`) are not handled — only plain task trees.
 */
import type {DvValue, Link, TaskNode} from "../types";
import {formatDurationMs, isDvDate, isDuration, isLink} from "../values";

/** Options shared by the three exporters (upstream takes full QuerySettings). */
export interface MarkdownExportOptions {
	/** null/undefined → this text; default "-". */
	renderNullAs?: string;
}

const DEFAULT_RENDER_NULL_AS = "-";
/** Upstream `markdownTaskList` indents nested tasks with 4 spaces. */
const TASK_INDENT = "    ";
/** `markdownList` nests with 2 spaces (upstream uses 4 — see module note). */
const LIST_INDENT = "  ";

/** Array or DataArray → plain array; undefined for anything else. */
function asArray(v: DvValue): DvValue[] | undefined {
	if (Array.isArray(v)) return v;
	if (v !== null && typeof v === "object") {
		const maybe = v as {array?: unknown; length?: unknown};
		if (typeof maybe.array === "function" && typeof maybe.length === "number") {
			return (maybe.array as () => DvValue[])();
		}
	}
	return undefined;
}

/** Plain data object (excludes links, dates, durations and arrays). */
function isPlainObject(v: DvValue): v is {[k: string]: DvValue} {
	if (v === null || typeof v !== "object") return false;
	if (Array.isArray(v) || v instanceof Date) return false;
	return !isDvDate(v) && !isDuration(v) && !isLink(v);
}

/** `yyyy-MM-dd`, plus `HH:mm` when the ISO value carries a non-midnight time. */
function markdownDate(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	const pad = (n: number): string => (n < 10 ? "0" + n : String(n));
	const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
	const midnight =
		d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
	return midnight ? date : `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** `[[path#sub|display]]`; falls back to the plain-literal form for legacy links. */
function markdownLink(link: Link): string {
	if (typeof link.markdown === "function") return link.markdown();
	const sub = link.subpath ?? "";
	const body = `${link.path}${sub}`;
	return link.display !== undefined && link.display !== "" ? `[[${body}|${link.display}]]` : `[[${body}]]`;
}

/** One value → one line of markdown text (arrays/objects stay inline). */
function markdownValue(v: DvValue, opts?: MarkdownExportOptions): string {
	if (v === null || v === undefined) return opts?.renderNullAs ?? DEFAULT_RENDER_NULL_AS;
	if (typeof v === "string") return v;
	if (typeof v === "boolean" || typeof v === "number") return String(v);
	if (typeof v === "function") return "<function>";
	if (v instanceof Date) return markdownDate(v.toISOString());
	if (isDvDate(v)) return markdownDate(v.toISO());
	if (isDuration(v)) return formatDurationMs(v.ms);
	if (isLink(v)) return markdownLink(v);
	const arr = asArray(v);
	if (arr !== undefined) return arr.map((x) => markdownValue(x, opts)).join(", ");
	if (isPlainObject(v)) {
		return Object.entries(v)
			.map(([k, x]) => `${k}: ${markdownValue(x, opts)}`)
			.join(", ");
	}
	return String(v);
}

/** Escape `|` so a cell cannot split its row (upstream `escapeTable`). */
function escapeTable(text: string): string {
	return text.split(/(?!\\)\|/i).join("\\|");
}

/** Literal matrix → GFM table (`| h |` / `| --- |` / rows). */
export function markdownTable(
	headers: string[],
	values: DvValue[][],
	opts?: MarkdownExportOptions,
): string {
	let out = `| ${headers.map(escapeTable).join(" | ")} |\n`;
	out += `| ${headers.map(() => "---").join(" | ")} |\n`;
	for (const row of values) {
		out += `| ${row.map((v) => escapeTable(markdownValue(v, opts))).join(" | ")} |\n`;
	}
	return out;
}

/** One bullet for a single scalar element at `depth`. */
function markdownLine(value: DvValue, depth: number, opts?: MarkdownExportOptions): string {
	return LIST_INDENT.repeat(depth) + "- " + markdownValue(value, opts) + "\n";
}

/** Bullets for one entry of a list at `depth`; nested containers recurse. */
function markdownItem(value: DvValue, depth: number, opts?: MarkdownExportOptions): string {
	const arr = asArray(value);
	// A nested array is a sub-list one level in; an object spreads its keys at this level.
	if (arr !== undefined) return markdownBlock(arr, depth + 1, opts);
	if (isPlainObject(value)) return markdownBlock(value, depth, opts);
	return markdownLine(value, depth, opts);
}

/** Render an array/object as bullets starting at `depth`. */
function markdownBlock(value: DvValue, depth: number, opts?: MarkdownExportOptions): string {
	const indent = LIST_INDENT.repeat(depth);
	const arr = asArray(value);
	if (arr !== undefined) {
		if (arr.length === 0) return `${indent}- \n`;
		return arr.map((v) => markdownItem(v, depth, opts)).join("");
	}
	if (isPlainObject(value)) {
		const entries = Object.entries(value);
		if (entries.length === 0) return `${indent}- \n`;
		return entries
			.map(([k, v]) =>
				asArray(v) !== undefined || isPlainObject(v)
					? `${indent}- ${k}:\n${markdownBlock(v, depth + 1, opts)}`
					: `${indent}- ${k}: ${markdownValue(v, opts)}\n`,
			)
			.join("");
	}
	return markdownLine(value, depth, opts);
}

/** Values → `- value` lines; arrays nest as `  - ` indented sub-lists. */
export function markdownList(values: DvValue[], opts?: MarkdownExportOptions): string {
	const items = asArray(values) ?? [values];
	return items.map((v) => markdownItem(v, 0, opts)).join("");
}

function asTaskArray(input: TaskNode[] | TaskNode): TaskNode[] {
	if (Array.isArray(input)) return input;
	if (input === null || typeof input !== "object") return [];
	return [input];
}

/** `visual ?? text` with newlines folded (upstream `(visual ?? text).split("\n").join(" ")`). */
function taskText(t: TaskNode): string {
	const raw = typeof t.visual === "string" && t.visual !== "" ? t.visual : typeof t.text === "string" ? t.text : "";
	return raw.split("\n").join(" ");
}

function taskLines(input: TaskNode[] | TaskNode, depth: number): string {
	let out = "";
	for (const t of asTaskArray(input)) {
		const prefix = t.task === false ? "" : `[${typeof t.status === "string" && t.status !== "" ? t.status : " "}] `;
		out += TASK_INDENT.repeat(depth) + "- " + prefix + taskText(t) + "\n";
		// `children` is canonical; legacy `subtasks` is the fallback.
		const kids = Array.isArray(t.children) ? t.children : Array.isArray(t.subtasks) ? t.subtasks : [];
		if (kids.length > 0) out += taskLines(kids, depth + 1);
	}
	return out;
}

/**
 * Task tree → `- [x] text` / `- [ ] text` lines, nested tasks indented 4 spaces.
 * `_opts` is accepted for signature parity with the other exporters: task text is
 * plain markdown, so there is no null cell to render.
 */
export function markdownTaskList(tasks: TaskNode[] | TaskNode, _opts?: MarkdownExportOptions): string {
	return taskLines(tasks, 0);
}
