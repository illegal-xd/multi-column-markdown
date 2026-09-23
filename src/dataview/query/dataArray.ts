/**
 * Golden DataArray implementation — Obsidian Dataview-compatible surface
 * (contract: types.ts `DataArray`).
 *
 * Upstream Dataview hands user code a Proxy over a JS array, and the canonical
 * docs idioms depend on two indexing behaviours a plain class cannot provide:
 *   - `arr[0]`   → numeric indexing (out of range → undefined)
 *   - `arr.file` → "swizzling": project `field` over every element, flatten one
 *                  level, skip nullish entries  (`dv.pages().file.name`)
 * Both live in the Proxy `get` trap below. Own API members (`length`, every
 * method) win over swizzling, so `arr.length` never reads an element's field.
 *
 * Perf notes (regression-guarded by the [perf] case in
 * test/dataview-dataarray.test.mjs):
 *  - Instances are nearly free: the method table is ONE shared prototype
 *    (`DataArrayCore`) and the backing buffer lives in a module-level WeakMap
 *    keyed by the proxy, so creating a DataArray allocates only `{}` + a Proxy
 *    — no per-instance closures (a per-instance 50-closure literal used to cost
 *    ~20us, i.e. more than the whole 1000-element projection it wrapped).
 *  - The `get` trap does no `Object.entries`/iteration work: API names are
 *    answered from a prototype-derived Set (O(1)), only unknown string keys
 *    reach the swizzle path.
 *  - Swizzling is ONE pass: pre-split path segments, single-segment fast path,
 *    preallocated output buffer, no per-element dictionary rebuild.
 *  - `sort` uses an index-decorated stable sort (Schwartzian transform), so the
 *    key function runs O(n) times instead of O(n log n).
 */
import type {DataArray, FieldSpec} from "../types";

// ---------------------------------------------------------------------------
// Field access
// ---------------------------------------------------------------------------

/** Split a (possibly dotted) field path once; `null` = identity ("", "this"). */
function pathSegments(path: string): string[] | null {
	if (path === "" || path === "this") return null;
	return path.includes(".") ? path.split(".") : [path];
}

/** Read a pre-split path; a nullish intermediate short-circuits to undefined. */
function readSegments(obj: unknown, segments: string[]): unknown {
	let cur: unknown = obj;
	for (let i = 0; i < segments.length; i++) {
		if (cur === null || cur === undefined) return undefined;
		cur = (cur as Record<string, unknown>)[segments[i]!];
	}
	return cur;
}

/**
 * Key extractor for `sort`/`groupBy`/`distinct`/aggregations.
 * `undefined` = identity, string = dotted field path (split once here),
 * function = used as-is.
 */
function keyExtractor<T, U>(key: FieldSpec<T> | ((v: T, i: number) => U) | undefined): (v: T, i: number) => U {
	if (key === undefined) return (v) => v as unknown as U;
	if (typeof key === "function") return key as (v: T, i: number) => U;
	const segs = pathSegments(key);
	if (segs === null) return (v) => v as unknown as U;
	return (v) => readSegments(v, segs) as U;
}

/** Dataview ordering: null/undefined last (asc), dates by millis, case-insensitive strings. */
export function compareValues(a: unknown, b: unknown): number {
	const an = a === null || a === undefined;
	const bn = b === null || b === undefined;
	if (an && bn) return 0;
	if (an) return 1;
	if (bn) return -1;
	if (typeof a === "number" && typeof b === "number") return a - b;
	if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1;
	const am = (a as {toMillis?: () => number}).toMillis;
	const bm = (b as {toMillis?: () => number}).toMillis;
	if (typeof am === "function" && typeof bm === "function") return am.call(a) - bm.call(b);
	if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
	const as = typeof a === "string" ? a : JSON.stringify(a);
	const bs = typeof b === "string" ? b : JSON.stringify(b);
	return as < bs ? -1 : as > bs ? 1 : 0;
}

/**
 * Every DataArray we hand out. Swizzling/`to`/`expand` recognise nested arrays
 * with one WeakSet hit — the same identity test upstream gets from
 * `value instanceof DataArrayImpl`, and far cheaper than probing two properties
 * on every plain object (`dv.pages().file` is 1000 negative probes).
 */
