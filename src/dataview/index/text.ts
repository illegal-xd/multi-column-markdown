/**
 * Line/text extraction helpers for parsePageFile (inline fields, tags, links,
 * alias/etag normalization, frontmatter coercion). Split from parse.ts to keep
 * files within the ≤300-line review signal.
 */
import type {JsonValue, LinkMeta} from "../types";
import {coerceStringField} from "../values";

const WRAP_BRACKET_RE = /\[([^\]]+?)::\s*([^\]]*)\]/g;
const WRAP_PAREN_RE = /\(([^\)]+?)::\s*([^\)]*)\)/g;
/** Bare `key:: value` — key is a single token (spaced keys need [ ]/( ) wrappers), value to EOL. */
const BARE_FIELD_RE = /(?:^|[\s[\({])((?:[^\[\]()\s])+?)::\s*(.*)$/;

/** Replace inline code spans with spaces (keeps word boundaries for tags). */
export function stripInlineCode(s: string): string {
	return s.replace(/(`+)([\s\S]*?)\1/g, " ");
}

function splitFlowItems(s: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let q: string | null = null;
	let cur = "";
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (q) {
			cur += c;
			if (c === q) q = null;
			continue;
		}
		if (c === '"' || c === "'") {
			q = c;
			cur += c;
			continue;
		}
		if (c === "[") depth++;
		else if (c === "]") depth--;
		else if (c === "," && depth === 0) {
			out.push(cur);
			cur = "";
			continue;
		}
		cur += c;
	}
	out.push(cur);
	return out.map((x) => x.trim()).filter((x) => x !== "");
}

/** Inline-field value: `[a, b]` → JsonValue array; otherwise coerceStringField. */
function fieldValue(raw: string): JsonValue {
	const v = raw.trim();
	if (v.length >= 2 && v.startsWith("[") && v.endsWith("]")) {
		const inner = v.slice(1, -1).trim();
		return inner === "" ? [] : splitFlowItems(inner).map((el) => fieldValue(el));
	}
	if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
		return coerceStringField(v.slice(1, -1).replace(/''/g, "'"));
	}
	return coerceStringField(v);
}

/** Collect inline fields from one line into `sink` (later keys overwrite earlier). */
export function extractInlineFields(line: string, sink: Record<string, JsonValue>): void {
	let rest = line;
	rest = rest.replace(WRAP_BRACKET_RE, (_m, k: string, v: string) => {
		const key = k.trim();
		if (key) sink[key] = fieldValue(v);
		return " ";
	});
	rest = rest.replace(WRAP_PAREN_RE, (_m, k: string, v: string) => {
		const key = k.trim();
		if (key) sink[key] = fieldValue(v);
		return " ";
	});
	const b = BARE_FIELD_RE.exec(rest);
	if (b) {
		const key = b[1].trim();
		if (key) sink[key] = fieldValue(b[2]);
	}
}

/**
 * Body hashtags: `[\p{L}\p{N}_/-]+` after `#`, not mid-word, not after `#`
 * (so `##x` is no tag), outside fenced/inline code and `[[...]]` spans.
 */
export function extractBodyTags(cleaned: string): string[] {
	const src = cleaned.replace(/\[\[[^\]]*\]\]/g, " ").replace(/\]\([^)]*\)/g, "]");
	const re = /(?:^|[^#\p{L}\p{N}_/-])#([\p{L}\p{N}_/-]+)/gu;
	const out: string[] = [];
	for (;;) {
		const m = re.exec(src);
		if (m === null) break;
		out.push("#" + m[1]);
	}
	return out;
}

/** Wiki + markdown links on a code-stripped line (absolute line number attached). */
export function extractLinks(cleaned: string, line: number, out: LinkMeta[]): void {
	const wiki = /(!?)\[\[([^\]|#]*)(#[^\]|]*)?(?:\|([^\]]*))?\]\]/g;
	for (;;) {
		const m = wiki.exec(cleaned);
		if (m === null) break;
		const meta: LinkMeta = {path: m[2].trim(), embed: m[1] === "!", line};
		if (m[3]) meta.subpath = m[3];
		if (m[4]) meta.display = m[4];
		out.push(meta);
	}
	const md = /(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
	for (;;) {
		const m = md.exec(cleaned);
		if (m === null) break;
		const rawPath = m[3];
		if (rawPath.includes("://") || rawPath.startsWith("mailto:") || rawPath.startsWith("#")) continue;
		const path = rawPath.startsWith("./") ? rawPath.slice(2) : rawPath;
		const meta: LinkMeta = {path, embed: m[1] === "!", line};
		if (m[2]) meta.display = m[2];
		out.push(meta);
	}
}

/** Frontmatter `tags` (string / comma string / array) → "#"-prefixed list. */
export function normalizeFmTags(v: JsonValue | undefined): string[] {
	const parts: string[] = [];
	if (typeof v === "string") parts.push(...v.split(","));
	else if (Array.isArray(v)) {
		for (const item of v) if (typeof item === "string") parts.push(item);
	}
	const out: string[] = [];
	for (const p of parts) {
		const t = p.trim();
		if (t) out.push(t.startsWith("#") ? t : "#" + t);
	}
	return out;
}

export function normalizeAliases(v: JsonValue | undefined): string[] {
	if (typeof v === "string") return v.trim() ? [v.trim()] : [];
	if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter((s) => s !== "");
	return [];
}

/** tags ∪ all parents: "#a/b" → also "#a". Order: first-seen wins. */
export function expandEtags(tags: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const add = (t: string): void => {
		if (!seen.has(t)) {
			seen.add(t);
			out.push(t);
		}
	};
	for (const t of tags) {
		add(t);
		if (!t.startsWith("#")) continue;
		const parts = t.slice(1).split("/");
		let acc = "";
		for (let i = 0; i < parts.length - 1; i++) {
			acc = acc === "" ? parts[i] : acc + "/" + parts[i];
			add("#" + acc);
		}
	}
	return out;
}

export function isPlainObject(v: JsonValue): v is Record<string, JsonValue> {
	return typeof v === "object" && v !== null && !Array.isArray(v) && !("__dv" in v);
}

/** Deep-coerce every plain string via coerceStringField (tagged values untouched). */
export function coerceJson(v: JsonValue): JsonValue {
	if (typeof v === "string") return coerceStringField(v);
	if (Array.isArray(v)) return v.map(coerceJson);
	if (isPlainObject(v)) {
		const out: Record<string, JsonValue> = {};
		for (const [k, val] of Object.entries(v)) out[k] = coerceJson(val);
		return out;
	}
	return v;
}

export function pathMeta(path: string): {name: string; folder: string; ext: string} {
	const slash = path.lastIndexOf("/");
	const base = slash >= 0 ? path.slice(slash + 1) : path;
	const folder = slash >= 0 ? path.slice(0, slash) : "";
	const dot = base.lastIndexOf(".");
	const name = dot > 0 ? base.slice(0, dot) : base;
	const ext = dot > 0 ? base.slice(dot + 1) : "";
	return {name, folder, ext};
}
