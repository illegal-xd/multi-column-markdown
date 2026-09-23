/**
 * Golden source matching — shared by DQL FROM and dv.pages(source).
 * Semantics follow Obsidian Dataview (Sources docs):
 *   - string:    folder/path prefix match on the page path (or exact name)
 *   - "#tag":    page etags contain the tag, or tag is a parent of an etag
 *                (FROM #project matches #project/web)
 *   - link:      exact path match (extension-insensitive for .md)
 *   - boolean:   pages() → true; explicit false → none
 *   - negation:  `-#tag`, `-"folder"`, `-[[link]]` → invert the operand
 *   - boolean:   `and` binds tighter than `or` (case-insensitive, whitespace
 *                optional around the operators)
 *   - functions: `incoming([[X]])` → pages that link to X;
 *                `outgoing([[X]])` → pages X links to. Bare (no argument)
 *                uses the current file. Args: `[[path]]` or `"path"`.
 *
 * The source grammar is parsed ONCE per distinct source string (module Map),
 * and `outgoing(...)` link sets are resolved ONCE per (snapshot pages array,
 * target) pair (WeakMap) — matchSource stays a cheap per-page predicate even
 * at 1000s of pages.
 */
import type {PageMeta} from "../types";
import {isLink} from "../values";

/**
 * Optional context for link-aware sources. Purely additive: callers that omit
 * it (dv.pages, legacy executeDql) keep the previous behaviour exactly.
 */
export interface SourceMatchContext {
	/** Snapshot pages; needed to resolve `outgoing(...)` link targets. */
	allPages?: readonly PageMeta[];
	/** Path of the page containing the query — used by `incoming()`/`outgoing()`. */
	currentPath?: string;
}

// ---------------------------------------------------------------------------
// Source grammar AST
// ---------------------------------------------------------------------------

type SourceNode =
	| {kind: "tag"; tag: string}
	| {kind: "str"; value: string}
	| {kind: "link"; path: string}
	| {kind: "incoming"; target: string | null}
	| {kind: "outgoing"; target: string | null}
	| {kind: "not"; child: SourceNode}
	| {kind: "and"; children: SourceNode[]}
	| {kind: "or"; children: SourceNode[]};

interface Cursor {
	s: string;
	i: number;
}

const TAG_CHAR = /[\p{L}\p{N}_/-]/u;
/** A bare token (folder name / expression-ish word) ends at whitespace or `(`. */
const IDENT_STOP = /[\s()]/;

function skipWs(p: Cursor): void {
	while (p.i < p.s.length && /\s/.test(p.s[p.i]!)) p.i++;
}

function isWordChar(c: string | undefined): boolean {
	return c !== undefined && /[\p{L}\p{N}_]/u.test(c);
}

/** Case-insensitive keyword match that respects word boundaries. */
function matchWord(p: Cursor, word: string): boolean {
	if (p.s.slice(p.i, p.i + word.length).toLowerCase() !== word) return false;
	const before = p.i === 0 ? undefined : p.s[p.i - 1];
	const after = p.s[p.i + word.length];
	if (isWordChar(before) || isWordChar(after)) return false;
	p.i += word.length;
	return true;
}

function parseOr(p: Cursor): SourceNode | null {
	const first = parseAnd(p);
	if (first === null) return null;
	const children: SourceNode[] = [first];
	for (;;) {
		const save = p.i;
		skipWs(p);
		if (!matchWord(p, "or")) {
			p.i = save;
			break;
		}
		const right = parseAnd(p);
		if (right === null) return null;
		children.push(right);
	}
	return children.length === 1 ? first : {kind: "or", children};
}

function parseAnd(p: Cursor): SourceNode | null {
	const first = parseUnary(p);
	if (first === null) return null;
	const children: SourceNode[] = [first];
	for (;;) {
		const save = p.i;
		skipWs(p);
		if (!matchWord(p, "and")) {
			p.i = save;
			break;
		}
		const right = parseUnary(p);
		if (right === null) return null;
		children.push(right);
	}
	return children.length === 1 ? first : {kind: "and", children};
}

function parseUnary(p: Cursor): SourceNode | null {
	skipWs(p);
	if (p.s[p.i] === "-") {
		p.i++;
		const child = parseUnary(p);
		return child === null ? null : {kind: "not", child};
	}
	return parsePrimary(p);
}

function readQuoted(p: Cursor): string | null {
	const s = p.s;
	const quote = s[p.i]!;
	p.i++;
	let out = "";
	while (p.i < s.length) {
		const c = s[p.i]!;
		if (c === "\\" && p.i + 1 < s.length) {
			out += s[p.i + 1]!;
			p.i += 2;
			continue;
		}
		if (c === quote) {
			p.i++;
			return out;
		}
		out += c;
		p.i++;
	}
	return null;
}

