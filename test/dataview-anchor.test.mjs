/**
 * Preview scroll-anchor tests (src/dataview/webview/anchor.ts).
 *
 * The pure geometry is tested directly; the DOM layer is driven through a tiny
 * fake window/document so the real record → swap → re-anchor sequence runs
 * (that sequence is what keeps the editor from being scrolled away when a
 * dataview block resolves and changes the document height).
 *
 *   NODE_PATH=./test/helpers/node_modules node --test test/dataview-anchor.test.mjs
 */
import {test} from "node:test";
import assert from "node:assert/strict";
import {execSync} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const dir = mkdtempSync(join(tmpdir(), "amc-anchor-"));
try {
  execSync(
    "npx esbuild src/dataview/webview/anchor.ts --bundle --format=esm --outfile=" + join(dir, "anchor.mjs"),
    {cwd: new URL("..", import.meta.url).pathname, stdio: "pipe"},
  );
} catch (e) {
  console.error(String(e.stdout ?? e));
  process.exit(1);
}
const {pickAnchor, anchorTop, installAnchorPreserver, installEditorSyncGuard} = await import(join(dir, "anchor.mjs"));
process.on("exit", () => rmSync(dir, {recursive: true, force: true}));

const blocks = (pairs) => pairs.map(([line, top]) => ({line, top}));

// ── pure geometry ─────────────────────────────────────────────────────────

test("anchor: pickAnchor returns the block under the viewport top plus the offset", () => {
  const b = blocks([[10, 0], [20, 100], [30, 250]]);
  assert.deepEqual(pickAnchor(b, 0), {line: 10, offset: 0});
  assert.deepEqual(pickAnchor(b, 50), {line: 10, offset: 50});
  assert.deepEqual(pickAnchor(b, 100), {line: 20, offset: 0});
  assert.deepEqual(pickAnchor(b, 260), {line: 30, offset: 10});
  assert.deepEqual(pickAnchor(b, 9999), {line: 30, offset: 9749});
  // Above the first block / empty document.
  assert.deepEqual(pickAnchor(b, -5), {line: 10, offset: 0});
  assert.equal(pickAnchor([], 0), null);
});

test("anchor: anchorTop restores the same line, falls back to the next one", () => {
  const b = blocks([[10, 0], [20, 100], [30, 250]]);
  assert.equal(anchorTop(b, {line: 20, offset: 10}), 110);
  assert.equal(anchorTop(b, {line: 30, offset: 0}), 250);
  // The recorded block disappeared (the file changed) → nearest later line.
  assert.equal(anchorTop(b, {line: 25, offset: 0}), 250);
  // Nothing later either → do not move at all.
  assert.equal(anchorTop(b, {line: 99, offset: 0}), null);
  assert.equal(anchorTop([], {line: 1, offset: 0}), null);
});

test("anchor: a block that grows above the reader keeps its source line at the top", () => {
  // Symptom: VSCode restores by progress, so the same scrollTop lands on line 10.
  const before = blocks([[10, 0], [20, 100], [30, 250]]);
  const after = blocks([[10, 0], [20, 600], [30, 750]]);
  assert.deepEqual(pickAnchor(before, 260), {line: 30, offset: 10});
  assert.equal(pickAnchor(after, 260).line, 10, "naive progress restore drifts to another line");
  // With anchoring, line 30 is still where the reader left it.
  assert.equal(anchorTop(after, pickAnchor(before, 260)), 760);
});

test("anchor: install is a safe no-op without DOM APIs and is idempotent", () => {
  assert.doesNotThrow(() => installAnchorPreserver({}, {}));
  assert.doesNotThrow(() => installAnchorPreserver({body: null}, {body: null}));
});

// ── DOM layer (fake window/document) ──────────────────────────────────────

/**
 * Minimal DOM good enough for readBlocks/scrollTo/MutationObserver/timers, plus a
 * listener registry that respects capture order — that order is what the
 * edit-sync guard relies on (capture runs before the preview client's bubble
 * listener, and our own recorder is registered first).
 */
