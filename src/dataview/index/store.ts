/**
 * createIndexStore — incremental IndexStore with reverse indexes.
 *
 * Performance design (optimization notes):
 * - PageMeta is immutable after publish: updates replace via `{...old}` spread
 *   so snapshots holding prior refs are never mutated in place.
 * - Reverse indexes (tag/folder/outlink) make upsert O(outlinks + affected
 *   targets) instead of O(n): only the changed file re-parses; affected target
 *   pages get their inlinks cascaded via shallow copy.
 * - Unchanged file (same mtime + size) short-circuits before parse — no
 *   version bump, parseCalls untouched.
 * - snapshot()/allPages() reuse a path-sorted cache (invalidated on write);
 *   the snapshot itself is an O(n) shallow array copy — no deep clone,
 *   relying on the immutability contract above.
 */
import type {IndexSnapshot, IndexStats, IndexStore, LinkMeta, PageMeta} from "../types";
import {parsePageFile} from "./parse";

function comparePath(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function addSet(m: Map<string, Set<string>>, key: string, value: string): void {
	let s = m.get(key);
	if (!s) {
		s = new Set();
		m.set(key, s);
	}
	s.add(value);
}

function deleteSet(m: Map<string, Set<string>>, key: string, value: string): void {
	const s = m.get(key);
	if (!s) return;
	s.delete(value);
	if (s.size === 0) m.delete(key);
}

function sameLinks(a: readonly LinkMeta[], b: readonly LinkMeta[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

function sortedPaths(s: Set<string> | undefined): string[] {
	if (!s) return [];
	return [...s].sort(comparePath);
}

export function createIndexStore(): IndexStore {
	const pages = new Map<string, PageMeta>();
	const tagIndex = new Map<string, Set<string>>(); // etag → paths
	const folderIndex = new Map<string, Set<string>>();
	const outlinkIndex = new Map<string, Set<string>>(); // target → source paths
	let version = 0;
	let parseCalls = 0;
	let lastIncrementalMs: number | undefined;
	let lastSnapshotMs: number | undefined;
	let sortedCache: PageMeta[] | null = null;

	const addToIndex = (page: PageMeta): void => {
		for (const tag of page.etags) addSet(tagIndex, tag, page.path);
		addSet(folderIndex, page.folder, page.path);
		for (const link of page.outlinks) addSet(outlinkIndex, link.path, page.path);
	};

	const removeFromIndex = (page: PageMeta): void => {
		for (const tag of page.etags) deleteSet(tagIndex, tag, page.path);
		deleteSet(folderIndex, page.folder, page.path);
		for (const link of page.outlinks) deleteSet(outlinkIndex, link.path, page.path);
	};

	const computeInlinks = (target: string): LinkMeta[] => {
		const sources = outlinkIndex.get(target);
		if (!sources) return [];
		const out: LinkMeta[] = [];
		for (const src of sources) {
			const page = pages.get(src);
			if (!page) continue;
			for (const link of page.outlinks) if (link.path === target) out.push(link);
		}
		return out;
	};

	/** Cascade: rebuild target's inlinks on a shallow copy (never mutate a published page). */
	const refreshInlinks = (target: string): void => {
		const page = pages.get(target);
		if (!page) return;
		const next = computeInlinks(target);
		if (sameLinks(page.inlinks, next)) return; // no structural change → keep identity
		pages.set(target, {...page, inlinks: next});
		sortedCache = null; // replaced object → sorted cache must rebuild
	};

	const sorted = (): PageMeta[] => {
		if (!sortedCache) sortedCache = [...pages.values()].sort((a, b) => comparePath(a.path, b.path));
		return sortedCache;
	};

	return {
		get version(): number {
			return version;
		},
		upsertFile(path: string, content: string, mtime: number, size: number): void {
			const t0 = performance.now();
			const prev = pages.get(path);
			if (prev && prev.mtime === mtime && prev.size === size) {
				// Skip: unchanged content signal (mtime+size) → no parse, no bump.
				lastIncrementalMs = performance.now() - t0;
				return;
			}
			const page = parsePageFile(path, content, mtime, size);
			parseCalls++;
			const affected = new Set<string>([path]);
			if (prev) {
				for (const link of prev.outlinks) affected.add(link.path);
				removeFromIndex(prev);
			}
			for (const link of page.outlinks) affected.add(link.path);
			pages.set(path, page);
			sortedCache = null;
			addToIndex(page);
			for (const target of affected) refreshInlinks(target);
			version++; // one bump per actual mutation event (incl. cascade effects)
			lastIncrementalMs = performance.now() - t0;
		},
		removeFile(path: string): void {
			const t0 = performance.now();
			const prev = pages.get(path);
			if (!prev) {
				lastIncrementalMs = performance.now() - t0;
				return;
			}
			removeFromIndex(prev);
			pages.delete(path);
			sortedCache = null;
			for (const link of prev.outlinks) refreshInlinks(link.path);
			version++;
			lastIncrementalMs = performance.now() - t0;
		},
		getPage(path: string): PageMeta | undefined {
			return pages.get(path);
		},
		allPages(): readonly PageMeta[] {
			return sorted().slice();
		},
		snapshot(): IndexSnapshot {
			const t0 = performance.now();
			// O(n) shallow copy over the sorted cache — no deep clone; safe because
			// published PageMeta objects are replaced (spread), never mutated.
			const snap: IndexSnapshot = {version, pages: sorted().slice(), generatedAt: Date.now()};
			lastSnapshotMs = performance.now() - t0;
			return snap;
		},
		byTag(tag: string): readonly string[] {
			return sortedPaths(tagIndex.get(tag));
		},
		byFolder(folder: string): readonly string[] {
			return sortedPaths(folderIndex.get(folder));
		},
		stats(): IndexStats {
			return {files: pages.size, version, parseCalls, lastIncrementalMs, lastSnapshotMs};
		},
	};
}
