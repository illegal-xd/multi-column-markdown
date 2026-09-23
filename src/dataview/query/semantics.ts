/**
 * Shared value semantics for the expression engine and DvFunctions.
 *
 * Kept in its own module so expression.ts (parser/evaluator) and functions.ts
 * (builtin table) can both use it WITHOUT a circular import:
 *   expression → {semantics, functions}, functions → {semantics, dataArray, …}.
 */
import type {DataArray, DvValue, Link} from "../types";
import {compareValues} from "./dataArray";
import {isDataArray, isDvDate, isDuration, isLink} from "../values";
import {createLink} from "../link";

/** Dataview/JS truthiness used by and/or/not and DQL WHERE. */
export function truthy(v: DvValue): boolean {
	if (v === null || v === undefined || v === false) return false;
	if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
	if (typeof v === "string") return v.length > 0;
	return true;
}

function millisOf(v: unknown): number | null {
	if (v instanceof Date) return v.getTime();
	if (isDvDate(v)) return v.toMillis();
	return null;
}

/**
 * Dataview `==` semantics:
 *   null == null  → true; null vs anything else → false (undefined ≡ null);
 *   primitives strict; dates by millis; durations by ms; links by path;
 *   arrays element-wise; plain objects by own-key/value set.
 */
export function looseEquals(a: DvValue, b: DvValue): boolean {
	if (a === undefined) a = null;
	if (b === undefined) b = null;
	if (a === null || b === null) return a === b;
	if (typeof a === "number" || typeof a === "string" || typeof a === "boolean") return a === b;
	const am = millisOf(a);
	if (am !== null) return millisOf(b) === am;
	if (isDuration(a)) return isDuration(b) && a.ms === b.ms;
	if (isLink(a)) return isLink(b) && a.path === b.path && a.subpath === b.subpath;
	if (Array.isArray(a)) {
		if (isDataArray(b)) b = b.array() as DvValue;
		if (!Array.isArray(b) || a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) if (!looseEquals(a[i]!, b[i]!)) return false;
		return true;
	}
	if (isDataArray(a)) return looseEquals(a.array() as DvValue, b);
	if (typeof a === "object" && typeof b === "object" && b !== null && !Array.isArray(b) && !isDataArray(b)) {
		const ao = a as Record<string, DvValue>;
		const bo = b as Record<string, DvValue>;
		if (isDvDate(ao) || isDvDate(bo) || isLink(ao) || isDuration(ao)) return a === b;
		const ak = Object.keys(ao);
		const bk = Object.keys(bo);
		if (ak.length !== bk.length) return false;
		for (const k of ak) {
			if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
			if (!looseEquals(ao[k]!, bo[k]!)) return false;
		}
		return true;
	}
	return a === b;
}

/** array/DataArray → plain array; anything else → null (not an array). */
export function toArrayOrNull(v: DvValue): DvValue[] | null {
	if (Array.isArray(v)) return v;
	if (isDataArray(v)) return (v as DataArray<DvValue>).array();
	return null;
}

/** Field-path projection used by sort(array, "a.b"): ""/"this" = identity. */
export function pathGet(obj: unknown, path: string): unknown {
	if (path === "" || path === "this") return obj;
	let cur: unknown = obj;
	for (const seg of path.split(".")) {
		if (cur === null || cur === undefined) return undefined;
		cur = (cur as Record<string, unknown>)[seg];
	}
	return cur;
}

/** Dataview relational operators: null sorts LAST (greatest) via compareValues. */
export function compareRel(a: DvValue, b: DvValue): number {
	return compareValues(a, b);
}

/** Link construction shared by the `link()` builtin and FROM rewrites. */
export function makeLink(path: string, display?: DvValue, embed?: DvValue): Link {
	// Factory (not a literal) so DQL/JS get the Dataview Link method surface
	// (`asFile`, `withDisplay`, `markdown`, `type`, …) — upstream parity.
	return createLink({
		path,
		display: typeof display === "string" ? display : undefined,
		embed: embed === true,
	});
}

/** compareValues re-export so executeDql can import from one place if desired. */
export {compareValues};
