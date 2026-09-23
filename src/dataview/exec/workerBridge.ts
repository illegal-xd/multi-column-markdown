/**
 * Worker-side protocol bridge (host ⇄ worker message plumbing only).
 *
 * Business execution (vm context, async wrapping of dataviewjs/DQL) is
 * injected via WorkerRuntimeDeps — this file never sees dv/DQL. It owns:
 *   - HostToWorker / WorkerToHost dispatch (plain postMessage, Atomics-free)
 *   - concurrent in-flight job map + per-job IO correlation tables
 *   - late-`done` suppression after `cancel`
 *   - runJob error wrapping ({message, detail: stack}) and console → log fanout
 *
 * Resource limits: the host spawns this script with
 * `new Worker(path, {resourceLimits: {maxOldGenerationSizeMb: 256}})` — heap
 * exhaustion then kills THIS thread (host `error` event → resolve job error +
 * respawn), keeping runaway allocations away from the extension host.
 * Security boundary note: worker threads + resourceLimits + host-side
 * timeout→terminate form a timeout/DoS isolation boundary for buggy or
 * hung code — they are NOT a malicious-code sandbox (no fs/net capability
 * restriction); never run genuinely untrusted code without a further policy.
 */
import {parentPort} from "node:worker_threads";
import type {ExecJob, ExecResult, HostToWorker, IndexSnapshot, IoBridge, WorkerRuntimeDeps, WorkerToHost} from "../types";

const EMPTY_SNAPSHOT: IndexSnapshot = {version: 0, pages: [], generatedAt: 0};

interface PendingIo {
	jobId: string;
	op: "read" | "exists";
	resolve: (value: string) => void;
	reject: (e: Error) => void;
}

interface InFlightJob {
	job: ExecJob;
	cancelled: boolean;
	/** Per-job IO correlation table (ioId → waiter). */
	io: Map<string, PendingIo>;
	startedAt: number;
}

let started = false;

function safeJson(v: unknown): string {
	try {
		return JSON.stringify(v) ?? String(v);
	} catch {
		return String(v); // circular / BigInt payloads fall back to String()
	}
}

