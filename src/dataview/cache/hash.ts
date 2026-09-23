import {createHash} from "node:crypto";

/**
 * Stable render-cache key: sha1 over NUL-separated parts, truncated to the
 * first 16 hex chars (64 bits — collision space far beyond cache cardinality).
 * The NUL separator keeps ("a", "bc") distinct from ("ab", "c").
 * Used as the cache key for rendered block HTML / RenderOp memoization.
 */
export function hashKey(...parts: Array<string | number>): string {
	const h = createHash("sha1");
	for (const p of parts) {
		h.update(String(p));
		h.update("\0");
	}
	return h.digest("hex").slice(0, 16);
}
