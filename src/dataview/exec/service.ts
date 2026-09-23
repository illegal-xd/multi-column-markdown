/**
 * Host-side sandbox execution service (B4).
 *
 * Sticky worker pool + per-slot FIFO queue + timeout/cancel via process-level
 * `terminate()` + IO bridge + backpressure. Business logic (dv/DQL) is NOT
 * known here — jobs are opaque `ExecJob`s; the integrator points `workerPath`
 * at the bundled worker entry (startWorker({runJob})).
 *
 * Contract: `run()` NEVER rejects — every failure resolves an ExecResult with
 * `ok:false` (a dropped rejection would take down the preview render path).
 * Only construction throws (invalid opts: missing/nonexistent workerPath).
 *
 * Security boundary: worker_threads + resourceLimits + forced terminate give
 * a timeout/DoS isolation boundary (hung `while(true){}` and crashes are
 * recovered by killing the thread). This is NOT a malicious-code sandbox —
 * worker code still has full Node fs/net capability.
 */
import {existsSync} from "node:fs";
import {access, readFile} from "node:fs/promises";
import {cpus} from "node:os";
import {join} from "node:path";
import {Worker} from "node:worker_threads";
import {hashKey} from "../cache/hash";
import type {
	ExecJob,
	ExecResult,
	ExecService,
	ExecServiceOptions,
	ExecStats,
	HostIo,
	HostToWorker,
	IndexSnapshot,
	WorkerToHost,
} from "../types";

const DEFAULT_MAX_QUEUE = 256;
const DEFAULT_MAX_CODE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
/** Spawn failures before a slot is declared broken (guards respawn storms). */
const MAX_SPAWN_FAILURES = 3;

interface Queued {
	job: ExecJob;
	resolve: (r: ExecResult) => void;
	enqueuedAt: number;
}

interface InFlight {
	job: ExecJob;
	resolve: (r: ExecResult) => void;
	startedAt: number;
	timer: ReturnType<typeof setTimeout>;
}

interface Slot {
	worker: Worker | null;
	currentIndexVersion: number;
	inFlight: InFlight | null;
	retiring: boolean;
	broken: boolean;
	consecutiveFailures: number;
	queue: Queued[];
	pendingTeardown: Promise<void> | null;
}

function defaultPoolSize(): number {
	const n = cpus().length || 2;
	return Math.max(1, Math.min(4, n - 1));
}

function defaultHostIo(): HostIo {
	return {
		async read(path: string): Promise<string> {
			return readFile(join(process.cwd(), path), "utf8");
		},
		async exists(path: string): Promise<boolean> {
			try {
				await access(join(process.cwd(), path));
				return true;
			} catch {
				// Any stat failure (ENOENT/EACCES/…) ⇒ not readable: dv.io.exists semantics.
				return false;
			}
		},
	};
}

function errResult(job: ExecJob, message: string, durationMs: number): ExecResult {
	return {id: job.id, ok: false, ops: [], error: {message}, durationMs, indexVersion: job.indexVersion};
}

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