export function startWorker(deps: WorkerRuntimeDeps): void {
	if (started) {
		throw new Error("startWorker(): already started in this worker thread");
	}
	started = true;
	const port = parentPort;
	if (!port) {
		throw new Error("startWorker(): must run inside a worker_thread (parentPort is null)");
	}
	if (!deps || typeof deps.runJob !== "function") {
		throw new Error("startWorker(): deps.runJob is required");
	}

	// Original console sinks captured BEFORE patching: internal diagnostics use
	// these so a broken parentPort cannot recurse through the patched console.
	const orig = {log: console.log, info: console.info, warn: console.warn, error: console.error};

	let snapshot: IndexSnapshot = EMPTY_SNAPSHOT;
	let indexVersion = 0;
	let ioSeq = 0;
	const jobs = new Map<string, InFlightJob>();
	const pendingIo = new Map<string, PendingIo>(); // ioId (embeds jobId) → waiter

	/** Never throws: a dead port drops the message (host is already tearing down). */
	const post = (msg: WorkerToHost): void => {
		try {
			port.postMessage(msg); // arrow fn keeps the null-guard narrowing above
		} catch (e) {
			orig.error("[dataview/worker] postMessage failed (host port closed?):", e);
		}
	};

	function requestIo(entry: InFlightJob, op: "read" | "exists", path: string): Promise<string> {
		if (entry.cancelled) {
			return Promise.reject(new Error("job cancelled"));
		}
		const id = `${entry.job.id}#${++ioSeq}`;
		const p = new Promise<string>((resolve, reject) => {
			const waiter: PendingIo = {jobId: entry.job.id, op, resolve, reject};
			pendingIo.set(id, waiter);
			entry.io.set(id, waiter);
			post({t: "io", id, op, path});
		});
		// Pre-attach a no-op catch: if runJob never awaits this promise, the
		// later ioResult rejection must not trip unhandledRejection (which
		// would crash the whole worker). Callers that DO await still see it.
		p.catch(() => undefined);
		return p;
	}

	function rejectJobIo(entry: InFlightJob, reason: string): void {
		for (const [id, waiter] of entry.io) {
			pendingIo.delete(id);
			waiter.reject(new Error(reason));
		}
		entry.io.clear();
	}

	function errorResult(job: ExecJob, err: unknown, startedAt: number): ExecResult {
		const message = err instanceof Error ? err.message : String(err);
		const detail = err instanceof Error && err.stack ? err.stack : undefined;
		return {
			id: job.id,
			ok: false,
			ops: [],
			error: detail === undefined ? {message} : {message, detail},
			durationMs: Date.now() - startedAt,
			indexVersion: job.indexVersion,
		};
	}

	function settle(entry: InFlightJob, result: ExecResult): void {
		if (entry.cancelled) {
			return; // host already resolved cancel/timeout — drop the late done
		}
		jobs.delete(entry.job.id);
		const ok = !!result && result.ok === true;
		const ops = result && Array.isArray(result.ops) ? result.ops : [];
		const durationMs = result && typeof result.durationMs === "number" && result.durationMs >= 0
			? result.durationMs
			: Date.now() - entry.startedAt;
		const indexVersionOut = result && typeof result.indexVersion === "number" ? result.indexVersion : entry.job.indexVersion;
		const error = ok
			? undefined
			: result && result.error
				? result.error
				: {message: "Dataview job failed without an error message"};
		post({
			t: "done",
			result: {id: entry.job.id, ok, ops, error, durationMs, indexVersion: indexVersionOut},
		});
	}

	function onMessage(raw: unknown): void {
		if (!raw || typeof raw !== "object" || typeof (raw as {t?: unknown}).t !== "string") {
			orig.error("[dataview/worker] malformed host message dropped:", raw);
			return;
		}
		const msg = raw as HostToWorker;
		switch (msg.t) {
			case "syncIndex": {
				snapshot = msg.snapshot;
				indexVersion = msg.version;
				return;
			}
			case "run": {
				const job = msg.job;
				if (jobs.has(job.id)) {
					// Duplicate id = host protocol bug; answering keeps the id space sane.
					post({
						t: "done",
						result: {
							id: job.id,
							ok: false,
							ops: [],
							error: {message: "Dataview job id already running"},
							durationMs: 0,
							indexVersion: job.indexVersion,
						},
					});
					return;
				}
				const entry: InFlightJob = {job, cancelled: false, io: new Map(), startedAt: Date.now()};
				jobs.set(job.id, entry);
				const snap = snapshot; // bind: a mid-flight syncIndex must not mutate this job's view
				const io: IoBridge = {
					read: (path) => requestIo(entry, "read", path),
					exists: async (path) => (await requestIo(entry, "exists", path)) === "true",
				};
				void Promise.resolve()
					.then(() => deps.runJob(job, snap, io))
					.then(
						(result) => settle(entry, result),
						(err: unknown) => settle(entry, errorResult(job, err, entry.startedAt)),
					);
				return;
			}
			case "cancel": {
				const entry = jobs.get(msg.id);
				if (!entry) {
					return; // already settled — expected race with `done`
				}
				entry.cancelled = true;
				jobs.delete(msg.id);
				rejectJobIo(entry, "job cancelled");
				// Host terminates this worker for running-job cancels; marking here
				// guarantees a late runJob completion is dropped instead of posting
				// a `done` the host already resolved as cancelled.
				return;
			}
			case "ioResult": {
				const waiter = pendingIo.get(msg.id);
				if (!waiter) {
					return; // IO for a cancelled/settled job — already settled or terminated
				}
				pendingIo.delete(msg.id);
				jobs.get(waiter.jobId)?.io.delete(msg.id);
				if (!msg.ok) {
					waiter.reject(new Error(msg.error));
				} else {
					// exists results travel as "true"/"false" (protocol value is string).
					waiter.resolve(msg.value);
				}
				return;
			}
			case "shutdown": {
				process.exit(0);
				return;
			}
			default: {
				orig.error("[dataview/worker] unknown host message:", (raw as {t: string}).t);
			}
		}
	}

	// Fan console output out as {t:"log"} (+ deps.onLog as an extra sink) so
	// dataviewjs console.log reaches the host. Original methods still run so
	// worker stdout keeps working in debuggers.
	const forward = (level: "info" | "warn" | "error", args: unknown[]): void => {
		const message = args.map((a) => (typeof a === "string" ? a : safeJson(a))).join(" ");
		try {
			deps.onLog?.(level, message);
		} catch (e) {
			orig.error("[dataview/worker] deps.onLog threw:", e);
		}
		post({t: "log", level, message});
	};
	console.log = (...args: unknown[]) => {
		forward("info", args);
		orig.log(...args);
	};
	console.info = (...args: unknown[]) => {
		forward("info", args);
		orig.info(...args);
	};
	console.warn = (...args: unknown[]) => {
		forward("warn", args);
		orig.warn(...args);
	};
	console.error = (...args: unknown[]) => {
		forward("error", args);
		orig.error(...args);
	};

	port.on("message", onMessage);
	post({t: "ready", indexVersion});
}
