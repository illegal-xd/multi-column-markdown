/**
 * parsePageFile — pure PageMeta construction from raw file content.
 *
 * Semantics (Obsidian Dataview-aligned where noted; gaps listed in
 * docs/dataview/README.md): frontmatter YAML subset via ./yaml.ts, absolute
 * 0-based line numbers (line 0 = first file line), inline fields (3 wrapper
 * shapes), tags/etags, ATX headings/sections, nested TASKS **and** nested LIST
 * ITEMS (upstream `file.lists` holds both), wiki/markdown outlinks.
 * Never throws — bad frontmatter degrades to {} with full body.
 * Text helpers live in ./text.ts.
 *
 * List-item model (upstream data-model/serialized/markdown.ts):
 *   every `- foo` / `- [ ] foo` line becomes ONE node carrying `task: boolean`;
 *   nesting is by indentation, children may mix tasks and plain entries, and
 *   `lineCount`/`parent`/`list`/`blockId`/`section`/`outlinks` are filled the
 *   way upstream fills SListItemBase. Tasks additionally carry status/checked.
 */
import type {
	HeadingMeta,
	JsonValue,
	LinkMeta,
	ListItemBaseMeta,
	ListItemMeta,
	ListMeta,
	PageMeta,
	SectionMeta,
	TaskMeta,
} from "../types";
import {
	coerceJson,
	expandEtags,
	extractBodyTags,
	extractInlineFields,
	extractLinks,
	isPlainObject,
	normalizeAliases,
	normalizeFmTags,
	pathMeta,
	stripInlineCode,
} from "./text";
import {parseYamlValue} from "./yaml";