export function createExecService(opts: ExecServiceOptions): ExecService {
	if (!opts || typeof opts.workerPath !== "string" || opts.workerPath.length === 0) {
		throw new Error("createExecService: opts.workerPath (absolute path to bundled worker script) is required");
	}
	if (!existsSync(opts.workerPath)) {
		throw new Error(`createExecService: worker script not found at ${opts.workerPath}`);
	}
	const poolSize = opts.poolSize ?? defaultPoolSize();
	if (!Number.isInteger(poolSize) || poolSize < 1) {
		throw new Error(`createExecService: poolSize must be a positive integer, got ${String(opts.poolSize)}`);
	}
	const maxQueue = opts.maxQueue ?? DEFAULT_MAX_QUEUE;
	if (!Number.isInteger(maxQueue) || maxQueue < 1) {
		throw new Error(`createExecService: maxQueue must be a positive integer, got ${String(opts.maxQueue)}`);
	}
	const maxCodeBytes = opts.maxCodeBytes ?? DEFAULT_MAX_CODE_BYTES;
	if (!Number.isInteger(maxCodeBytes) || maxCodeBytes < 1) {
		throw new Error(`createExecService: maxCodeBytes must be a positive integer, got ${String(opts.maxCodeBytes)}`);
	}
	const defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (typeof defaultTimeoutMs !== "number" || !Number.isFinite(defaultTimeoutMs) || defaultTimeoutMs <= 0) {
		throw new Error(`createExecService: defaultTimeoutMs must be > 0, got ${String(opts.defaultTimeoutMs)}`);
	}
	const hostIo = opts.hostIo ?? defaultHostIo();

	const slots: Slot[] = Array.from({length: poolSize}, () => ({
		worker: null,
		currentIndexVersion: 0,
		inFlight: null,
		retiring: false,
		broken: false,
		consecutiveFailures: 0,
		queue: [],
		pendingTeardown: null,
	}));
	/** Latest snapshot reference; replaced ONLY on version change (see ensureIndex). */
	let latestSnapshot: IndexSnapshot | undefined;
	let disposed = false;
	let disposePromise: Promise<void> | null = null;
	const counters = {completed: 0, timeouts: 0, cancelled: 0, respawns: 0};

	/** postMessage to a possibly-dead worker: never throws; failure is logged. */
	function tryPost(w: Worker, msg: HostToWorker): void {
		try {
			w.postMessage(msg);
		} catch (e) {
			// Expected during timeout/cancel races — the thread is gone, its pending
			// IO promises die with it (terminate is the documented fallback).
			console.error("[dataview/exec] postMessage to worker failed:", e);
		}
	}

	function spawn(slot: Slot): void {
		try {
			// resourceLimits: a runaway heap allocation in user code OOM-kills only
			// this worker (host `error` event → job error + respawn), never the
			// extension host. Isolation limit, not a malicious-code boundary.
			const w = new Worker(opts.workerPath, {resourceLimits: {maxOldGenerationSizeMb: 256}});
			slot.worker = w;
			slot.currentIndexVersion = 0;
			w.on("message", (raw: unknown) => onWorkerMessage(slot, w, raw));
			w.on("error", (err: Error) => onWorkerGone(slot, w, `worker error: ${err.message}`));
			w.on("exit", (code: number) => onWorkerGone(slot, w, `worker exited with code ${code}`));
		} catch (e) {
			slot.worker = null;
			slot.broken = true;
			flushSlot(slot, `Dataview worker spawn failed: ${errMsg(e)}`);
		}
	}

	function settleInFlight(slot: Slot, inflight: InFlight, message: string): void {
		if (slot.inFlight !== inflight) {
			return; // already resolved by a racing done/timeout/cancel
		}
		slot.inFlight = null;
		clearTimeout(inflight.timer);
		inflight.resolve(errResult(inflight.job, message, Date.now() - inflight.startedAt));
	}

	function failInFlight(slot: Slot, message: string): void {
		const inflight = slot.inFlight;
		if (inflight) {
			settleInFlight(slot, inflight, message);
		}
	}

	function flushSlot(slot: Slot, message: string): void {
		const pending = slot.queue.splice(0, slot.queue.length);
		for (const q of pending) {
			q.resolve(errResult(q.job, message, Date.now() - q.enqueuedAt));
		}
	}

	function retireAndRespawn(slot: Slot, reason: string): Promise<void> {
		slot.retiring = true;
		const w = slot.worker;
		slot.worker = null;
		slot.currentIndexVersion = 0;
		const teardown = (async () => {
			if (w) {
				try {
					await w.terminate();
				} catch (e) {
					console.error("[dataview/exec] terminate() failed during respawn:", e);
				}
			}
			if (disposed) {
				slot.retiring = false;
				return;
			}
			slot.consecutiveFailures++;
			if (slot.consecutiveFailures >= MAX_SPAWN_FAILURES) {
				// Entry script itself is broken (fails before `ready`): stop the
				// respawn loop instead of spinning forever.
				slot.broken = true;
				slot.retiring = false;
				flushSlot(slot, `Dataview worker unavailable (repeated failures: ${reason})`);
				return;
			}
			counters.respawns++;
			spawn(slot);
			slot.retiring = false;
			pump();
		})();
		slot.pendingTeardown = teardown;
		return teardown;
	}

	function onWorkerGone(slot: Slot, w: Worker, reason: string): void {
		// Identity + retiring guards: intentional terminate (timeout/cancel/dispose)
		// already settled the job; a stale event must not double-resolve or
		// double-count respawns.
		if (disposed || slot.retiring || slot.worker !== w) {
			return;
		}
		failInFlight(slot, `Dataview worker crashed: ${reason}`);
		void retireAndRespawn(slot, reason);
	}

	function onWorkerMessage(slot: Slot, w: Worker, raw: unknown): void {
		if (!raw || typeof raw !== "object" || typeof (raw as {t?: unknown}).t !== "string") {
			console.error("[dataview/exec] malformed worker message dropped:", raw);
			return;
		}
		const msg = raw as WorkerToHost;
		switch (msg.t) {
			case "ready":
				// Never rewind: a run dispatched before `ready` arrived may already
				// have posted syncIndex; max() keeps the optimistic version.
				slot.currentIndexVersion = Math.max(slot.currentIndexVersion, msg.indexVersion);
				slot.consecutiveFailures = 0; // boot succeeded — reset the spawn-failure guard
				return;
			case "done": {
				const inflight = slot.inFlight;
				if (!inflight || slot.worker !== w || inflight.job.id !== msg.result?.id) {
					return; // late/duplicate done after timeout/cancel — already resolved
				}
				slot.inFlight = null;
				clearTimeout(inflight.timer);
				counters.completed++;
				inflight.resolve({
					id: inflight.job.id,
					ok: msg.result.ok === true,
					ops: Array.isArray(msg.result.ops) ? msg.result.ops : [],
					error: msg.result.error,
					durationMs: typeof msg.result.durationMs === "number" && msg.result.durationMs >= 0 ? msg.result.durationMs : 0,
					indexVersion: typeof msg.result.indexVersion === "number" ? msg.result.indexVersion : inflight.job.indexVersion,
				});
				pump();
				return;
			}
			case "io":
				serviceIo(w, msg);
				return;
			case "log": {
				// No log sink in ExecServiceOptions — mirror to host console for debuggability.
				const sink = msg.level === "error" ? console.error : msg.level === "warn" ? console.warn : console.log;
				sink(`[dataview/exec worker${msg.jobId ? ` ${msg.jobId}` : ""}] ${msg.message}`);
				return;
			}
			default:
				console.error("[dataview/exec] unknown worker message:", (raw as {t: string}).t);
		}
	}

	function serviceIo(w: Worker, msg: {t: "io"; id: string; op: "read" | "exists"; path: string}): void {
		const work = msg.op === "read"
			? Promise.resolve().then(() => hostIo.read(msg.path)).then((v) => String(v))
			: Promise.resolve().then(() => hostIo.exists(msg.path)).then((v) => (v ? "true" : "false"));
		work
			.then((value) => {
				tryPost(w, {t: "ioResult", id: msg.id, ok: true, value});
			})
			.catch((e: unknown) => {
				tryPost(w, {t: "ioResult", id: msg.id, ok: false, error: errMsg(e)});
			});
	}

	function onTimeout(slot: Slot, w: Worker, job: ExecJob, timeoutMs: number): void {
		const inflight = slot.inFlight;
		if (!inflight || slot.worker !== w || inflight.job.id !== job.id) {
			return; // completed/replaced before the timer fired
		}
		settleInFlight(slot, inflight, `Dataview job timed out after ${timeoutMs}ms`);
		counters.timeouts++;
		// The timeout MUST kill the process-level worker: `while(true){}` never
		// yields to the worker message loop, so only terminate() interrupts it.
		void retireAndRespawn(slot, "timeout");
	}

	// Sticky routing: same pagePath ⇒ same slot (sha1-based, deterministic).
	// Perf rationale: each syncIndex structured-clones the whole snapshot
	// (potentially several MB) across postMessage; pinning a page to a slot
	// means the snapshot is re-sent only on index version bumps — not per job.
	function hashSlot(pagePath: string): number {
		const hex = hashKey(pagePath).slice(0, 8);
		return (parseInt(hex, 16) >>> 0) % poolSize;
	}

	function dispatch(slot: Slot, q: Queued): void {
		const job = q.job;
		const w = slot.worker;
		if (!w || slot.broken) {
			q.resolve(errResult(job, "Dataview worker unavailable", Date.now() - q.enqueuedAt));
			return;
		}
		if (job.indexVersion > slot.currentIndexVersion) {
			// Worker lags behind what this job wants: send syncIndex first.
			// Same-port messages are FIFO, so run always sees the new snapshot.
			if (!latestSnapshot || latestSnapshot.version < job.indexVersion) {
				q.resolve(errResult(job, `Dataview index not ready (wanted v${job.indexVersion}, have v${latestSnapshot?.version ?? 0})`, Date.now() - q.enqueuedAt));
				return;
			}
			tryPost(w, {t: "syncIndex", version: latestSnapshot.version, snapshot: latestSnapshot});
			slot.currentIndexVersion = latestSnapshot.version;
		}
		const timeoutMs = job.timeoutMs > 0 ? job.timeoutMs : defaultTimeoutMs;
		const startedAt = Date.now();
		const timer = setTimeout(() => onTimeout(slot, w, job, timeoutMs), timeoutMs);
		slot.inFlight = {job, resolve: q.resolve, startedAt, timer};
		tryPost(w, {t: "run", job});
	}

	function pump(): void {
		if (disposed) {
			return;
		}
		// Scan every slot (not just a global head): a job whose sticky slot is
		// busy waits in ITS slot's FIFO while other slots keep draining — this
		// preserves per-page ordering without head-of-line blocking the pool.
		for (const slot of slots) {
			if (slot.broken) {
				flushSlot(slot, "Dataview worker unavailable (repeated failures)");
				continue;
			}
			if (slot.inFlight || slot.retiring || slot.queue.length === 0) {
				continue;
			}
			if (!slot.worker) {
				spawn(slot); // lazy spawn
			}
			if (!slot.worker || slot.broken) {
				continue;
			}
			const q = slot.queue.shift();
			if (q) {
				dispatch(slot, q);
			}
		}
	}

	function ensureIndex(snapshot: IndexSnapshot): void {
		if (!snapshot || typeof snapshot.version !== "number") {
			throw new Error("ensureIndex: snapshot with a numeric version is required");
		}
		// Cache the reference and replace ONLY on version change: callers may
		// hand over an equal-but-fresh object on every refresh; keeping the old
		// reference avoids a needless re-clone of every page at the worker
		// boundary (equality check is version-only — deep-comparing pages would
		// cost more than the clone it saves).
		if (latestSnapshot && latestSnapshot.version === snapshot.version) {
			return;
		}
		latestSnapshot = snapshot;
	}

	function run(job: ExecJob): Promise<ExecResult> {
		return new Promise<ExecResult>((resolve) => {
			if (disposed) {
				resolve(errResult(job, "Dataview exec service disposed", 0));
				return;
			}
			if (job.code.length > maxCodeBytes) {
				resolve(errResult(job, `Dataview job code too large (${job.code.length} > ${maxCodeBytes} bytes)`, 0));
				return;
			}
			let queuedCount = 0;
			for (const s of slots) {
				queuedCount += s.queue.length;
			}
			if (queuedCount >= maxQueue) {
				resolve(errResult(job, "queue full", 0));
				return;
			}
			const slot = slots[hashSlot(job.pagePath)];
			slot.queue.push({job, resolve, enqueuedAt: Date.now()});
			try {
				pump();
			} catch (e) {
				// Contract: run() never rejects — surface scheduler failures as a result.
				const i = slot.queue.findIndex((q) => q.job.id === job.id);
				if (i >= 0) {
					slot.queue.splice(i, 1);
					resolve(errResult(job, `Dataview exec scheduling failed: ${errMsg(e)}`, 0));
				}
			}
		});
	}

	function cancel(jobId: string): void {
		if (disposed) {
			return;
		}
		for (const slot of slots) {
			const qi = slot.queue.findIndex((q) => q.job.id === jobId);
			if (qi >= 0) {
				const q = slot.queue.splice(qi, 1)[0];
				counters.cancelled++;
				q.resolve(errResult(q.job, "Dataview job cancelled", Date.now() - q.enqueuedAt));
				return;
			}
		}
		for (const slot of slots) {
			const inflight = slot.inFlight;
			if (!inflight || inflight.job.id !== jobId) {
				continue;
			}
			settleInFlight(slot, inflight, "Dataview job cancelled");
			counters.cancelled++;
			if (slot.worker) {
				tryPost(slot.worker, {t: "cancel", id: jobId}); // worker marks + drops late done
			}
			void retireAndRespawn(slot, "cancelled");
			return;
		}
		// Unknown id: already finished or never existed — idempotent no-op.
	}

	function stats(): ExecStats {
		let queued = 0;
		let running = 0;
		for (const s of slots) {
			queued += s.queue.length;
			if (s.inFlight) {
				running++;
			}
		}
		return {
			poolSize,
			queued,
			running,
			completed: counters.completed,
			timeouts: counters.timeouts,
			cancelled: counters.cancelled,
			respawns: counters.respawns,
		};
	}

	function dispose(): Promise<void> {
		if (!disposePromise) {
			disposed = true;
			disposePromise = (async () => {
				for (const slot of slots) {
					flushSlot(slot, "Dataview exec service disposed");
					failInFlight(slot, "Dataview exec service disposed");
				}
				await Promise.all(slots.map(async (slot) => {
					if (slot.pendingTeardown) {
						await slot.pendingTeardown; // in-progress timeout/cancel kill finishes first (no respawn: disposed)
					}
					const w = slot.worker;
					if (!w) {
						return;
					}
					slot.worker = null;
					slot.retiring = true; // suppress crash handlers during teardown
					try {
						await w.terminate();
					} catch (e) {
						console.error("[dataview/exec] terminate() failed during dispose:", e);
					}
				}));
			})();
		}
		return disposePromise;
	}

	return {ensureIndex, run, cancel, stats, dispose};
}
