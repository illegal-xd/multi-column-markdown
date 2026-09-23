/**
 * Golden value conversion helpers — the single place that knows how to move
 * data between the three representations:
 *   JsonValue (index) ⇄ DvValue (runtime) ⇄ CellValue (render protocol)
 *
 * All conversions are pure and JSON-clone safe on the CellValue side.
 */
import type {
	CellValue,
	DataArray,
	DvDate,
	DvValue,
	Duration,
	JsonValue,
	Link,
	ListItemMeta,
	ListItemNode,
	TaggedValue,
	TaskMeta,
	TaskNode,
} from "./types";
import {createDuration, parseDate, parseDuration} from "./query/datetime";
import {createLink, linkFromMeta} from "./link";

export function isTagged(v: unknown): v is TaggedValue {
	return typeof v === "object" && v !== null && "__dv" in (v as Record<string, unknown>);
}

export function isLink(v: unknown): v is Link {
	return (
		typeof v === "object" &&
		v !== null &&
		"path" in (v as Record<string, unknown>) &&
		typeof (v as {path: unknown}).path === "string" &&
		"embed" in (v as Record<string, unknown>)
	);
}

export function isDuration(v: unknown): v is Duration {
	return typeof v === "object" && v !== null && "ms" in (v as Record<string, unknown>) && typeof (v as {ms: unknown}).ms === "number";
}

export function isDvDate(v: unknown): v is DvDate {
	return (
		typeof v === "object" &&
		v !== null &&
		"toFormat" in (v as Record<string, unknown>) &&
		"toISO" in (v as Record<string, unknown>) &&
		"year" in (v as Record<string, unknown>)
	);
}

/** Duck-type check for DataArray (avoids importing the implementation). */
export function isDataArray(v: unknown): v is DataArray<never> {
	return (
		typeof v === "object" &&
		v !== null &&
		typeof (v as {array?: unknown}).array === "function" &&
		typeof (v as {length?: unknown}).length === "number" &&
		typeof (v as {flatten?: unknown}).flatten === "function"
	);
}

/** JsonValue → runtime DvValue (expands tagged date/dur/link). */
export function fromJsonValue(v: JsonValue): DvValue {
	if (v === null || typeof v === "boolean" || typeof v === "number" || typeof v === "string") return v;
	if (Array.isArray(v)) return v.map(fromJsonValue);
	if (isTagged(v)) {
		if (v.__dv === "date") return parseDate(v.iso);
		// Factories (not literals): Duration/Link method surfaces must exist on values
		// that came from the index, exactly as on freshly parsed ones.
		if (v.__dv === "dur") return createDuration(v.ms);
		return createLink(v.link);
	}
	const out: Record<string, DvValue> = {};
	for (const [k, val] of Object.entries(v)) out[k] = fromJsonValue(val);
	return out;
}

/** Runtime DvValue → JsonValue (dates become tagged; functions dropped → null). */
export function toJsonValue(v: DvValue): JsonValue {
	if (v === null || v === undefined) return null;
	if (typeof v === "boolean" || typeof v === "number" || typeof v === "string") return v;
	if (v instanceof Date) return {__dv: "date", iso: v.toISOString()};
	if (Array.isArray(v)) return v.map(toJsonValue);
	if (isDvDate(v)) return {__dv: "date", iso: v.toISO()};
	if (isDuration(v)) return {__dv: "dur", ms: v.ms};
	if (isLink(v)) return {__dv: "link", link: v};
	if (isDataArray(v)) return v.array().map((x) => toJsonValue(x as DvValue));
	if (typeof v === "function") return null;
	const out: Record<string, JsonValue> = {};
	for (const [k, val] of Object.entries(v as Record<string, DvValue>)) {
		// `file` on a page object is not JSON round-trippable — skip (page rebuild covers it).
		if (k === "file") continue;
		out[k] = toJsonValue(val);
	}
	return out;
}

/**
 * Runtime DvValue → serializable CellValue for the render protocol.
 * Perf: single pass, no intermediate clones; nested arrays capped by caller
 * via render options (deep pathological inputs hit MAX_CELL_DEPTH).
 */
