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
				? ` style="flex: 0 0 calc(${maxWidth}% - ${((groups.length - 1) * 8 / groups.length).toFixed(1)}px)"`
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
				const shrink = (groups.length - 1) * 8 / groups.length;
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
