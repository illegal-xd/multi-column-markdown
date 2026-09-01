/**
 * markdown-it plugin — renders column markers in the built-in Markdown
 * preview (the VSCode equivalent of the reference plugin's Reading View).
 *
 * Loaded by VSCode's markdown preview extension via the
 * `contributes.markdownMarkdownItPlugins` declaration. The module runs in
 * the markdown extension host, so it can (best-effort) read the
 * `enableReadingView` setting; if `require("vscode")` is unavailable it
 * falls back to always-enabled.
 *
 * Implementation: a **block ruler** (before `paragraph`) matches the
 * `%% col-start %%` line, scans forward for the matching `%% col-end %%`
 * (supporting nesting) and consumes the whole line range as a single
 * `amc_columns` token carrying the raw source. Rendering re-parses the
 * region with the shared `findColumnRegions` and recursively renders each
 * column with the same markdown-it instance — identical parsing semantics
 * to the reference implementation.
 */
import MarkdownIt from "markdown-it";
import {findColumnRegions} from "../core/parser";
import type {ColumnData, ColumnRegion} from "../types";
import {applyColumnStyleVars, applyContainerStyleVars, resolveColor} from "./styleVars";
import type {ColumnStyleData} from "../types";

/** Default container gap in px (used for flex-basis shrink compensation). */
const DEFAULT_GAP_PX = 5;

/**
 * Gap in px for the flex-basis shrink compensation. Only px values (bare
 * numbers or `px` unit) translate exactly; other CSS lengths (em/%) fall
 * back to the default so the layout stays consistent with the CSS gap.
 */
function gapPx(style: ColumnStyleData | undefined): number {
	const raw = style?.gap;
	if (!raw) return DEFAULT_GAP_PX;
	const m = /^\d+(\.\d+)?(px)?$/i.exec(raw.trim());
	return m ? parseFloat(m[0]) : DEFAULT_GAP_PX;
}

/**
 * Width in px of a group-to-group separator element. Must stay in sync with
 * `buildSeparatorHtml`: custom separators size via `--sep-size`, visual
 * separators are a fixed 8px element (`.column-separator-visual`).
 */
function separatorWidthPx(style: ColumnStyleData | undefined): number {
	if (!style?.separator) return 0;
	if (style.separatorStyle === "custom") {
		return style.separatorWidth ? style.separatorWidth * 6 + 6 : 12;
	}
	return 8;
}

/**
 * Per-column flex-basis shrink (px) so columns + separators + gaps sum to
 * the container width. Each group-to-group separator contributes its own
 * width plus an extra gap (it adds one more flex item between columns):
 *   shrink = (S*(w + gap) + (N-1)*gap) / N
 * where N = column groups, S = separators between groups, w = sep width.
 */
function shrinkPx(region: ColumnRegion, gap: number): number {
	const groups = groupColumns(region.columns);
	let extra = (groups.length - 1) * gap;
	for (let i = 1; i < groups.length; i++) {
		const prevCol = region.columns[groups[i - 1]!.indices[groups[i - 1]!.indices.length - 1]!]!;
		if (prevCol.style?.separator) {
			extra += separatorWidthPx(prevCol.style) + gap;
		}
	}
	return groups.length > 0 ? extra / groups.length : 0;
}

const START_RE = /^%%\s*col-start(?:\s*:.*)?\s*%%$/;
const END_RE = /^%%\s*col-end\s*%%$/;

interface BlockState {
	src: string;
	bMarks: number[];
	eMarks: number[];
	blkIndent: number;
	line: number;
	pending: unknown;
	level: number;
	push(type: string, tag: string, nesting: number): {content: string; map: [number, number]; level: number};
	getLines(begin: number, end: number, indent: number, keepLastLF: boolean): string;
}

interface ColumnsMd {
	block: {
		ruler: {
			before(
				anchorName: string,
				ruleName: string,
				rule: (state: BlockState, startLine: number, endLine: number, silent: boolean) => boolean,
			): void;
		};
	};
	renderer: {rules: Record<string, (tokens: Array<{content: string}>, idx: number, options: unknown, env: unknown, self: unknown) => string>};
	render(src: string, env?: unknown): string;
}