const MAX_CELL_DEPTH = 16;

export function toCell(v: DvValue, depth = 0): CellValue {
	if (v === null || v === undefined) return {t: "null"};
	if (typeof v === "function") return {t: "str", v: "<function>"};
	if (typeof v === "boolean") return {t: "bool", v};
	if (typeof v === "number") return Number.isFinite(v) ? {t: "num", v} : {t: "str", v: String(v)};
	if (typeof v === "string") return {t: "str", v};
	if (v instanceof Date) return {t: "date", iso: v.toISOString()};
	if (isDvDate(v)) return {t: "date", iso: v.toISO()};
	if (isDuration(v)) return {t: "dur", ms: v.ms};
	if (isLink(v)) return {t: "link", link: v};
	if (depth >= MAX_CELL_DEPTH) return {t: "str", v: "…"};
	if (Array.isArray(v)) {
		if (isDataArray(v)) return {t: "arr", v: v.array().map((x) => toCell(x as DvValue, depth + 1))};
		return {t: "arr", v: v.map((x) => toCell(x, depth + 1))};
	}
	if (isDataArray(v)) return {t: "arr", v: v.array().map((x) => toCell(x as DvValue, depth + 1))};
	// Plain object / page object: store fields without the heavy `file` payload.
	const src = v as Record<string, DvValue>;
	const out: Record<string, CellValue> = {};
	for (const [k, val] of Object.entries(src)) {
		if (k === "file") continue;
		out[k] = toCell(val, depth + 1);
	}
	return {t: "obj", v: out};
}

/** CellValue → plain text (console/log/error messages, benchmarks). */
export function cellToText(c: CellValue): string {
	switch (c.t) {
		case "null":
			return "";
		case "bool":
			return String(c.v);
		case "num":
			return String(c.v);
		case "str":
			return c.v;
		case "date":
			return c.iso;
		case "dur":
			return formatDurationMs(c.ms);
		case "link":
			return c.link.display ?? c.link.path;
		case "arr":
			return "[" + c.v.map(cellToText).join(", ") + "]";
		case "obj":
			return "{" + Object.entries(c.v).map(([k, x]) => `${k}: ${cellToText(x)}`).join(", ") + "}";
		case "html":
		case "md":
			return c.v;
	}
}

/** Compact duration formatting ("1d 2h", "30m") — display only. */
export function formatDurationMs(ms: number): string {
	const sign = ms < 0 ? "-" : "";
	let rest = Math.abs(Math.round(ms));
	if (rest < 1000) return `${sign}${rest}ms`;
	const parts: string[] = [];
	const units: Array<[string, number]> = [
		["w", 7 * 24 * 3600e3],
		["d", 24 * 3600e3],
		["h", 3600e3],
		["m", 60e3],
		["s", 1e3],
	];
	for (const [suffix, size] of units) {
		if (rest >= size) {
			const n = Math.floor(rest / size);
			parts.push(`${n}${suffix}`);
			rest -= n * size;
		}
		if (parts.length === 2) break;
	}
	return sign + parts.join(" ");
}

/**
 * Keys that the node's own shape owns — annotation spread must not shadow them
 * (an annotation literally named `children` would otherwise break rendering).
 */
const RESERVED_ITEM_KEYS = new Set([
	"task", "text", "visual", "status", "checked", "completed", "fullyCompleted",
	"annotated", "symbol", "path", "line", "lineCount", "list", "parent", "blockId",
	"link", "section", "tags", "outlinks", "children", "subtasks", "real", "header", "fields",
]);

/**
 * Index list item (task OR plain entry) → runtime ListItemNode.
 * Shared by DQL TASKS, dv.taskList and `page.file.tasks/lists`, so all three see
 * identical objects — upstream builds one SListItem shape for every consumer.
 *
 * Inline fields are BOTH kept under `fields` and spread onto the node, which is
 * what makes the canonical idioms work: `t => t.due`, `t => !t.completed`,
 * `TASKS WHERE due`.
 */
