/**
 * Region cache: parsed regions are reused across preview refreshes.
 *
 * Contract: every cached region is deeply frozen — callers must treat the
 * result as read-only (this is what makes sharing one instance safe).
 *
 * Memory design: the key is **not** the document text. A cache keyed by text
 * keeps up to `REGION_CACHE_LIMIT` whole document strings alive, and while the
 * author types every keystroke produces a new string, so those retained copies
 * are pure garbage pressure (up to 32 × 256KB). Entries are keyed by a 32-bit
 * hash and verified with a length + head/tail fingerprint, which costs the same
 * O(n) as hashing the string for a Map key but keeps only ~80 bytes per entry.
 *
 * Bounds: at most `REGION_CACHE_LIMIT` documents are retained, and documents
 * above `REGION_CACHE_MAX_DOC_CHARS` are parsed without being cached.
 */
import type {ColumnRegion} from "../types";

const REGION_CACHE_LIMIT = 32;
/** Documents above this size are parsed but not retained. */
const REGION_CACHE_MAX_DOC_CHARS = 256 * 1024;
/** Characters of the document head/tail kept for collision detection. */
const FINGERPRINT_CHARS = 32;

interface CacheEntry {
	/** `length:head:tail` — identifies the document without retaining it. */
	fingerprint: string;
	regions: ColumnRegion[];
}

const regionCache = new Map<number, CacheEntry>();
const cacheStats = {hits: 0, misses: 0, evictions: 0, skips: 0};

/** FNV-1a (32-bit). Same cost class as Map's own string hashing. */
function hashText(text: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

function fingerprintOf(text: string): string {
	if (text.length <= FINGERPRINT_CHARS * 2) return `${text.length}:${text}`;
	return `${text.length}:${text.slice(0, FINGERPRINT_CHARS)}:${text.slice(-FINGERPRINT_CHARS)}`;
}

/** Freeze a region (and its arrays/columns) so cached results stay immutable. */
function freezeRegion(region: ColumnRegion): ColumnRegion {
	for (const column of region.columns) Object.freeze(column);
	Object.freeze(region.columns);
	Object.freeze(region.columnLineRanges);
	Object.freeze(region.columnAbsoluteOffsets);
	Object.freeze(region.columnMarkerOffsets);
	Object.freeze(region.containerMarkerOffset);
	Object.freeze(region.endMarkerOffset);
	return Object.freeze(region);
}

function storeInCache(hash: number, fingerprint: string, docLength: number, regions: ColumnRegion[]): void {
	if (docLength > REGION_CACHE_MAX_DOC_CHARS) {
		cacheStats.skips += 1;
		return;
	}
	const existing = regionCache.get(hash);
	if (existing) {
		regionCache.delete(hash);
	} else if (regionCache.size >= REGION_CACHE_LIMIT) {
		const oldest = regionCache.keys().next().value;
		if (oldest !== undefined) {
			regionCache.delete(oldest);
			cacheStats.evictions += 1;
		}
	}
	regionCache.set(hash, {fingerprint, regions});
}

/**
 * Look the document up, parsing on a miss. `parse` runs at most once per
 * document version; its result is frozen before being shared.
 */
export function cachedRegions(doc: string, parse: () => ColumnRegion[]): ColumnRegion[] {
	const hash = hashText(doc);
	const fingerprint = fingerprintOf(doc);
	const cached = regionCache.get(hash);
	if (cached && cached.fingerprint === fingerprint) {
		cacheStats.hits += 1;
		// LRU touch: re-insert so the most recently used entry evicts last.
		regionCache.delete(hash);
		regionCache.set(hash, cached);
		return cached.regions;
	}
	cacheStats.misses += 1;
	const regions = parse().map(freezeRegion);
	Object.freeze(regions);
	storeInCache(hash, fingerprint, doc.length, regions);
	return regions;
}

/** Lifetime cache counters (diagnostics; cumulative since module load). */
export function getRegionCacheStats(): {
	hits: number;
	misses: number;
	evictions: number;
	skips: number;
	size: number;
	limit: number;
} {
	return {
		hits: cacheStats.hits,
		misses: cacheStats.misses,
		evictions: cacheStats.evictions,
		skips: cacheStats.skips,
		size: regionCache.size,
		limit: REGION_CACHE_LIMIT,
	};
}

/** Drop cached regions (tests, settings changes, closed documents). */
export function clearRegionCache(): void {
	regionCache.clear();
}
