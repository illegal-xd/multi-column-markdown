/**
 * Per-render-pass "dynamic content" scope.
 *
 * The column renderer caches the HTML of a column by its source text, because
 * typing in one column must not re-render the others. That cache is only valid
 * for output that depends on the text alone. Some renderers do not:
 *
 *   - ```dataview / ```dataviewjs fences (state goes pending → ready),
 *   - inline `` `= …` `` / `` `$= …` `` queries (same, and the prefix is
 *     configurable, so a text pattern cannot be used as the gate),
 *   - `![[note]]` embeds (the *target* file changes, not this text).
 *
 * Instead of guessing from the text, those renderers mark the scope while they
 * run; a column whose render marked the scope is not cached. The scope object
 * is created once per preview render pass and shared through the markdown-it
 * `env` (which every nested render spreads), so a dynamic block nested inside a
 * column invalidates the enclosing column too.
 */
export const DYNAMIC_SCOPE_ENV_KEY = "__amcDynamicScope";

export interface RenderScope {
	/** Incremented by every renderer that produced non-text-dependent output. */
	marks: number;
}

function attach(env: unknown, scope: RenderScope): RenderScope {
	if (typeof env === "object" && env !== null) {
		(env as Record<string, unknown>)[DYNAMIC_SCOPE_ENV_KEY] = scope;
	}
	return scope;
}

/** The scope of the current render pass (created on first use). */
export function getRenderScope(env: unknown): RenderScope {
	const existing = (typeof env === "object" && env !== null
		? (env as Record<string, unknown>)[DYNAMIC_SCOPE_ENV_KEY]
		: undefined) as RenderScope | undefined;
	if (existing && typeof existing.marks === "number") return existing;
	return attach(env, {marks: 0});
}

/** Flag "output is not a pure function of the source text" for this pass. */
export function markDynamicContent(env: unknown): void {
	getRenderScope(env).marks += 1;
}
