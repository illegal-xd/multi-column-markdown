/**
 * LRU cache over Map insertion order (Map preserves key insertion order;
 * re-inserting on get marks a key as most-recently-used, so the first key
 * is always the eviction candidate). No vscode import — pure data structure.
 */

export interface HitStats {
	hits: number;
	misses: number;
	/** hits / (hits + misses); 0 when there were no lookups yet. */
	hitRate: number;
	size: number;
	capacity: number;
	/** Retained weight (0 when no weigher is configured). */
	weight: number;
	/** Weight ceiling (undefined when only the entry count is bounded). */
	maxWeight: number | undefined;
}

export interface LruOptions<V> {
	/**
	 * Retained-weight ceiling. Entry counting alone cannot bound a cache of
	 * rendered HTML: 500 entries of a large table/heatmap can be hundreds of MB.
	 * With a weigher, the cache also evicts until the total weight fits.
	 */
	maxWeight?: number;
	/** Weight of one value (e.g. its HTML length). Required for `maxWeight`. */
	weigh?: (value: V) => number;
}

export class LruCache<K, V> {
	private readonly map = new Map<K, V>();
	private readonly maxWeight: number | undefined;
	private readonly weigh: ((value: V) => number) | undefined;
	private weight = 0;
	private hits = 0;
	private misses = 0;

	constructor(
		private readonly capacity: number,
		options: LruOptions<V> = {},
	) {
		if (!Number.isInteger(capacity) || capacity < 1) {
			throw new Error(`LruCache: capacity must be a positive integer, got ${String(capacity)}`);
		}
		if (options.maxWeight !== undefined && (options.maxWeight <= 0 || !options.weigh)) {
			throw new Error("LruCache: maxWeight requires a positive ceiling and a weigher");
		}
		this.maxWeight = options.maxWeight;
		this.weigh = options.weigh;
	}

	private weightOf(value: V): number {
		return this.weigh ? this.weigh(value) : 0;
	}

	/** Evict eldest entries until both the count and weight ceilings hold. */
	private trim(): void {
		while (this.map.size > this.capacity || (this.maxWeight !== undefined && this.weight > this.maxWeight && this.map.size > 1)) {
			const eldest = this.map.keys().next();
			if (eldest.done) return;
			const value = this.map.get(eldest.value) as V;
			this.map.delete(eldest.value);
			this.weight -= this.weightOf(value);
		}
	}

	get(key: K): V | undefined {
		const v = this.map.get(key);
		if (!this.map.has(key)) {
			this.misses++;
			return undefined;
		}
		// Re-insert to refresh recency (delete + set moves the key to the tail).
		this.map.delete(key);
		this.map.set(key, v as V);
		this.hits++;
		return v as V;
	}

	set(key: K, value: V): void {
		const existing = this.map.get(key);
		if (existing !== undefined || this.map.has(key)) {
			this.weight -= this.weightOf(existing as V);
			this.map.delete(key);
		}
		this.map.set(key, value);
		this.weight += this.weightOf(value);
		this.trim();
	}

	delete(key: K): boolean {
		const existing = this.map.get(key);
		if (!this.map.has(key)) return false;
		this.weight -= this.weightOf(existing as V);
		return this.map.delete(key);
	}

	/** Drops all entries. Hit/miss counters stay cumulative (telemetry window). */
	clear(): void {
		this.map.clear();
		this.weight = 0;
	}

	get size(): number {
		return this.map.size;
	}

	hitStats(): HitStats {
		const total = this.hits + this.misses;
		return {
			hits: this.hits,
			misses: this.misses,
			hitRate: total === 0 ? 0 : this.hits / total,
			size: this.map.size,
			capacity: this.capacity,
			weight: this.weight,
			maxWeight: this.maxWeight,
		};
	}
}
