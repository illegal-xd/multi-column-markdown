/**
 * YAML subset parser for frontmatter (index layer, zero-dependency).
 *
 * Supported: scalars (null/bool/int/float/quoted/plain), inline arrays `[a, b]`,
 * inline maps `{a: 1}`, block sequences (`- `), nested maps by indentation,
 * `|` / `>` multiline block scalars, `#` comments outside quotes.
 * Unsupported constructs (anchors, tags, multi-line flow) → error result.
 * Never throws: all failures surface as {value: null, error}.
 * Scalar/flow helpers live in ./yaml-flow.ts.
 */
import type {JsonValue} from "../types";
import {parseValue, unescapeDouble, YamlError} from "./yaml-flow";

export interface YamlParseResult {
	value: JsonValue | null;
	error?: string;
}

/** Public entry — pure, exception-free. */
export function parseYamlValue(text: string): YamlParseResult {
	try {
		return {value: new YamlDoc(text).parse()};
	} catch (e) {
		return {value: null, error: e instanceof Error ? e.message : String(e)};
	}
}

export interface YamlTolerantResult {
	value: JsonValue | null;
	/**
	 * Set when the document is not valid YAML for this subset: either it needed
	 * lines dropped to parse at all, or nothing could be recovered. Callers use
	 * this for diagnostics only — the value is still the best readable subset.
	 */
	recovered?: string;
}

/** Upper bound on repair rounds (one malformed line dropped per round). */
const MAX_REPAIR_ATTEMPTS = 24;

/**
 * Frontmatter entry point: parse, and on failure drop the offending line and
 * try again.
 *
 * Real notes routinely carry slightly-broken frontmatter (a multi-line plain
 * scalar followed by another key, a stray colon-less line, a tab). Treating
 * that as "the whole block is invalid" silently loses every field — tags,
 * aliases and the metadata a query filters on — even though all the other
 * lines are fine. Recovery keeps everything readable; the dropped line is
 * reported through `recovered` (console/log only, never the document).
 */
export function parseYamlTolerant(text: string): YamlTolerantResult {
	const lines = text.split(/\r?\n/);
	let firstError: string | undefined;
	for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
		const res = parseYamlValue(lines.join("\n"));
		if (!res.error) {
			return firstError === undefined ? {value: res.value} : {value: res.value, recovered: firstError};
		}
		firstError ??= res.error;
		const line = errorLine(res.error);
		if (line === null || line < 1 || line > lines.length || lines.length <= 1) break;
		lines.splice(line - 1, 1);
	}
	return {value: null, recovered: firstError};
}

/** Line number reported by the stale-line errors ("… at line N"), 1-based. */
function errorLine(message: string): number | null {
	const m = /\bat line (\d+)\b/.exec(message);
	return m ? Number(m[1]) : null;
}

interface Row {
	no: number;
	indent: number;
	/** Content after indent, trailing comment stripped. */
	text: string;
}

/** `key:` requires colon followed by whitespace or EOL (YAML plain-scalar rule). */
const KEY_RE = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^:#]+?))\s*:(?:\s+(.*))?$/;
const SEQ_RE = /^-(?:\s+(.*))?$/;
const BLOCK_IND_RE = /^[|>][-+]?\d*$/;

/**
 * A plain (unquoted, non-flow) scalar — the only kind that may continue onto
 * following indented lines. `|` / `>` indicators are handled before this check.
 */
function isPlainScalarText(text: string): boolean {
	const t = text.trim();
	return t !== "" && !/^['"[{]/.test(t) && !BLOCK_IND_RE.test(t);
}

function stripComment(s: string): string {
	let q: "'" | '"' | null = null;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (q === "'") {
			if (c === "'") q = null;
		} else if (q === '"') {
			if (c === "\\") i++;
			else if (c === '"') q = null;
		} else if (c === "'" || c === '"') {
			q = c;
		} else if (c === "#" && (i === 0 || s[i - 1] === " " || s[i - 1] === "\t")) {
			return s.slice(0, i).trimEnd();
		}
	}
	return s.trimEnd();
}

function isBlankOrComment(raw: string): boolean {
	const t = raw.replace(/^[ \t]+/, "");
	return t === "" || t.startsWith("#");
}

function lineIndent(raw: string): number {
	const t = raw.replace(/^[ \t]+/, "");
	return raw.length - t.length;
}

class YamlDoc {
	private readonly lines: string[];
	private i = 0;

	constructor(text: string) {
		this.lines = text.split(/\r?\n/);
	}

	parse(): JsonValue {
		if (!this.peekRow()) return null;
		const value = this.block(0);
		const left = this.peekRow();
		if (left) throw new YamlError(`unexpected content at line ${left.no + 1}: "${left.text}"`);
		return value;
	}

	private peekRow(): Row | null {
		while (this.i < this.lines.length) {
			if (isBlankOrComment(this.lines[this.i])) {
				this.i++;
				continue;
			}
			const raw = this.lines[this.i];
			const indent = lineIndent(raw);
			return {no: this.i, indent, text: stripComment(raw.slice(indent))};
		}
		return null;
	}

