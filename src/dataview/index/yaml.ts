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
		return parseValue(row.text);
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