const WRAPPED = new WeakSet<object>();

/** Identity check: is this one of our DataArrays? */
function isWrappedArray(v: unknown): v is DataArray<unknown> {
	return typeof v === "object" && v !== null && WRAPPED.has(v);
}

/** Real array or DataArray (identity first, duck-typed fallback for `flatten`). */
function isFlattenable(value: unknown): boolean {
	if (Array.isArray(value)) return true;
	if (typeof value !== "object" || value === null) return false;
	if (WRAPPED.has(value)) return true;
	// Foreign DataArray-shaped value (see values.ts isDataArray): rare slow path,
	// kept so `flatten()` accepts the same shapes it always did.
	return (
		typeof (value as {array?: unknown}).array === "function" &&
		typeof (value as {flatten?: unknown}).flatten === "function"
	);
}

/** Numeric index key ("0", "-3"); "1.5"/"10px"/"01" are NOT indexes (unlike upstream's parseInt). */
function isIndexKey(prop: string): boolean {
	if (prop.length === 0) return false;
	const n = Number(prop);
	return Number.isInteger(n) && String(n) === prop;
}

// ---------------------------------------------------------------------------
// Shared state (the proxy is the key — methods are receiver-agnostic)
// ---------------------------------------------------------------------------

interface ArrayState<T> {
	items: T[];
	/** The proxy itself: `mutate` must return the very same array for chaining. */
	self: DataArray<T>;
}

const STATES = new WeakMap<object, ArrayState<unknown>>();

function stateOf<T>(self: unknown): ArrayState<T> {
	return STATES.get(self as object) as ArrayState<T>;
}

// ---------------------------------------------------------------------------
// Module-level operation implementations (no per-instance closures)
// ---------------------------------------------------------------------------

/** Numeric projection for sum/min/max/mean/median (skips non-finite values). */
function numericValues<T>(items: T[], field?: FieldSpec<T>): number[] {
	const fn = keyExtractor<T, unknown>(field);
	const out: number[] = [];
	for (let i = 0; i < items.length; i++) {
		const n = Number(fn(items[i]!, i));
		if (Number.isFinite(n)) out.push(n);
	}
	return out;
}

function meanOf<T>(items: T[], field?: FieldSpec<T>): number {
	const ns = numericValues(items, field);
	return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : 0;
}

function sortImpl<T, U>(
	items: T[],
	key: FieldSpec<T> | ((v: T, i: number) => U) | undefined,
	direction: "asc" | "desc" | undefined,
	comparator?: (a: U, b: U) => number,
): DataArray<T> {
	const extract = keyExtractor<T, U>(key);
	const cmp = comparator ?? (compareValues as (a: U, b: U) => number);
	const dir = direction === "desc" ? -1 : 1;
	// Schwartzian: decorate with the index for stability, one comparator pass.
	const decorated = new Array<{v: T; i: number; k: U}>(items.length);
	for (let i = 0; i < items.length; i++) decorated[i] = {v: items[i]!, i, k: extract(items[i]!, i)};
	decorated.sort((a, b) => {
		const c = cmp(a.k, b.k);
		return c !== 0 ? c * dir : a.i - b.i;
	});
	const out = new Array<T>(items.length);
	for (let i = 0; i < decorated.length; i++) out[i] = decorated[i]!.v;
	return createDataArray(out);
}

/**
 * Swizzle one field over every element: skip nullish, flatten arrays /
 * DataArrays one level. Single pass, pre-split segments, preallocated buffer.
 */
function project<T>(items: T[], key: string): {values: unknown[]; hits: number} {
	const segs = pathSegments(key);
	const single = segs !== null && segs.length === 1;
	const field = single ? segs![0]! : "";
	const out = new Array<unknown>(items.length);
	let n = 0;
	let hits = 0;
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		if (item === null || item === undefined) continue;
		const value = single
			? (item as Record<string, unknown>)[field]
			: segs === null
				? item
				: readSegments(item, segs);
		if (value === null || value === undefined) continue;
		hits++;
		if (Array.isArray(value)) {
			for (let j = 0; j < value.length; j++) out[n++] = value[j];
		} else if (isWrappedArray(value)) {
			const inner = value.array();
			for (let j = 0; j < inner.length; j++) out[n++] = inner[j];
		} else {
			out[n++] = value;
		}
	}
	if (n !== out.length) out.length = n;
	return {values: out, hits};
}

