/**
 * In-process performance metrics: cumulative counters plus timing series
 * (count/total/min/max over ALL samples, p50 over the most recent 512 via a
 * sliding window). Module-level singleton for app wiring; `new Metrics()` for
 * isolated instances in tests. JSON-friendly snapshots only — no vscode.
 */

const SAMPLE_WINDOW = 512;

interface TimingSeries {
	count: number;
	totalMs: number;
	minMs: number;
	maxMs: number;
	/** Sliding window of the last SAMPLE_WINDOW samples, in arrival order. */
	samples: number[];
}

export interface TimingSnapshot {
	count: number;
	totalMs: number;
	minMs: number;
	maxMs: number;
	p50Ms: number;
}

export interface MetricsSnapshot {
	counters: Record<string, number>;
	timings: Record<string, TimingSnapshot>;
}

function now(): number {
	return performance.now();
}

/** Nearest-rank percentile on a pre-sorted array. */
function nearestRank(sorted: number[], p: number): number {
	if (sorted.length === 0) {
		return 0;
	}
	const idx = Math.max(0, Math.ceil(p * sorted.length) - 1);
	return sorted[Math.min(idx, sorted.length - 1)];
}

export class Metrics {
	private readonly counters = new Map<string, number>();
	private readonly timings = new Map<string, TimingSeries>();

	recordMetric(name: string, ms: number): void {
		if (typeof name !== "string" || name.length === 0) {
			throw new Error("recordMetric: name must be a non-empty string");
		}
		if (typeof ms !== "number" || !Number.isFinite(ms)) {
			throw new Error(`recordMetric: ms must be a finite number, got ${String(ms)}`);
		}
		let s = this.timings.get(name);
		if (!s) {
			s = {count: 0, totalMs: 0, minMs: Number.POSITIVE_INFINITY, maxMs: Number.NEGATIVE_INFINITY, samples: []};
			this.timings.set(name, s);
		}
		s.count++;
		s.totalMs += ms;
		if (ms < s.minMs) {
			s.minMs = ms;
		}
		if (ms > s.maxMs) {
			s.maxMs = ms;
		}
		s.samples.push(ms);
		if (s.samples.length > SAMPLE_WINDOW) {
			s.samples.shift();
		}
	}

	increment(counter: string, by = 1): void {
		if (typeof counter !== "string" || counter.length === 0) {
			throw new Error("increment: counter must be a non-empty string");
		}
		if (typeof by !== "number" || !Number.isFinite(by)) {
			throw new Error(`increment: by must be a finite number, got ${String(by)}`);
		}
		this.counters.set(counter, (this.counters.get(counter) ?? 0) + by);
	}

	getMetrics(): MetricsSnapshot {
		const counters: Record<string, number> = {};
		for (const [k, v] of this.counters) {
			counters[k] = v;
		}
		const timings: Record<string, TimingSnapshot> = {};
		for (const [k, s] of this.timings) {
			const sorted = s.samples.slice().sort((a, b) => a - b);
			timings[k] = {
				count: s.count,
				totalMs: s.totalMs,
				minMs: Number.isFinite(s.minMs) ? s.minMs : 0,
				maxMs: Number.isFinite(s.maxMs) ? s.maxMs : 0,
				p50Ms: nearestRank(sorted, 0.5),
			};
		}
		return {counters, timings};
	}

	resetMetrics(): void {
		this.counters.clear();
		this.timings.clear();
	}

	/** Times a synchronous fn; records even when fn throws (rethrow is implicit). */
	time<T>(name: string, fn: () => T): T {
		const t0 = now();
		try {
			return fn();
		} finally {
			this.recordMetric(name, now() - t0);
		}
	}

	/** Async variant of {@link Metrics.time}. */
	async timeAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
		const t0 = now();
		try {
			return await fn();
		} finally {
			this.recordMetric(name, now() - t0);
		}
	}
}

/** Thread-local singleton used by the free-function API below. */
export const metrics = new Metrics();

export function recordMetric(name: string, ms: number): void {
	metrics.recordMetric(name, ms);
}

export function increment(counter: string, by?: number): void {
	metrics.increment(counter, by);
}

export function getMetrics(): MetricsSnapshot {
	return metrics.getMetrics();
}

export function resetMetrics(): void {
	metrics.resetMetrics();
}

export function time<T>(name: string, fn: () => T): T {
	return metrics.time(name, fn);
}

export function timeAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
	return metrics.timeAsync(name, fn);
}
