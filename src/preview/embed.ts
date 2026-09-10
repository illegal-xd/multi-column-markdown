/**
 * Markdown/image embeds for the preview: `![[note]]` renders the target's
 * content, `![[image.png]]` falls back to an `<img>`.
 *
 * Cost control (the render path is synchronous and runs on every preview
 * refresh, so it must stay bounded):
 *   1. **Path stack** — a target already being rendered is a cycle; it
 *      renders a visible marker instead of recursing.
 *   2. **Content cache** — one `readFileSync` per distinct file per render
 *      pass, no matter how often the file is embedded.
 *   3. **Budget** — total expansions per render pass are capped; past the
 *      budget embeds fall back to a link-like marker.
 *   4. **Depth cap** — belt and braces for the recursion itself.
 */
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type MarkdownIt from "markdown-it";
import {escapeHtml} from "./htmlEscape";

export const MAX_EMBED_DEPTH = 8;
export const MAX_EMBEDS_PER_RENDER = 50;

interface EmbedState {
	/** Targets currently being rendered (cycle detection). */
	stack: string[];
	/** target → absolute path (null when unresolvable) for this render pass. */
	resolved: Map<string, string | null>;
	/** absolute path → file content (null when unreadable). */
	contents: Map<string, string | null>;
	/** Remaining expansions for this render pass. */
	remaining: number;
}

const EMBED_STATE_KEY = "__amcEmbedState";

function isEmbedState(value: unknown): value is EmbedState {
	return typeof value === "object" && value !== null && Array.isArray((value as EmbedState).stack);
}

/** Per-render-pass embed state, attached to the markdown-it `env`. */
export function getEmbedState(env: unknown): EmbedState {
	const holder = (typeof env === "object" && env !== null ? env : {}) as Record<string, unknown>;
	const existing = holder[EMBED_STATE_KEY];
	if (isEmbedState(existing)) return existing;
	const state: EmbedState = {
		stack: [],
		resolved: new Map(),
		contents: new Map(),
		remaining: MAX_EMBEDS_PER_RENDER,
	};
	holder[EMBED_STATE_KEY] = state;
	return state;
}

/**
 * Resolve a workspace-relative embed target to an absolute path.
 * Rejects absolute paths and any `..` segment, and refuses to leave the
 * first workspace folder.
 */
function resolveEmbedPath(target: string): string | null {
	const normalized = target.replaceAll("\\\\", "/").replace(/^\.\//, "");
	if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) return null;
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) return null;
	const root = folder.uri.fsPath;
	for (const candidate of [normalized, `${normalized}.md`, `${normalized}/index.md`]) {
		const file = path.join(root, candidate);
		if (path.relative(root, file).startsWith("..")) continue;
		if (!file.toLowerCase().endsWith(".md")) continue;
		try {
			if (fs.statSync(file).isFile()) return file;
		} catch {
			// Try the next candidate.
		}
	}
	return null;
}

function resolvedPathFor(state: EmbedState, target: string): string | null {
	if (!state.resolved.has(target)) state.resolved.set(target, resolveEmbedPath(target));
	return state.resolved.get(target) ?? null;
}

function readCached(state: EmbedState, file: string): string | null {
	if (!state.contents.has(file)) {
		try {
			state.contents.set(file, fs.readFileSync(file, "utf8"));
		} catch {
			state.contents.set(file, null);
		}
	}
	return state.contents.get(file) ?? null;
}

function marker(kind: string, label: string): string {
	return `<div class="${kind}">${escapeHtml(label)}</div>`;
}

/**
 * Render `![[target]]` as embedded Markdown, or return null when the caller
 * should fall back to the plain `<img>` rendering (missing file, depth cap,
 * budget exhausted).
 */
export function renderMarkdownEmbed(md: MarkdownIt, target: string, env: unknown): string | null {
	const holder = (typeof env === "object" && env !== null ? env : {}) as {amcEmbedDepth?: number};
	const depth = holder.amcEmbedDepth ?? 0;
	if (depth >= MAX_EMBED_DEPTH) return null;

	const state = getEmbedState(env);
	const file = resolvedPathFor(state, target);
	if (file === null) return null;

	if (state.stack.includes(file)) return marker("amc-embed-cycle", `⟳ [[${target}]] (circular embed)`);
	if (state.remaining <= 0) return marker("amc-embed-limited", `[[${target}]] (embed limit reached)`);

	const content = readCached(state, file);
	if (content === null) return null;

	state.remaining -= 1;
	state.stack.push(file);
	try {
		const nextEnv = {...(env as object), amcEmbedDepth: depth + 1};
		return `<div class="amc-embed-markdown">${md.render(content, nextEnv)}</div>`;
	} finally {
		state.stack.pop();
	}
}