/**
 * `[field]` proxy read: "swizzling". Upstream returns an EMPTY data array when no
 * element carries the field (its Proxy maps over elements and drops undefined),
 * so chains like `dv.pages("#books").genres` on a vault without `genres` yield an
 * empty list rather than a TypeError on the next `.length`.
 */
function swizzle<T>(items: T[], key: string): DataArray<unknown> {
	const {values} = project(items, key);
	return createDataArray(values);
}

function groupByImpl<T, U>(
	items: T[],
	key: FieldSpec<T> | ((v: T, i: number) => U),
	comparator?: (a: U, b: U) => number,
): DataArray<{key: U; rows: DataArray<T>}> {
	const extract = keyExtractor<T, U>(key);
	const groups: Array<{key: U; rows: T[]}> = [];
	if (comparator) {
		// Custom equality: comparator(a, b) === 0 merges two keys.
		for (let i = 0; i < items.length; i++) {
			const k = extract(items[i]!, i);
			let hit: {key: U; rows: T[]} | undefined;
			for (let g = 0; g < groups.length; g++) {
				if (comparator(groups[g]!.key, k) === 0) {
					hit = groups[g];
					break;
				}
			}
			if (hit) hit.rows.push(items[i]!);
			else groups.push({key: k, rows: [items[i]!]});
		}
	} else {
		// Default equality: Map key identity; first-seen order is preserved.
		const index = new Map<unknown, {key: U; rows: T[]}>();
		for (let i = 0; i < items.length; i++) {
			const k = extract(items[i]!, i);
			const hit = index.get(k);
			if (hit) hit.rows.push(items[i]!);
			else {
				const group = {key: k, rows: [items[i]!]};
				index.set(k, group);
				groups.push(group);
			}
		}
	}
	return createDataArray(groups.map((g) => ({key: g.key, rows: createDataArray(g.rows)})));
}

function uniqueImpl<T>(items: T[]): DataArray<T> {
	const seen = new Set<unknown>();
	const out: T[] = [];
	for (const v of items) {
		const k = typeof v === "object" && v !== null ? JSON.stringify(v) : v;
		if (!seen.has(k)) {
			seen.add(k);
			out.push(v);
		}
	}
	return createDataArray(out);
}

function distinctImpl<T, U>(
	items: T[],
	key: FieldSpec<T> | ((v: T, i: number) => U) | undefined,
	comparator?: (a: U, b: U) => number,
): DataArray<T> {
	// No key → keep the historical (JSON-value) dedupe used by `unique()`.
	if (key === undefined && comparator === undefined) return uniqueImpl(items);
	const extract = keyExtractor<T, U>(key);
	const out: T[] = [];
	if (comparator) {
		const keys: U[] = [];
		for (let i = 0; i < items.length; i++) {
			const k = extract(items[i]!, i);
			let dup = false;
			for (let j = 0; j < keys.length; j++) {
				if (comparator(keys[j]!, k) === 0) {
					dup = true;
					break;
				}
			}
			if (!dup) {
				keys.push(k);
				out.push(items[i]!);
			}
		}
	} else {
		const seen = new Set<unknown>();
		for (let i = 0; i < items.length; i++) {
			const k = extract(items[i]!, i);
			if (!seen.has(k)) {
				seen.add(k);
				out.push(items[i]!);
			}
		}
	}
	return createDataArray(out);
}