export function buildListItem(node: ListItemMeta, path: string): ListItemNode {
	// Defensive defaults: the index always fills these, but DQL/dv fixtures and
	// older PageMeta values build items by hand (children/tags/outlinks/fields).
	const children = (node.children ?? []).map((c) => buildListItem(c, path));
	// Tolerate hand-built items (fixtures, older PageMeta): without the `task`
	// discriminator, an item carrying a string `status` IS a task.
	const isTask = node.task ?? typeof (node as {status?: unknown}).status === "string";
	const status = isTask ? ((node as TaskMeta).status ?? "") : "";
	const completed = isTask && status.toLowerCase() === "x";
	const checked = isTask ? ((node as TaskMeta).checked ?? status !== "") : false;
	// Upstream: a task is fully completed when it AND every descendant is done.
	const fullyCompleted = completed && children.every((c) => c.fullyCompleted);
	const sectionLink = createLink({path, subpath: node.section?.subpath, embed: false});
	// Block-targeted links point at the item itself; otherwise at its section.
	const link = node.blockId !== undefined ? createLink({path, subpath: `#^${node.blockId}`, embed: false}) : sectionLink;

	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(node.fields ?? {})) {
		if (RESERVED_ITEM_KEYS.has(k)) continue;
		out[k] = fromJsonValue(v);
	}
	Object.assign(out, {
		task: isTask,
		text: node.text,
		visual: node.visual ?? node.text,
		status,
		checked,
		completed,
		fullyCompleted,
		annotated: node.annotated ?? Object.keys(node.fields ?? {}).length > 0,
		symbol: node.symbol ?? "-",
		path,
		line: node.line,
		lineCount: node.lineCount ?? 1,
		list: node.list ?? node.line,
		link,
		section: sectionLink,
		tags: (node.tags ?? []).slice(),
		outlinks: (node.outlinks ?? []).map(linkFromMeta),
		children,
		// Deprecated upstream aliases share the children array (same objects).
		subtasks: children,
		real: isTask,
		header: sectionLink,
		fields: node.fields ?? {},
	} satisfies Partial<ListItemNode>);
	if (node.parent !== undefined) out["parent"] = node.parent;
	if (node.blockId !== undefined) out["blockId"] = node.blockId;
	return out as ListItemNode;
}

/** Back-compat name for the task-only entry point. */
export function taskMetaToNode(t: TaskMeta, path: string): TaskNode {
	return buildListItem(t, path);
}

/** Flatten a task forest (Dataview taskList with grouping helpers). */
export function flattenTasks(nodes: TaskNode[]): TaskNode[] {
	const out: TaskNode[] = [];
	const walk = (list: TaskNode[]): void => {
		for (const n of list) {
			out.push(n);
			walk(n.children);
		}
	};
	walk(nodes);
	return out;
}
export function coerceStringField(s: string): JsonValue {
	const trimmed = s.trim();
	const linkMatch = /^(!?)\[\[([^\]|#]+)(#[^\]|]+)?(?:\|([^\]]+))?\]\]$/.exec(trimmed);
	if (linkMatch) {
		return {
			__dv: "link",
			link: {
				path: linkMatch[2]!.trim(),
				subpath: linkMatch[3],
				display: linkMatch[4]?.trim(),
				embed: linkMatch[1] === "!",
			},
		};
	}
	// Full ISO date or date-only — tagged so pages expose real date values.
	if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(trimmed)) {
		const parsed = parseDate(trimmed);
		if (parsed) return {__dv: "date", iso: parsed.toISO()};
	}
	const durParsed = parseDuration(trimmed);
	if (durParsed && /\d\s*(ms|s|m|h|d|w|month|year)/i.test(trimmed) && /\d/.test(trimmed) && trimmed.length <= 32) {
		// Only tag obvious duration shapes like "2h", "1d 30m" — avoid eating plain words.
		if (/^[\d.\s]+(ms|s|m|h|d|w|weeks?|days?|hours?|minutes?|seconds?|months?|years?)([\s\d]+[a-z]+)*$/i.test(trimmed)) {
			return {__dv: "dur", ms: durParsed.ms};
		}
	}
	return s;
}


