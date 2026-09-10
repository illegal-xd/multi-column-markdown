/**
 * Region cache: parsed regions are reused across preview refreshes.
 *
 * Contract: every cached region is deeply frozen — callers must treat the
 * result as read-only (this is what makes sharing one instance safe).
 *
 * Bounds: at most `REGION_CACHE_LIMIT` documents are retained, and documents
 * above `REGION_CACHE_MAX_DOC_CHARS` are parsed without being cached (the key
 * holds the whole document text, so large files would dominate memory).
 */
import type {ColumnRegion} from "../types";

const REGION_CACHE_LIMIT = 32;
/** Documents above this size are parsed but not retained (cache holds keys). */
const REGION_CACHE_MAX_DOC_CHARS = 256 * 1024;

const regionCache = new Map<string, ColumnRegion[]>();
const cacheStats = {hits: 0, misses: 0, evictions: 0, skips: 0};

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

function storeInCache(doc: string, regions: ColumnRegion[]): void {
	if (doc.length > REGION_CACHE_MAX_DOC_CHARS) {
		cacheStats.skips += 1;
		return;
	}
	if (regionCache.size >= REGION_CACHE_LIMIT) {
		const oldest = regionCache.keys().next().value;
		if (oldest !== undefined) {
			regionCache.delete(oldest);
			cacheStats.evictions += 1;
		}
	}
	regionCache.set(doc, regions);
}

/**
 * Look the document up, parsing on a miss. `parse` runs at most once per
 * document version; its result is frozen before being shared.
 */
export function cachedRegions(doc: string, parse: () => ColumnRegion[]): ColumnRegion[] {
	const cached = regionCache.get(doc);
	if (cached) {
		cacheStats.hits += 1;
		// LRU touch: re-insert so the most recently used entry evicts last.
		regionCache.delete(doc);
		regionCache.set(doc, cached);
		return cached;
	}
	cacheStats.misses += 1;
	const regions = parse().map(freezeRegion);
	Object.freeze(regions);
	storeInCache(doc, regions);
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

/** Drop cached regions (used by tests and by settings/document resets). */
export function clearRegionCache(): void {
	regionCache.clear();
}
