/**
 * Failure reporting for the preview render path.
 *
 * Contract: a render failure is **never** turned into document markup. The
 * preview falls back to the author's own source (plain Markdown for a column
 * region, the original code fence for a dataview block), so the reader sees
 * text and layout instead of an error box. The failure itself goes to the
 * developer console — and, for dataview, to the `Dataview: Stats` counters.
 *
 * Deduplication: the preview re-renders on every keystroke, so a deterministic
 * failure would otherwise produce one log line per keystroke. Each distinct
 * `scope + message` is logged once; the set is bounded so a pathological
 * document cannot grow it without limit.
 */
const MAX_LOGGED = 32;
const logged = new Set<string>();

export function logRenderFailure(scope: string, detail: unknown): void {
	const message = detail instanceof Error ? `${detail.name}: ${detail.message}` : String(detail);
	const key = `${scope}\u0000${message}`;
	if (logged.has(key)) return;
	if (logged.size >= MAX_LOGGED) logged.clear();
	logged.add(key);
	// eslint-disable-next-line no-console -- the only place these failures are visible
	console.error(`[amc] ${scope} failed — showing the source instead: ${message}`);
}