export function installColumnsMarkdownItPlugin(md: MarkdownIt): void {
	const m = md as unknown as ColumnsMd;

	m.block.ruler.before("paragraph", "amc_columns", (state, startLine, endLine, silent) => {
		const lineText = state.src.slice(state.bMarks[startLine]!, state.eMarks[startLine]!).trim();
		if (!START_RE.test(lineText)) return false;
		if (silent) return false;

		// Find the matching col-end, supporting nesting.
		let depth = 1;
		let nextLine = startLine + 1;
		for (; nextLine < endLine; nextLine++) {
			const l = state.src.slice(state.bMarks[nextLine]!, state.eMarks[nextLine]!).trim();
			if (START_RE.test(l)) {
				depth++;
			} else if (END_RE.test(l)) {
				depth--;
				if (depth === 0) break;
			}
		}
		if (nextLine >= endLine) return false; // unclosed — leave as plain text

		const raw = state.getLines(startLine, nextLine + 1, state.blkIndent, false);
		const token = state.push("amc_columns", "", 0);
		token.content = raw;
		token.map = [startLine, nextLine];
		state.line = nextLine + 1;
		return true;
	});

	m.renderer.rules["amc_columns"] = (tokens, idx, _options, env) => {
		const depth = (env as {amcDepth?: number} | undefined)?.amcDepth ?? 0;
		return renderColumnsHtml(tokens[idx]!.content, md, env, depth);
	};

	installWikilinkInline(md);
	installTaskLists(md);
}

/**
 * GFM task list rendering (`- [ ]` / `- [x]`) → checkbox input + label.
 *
 * VSCode's built-in markdown preview no longer renders task lists on the
 * supported versions (verified: `- [ ]` stays as literal text), so the
 * plugin renders them itself. Logic ported from markdown-it-task-lists
 * (MIT, https://github.com/revin/markdown-it-task-lists) with the same
 * output shape VSCode used: `<li class="task-list-item">` containing
 * `<input class="task-list-item-checkbox" disabled>` and a
 * `<label class="task-list-item-label">`.
 *
 * Idempotent: if the host already rendered a task list (no `[ ]` text
 * remains), the rule finds nothing to do.
 */
function installTaskLists(md: MarkdownIt): void {
	interface TokenLike {
		type: string;
		level: number;
		content: string;
		children: TokenLike[];
		attrIndex(name: string): number;
		attrPush(attr: [string, string]): void;
		attrs: Array<[string, string]>;
	}

	const m = md as unknown as {core: {ruler: {after(anchor: string, name: string, rule: (state: {tokens: TokenLike[]; Token: new (type: string, tag: string, nesting: number) => TokenLike}) => void): void}}};

	const attrSet = (token: TokenLike, name: string, value: string): void => {
		const index = token.attrIndex(name);
		if (index < 0) token.attrPush([name, value]);
		else token.attrs[index] = [name, value];
	};

	const parentToken = (tokens: TokenLike[], index: number): number => {
		const targetLevel = tokens[index]!.level - 1;
		for (let i = index - 1; i >= 0; i--) {
			if (tokens[i]!.level === targetLevel) return i;
		}
		return -1;
	};

	const isTodoItem = (tokens: TokenLike[], index: number): boolean => {
		const t = tokens[index];
		return (
			t !== undefined &&
			t.type === "inline" &&
			tokens[index - 1]?.type === "paragraph_open" &&
			tokens[index - 2]?.type === "list_item_open" &&
			(t.content.startsWith("[ ] ") || t.content.startsWith("[x] ") || t.content.startsWith("[X] "))
		);
	};

	const todoify = (token: TokenLike, TokenConstructor: new (type: string, tag: string, nesting: number) => TokenLike): void => {
		const id = "task-item-" + Math.ceil(Math.random() * (10000 * 1000) - 1000);
		const checked = token.content.startsWith("[x] ") || token.content.startsWith("[X] ") ? ' checked=""' : "";
		// html_inline tokens keep markdown-it's default renderer — no
		// custom renderer rule needed.
		const checkbox = new TokenConstructor("html_inline", "", 0);
		checkbox.content = `<input class="task-list-item-checkbox"${checked} disabled="" type="checkbox" id="${id}">`;
		const label = new TokenConstructor("html_inline", "", 0);
		label.content = `<label class="task-list-item-label" for="${id}">${token.content.slice(3)}</label>`;
		token.children = [checkbox, label];
		token.content = token.content.slice(3);
	};

	m.core.ruler.after("inline", "amc-task-lists", (state) => {
		const tokens = state.tokens;
		for (let i = 2; i < tokens.length; i++) {
			if (isTodoItem(tokens, i)) {
				todoify(tokens[i]!, state.Token);
				attrSet(tokens[i - 2]!, "class", "task-list-item");
				attrSet(tokens[parentToken(tokens, i - 2)]!, "class", "contains-task-list");
			}
		}
	});
}

