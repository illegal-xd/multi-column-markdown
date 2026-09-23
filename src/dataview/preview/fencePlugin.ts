/**
 * ```dataview / ```dataviewjs fence interception for the built-in preview.
 *
 * Why a fence-rule wrapper instead of a block ruler: markdown-it already turns
 * fenced code into a single `fence` token, so wrapping `renderer.rules.fence`
 * costs one string compare per fence and keeps the token stream untouched
 * (columns plugin, tables, task lists all keep working). A custom block ruler
 * would re-implement indentation/backtick/tilde handling for no benefit.
 *
 * Contract: `BlockResultProvider.getBlock` is SYNCHRONOUS (markdown-it's render
 * phase cannot await). Block execution happens in a worker thread; a miss
 * returns a `pending` placeholder and the worker result is delivered through a
 * throttled `markdown.preview.refresh` (see host/service.ts). This is the only
 * public path an extension has into the built-in preview's DOM, so the
 * "placeholder → refresh" cycle is a deliberate architectural choice, not a
 * workaround.
 *
 * No `vscode` import here: the file runs inside VSCode's markdown-it instance
 * and must stay unit-testable.
 */
import type MarkdownIt from "markdown-it";
import {escapeHtml} from "../../preview/htmlEscape";
import type {MarkdownItLike} from "../../preview/markdownItTypes";
import type {BlockResultProvider, BlockState, DataviewRenderEnv} from "../types";
import {renderErrorHtml} from "../render/html";

const FENCE_LANGS = new Set(["dataview", "dataviewjs"]);
const installed = new WeakSet<object>();
const inlineInstalled = new WeakSet<object>();

/** Upstream defaults for the inline prefixes (settings override them). */
export const DEFAULT_INLINE_PREFIX = "=";
export const DEFAULT_JS_INLINE_PREFIX = "$=";

/**
 * Env key used to hand the block's source line to the provider: it becomes the
 * `blockIndex` in ExecJob (stable across refreshes, unlike a running counter).
 * Namespaced to avoid colliding with VSCode's own env fields.
 */
export const DV_BLOCK_LINE_ENV_KEY = "__amcDvBlockLine";

export type DataviewFenceLang = "dataview" | "dataviewjs";

export interface DataviewInlineOptions {
	provider: BlockResultProvider;
	/** Config gates; read per span so toggling a setting needs no reload. */
	isEnabled?: () => boolean;
	/** DQL inline prefix (upstream `dataview.inlinePrefix`, default `=`). */
	inlinePrefix?: () => string;
	/** JS inline prefix (upstream `dataview.jsInlinePrefix`, default `$=`). */
	jsInlinePrefix?: () => string;
}

export interface DataviewFenceOptions {
	provider: BlockResultProvider;
	/** Config gate; checked per fence so toggling the setting needs no reload. */
	isEnabled?: () => boolean;
}

function defaultFenceHtml(token: {content: string; info?: string}): string {
	const lang = (token.info ?? "").trim().split(/\s+/)[0] ?? "";
	const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
	return `<pre><code${cls}>${escapeHtml(token.content)}</code></pre>\n`;
}

/**
 * Installs the fence wrapper. Idempotent per markdown-it instance (VSCode
 * caches the instance per preview session; double-installing would emit every
 * block twice).
 */