/** `expand(key)`: depth-first, flat output. Nodes without the key are skipped. */
function expandImpl<T>(items: T[], key: string): DataArray<unknown> {
	const segs = pathSegments(key);
	const out: unknown[] = [];
	// Reverse-push so `pop()` walks siblings in source order (upstream's LIFO
	// stack processes siblings backwards — deliberate deviation, see report).
	const stack: unknown[] = [];
	for (let i = items.length - 1; i >= 0; i--) stack.push(items[i]);
	while (stack.length > 0) {
		const node = stack.pop();
		const value = segs === null ? node : readSegments(node, segs);
		if (value === null || value === undefined) continue;
		out.push(node);
		if (Array.isArray(value)) {
			for (let j = value.length - 1; j >= 0; j--) stack.push(value[j]);
		} else if (isWrappedArray(value)) {
			const inner = value.array();
			for (let j = inner.length - 1; j >= 0; j--) stack.push(inner[j]);
		} else {
			stack.push(value);
		}
	}
	return createDataArray(out);
}

// ---------------------------------------------------------------------------
// Shared method table — ONE object for every DataArray instance
// ---------------------------------------------------------------------------

/**
 * All methods live here. They never read `this.items`; they look the backing
 * buffer up in `STATES` by the received proxy, which keeps the per-instance
 * cost at "one empty object + one Proxy".
 */
class DataArrayCore<T> {
	get length(): number {
		return stateOf<T>(this).items.length;
	}

	[Symbol.iterator](): Iterator<T> {
		return stateOf<T>(this).items[Symbol.iterator]();
	}

	array(): T[] {
		// Defensive copy: callers may mutate the result (Dataview semantics).
		return stateOf<T>(this).items.slice();
	}

	isEmpty(): boolean {
		return stateOf<T>(this).items.length === 0;
	}

	toJSON(): T[] {
		return stateOf<T>(this).items.slice();
	}

	toString(): string {
		return "[" + stateOf<T>(this).items.join(", ") + "]";
	}

	where(pred: (v: T, i: number, arr: T[]) => boolean): DataArray<T> {
		const items = stateOf<T>(this).items;
		const out: T[] = [];
		for (let i = 0; i < items.length; i++) if (pred(items[i]!, i, items)) out.push(items[i]!);
		return createDataArray(out);
	}

	filter(pred: (v: T, i: number, arr: T[]) => boolean): DataArray<T> {
		return this.where(pred);
	}

	map<U>(fn: (v: T, i: number, arr: T[]) => U): DataArray<U> {
		const items = stateOf<T>(this).items;
		const out = new Array<U>(items.length);
		for (let i = 0; i < items.length; i++) out[i] = fn(items[i]!, i, items);
		return createDataArray(out);
	}

	flatMap<U>(fn: (v: T, i: number, arr: T[]) => U[] | DataArray<U>): DataArray<U> {
		const items = stateOf<T>(this).items;
		const out: U[] = [];
		for (let i = 0; i < items.length; i++) {
			const r = fn(items[i]!, i, items);
			if (r === null || r === undefined) continue;
			if (Array.isArray(r)) {
				for (let j = 0; j < r.length; j++) out.push(r[j]!);
			} else {
				const inner = (r as DataArray<U>).array();
				for (let j = 0; j < inner.length; j++) out.push(inner[j]!);
			}
		}
		return createDataArray(out);
	}

	mutate(fn: (v: T, i: number, arr: T[]) => unknown): DataArray<unknown> {
		// In place, and returns the same proxy so chaining keeps the surface.
		const st = stateOf<T>(this);
		const items = st.items;
		for (let i = 0; i < items.length; i++) fn(items[i]!, i, items);
		return st.self as unknown as DataArray<unknown>;
	}

	limit(n: number): DataArray<T> {
		return createDataArray(stateOf<T>(this).items.slice(0, Math.max(0, n)));
	}

	take(n: number): DataArray<T> {
		return createDataArray(stateOf<T>(this).items.slice(0, Math.max(0, n)));
	}

	slice(start?: number, end?: number): DataArray<T> {
		return createDataArray(stateOf<T>(this).items.slice(start, end));
	}

	concat(other: Iterable<T>): DataArray<T> {
		const items = stateOf<T>(this).items;
		const out = items.slice();
		if (other === null || other === undefined) return createDataArray(out);
		if (typeof (other as {[Symbol.iterator]?: unknown})[Symbol.iterator] === "function") {
			for (const v of other) out.push(v);
		} else {
			out.push(other as T);
		}
		return createDataArray(out);
	}