	private block(minIndent: number): JsonValue {
		const row = this.peekRow();
		if (!row || row.indent < minIndent) return null;
		if (SEQ_RE.test(row.text)) return this.sequence(row.indent);
		if (KEY_RE.test(row.text)) return this.mapping(row.indent);
		this.i++;
		const value = parseValue(row.text);
		return isPlainScalarText(row.text) && typeof value === "string"
			? this.foldContinuation(row.indent, value)
			: value;
	}

	/** Nested block under an empty `key:` — deeper block, or same-indent sequence (valid YAML). */
	private blockAfter(parentIndent: number): JsonValue {
		const row = this.peekRow();
		if (!row) return null;
		if (row.indent > parentIndent) return this.block(row.indent);
		if (row.indent === parentIndent && SEQ_RE.test(row.text)) return this.sequence(row.indent);
		return null;
	}

	private mapping(indent: number): JsonValue {
		const obj: Record<string, JsonValue> = {};
		for (;;) {
			const row = this.peekRow();
			if (!row || row.indent < indent) break;
			if (row.indent > indent) throw new YamlError(`bad indentation at line ${row.no + 1}`);
			const m = KEY_RE.exec(row.text);
			if (!m) throw new YamlError(`expected "key: value" at line ${row.no + 1}: "${row.text}"`);
			const key = m[1] !== undefined ? unescapeDouble(m[1]) : m[2] !== undefined ? m[2].replace(/''/g, "'") : m[3].trim();
			const rest = m[4];
			this.i++;
			let value: JsonValue;
			if (rest === undefined || rest.trim() === "") {
				value = this.blockAfter(indent);
			} else if (BLOCK_IND_RE.test(rest.trim())) {
				value = this.blockScalar(indent, rest.trim());
			} else {
				value = parseValue(rest);
				// YAML plain scalars may continue on deeper-indented lines:
				//   description: first part
				//     second part
				// A line-based reader that treats that as "bad indentation" throws
				// away the whole frontmatter, so fold it instead. A continuation that
				// looks like `key:` or `- ` is *not* folded — that is the invalid
				// multi-line implicit key case, which must stay an error.
				if (isPlainScalarText(rest) && typeof value === "string") {
					value = this.foldContinuation(indent, value);
				}
			}
			obj[key] = value;
		}
		return obj;
	}

	private sequence(indent: number): JsonValue {
		const arr: JsonValue[] = [];
		for (;;) {
			const row = this.peekRow();
			if (!row || row.indent < indent) break;
			if (row.indent > indent) throw new YamlError(`bad indentation at line ${row.no + 1}`);
			const m = SEQ_RE.exec(row.text);
			if (!m) break; // parent mapping resumes at this indent
			const rest = m[1];
			if (rest === undefined || rest.trim() === "") {
				this.i++;
				arr.push(this.blockAfter(indent));
			} else if (BLOCK_IND_RE.test(rest.trim())) {
				this.i++;
				arr.push(this.blockScalar(indent, rest.trim()));
			} else {
				// Compact item (`- key: v` / nested `- - a` / plain scalar):
				// rewrite the dash line as content at the item's inner indent, then re-dispatch.
				const innerIndent = indent + row.text.length - rest.length;
				this.lines[row.no] = " ".repeat(innerIndent) + rest;
				arr.push(this.block(innerIndent));
			}
		}
		return arr;
	}

	/**
	 * Fold the deeper-indented continuation lines of a plain scalar into it
	 * (YAML folds them with a space). Stops at a line that is a key, a sequence
	 * item, or no deeper than `parentIndent`. Blank lines are skipped by
	 * `peekRow`; this reader folds them to a space rather than a newline, which
	 * is the documented subset behaviour.
	 */
	private foldContinuation(parentIndent: number, first: string): string {
		let value = first;
		for (;;) {
			const row = this.peekRow();
			if (!row || row.indent <= parentIndent) break;
			if (SEQ_RE.test(row.text) || KEY_RE.test(row.text)) break;
			value += ` ${row.text.trim()}`;
			this.i++;
		}
		return value;
	}

	/** `|` / `>` multiline scalar after `key:` or `- `; consumes deeper raw lines. */
	private blockScalar(parentIndent: number, indicator: string): string {
		const style = indicator[0];
		const collected: string[] = [];
		let contentIndent = -1;
		while (this.i < this.lines.length) {
			const raw = this.lines[this.i];
			const t = raw.replace(/^[ \t]+/, "");
			if (t === "") {
				collected.push("");
				this.i++;
				continue;
			}
			const indent = raw.length - t.length;
			if (indent <= parentIndent) break;
			if (contentIndent === -1) contentIndent = indent;
			collected.push(raw.slice(Math.min(contentIndent, indent)));
			this.i++;
		}
		while (collected.length > 0 && collected[collected.length - 1] === "") collected.pop();
		if (style === "|") return collected.join("\n");
		let out = "";
		for (const line of collected) {
			if (line === "") out += "\n";
			else out += out !== "" && !out.endsWith("\n") ? " " + line : line;
		}
		return out;
	}
}