/**
 * Obsidian-style wikilinks in the preview: `[[note]]` / `[[note|label]]`
 * render as links (VSCode resolves relative .md hrefs against the document)
 * and `![[image.png]]` renders as an embedded image.
 */
function installWikilinkInline(md: MarkdownIt): void {
	const m = md as unknown as {
		inline: {ruler: {before(anchor: string, name: string, rule: (state: InlineState, silent: boolean) => boolean): void}};
		renderer: {rules: Record<string, (tokens: Array<{attrGet(n: string): string | null; content: string}>, idx: number) => string>};
	};

	const linkRe = /^\[\[([^\[\]|]+)(?:\|([^\[\]]+))?\]\]/;
	const embedRe = /^!\[\[([^\[\]|]+)(?:\|([^\[\]]+))?\]\]/;

	m.inline.ruler.before("emphasis", "amc_wikilink_embed", (state, silent) => {
		const src = state.src;
		const start = state.pos;
		if (src[start] !== "!" || src[start + 1] !== "[" || src[start + 2] !== "[") return false;
		const match = embedRe.exec(src.slice(start));
		if (!match) return false;
		if (silent) return false;
		const token = state.push("amc_wikilink_embed", "img", 0);
		const target = String(match[1]).trim();
		token.attrSet("src", target);
		token.attrSet("alt", (match[2] ?? match[1] ?? "").trim());
		state.pos += match[0].length;
		return true;
	});

	m.inline.ruler.before("emphasis", "amc_wikilink", (state, silent) => {
		const src = state.src;
		const start = state.pos;
		if (src[start] !== "[" || src[start + 1] !== "[") return false;
		const match = linkRe.exec(src.slice(start));
		if (!match) return false;
		if (silent) return false;
		const token = state.push("amc_wikilink", "a", 0);
		const target = String(match[1]).trim();
		token.attrSet("href", `${target}.md`);
		token.content = (match[2] ?? match[1] ?? "").trim();
		state.pos += match[0].length;
		return true;
	});

	m.renderer.rules["amc_wikilink"] = (tokens, idx) => {
		const t = tokens[idx]!;
		return `<a class="amc-wikilink" href="${escapeAttr(t.attrGet("href") ?? "#")}">${escapeHtml(t.content)}</a>`;
	};
	m.renderer.rules["amc_wikilink_embed"] = (tokens, idx) => {
		const t = tokens[idx]!;
		return `<img class="amc-embed" src="${escapeAttr(t.attrGet("src") ?? "")}" alt="${escapeAttr(t.attrGet("alt") ?? "")}">`;
	};
}

interface InlineState {
	src: string;
	pos: number;
	push(type: string, tag: string, nesting: number): {attrSet(k: string, v: string): void; content: string};
}

function renderColumnsHtml(raw: string, md: MarkdownIt, env: unknown, depth: number): string {
	const regions = findColumnRegions(raw);
	if (regions.length === 0) return "";
	return renderRegion(regions[0]!, md, env, depth);
}