	indexOf(element: T, fromIndex = 0): number {
		// Upstream compares with the dataview comparator, not `===`.
		const items = stateOf<T>(this).items;
		const start = fromIndex < 0 ? Math.max(0, items.length + fromIndex) : fromIndex;
		for (let i = start; i < items.length; i++) if (compareValues(items[i], element) === 0) return i;
		return -1;
	}

	includes(element: T): boolean {
		return this.indexOf(element, 0) !== -1;
	}

	find(pred: (v: T, i: number, arr: T[]) => boolean): T | undefined {
		const items = stateOf<T>(this).items;
		for (let i = 0; i < items.length; i++) if (pred(items[i]!, i, items)) return items[i];
		return undefined;
	}

	findIndex(pred: (v: T, i: number, arr: T[]) => boolean, fromIndex = 0): number {
		const items = stateOf<T>(this).items;
		const start = fromIndex < 0 ? Math.max(0, items.length + fromIndex) : fromIndex;
		for (let i = start; i < items.length; i++) if (pred(items[i]!, i, items)) return i;
		return -1;
	}

	join(sep = ", "): string {
		return stateOf<T>(this)
			.items.map((v) => (v === null || v === undefined ? "" : String(v)))
			.join(sep);
	}

	sort<U = T>(
		key?: FieldSpec<T> | ((v: T, i: number) => U),
		direction: "asc" | "desc" = "asc",
		comparator?: (a: U, b: U) => number,
	): DataArray<T> {
		return sortImpl<T, U>(stateOf<T>(this).items, key, direction, comparator);
	}

	ordered(key?: FieldSpec<T>, direction: "asc" | "desc" = "asc"): DataArray<T> {
		return sortImpl<T, unknown>(stateOf<T>(this).items, key, direction);
	}

	groupBy<U = unknown>(
		key: FieldSpec<T> | ((v: T, i: number) => U),
		comparator?: (a: U, b: U) => number,
	): DataArray<{key: U; rows: DataArray<T>}> {
		return groupByImpl<T, U>(stateOf<T>(this).items, key, comparator);
	}

	groupIn(): DataArray<{key: unknown; rows: DataArray<T>}> {
		const items = stateOf<T>(this).items;
		return createDataArray([{key: items.slice(), rows: createDataArray(items.slice())}]);
	}

	distinct<U = T>(
		key?: FieldSpec<T> | ((v: T, i: number) => U),
		comparator?: (a: U, b: U) => number,
	): DataArray<T> {
		return distinctImpl<T, U>(stateOf<T>(this).items, key, comparator);
	}

	unique(): DataArray<T> {
		return uniqueImpl(stateOf<T>(this).items);
	}

	every(pred: (v: T, i: number) => boolean): boolean {
		const items = stateOf<T>(this).items;
		for (let i = 0; i < items.length; i++) if (!pred(items[i]!, i)) return false;
		return true;
	}

	some(pred: (v: T, i: number) => boolean): boolean {
		const items = stateOf<T>(this).items;
		for (let i = 0; i < items.length; i++) if (pred(items[i]!, i)) return true;
		return false;
	}

	none(pred: (v: T, i: number) => boolean): boolean {
		const items = stateOf<T>(this).items;
		for (let i = 0; i < items.length; i++) if (pred(items[i]!, i)) return false;
		return true;
	}

	any(pred?: (v: T, i: number) => boolean): boolean {
		const items = stateOf<T>(this).items;
		if (!pred) return items.length > 0;
		for (let i = 0; i < items.length; i++) if (pred(items[i]!, i)) return true;
		return false;
	}

	first(): T | undefined {
		const items = stateOf<T>(this).items;
		return items.length > 0 ? items[0] : undefined;
	}

	last(): T | undefined {
		const items = stateOf<T>(this).items;
		return items.length > 0 ? items[items.length - 1] : undefined;
	}

	to(key: string): DataArray<unknown> {
		// Explicit call: always a DataArray, even when nothing matched.
		return createDataArray(project(stateOf<T>(this).items, key).values);
	}

	expand(key: string): DataArray<unknown> {
		return expandImpl(stateOf<T>(this).items, key);
	}

