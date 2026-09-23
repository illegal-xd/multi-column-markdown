/// <reference lib="dom" />
/**
 * Preview scroll anchoring — keeps the reading position (and the editor position)
 * stable across `markdown.preview.refresh`.
 *
 * Two separate mechanisms move the **editor** while the user types; both are
 * handled here.
 *
 * 1. **The preview's own position drifts.** The preview client has no scroll
 *    restore for content updates; the browser keeps `scrollY` while the morphed
 *    document changes height, so whatever source line sat at the top is replaced
 *    by another one (`pickAnchor`/`anchorTop` below put the recorded line back).
 *
 * 2. **Any scroll event is reported to the host as a user scroll.** The client
 *    does
 *
 *        window.addEventListener("scroll", throttle(50, () => {
 *          if (S > 0) return;                                   // suppression flag
 *          X.postMessage("revealLine", {line: me(window.scrollY)});
 *        }));
 *
 *    and the host answers with `revealRange(..., TextEditorRevealType.AtTop)`
 *    (gated by `markdown.preview.scrollEditorWithPreview`, default true) — i.e.
 *    **the editor scrolls so that line is at the top**. `S` is only raised by the
 *    initial restore (200 ms), the editor→preview `updateView` message (50 ms),
 *    resize and diff sync — **the content-update path never raises it**, so the
 *    browser's own scroll anchoring *and* our own corrective `scrollTo` (below)
 *    both count as "the user scrolled the preview" and yank the editor to
 *    whatever line the preview happens to show. With a long document the editor
 *    and the preview disagree by hundreds of lines, which is why the jump looked
 *    large.
 *
 *    Fix: while a content update settles, swallow those scroll events in the
 *    **capture** phase (the client listens on `window` in the bubble phase and
 *    Chrome delivers viewport scrolls at `document`, so capture runs first), so
 *    the host never hears about the programmatic scrolls. The preview→editor sync
 *    itself is untouched: it resumes as soon as the settle window closes, and any
 *    later scroll event re-syncs normally.
 *
 * The anchor is re-recorded on every scroll event, so a restore always targets the
 * reader's latest position — it cannot "fight" a scroll: if they moved meanwhile,
 * the recorded line moved with them and the restore is a no-op.
 *
 * Pure geometry (`pickAnchor` / `anchorTop`) is DOM-free and unit-tested; the DOM
 * layer only reads `[data-line]` blocks, calls `scrollTo` and manages listeners.
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
/** The preview client announces each content update with this event. */
const UPDATE_EVENT = "vscode.markdown.updateContent";
/** How long preview→editor scroll reports stay suppressed after an update. */
const QUIET_UPDATE_MS = 350;
/** Late layout (images, web fonts) shifts content after the swap: hold a little longer. */
const QUIET_LAYOUT_MS = 200;

let blocks: LineBlock[] = [];
let recorded: ScrollAnchor | null = null;
let rafId = 0;
let settleTimer = 0;
/** One install per window (the page is recreated on reload, the module with it). */
const installedWindows = new WeakSet<object>();
let quietUntil = 0;
let clock: () => number = () => Date.now();
/** The window the cached geometry belongs to (a page owns exactly one window). */
let stateWindow: Window | null = null;

/** Cached geometry belongs to one page: a different window starts cold. */
function ensureWindow(win: Window): void {
	if (stateWindow === win) return;
	stateWindow = win;
	blocks = [];
	recorded = null;
	rafId = 0;
	settleTimer = 0;
	quietUntil = 0;
}

/**
 * Hold preview→editor scroll reporting for `ms`.
 *
 * The markdown preview client turns *any* scroll event of the preview into a
 * `revealLine` message, which the host answers with
 * `revealRange(..., TextEditorRevealType.AtTop)` — that is what dragged the
 * editor around while the document height changed under a refresh. Scrolling the
 * preview programmatically is unavoidable when a block above the viewport changes
 * size, so the events it produces are held back instead of being reported as user
 * scrolls. Called by the guard below and by `preserveAnchor` before it scrolls.
 */
export function holdEditorSync(ms: number = QUIET_UPDATE_MS, win?: Window): void {
	if (win) ensureWindow(win);
	quietUntil = Math.max(quietUntil, clock() + ms);
}

/** Drop scroll events while the edit-sync guard holds them (capture phase). */
export function installEditorSyncGuard(win: Window, doc: Document, opts: {now?: () => number} = {}): void {
	ensureWindow(win);
	if (opts.now) clock = opts.now;
	if (typeof win.addEventListener !== "function") return;

	const swallow = (event: Event): void => {
		if (clock() >= quietUntil) return;
		event.stopImmediatePropagation();
		event.stopPropagation();
	};
	// Capture on BOTH targets: the preview client's listener is a bubble-phase
	// `window` listener, and Chrome delivers viewport scrolls at `document`, so a
	// capture listener is the only place that runs before them.
	for (const target of [win as EventTarget, doc as EventTarget]) {
		if (typeof target.addEventListener !== "function") continue;
		target.addEventListener("scroll", swallow as EventListener, {capture: true, passive: true});
	}
	// Every preview content update morphs the body (the refresh and plain typing
	// both go through it): content can shift for the next few frames.
	win.addEventListener(UPDATE_EVENT, () => holdEditorSync(QUIET_UPDATE_MS, win));
	// `load` does not bubble: capture on the document to catch images/web fonts.
	if (typeof doc.addEventListener === "function") {
		doc.addEventListener("load", () => {
			holdEditorSync(QUIET_LAYOUT_MS, win);
			schedulePreserve(win, doc);
		}, true);
	}
}

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
	ensureWindow(win);
	if (blocks.length === 0) readBlocks(win, doc);
	recorded = pickAnchor(blocks, win.scrollY);
}

/** Restore the recorded source line when a DOM swap moved it. */
function preserveAnchor(win: Window, doc: Document): void {
	ensureWindow(win);
	if (recorded === null) return;
	readBlocks(win, doc);
	const now = pickAnchor(blocks, win.scrollY);
	if (now !== null && now.line === recorded.line) return;
	const top = anchorTop(blocks, recorded);
	if (top === null || top === win.scrollY) return;
	// Our scroll is not a user scroll: hold the preview→editor report it triggers.
	holdEditorSync(QUIET_UPDATE_MS, win);
	win.scrollTo(0, top);
}

/**
 * Coalesced re-anchor: one animation-frame pass for the swap itself and one
 * delayed pass for layout that settles later (images/emoji/windowed tables).
 * Cheap and idempotent — safe to call for every mutation batch.
 */
function schedulePreserve(win: Window, doc: Document): void {
	ensureWindow(win);
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
export function installAnchorPreserver(win: Window, doc: Document, opts: {now?: () => number} = {}): void {
	if (typeof win.addEventListener !== "function" || doc.body === null) return;
	ensureWindow(win);
	if (installedWindows.has(win as unknown as object)) return;
	installedWindows.add(win as unknown as object);

	recordAnchor(win, doc);
	// Registered in the capture phase and BEFORE the guard below, so the reader's
	// position is always recorded even while scroll events are being swallowed.
	win.addEventListener("scroll", () => recordAnchor(win, doc), {capture: true, passive: true});
	installEditorSyncGuard(win, doc, opts);
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