/** `[[path|display]]` / `![[path]]` → the page path (subpath/display dropped). */
function readWikiLink(p: Cursor, embed: boolean): string | null {
	const s = p.s;
	if (embed) {
		if (s[p.i] !== "!" || s[p.i + 1] !== "[") return null;
		p.i++;
	}
	if (s[p.i] !== "[" || s[p.i + 1] !== "[") return null;
	const end = s.indexOf("]]", p.i + 2);
	if (end < 0) return null;
	let inner = s.slice(p.i + 2, end);
	p.i = end + 2;
	const pipe = inner.indexOf("|");
	if (pipe >= 0) inner = inner.slice(0, pipe);
	const hash = inner.indexOf("#");
	if (hash >= 0) inner = inner.slice(0, hash);
	inner = inner.trim();
	return inner === "" ? null : inner;
}

/** Argument of incoming()/outgoing(): `[[path]]` or `"path"`. */
function readLinkArg(p: Cursor): string | null {
	skipWs(p);
	const c = p.s[p.i];
	if (c === "[") return readWikiLink(p, false);
	if (c === '"' || c === "'") return readQuoted(p);
	return null;
}

function parsePrimary(p: Cursor): SourceNode | null {
	skipWs(p);
	const s = p.s;
	const c = s[p.i];
	if (c === undefined) return null;
	if (c === "(") {
		p.i++;
		const inner = parseOr(p);
		if (inner === null) return null;
		skipWs(p);
		if (s[p.i] !== ")") return null;
		p.i++;
		return inner;
	}
	if (c === "!" && s[p.i + 1] === "[") {
		const path = readWikiLink(p, true);
		return path === null ? null : {kind: "link", path};
	}
	if (c === "[") {
		const path = readWikiLink(p, false);
		return path === null ? null : {kind: "link", path};
	}
	if (c === "#") {
		const start = p.i;
		let j = p.i + 1;
		while (j < s.length && TAG_CHAR.test(s[j]!)) j++;
		if (j === start + 1) return null; // lone "#"
		p.i = j;
		return {kind: "tag", tag: s.slice(start, j)};
	}
	if (c === '"' || c === "'") {
		const value = readQuoted(p);
		return value === null ? null : {kind: "str", value};
	}
	// Bare token: `notes`, `notes/sub`, `a.md`, or incoming/outgoing(...).
	const start = p.i;
	while (p.i < s.length && !IDENT_STOP.test(s[p.i]!)) p.i++;
	if (p.i === start) return null;
	const word = s.slice(start, p.i);
	const lower = word.toLowerCase();
	if (lower === "incoming" || lower === "outgoing") {
		const save = p.i;
		skipWs(p);
		if (s[p.i] === "(") {
			p.i++;
			skipWs(p);
			if (s[p.i] === ")") {
				p.i++;
				return {kind: lower as "incoming" | "outgoing", target: null};
			}
			const target = readLinkArg(p);
			if (target === null) return null; // unsupported argument form
			skipWs(p);
			if (s[p.i] !== ")") return null;
			p.i++;
			return {kind: lower as "incoming" | "outgoing", target};
		}
		p.i = save;
	}
	return {kind: "str", value: word};
}

/** Parse a full source string; null = not a valid source (no partial parses). */
function parseSourceText(text: string): SourceNode | null {
	if (text.trim() === "") return null;
	const p: Cursor = {s: text, i: 0};
	const node = parseOr(p);
	if (node === null) return null;
	skipWs(p);
	return p.i >= text.length ? node : null;
}

// Parse cache: sources are immutable strings, so one entry per distinct text.
const PARSE_CACHE = new Map<string, SourceNode | null>();
const PARSE_CACHE_MAX = 512;

function cachedParseSource(text: string): SourceNode | null {
	const hit = PARSE_CACHE.get(text);
	if (hit !== undefined) return hit;
	const parsed = parseSourceText(text);
	if (PARSE_CACHE.size >= PARSE_CACHE_MAX) PARSE_CACHE.clear();
	PARSE_CACHE.set(text, parsed);
	return parsed;
}

/**
 * True when the source uses boolean operators / negation / incoming / outgoing,
 * i.e. it cannot be represented as a single evaluated value. parseDql uses this
 * to hand the RAW source text to matchSource instead of a lossy `and`/`or`
 * expression evaluation (`'#a' and -'#b'` evaluates to a boolean, not a source).
 */