function fakeDom(blockDefs) {
  const view = {scrollY: 0};
  const listeners = [];
  const timeouts = [];
  const frames = [];
  const elements = blockDefs.map(({line}) => {
    const el = {
      line,
      absoluteTop: 0,
      getAttribute: (name) => (name === "data-line" ? String(el.line) : null),
      getBoundingClientRect: () => ({top: el.absoluteTop - view.scrollY}),
    };
    return el;
  });
  let mutationCallback = null;
  const win = {
    get scrollY() {
      return view.scrollY;
    },
    scrollTo(_x, top) {
      view.scrollY = top;
    },
    addEventListener(type, fn, options) {
      listeners.push({target: "win", type, fn, capture: options === true || !!(options && options.capture)});
    },
    requestAnimationFrame(fn) {
      frames.push(fn);
      return frames.length;
    },
    setTimeout(fn) {
      timeouts.push(fn);
      return timeouts.length;
    },
    clearTimeout() {},
  };
  const doc = {
    body: {},
    querySelectorAll: () => elements,
    addEventListener(type, fn, options) {
      listeners.push({target: "doc", type, fn, capture: options === true || !!(options && options.capture)});
    },
    removeEventListener() {},
  };
  globalThis.MutationObserver = class {
    constructor(cb) {
      mutationCallback = cb;
    }
    observe() {}
  };
  /** Dispatch in DOM order: capture listeners first, then bubble/target ones. */
  const emit = (type, detail) => {
    const event = {
      type,
      detail,
      stopped: 0,
      stopImmediatePropagation() {
        this.stopped = 2;
      },
      stopPropagation() {
        if (this.stopped < 2) this.stopped = 1;
      },
    };
    for (const l of listeners.filter((l) => l.type === type && l.capture)) {
      l.fn(event);
      if (event.stopped === 2) return event;
    }
    for (const l of listeners.filter((l) => l.type === type && !l.capture)) {
      l.fn(event);
      if (event.stopped === 2) return event;
    }
    return event;
  };
  return {
    win,
    doc,
    listeners,
    emit,
    /** Stands in for the markdown preview client's scroll listener. */
    onClientScroll: (fn) => win.addEventListener("scroll", fn),
    setTops: (tops) => {
      elements.forEach((el, i) => {
        el.absoluteTop = tops[i];
      });
    },
    /** A user scroll: the position changes and the browser fires `scroll`. */
    scrollTo: (top) => {
      view.scrollY = top;
      emit("scroll");
    },
    /** Simulates the refresh swap: layout changes, then mutation + frame + settle timer run. */
    mutate: () => {
      mutationCallback?.();
      const pending = [...frames.splice(0), ...timeouts.splice(0)];
      for (const fn of pending) fn();
    },
  };
}

// ── editor-sync guard (the reason the editor used to jump) ────────────────

test("guard: preview scrolls are reported while idle and held after a content update", () => {
  const dom = fakeDom([{line: 10}]);
  let t = 0;
  installEditorSyncGuard(dom.win, dom.doc, {now: () => t});
  const reported = [];
  dom.onClientScroll(() => reported.push(dom.win.scrollY));

  dom.scrollTo(10);
  assert.equal(reported.length, 1, "an idle preview scroll is still reported (feature intact)");

  // The preview re-renders (refresh or plain typing): hold the reports.
  dom.emit("vscode.markdown.updateContent");
  t += 100;
  dom.scrollTo(20);
  assert.equal(reported.length, 1, "a scroll inside the settle window must not reach the host");
  t += 400;
  dom.scrollTo(30);
  assert.equal(reported.length, 2, "the sync is live again once the window closes");
});

test("guard: capture listeners are installed on both window and document", () => {
  const dom = fakeDom([{line: 10}]);
  installEditorSyncGuard(dom.win, dom.doc, {now: () => 0});
  const scrolls = dom.listeners.filter((l) => l.type === "scroll");
  assert.deepEqual(scrolls.map((l) => [l.target, l.capture]), [["win", true], ["doc", true]]);
  assert.equal(dom.listeners.filter((l) => l.type === "vscode.markdown.updateContent").length, 1);
  assert.equal(dom.listeners.filter((l) => l.type === "load" && l.capture).length, 1);
});

test("guard: our own recorder runs before the guard swallows the event", () => {
  const dom = fakeDom([{line: 10}, {line: 20}]);
  dom.setTops([0, 100]);
  let t = 0;
  installAnchorPreserver(dom.win, dom.doc, {now: () => t});
  const reported = [];
  dom.onClientScroll(() => reported.push(1));

  // A programmatic re-anchor (block above grows) holds the sync …
  dom.scrollTo(110);
  reported.length = 0;
  dom.setTops([0, 600]);
  dom.mutate();
  assert.equal(dom.win.scrollY, 610, "the anchor restored the recorded line");
  t += 10;
  dom.scrollTo(610);
  assert.equal(reported.length, 0, "the host is not told about our corrective scroll");

  // … but the reader's position is still recorded (capture runs first).
  t += 500;
  dom.setTops([0, 900]);
  dom.mutate();
  assert.equal(dom.win.scrollY, 910, "the reader's latest line is still the anchor");
});

test("anchor: refresh keeps the reading line, and follows the reader when they move", () => {
  const dom = fakeDom([{line: 10}, {line: 20}, {line: 30}]);
  dom.setTops([0, 100, 250]);
  installAnchorPreserver(dom.win, dom.doc);

  // Reader scrolls the preview to line 30.
  dom.scrollTo(260);
  assert.equal(dom.win.scrollY, 260);

  // A dataview block above resolves: everything below moves down, DOM mutates.
  dom.setTops([0, 600, 750]);
  dom.mutate();
  assert.equal(dom.win.scrollY, 760, "line 30 is restored at the same offset");

  // Reader moves back into line 10 (the block that now spans 0…700).
  dom.scrollTo(300);
  dom.setTops([0, 700, 850]);
  dom.mutate();
  assert.equal(dom.win.scrollY, 300, "the recorded line is already at the top: no move");

  // Reader moves down onto line 30 again; the next swap keeps that line.
  dom.scrollTo(850); // line 30's block starts here (tops are 0 / 700 / 850)
  dom.setTops([0, 1200, 1350]);
  dom.mutate();
  assert.equal(dom.win.scrollY, 1350, "line 30 is back at the top after the swap");
});