export function installDataviewFences(md: MarkdownIt, opts: DataviewFenceOptions): void {
	if (installed.has(md)) return;
	installed.add(md);

	const m = md as unknown as MarkdownItLike;
	const prev = m.renderer.rules["fence"];

	m.renderer.rules["fence"] = (tokens, idx, options, env, self) => {
		const token = tokens[idx];
		if (!token) return "";
		// `info` is the language hint after the fence marker ("dataviewjs" or
		// "dataviewjs title"); only the first word selects the renderer.
		const info = (token.info ?? "").trim();
		const lang = info.split(/\s+/)[0]?.toLowerCase() ?? "";
		if (!FENCE_LANGS.has(lang)) {
			return prev ? prev(tokens, idx, options, env, self) : defaultFenceHtml(token);
		}
		if (opts.isEnabled && !opts.isEnabled()) {
			return prev ? prev(tokens, idx, options, env, self) : defaultFenceHtml(token);
		}

		const renderEnv = (env ?? {}) as DataviewRenderEnv;
		renderEnv[DV_BLOCK_LINE_ENV_KEY] = token.map?.[0] ?? 0;

		let state: BlockState;
		try {
			state = opts.provider.getBlock(renderEnv, lang as DataviewFenceLang, token.content);
		} catch (e) {
			// Error isolation: one throwing provider call must not blank the page.
			state = {status: "error", html: renderErrorHtml(e instanceof Error ? e.message : String(e))};
		}
		// data-dv-state lets tests/support inspect ready|pending|error without
		// re-parsing the inner HTML; the wrapper div is also the CSS anchor.
		return `<div class="dataview-block" data-dv-lang="${lang}" data-dv-state="${state.status}">${state.html}</div>\n`;
	};
}

function defaultCodeInlineHtml(token: {content: string}): string {
	return `<code>${escapeHtml(token.content)}</code>`;
}

/**
 * Installs inline query rendering (`` `= expr` `` / `` `$= expr` ``).
 *
 * Why `code_inline` and not a core rule: markdown-it has already resolved the
 * backtick parsing rules by then, so this gets exactly the spans a user wrote as
 * code — no re-implementing of escaping, and inline code inside fenced blocks or
 * indented code is untouched (it is never a code_inline token).
 *
 * Prefix matching mirrors upstream: the JS prefix is checked first (`$=` then
 * `=`), the span must be non-empty after the prefix, and a disabled setting or a
 * provider without `getInline` falls through to the default `<code>` output so
 * the document stays readable.
 */
export function installDataviewInlines(md: MarkdownIt, opts: DataviewInlineOptions): void {
	if (inlineInstalled.has(md)) return;
	inlineInstalled.add(md);

	const m = md as unknown as MarkdownItLike;
	const prev = m.renderer.rules["code_inline"];

	m.renderer.rules["code_inline"] = (tokens, idx, options, env, self) => {
		const token = tokens[idx];
		if (!token) return "";
		const fallback = (): string => (prev ? prev(tokens, idx, options, env, self) : defaultCodeInlineHtml(token));
		if (opts.isEnabled && !opts.isEnabled()) return fallback();
		if (!opts.provider.getInline) return fallback();

		const jsPrefix = opts.jsInlinePrefix?.() ?? DEFAULT_JS_INLINE_PREFIX;
		const dqlPrefix = opts.inlinePrefix?.() ?? DEFAULT_INLINE_PREFIX;
		const raw = token.content;
		let kind: DataviewFenceLang;
		let code: string;
		if (jsPrefix !== "" && raw.startsWith(jsPrefix)) {
			kind = "dataviewjs";
			code = raw.slice(jsPrefix.length).trim();
		} else if (dqlPrefix !== "" && raw.startsWith(dqlPrefix)) {
			kind = "dataview";
			code = raw.slice(dqlPrefix.length).trim();
		} else {
			return fallback();
		}
		// `=` alone (or `$=` alone) is not a query — upstream leaves it literal.
		if (code === "") return fallback();

		let state: BlockState;
		try {
			state = opts.provider.getInline(env as DataviewRenderEnv, kind, code);
		} catch (e) {
			// Error isolation: one throwing provider call must not blank the page.
			state = {status: "error", html: renderErrorHtml(e instanceof Error ? e.message : String(e))};
		}
		return (
			`<span class="dataview-inline" data-dv-lang="${kind}" data-dv-state="${state.status}">` +
			`${state.html}</span>`
		);
	};
}
