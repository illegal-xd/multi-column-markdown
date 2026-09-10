/**
 * Obsidian-style wikilinks in the preview: `[[note]]` / `[[note|label]]`
 * render as links (VSCode resolves relative .md hrefs against the document)
 * and `![[image.png]]` renders as an embedded image.
 *
 * Markdown embeds (`![[note]]` with a Markdown target) are delegated to
 * `embed.ts`, which owns their cost control.
 */
import type MarkdownIt from "markdown-it";
import {isMarkdownTarget, parseWikilinkTarget, wikilinkFragment} from "../core/wikilink";
import {escapeAttr, escapeHtml} from "./htmlEscape";
import {renderMarkdownEmbed} from "./embed";
import type {InlineRuleState, MarkdownItLike, RenderToken} from "./markdownItTypes";

const linkRe = /^\[\[([^\[\]|]+)(?:\|([^\[\]]+))?\]\]/;
const embedRe = /^!\[\[([^\[\]|]+)(?:\|([^\[\]]+))?\]\]/;

export function installWikilinkInline(md: MarkdownIt): void {
	const m = md as unknown as MarkdownItLike;

	m.inline.ruler.before("emphasis", "amc_wikilink_embed", (state: InlineRuleState, silent: boolean) => {
		const src = state.src;
		const start = state.pos;
		if (src[start] !== "!" || src[start + 1] !== "[" || src[start + 2] !== "[") return false;
		const match = embedRe.exec(src.slice(start));
		if (!match) return false;
		if (silent) return false;
		const token = state.push("amc_wikilink_embed", "img", 0);
		const rawTarget = String(match[1]).trim();
		const parsed = parseWikilinkTarget(`${rawTarget}|${match[2] ?? ""}`);
		token.attrSet("src", parsed.target + wikilinkFragment(parsed.fragment));
		token.attrSet("alt", (parsed.alias ?? parsed.target).trim());
		token.attrSet("data-amc-markdown", isMarkdownTarget(parsed.target) ? "true" : "false");
		state.pos += match[0].length;
		return true;
	});

	m.inline.ruler.before("emphasis", "amc_wikilink", (state: InlineRuleState, silent: boolean) => {
		const src = state.src;
		const start = state.pos;
		if (src[start] !== "[" || src[start + 1] !== "[") return false;
		const match = linkRe.exec(src.slice(start));
		if (!match) return false;
		if (silent) return false;
		const token = state.push("amc_wikilink", "a", 0);
		const parsed = parseWikilinkTarget(`${String(match[1]).trim()}|${match[2] ?? ""}`);
		const hrefTarget = parsed.target.toLowerCase().endsWith(".md") ? parsed.target : `${parsed.target}.md`;
		token.attrSet("href", `${hrefTarget}${wikilinkFragment(parsed.fragment)}`);
		token.content = parsed.alias ?? parsed.target;
		state.pos += match[0].length;
		return true;
	});

	m.renderer.rules["amc_wikilink"] = (tokens: RenderToken[], idx: number) => {
		const t = tokens[idx]!;
		return `<a class="amc-wikilink" href="${escapeAttr(t.attrGet("href") ?? "#")}">${escapeHtml(t.content)}</a>`;
	};

	m.renderer.rules["amc_wikilink_embed"] = (tokens: RenderToken[], idx: number, _options, env) => {
		const t = tokens[idx]!;
		const src = t.attrGet("src") ?? "";
		if (t.attrGet("data-amc-markdown") === "true") {
			const embedded = renderMarkdownEmbed(md, src.split("#", 1)[0]!, env);
			if (embedded !== null) return embedded;
		}
		return `<img class="amc-embed" src="${escapeAttr(src)}" alt="${escapeAttr(t.attrGet("alt") ?? "")}">`;
	};
}