function renderRegion(region: ColumnRegion, md: MarkdownIt, env: unknown, depth: number): string {
	if (depth > 8) return "";
	const groups = groupColumns(region.columns);
	const shrink = shrinkPx(region, gapPx(region.containerStyle));

	const containerVars = applyContainerStyleVars(region.containerStyle);
	const containerClasses = [
		"columns-container",
		"columns-ui",
		"columns-reading",
		region.layout === "stack" ? "columns-stacked" : "",
		depth > 0 ? "columns-nested" : "",
		containerVars ? "columns-custom-style" : "",
	].filter(Boolean).join(" ");
	let html = `<div class="${containerClasses}"`;
	if (containerVars) html += ` style="${containerVars}"`;
	html += ">";

	for (let gi = 0; gi < groups.length; gi++) {
		const group = groups[gi]!;

		if (gi > 0) {
			const prevGroup = groups[gi - 1]!;
			html += buildSeparatorHtml(region.columns[prevGroup.indices[prevGroup.indices.length - 1]!]!);
		}

		const useStackWrapper = group.isStack && region.layout !== "stack" && group.indices.length > 1;
		if (useStackWrapper) {
			const maxWidth = Math.max(...group.indices.map((idx) => region.columns[idx]!.widthPercent));
			const flexStyle = maxWidth > 0
				? ` style="flex: 0 0 calc(${maxWidth}% - ${shrink.toFixed(1)}px)"`
				: "";
			html += `<div class="columns-stack-group"${flexStyle}>`;
		}

		for (let gi2 = 0; gi2 < group.indices.length; gi2++) {
			const ci = group.indices[gi2]!;
			const col = region.columns[ci]!;

			if (gi2 > 0 && group.isStack) {
				html += buildSeparatorHtml(region.columns[group.indices[gi2 - 1]!]!);
			}

			const vars = applyColumnStyleVars(col.style);
			const classes = ["column-item"];
			if (vars) classes.push("columns-custom-style");
			if (col.style?.leftBorder) classes.push("columns-left-border");
			let styleAttr = vars ? ` style="${vars}"` : "";
			if (!useStackWrapper && region.layout !== "stack" && col.widthPercent > 0) {
				const flex = `flex: 0 0 calc(${col.widthPercent}% - ${shrink.toFixed(1)}px)`;
				styleAttr = styleAttr ? `${styleAttr.slice(0, -1)};${flex}"` : ` style="${flex}"`;
			}
			html += `<div class="${classes.join(" ")}"${styleAttr}>`
				+ `<div class="column-content">${md.render(col.content, {...(env as object), amcDepth: depth + 1})}</div></div>`;
		}

		if (useStackWrapper) html += "</div>";
	}

	html += "</div>";
	return html;
}

function buildSeparatorHtml(col: ColumnData): string {
	const style = col.style;
	if (!style?.separator) return "";

	const color = resolveColor(style.separatorColor);
	if (style.separatorStyle === "custom" && style.separatorCustomChar) {
		const size = style.separatorWidth ? style.separatorWidth * 6 + 6 : 12;
		return `<div class="column-separator-custom" style="--sep-color:${color};--sep-size:${size}px">${escapeHtml(style.separatorCustomChar)}</div>`;
	}
	const width = style.separatorWidth ?? 1;
	const sepStyle = style.separatorStyle && style.separatorStyle !== "custom" ? style.separatorStyle : "solid";
	return `<div class="column-separator-visual" style="--sep-color:${color};--sep-width:${width}px;--sep-style:${sepStyle}"></div>`;
}

function groupColumns(columns: ReadonlyArray<ColumnData>): {indices: number[]; isStack: boolean}[] {
	const groups: {indices: number[]; isStack: boolean}[] = [];
	let i = 0;
	while (i < columns.length) {
		const stackId = columns[i]!.stacked;
		if (stackId && stackId > 0) {
			const start = i;
			while (i < columns.length && columns[i]!.stacked === stackId) i++;
			groups.push({indices: Array.from({length: i - start}, (_, k) => start + k), isStack: true});
		} else {
			groups.push({indices: [i], isStack: false});
			i++;
		}
	}
	return groups;
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function escapeAttr(text: string): string {
	return escapeHtml(text).replace(/'/g, "&#39;");
}

export type {ColumnRegion};
