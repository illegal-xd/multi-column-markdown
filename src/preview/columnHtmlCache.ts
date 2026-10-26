/**
 * Column content HTML cache.
 *
 * Cost model: a preview refresh re-renders the whole document, and a column
 * region renders each column through its own `md.render()` call. While the
 * author types inside one column, every *other* column is unchanged — re-parsing
 * and re-rendering them is pure waste (measured: 4 × 200 lines ≈ 1.9ms per
 * refresh, all of it repeated work after the first keystroke).
 *
 * What is cached is the raw `md.render()` output of the column content, i.e.
 * **scope-relative** HTML: line numbers in `data-line` are relative to the
 * column, so the caller still rebases them per position (`rebaseDataLines`).
 * That keeps a cache hit position-independent — the same column text moved up
 * or down the document reuses the entry and only the rebase differs.
 *
 * Validity: entries are only stored when the render did not touch dynamic
 * content (dataview blocks/inline queries, markdown embeds) — see
 * `renderScope.ts`. The cache is per markdown-it instance (`WeakMap`), so a
 * closed preview releases everything, and a bounded budget keeps the rest
 * small. Known limit: output of a *third-party* plugin that reads render-pass
 * state (env, current file) is assumed to depend on the text like ours does.
 */

const MAX_ENTRIES = 128;
/** Single entry ceiling: bigger column content is rendered but not retained. */
const MAX_ENTRY_CHARS = 64 * 1024;
/** Total retained HTML per markdown-it instance. */
const MAX_TOTAL_CHARS = 2 * 1024 * 1024;

interface ColumnCache {
	entries: Map<string, string>;
	chars: number;
	hits: number;
	misses: number;
	skips: number;
	evictions: number;
}

const caches = new WeakMap<object, ColumnCache>();

function cacheFor(owner: object): ColumnCache {
	let cache = caches.get(owner);
	if (!cache) {
		cache = {entries: new Map(), chars: 0, hits: 0, misses: 0, skips: 0, evictions: 0};
		caches.set(owner, cache);
	}
	return cache;
}

/** Cache key: rendered output depends on the source text and the nesting depth. */
export function columnCacheKey(content: string, depth: number): string {
	return `${depth}\u0000${content}`;
}

export function getCachedColumnHtml(owner: object, key: string): string | undefined {
	const cache = cacheFor(owner);
	const html = cache.entries.get(key);
	if (html === undefined) {
		cache.misses += 1;
		return undefined;
	}
	// LRU touch: re-insert so the least recently used entry evicts first.
	cache.entries.delete(key);
	cache.entries.set(key, html);
	cache.hits += 1;
	return html;
}

export function setCachedColumnHtml(owner: object, key: string, html: string): void {
	if (html.length > MAX_ENTRY_CHARS) {
		cacheFor(owner).skips += 1;
		return;
	}
	const cache = cacheFor(owner);
	const previous = cache.entries.get(key);
	if (previous !== undefined) {
		cache.chars -= previous.length;
		cache.entries.delete(key);
	}
	while (cache.entries.size >= MAX_ENTRIES || (cache.chars + html.length > MAX_TOTAL_CHARS && cache.entries.size > 0)) {
		const eldest = cache.entries.keys().next();
		if (eldest.done) break;
		const evicted = cache.entries.get(eldest.value)!;
		cache.entries.delete(eldest.value);
		cache.chars -= evicted.length;
		cache.evictions += 1;
	}
	cache.entries.set(key, html);
	cache.chars += html.length;
}

/** Lifetime counters for a markdown-it instance (diagnostics). */
export function getColumnHtmlCacheStats(owner: object): {
	hits: number;
	misses: number;
	skips: number;
	evictions: number;
	size: number;
	chars: number;
} {
	const cache = cacheFor(owner);
	return {
		hits: cache.hits,
		misses: cache.misses,
		skips: cache.skips,
		evictions: cache.evictions,
		size: cache.entries.size,
		chars: cache.chars,
	};
}