const TASK_RE = /^(\s*)([-*+])\s+\[([^\[\]]*)\](?:\s+(.*))?$/;
const LIST_RE = /^(\s*)([-*+])\s+(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*$/;
const FENCE_RE = /^\s*(`{3,}|~{3,})\s*(.*)$/;
/** Trailing `^block-id` (Obsidian block reference). */
const BLOCK_ID_RE = /\s+\^([A-Za-z0-9-]+)\s*$/;

/**
 * Frontmatter = first-line `---` to next `---`. Parse failure or non-map YAML
 * → raw=null (caller stores {}); body always starts after a closed block.
 */
function splitFrontmatter(lines: string[]): {raw: Record<string, JsonValue> | null; bodyStart: number} {
	if (lines.length >= 2 && /^---\s*$/.test(lines[0])) {
		for (let j = 1; j < lines.length; j++) {
			if (/^---\s*$/.test(lines[j])) {
				const res = parseYamlValue(lines.slice(1, j).join("\n"));
				const bodyStart = j + 1;
				if (!res.error && isPlainObject(res.value)) return {raw: res.value, bodyStart};
				return {raw: null, bodyStart};
			}
		}
	}
	return {raw: null, bodyStart: 0};
}

/** Strip a trailing block id from item text; returns [text, blockId?]. */
function splitBlockId(text: string): [string, string | undefined] {
	const m = BLOCK_ID_RE.exec(text);
	if (!m) return [text, undefined];
	return [text.slice(0, m.index).trimEnd(), m[1]];
}

/** Freeze a node's span: how many source lines it covers (upstream lineCount). */
function finalizeSpan(node: InProgressItem, endLine: number): void {
	node.lineCount = Math.max(1, endLine - node.line);
}

interface InProgressItem extends ListItemBaseMeta {
	children: ListItemMeta[];
	/** Task-only, filled for tasks. */
	status?: string;
	checked?: boolean;
}

function toTaskItem(node: InProgressItem): TaskMeta {
	const status = node.status ?? "";
	return {...(node as TaskMeta), task: true, status, checked: status !== ""};
}

function toPlainItem(node: InProgressItem): ListMeta {
	return {...(node as ListMeta), task: false};
}

/** Pure, exception-free page parser. `ctime` is unavailable → equals mtime. */
export function parsePageFile(path: string, content: string, mtime: number, size: number): PageMeta {
	const lines = content.split(/\r?\n/);
	const {raw, bodyStart} = splitFrontmatter(lines);

	let frontmatter: Record<string, JsonValue> = {};
	let fmTags: string[] = [];
	let aliases: string[] = [];
	if (raw) {
		frontmatter = coerceJson(raw) as Record<string, JsonValue>;
		fmTags = normalizeFmTags(raw["tags"]);
		aliases = normalizeAliases(raw["aliases"]);
	}

	const inlineFields: Record<string, JsonValue> = {};
	const headings: HeadingMeta[] = [];
	const lists: ListMeta[] = [];
	/** Every list-item root (tasks + plain) in document order — upstream file.lists. */
	const listItems: ListItemMeta[] = [];
	const rootTasks: TaskMeta[] = [];
	const outlinks: LinkMeta[] = [];
	const bodyTags: string[] = [];
	const seenTags = new Set<string>();
	const addTags = (found: string[]): void => {
		for (const t of found) {
			if (!seenTags.has(t)) {
				seenTags.add(t);
				bodyTags.push(t);
			}
		}
	};

	// Open (unfinalised) items, innermost last. Both kinds share this stack so a
	// task can nest under a plain list item and vice versa (upstream behaviour).
	const openItems: InProgressItem[] = [];
	let currentHeading: HeadingMeta | null = null;

	const finalizeThrough = (indent: number, line: number): void => {
		while (openItems.length > 0 && openItems[openItems.length - 1]!.indent >= indent) {
			finalizeSpan(openItems.pop()!, line);
		}
	};

	let inFence = false;
	let fenceChar = "";
	let fenceLen = 0;

	for (let i = bodyStart; i < lines.length; i++) {
		const line = lines[i];
		const fence = FENCE_RE.exec(line);
		if (fence) {
			const marker = fence[1];
			if (!inFence) {
				inFence = true;
				fenceChar = marker[0];
				fenceLen = marker.length;
				continue;
			}
			if (marker[0] === fenceChar && marker.length >= fenceLen && fence[2].trim() === "") {
				inFence = false;
				continue;
			}
		}
		if (inFence) continue;

		const cleaned = stripInlineCode(line);

		// ATX heading — requires space after `#`, so `#tag` never matches.
		const h = HEADING_RE.exec(line);
		if (h) {
			const heading: HeadingMeta = {level: h[1].length, text: h[2].replace(/\s+#+$/, ""), line: i};
			headings.push(heading);
			currentHeading = heading;
		}

		const task = TASK_RE.exec(cleaned);
		const list = task ? null : LIST_RE.exec(cleaned);
		if (task || list) {
			const indent = (task ? task[1] : list![1]).length;
			const symbol = task ? task[2] : list![2];
			const isTask = task !== null;
			const rawStatus = isTask ? (task![3] ?? "").trim() : "";
			const status = rawStatus === "" ? "" : rawStatus === "x" || rawStatus === "X" ? "x" : rawStatus;
			const bodyRaw = (isTask ? task![4] ?? "" : list![3]).trimEnd();
			const [text, blockId] = splitBlockId(bodyRaw);

			finalizeThrough(indent, i);

			const node: InProgressItem = {
				symbol,
				task: isTask,
				text,
				// Upstream `visual` is a display override and never contains the
				// checkbox — task views prepend the status themselves.
				visual: text,
				annotated: false,
				line: i,
				lineCount: 1,
				indent,
				list: i,
				tags: [],
				fields: {},
				outlinks: [],
				children: [],
			};
			if (blockId !== undefined) node.blockId = blockId;
			if (isTask) {
				node.status = status;
				node.checked = status !== "";
			}
			if (currentHeading) {
				node.section = {
					path,
					subpath: "#" + currentHeading.text,
					embed: false,
					line: currentHeading.line,
				};
			}
			node.tags = extractBodyTags(text);
			extractInlineFields(text, node.fields);
			node.annotated = Object.keys(node.fields).length > 0;
			extractLinks(text, i, node.outlinks);

			const parent = openItems[openItems.length - 1];
			if (parent) {
				node.parent = parent.line;
				node.list = parent.list;
				parent.children.push(isTask ? toTaskItem(node) : toPlainItem(node));
			} else if (isTask) {
				const item = toTaskItem(node);
				rootTasks.push(item);
				listItems.push(item);
			} else {
				const item = toPlainItem(node);
				lists.push(item);
				listItems.push(item);
			}
			openItems.push(node);
		} else if (cleaned.trim() !== "") {
			// Non-list content ends any list whose items cannot contain it.
			// (Tasks may legally span continuation lines; a plain paragraph after
			// a blank line does not continue the item, so we close on blank only.)
		} else {
			// Blank line: closes all open items (their spans already counted).
			finalizeThrough(0, i);
		}

		// Page-level scan runs for every non-fence line (inline wins over frontmatter later).
		extractInlineFields(cleaned, inlineFields);
		addTags(extractBodyTags(cleaned));
		extractLinks(cleaned, i, outlinks);
	}
	finalizeThrough(0, lines.length);

	const sections: SectionMeta[] = headings.map((heading, idx) => ({
		heading,
		range: [heading.line, idx + 1 < headings.length ? headings[idx + 1].line : lines.length],
	}));

	const tags: string[] = [];
	const seenAll = new Set<string>();
	for (const t of [...fmTags, ...bodyTags]) {
		if (!seenAll.has(t)) {
			seenAll.add(t);
			tags.push(t);
		}
	}

	const {name, folder, ext} = pathMeta(path);
	return {
		path,
		name,
		folder,
		ext,
		ctime: mtime, // no birth-time in the pure parse input — documented gap
		mtime,
		size,
		frontmatter,
		inlineFields,
		fields: {...frontmatter, ...inlineFields},
		tags,
		etags: expandEtags(tags),
		aliases,
		headings,
		sections,
		lists,
		listItems,
		tasks: rootTasks,
		inlinks: [], // pure parse cannot know other pages — store fills via cascade
		outlinks,
	};
}