export function isCompoundSource(text: string): boolean {
	const node = parseSourceText(text);
	if (node === null) return false;
	return node.kind !== "tag" && node.kind !== "str" && node.kind !== "link";
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function normPath(p: string): string {
	let s = p.replace(/\\/g, "/").replace(/^\.\//, "");
	if (!s.endsWith(".md") && !/\.[a-z0-9]+$/i.test(s)) s += ".md";
	return s;
}

/**
 * Folder/prefix normalization for string sources — unlike `normPath`, an
 * extension-less string is a *folder* ("notes"), NOT "notes.md".
 * Bugfix (B2 E4: FROM "folder" matched 0 rows before this split).
 */
function normSource(s: string): string {
	return s.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Identity key for link-set matching: posix, extension-insensitive for `.md`
 * (`"notes/a"`, `"notes/a.md"` and links written either way collapse to one).
 */
function pathKey(p: string): string {
	const s = p.replace(/\\/g, "/").replace(/^\.\//, "");
	return s.endsWith(".md") ? s.slice(0, -3) : s;
}

function tagMatches(etags: readonly string[], tag: string): boolean {
	const want = tag.startsWith("#") ? tag : "#" + tag;
	if (etags.includes(want)) return true;
	// Parent tag matches children: "#proj" matches "#proj/web".
	const childPrefix = want + "/";
	return etags.some((t) => t.startsWith(childPrefix));
}

function matchStringSource(src: string, page: PageMeta): boolean {
	if (src.startsWith("#")) return tagMatches(page.etags, src);
	// String source semantics (Dataview):
	//   "notes"        → folder/path prefix: "notes/a.md", "notes/sub/b.md"
	//   "notes/"       → same, trailing slash tolerated
	//   "notes/a.md"   → exact path match
	//   "a"            → exact "a.md" at root OR folder "a/*"
	const want = normSource(src);
	if (page.path === want || page.path === want + ".md") return true;
	const wantDir = want.endsWith("/") ? want : want + "/";
	return page.path.startsWith(wantDir);
}

// ---------------------------------------------------------------------------
// outgoing(...) resolution (cached per snapshot pages array)
// ---------------------------------------------------------------------------

const OUTGOING_CACHE = new WeakMap<readonly PageMeta[], Map<string, ReadonlySet<string>>>();

function outgoingSet(allPages: readonly PageMeta[], key: string): ReadonlySet<string> {
	let perSnapshot = OUTGOING_CACHE.get(allPages);
	if (perSnapshot === undefined) {
		perSnapshot = new Map();
		OUTGOING_CACHE.set(allPages, perSnapshot);
	}
	const hit = perSnapshot.get(key);
	if (hit !== undefined) return hit;
	const set = new Set<string>();
	for (const p of allPages) {
		if (pathKey(p.path) !== key) continue;
		for (const link of p.outlinks) set.add(pathKey(link.path));
		break; // paths are unique in a snapshot
	}
	perSnapshot.set(key, set);
	return set;
}

/** Normalized target key for incoming/outgoing (null target = current file). */
function linkTargetKey(target: string | null, ctx: SourceMatchContext | undefined): string | null {
	const raw = target ?? ctx?.currentPath ?? null;
	if (raw === null || raw === "") return null;
	return pathKey(raw);
}

/** incoming(X) = pages that contain an outlink to X. */
function matchIncoming(target: string | null, page: PageMeta, ctx: SourceMatchContext | undefined): boolean {
	const key = linkTargetKey(target, ctx);
	if (key === null) return false;
	return page.outlinks.some((l) => pathKey(l.path) === key);
}

/** outgoing(X) = pages that X links to (needs the snapshot to find X). */
function matchOutgoing(target: string | null, page: PageMeta, ctx: SourceMatchContext | undefined): boolean {
	const key = linkTargetKey(target, ctx);
	if (key === null) return false;
	const allPages = ctx?.allPages;
	if (allPages === undefined) return false;
	return outgoingSet(allPages, key).has(pathKey(page.path));
}

function evalSourceNode(node: SourceNode, page: PageMeta, ctx: SourceMatchContext | undefined): boolean {
	switch (node.kind) {
		case "tag":
			return tagMatches(page.etags, node.tag);
		case "str":
			return matchStringSource(node.value, page);
		case "link":
			return page.path === normPath(node.path);
		case "not":
			return !evalSourceNode(node.child, page, ctx);
		case "and":
			for (const child of node.children) if (!evalSourceNode(child, page, ctx)) return false;
			return true;
		case "or":
			for (const child of node.children) if (evalSourceNode(child, page, ctx)) return true;
			return false;
		case "incoming":
			return matchIncoming(node.target, page, ctx);
		case "outgoing":
			return matchOutgoing(node.target, page, ctx);
	}
}

// ---------------------------------------------------------------------------
// Public predicate
// ---------------------------------------------------------------------------

/**
 * @param source  dataview source value (string / tag string / Link / bool /
 *                null) OR raw source text (`#a or -#b`, `incoming([[x]])`, …)
 * @param page    candidate page
 * @param ctx     optional link context for incoming/outgoing (see above)
 */
export function matchSource(source: unknown, page: PageMeta, ctx?: SourceMatchContext): boolean {
	if (source === null || source === undefined) return true;
	if (typeof source === "boolean") return source;
	if (typeof source === "string") {
		const node = cachedParseSource(source);
		return node === null ? false : evalSourceNode(node, page, ctx);
	}
	if (isLink(source)) {
		return page.path === normPath(source.path);
	}
	return false;
}
