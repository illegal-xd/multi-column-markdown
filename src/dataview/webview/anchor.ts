/// <reference lib="dom" />
/**
 * Preview scroll anchoring — keeps the reading position (and therefore the
 * editor position) stable across `markdown.preview.refresh`.
 *
 * Why this exists: after a refresh VSCode restores the preview scroll by
 * *progress* (`scrollY / bodyHeight`), and its preview→editor sync then reveals
 * whatever source line ended up at the top of the preview. A dataview block that
 * resolves (placeholder → 1000-row table) changes the document height, so the
 * same progress lands on a **different** source line: the client posts
 * `revealLine`, and the host scrolls/selects that line in the editor — the
 * "editor jumps while I type" symptom.
 *
 * Fix: remember the top-most *source line* (and the offset inside it) before the
 * swap, then restore it after. Inside the preview client's 200ms
 * sync-suppression window this produces no message at all; outside it, the
 * message carries the line the reader was already on.
 *
 * The anchor is re-recorded on every scroll event, so a restore always targets
 * the reader's latest position — it cannot "fight" a scroll: if they moved
 * meanwhile, the recorded line moved with them and the restore is a no-op.
 *
 * Pure geometry (`pickAnchor` / `anchorTop`) is DOM-free and unit-tested; the DOM
 * layer only reads `[data-line]` blocks and calls `scrollTo`.
 */

/** A source-line block in the preview DOM (`data-line`); `top` is document-absolute. */
export interface LineBlock {
	line: number;
	top: number;
}

/** Where the reader is: the block at the top of the viewport + the offset inside it. */
export interface ScrollAnchor {
	line: number;
	offset: number;
}

/** Top-most block at `scrollTop` (blocks sorted by `top`), with the offset inside it. */
export function pickAnchor(blocks: readonly LineBlock[], scrollTop: number): ScrollAnchor | null {
	if (blocks.length === 0) return null;
	let lo = 0;
	let hi = blocks.length - 1;
	let found = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (blocks[mid]!.top <= scrollTop) {
			found = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	// Above the first block → anchor on it with no offset (never a negative offset).
	const block = found >= 0 ? blocks[found]! : blocks[0]!;
	return {line: block.line, offset: Math.max(0, scrollTop - block.top)};
}

/** scrollTop that puts `anchor` back (null when the line no longer exists). */
export function anchorTop(blocks: readonly LineBlock[], anchor: ScrollAnchor): number | null {
	if (blocks.length === 0) return null;
	const exact = blocks.find((b) => b.line === anchor.line);
	if (exact) return exact.top + anchor.offset;
	// The block is gone (edited file): the nearest later line keeps the reader close.
	const later = blocks.find((b) => b.line > anchor.line);
	return later ? later.top : null;
}

// ---------------------------------------------------------------------------
// DOM layer
// ---------------------------------------------------------------------------

/** VSCode writes the source line of every rendered block here. */
const LINE_SELECTOR = "[data-line]";
/** Late layout (emoji, fonts, windowed tables) can move the anchor again — re-check once. */
const SETTLE_MS = 150;

let blocks: LineBlock[] = [];
let recorded: ScrollAnchor | null = null;
let rafId = 0;
let settleTimer = 0;
let installed = false;

/** Re-read block tops — forces one layout pass, so it only runs when the cache is cold. */
function readBlocks(win: Window, doc: Document): void {
	const out: LineBlock[] = [];
	const seen = new Set<number>();
	for (const el of Array.from(doc.querySelectorAll(LINE_SELECTOR))) {
		const line = Number(el.getAttribute("data-line"));
		// Nested blocks repeat their parent's line: keep the first (outermost) occurrence.
		if (!Number.isFinite(line) || seen.has(line)) continue;
		seen.add(line);
		out.push({line, top: el.getBoundingClientRect().top + win.scrollY});
	}
	out.sort((a, b) => a.top - b.top || a.line - b.line);
	blocks = out;
}

/** Remember the current reading position (cheap once the block cache is warm). */
function recordAnchor(win: Window, doc: Document): void {
	if (blocks.length === 0) readBlocks(win, doc);
	recorded = pickAnchor(blocks, win.scrollY);
}

/** Restore the recorded source line when a DOM swap moved it. */
function preserveAnchor(win: Window, doc: Document): void {
	if (recorded === null) return;
	readBlocks(win, doc);
	const now = pickAnchor(blocks, win.scrollY);
	if (now !== null && now.line === recorded.line) return;
	const top = anchorTop(blocks, recorded);
	if (top === null || top === win.scrollY) return;
	win.scrollTo(0, top);
}

/**
 * Coalesced re-anchor: one animation-frame pass for the swap itself and one
 * delayed pass for layout that settles later (images/emoji/windowed tables).
 * Cheap and idempotent — safe to call for every mutation batch.
 */
function schedulePreserve(win: Window, doc: Document): void {
	if (rafId === 0) {
		rafId = win.requestAnimationFrame(() => {
			rafId = 0;
			preserveAnchor(win, doc);
		});
	}
	if (settleTimer !== 0) win.clearTimeout(settleTimer);
	settleTimer = win.setTimeout(() => {
		settleTimer = 0;
		preserveAnchor(win, doc);
	}, SETTLE_MS);
}

/**
 * Start tracking. Idempotent; degrades to a no-op where the DOM APIs are
 * missing (the script must stay testable outside a browser).
 */
export function installAnchorPreserver(win: Window, doc: Document): void {
	if (installed || typeof win.addEventListener !== "function" || doc.body === null) return;
	installed = true;

	recordAnchor(win, doc);
	win.addEventListener("scroll", () => recordAnchor(win, doc), {passive: true});
	// Resize/zoom moves every block: drop the cache (the next read recomputes it).
	win.addEventListener("resize", () => {
		blocks = [];
	}, {passive: true});

	if (typeof MutationObserver === "undefined") return;
	// Refresh (content swap) and our own enhancements both mutate here; either way
	// the cached tops are stale, and the reader may need re-anchoring afterwards.
	new MutationObserver(() => {
		blocks = [];
		schedulePreserve(win, doc);
	}).observe(doc.body, {childList: true, subtree: true});
}
