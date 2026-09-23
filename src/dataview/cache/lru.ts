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
}

export class LruCache<K, V> {
	private readonly map = new Map<K, V>();
	private hits = 0;
	private misses = 0;

	constructor(private readonly capacity: number) {
		if (!Number.isInteger(capacity) || capacity < 1) {
			throw new Error(`LruCache: capacity must be a positive integer, got ${String(capacity)}`);
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
		if (this.map.has(key)) {
			this.map.delete(key);
		} else if (this.map.size >= this.capacity) {
			const eldest = this.map.keys().next();
			if (!eldest.done) {
				this.map.delete(eldest.value);
			}
		}
		this.map.set(key, value);
	}

	delete(key: K): boolean {
		return this.map.delete(key);
	}

	/** Drops all entries. Hit/miss counters stay cumulative (telemetry window). */
	clear(): void {
		this.map.clear();
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
		};
	}
}