	forEach(fn: (v: T, i: number, arr: T[]) => void): void {
		const items = stateOf<T>(this).items;
		for (let i = 0; i < items.length; i++) fn(items[i]!, i, items);
	}

	sum(field?: FieldSpec<T>): number {
		let s = 0;
		for (const n of numericValues(stateOf<T>(this).items, field)) s += n;
		return s;
	}

	total(): number {
		const items = stateOf<T>(this).items;
		let sum = 0;
		for (let i = 0; i < items.length; i++) sum += Number(items[i]) || 0;
		return sum;
	}

	avg(field?: FieldSpec<T>): number {
		return meanOf(stateOf<T>(this).items, field);
	}

	mean(field?: FieldSpec<T>): number {
		return meanOf(stateOf<T>(this).items, field);
	}

	median(field?: FieldSpec<T>): number {
		const ns = numericValues(stateOf<T>(this).items, field).sort((a, b) => a - b);
		if (!ns.length) return 0;
		const mid = ns.length >> 1;
		return ns.length % 2 ? ns[mid]! : (ns[mid - 1]! + ns[mid]!) / 2;
	}

	min(field?: FieldSpec<T>): number {
		const ns = numericValues(stateOf<T>(this).items, field);
		if (!ns.length) return 0;
		let m = ns[0]!;
		for (let i = 1; i < ns.length; i++) if (ns[i]! < m) m = ns[i]!;
		return m;
	}

	max(field?: FieldSpec<T>): number {
		const ns = numericValues(stateOf<T>(this).items, field);
		if (!ns.length) return 0;
		let m = ns[0]!;
		for (let i = 1; i < ns.length; i++) if (ns[i]! > m) m = ns[i]!;
		return m;
	}

	reverse(): DataArray<T> {
		return createDataArray(stateOf<T>(this).items.slice().reverse());
	}

	flatten(): DataArray<unknown> {
		// Single-level flatten (unchanged existing semantics).
		const items = stateOf<T>(this).items;
		const out: unknown[] = [];
		for (let i = 0; i < items.length; i++) {
			const v = items[i];
			if (Array.isArray(v)) {
				for (let j = 0; j < v.length; j++) out.push(v[j]);
			} else if (isFlattenable(v)) {
				const inner = (v as DataArray<unknown>).array();
				for (let j = 0; j < inner.length; j++) out.push(inner[j]);
			} else {
				out.push(v);
			}
		}
		return createDataArray(out);
	}
}

/** The shared method table. */
const PROTO: Record<PropertyKey, unknown> = DataArrayCore.prototype as unknown as Record<PropertyKey, unknown>;

/**
 * API names that must beat swizzling. Derived from the prototype so a new
 * method can never silently lose priority to an element field.
 */
const API_MEMBERS: Set<string> = new Set(Object.getOwnPropertyNames(DataArrayCore.prototype));

const HANDLER: ProxyHandler<object> = {
	get(_target: object, prop: string | symbol, receiver: object): unknown {
		if (typeof prop === "symbol") return PROTO[prop];
		if (prop === "length") return (STATES.get(receiver) as ArrayState<unknown>).items.length;
		if (prop === "constructor") return Array; // upstream parity (values.constructor)
		if (API_MEMBERS.has(prop)) return PROTO[prop];
		const items = (STATES.get(receiver) as ArrayState<unknown>).items;
		if (isIndexKey(prop)) return items[Number(prop)];
		// Anything else is Dataview swizzling: `arr.file`, `arr.file.name`, …
		return swizzle(items, prop);
	},
};

/**
 * Create a DataArray over `items`.
 *
 * Cost per instance: one empty target object + one Proxy + one WeakMap entry.
 * Methods come from the shared `DataArrayCore` prototype and locate their
 * buffer through `STATES`, so no closures are allocated per array.
 */
export function createDataArray<T>(items: T[]): DataArray<T> {
	const target = {};
	const proxy = new Proxy(target, HANDLER) as unknown as DataArray<T>;
	STATES.set(proxy, {items, self: proxy} as ArrayState<unknown>);
	WRAPPED.add(proxy as unknown as object);
	return proxy;
}
