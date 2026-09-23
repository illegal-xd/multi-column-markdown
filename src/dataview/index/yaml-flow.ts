/**
 * Scalar / flow-value parsing helpers for the frontmatter YAML subset.
 * Split from yaml.ts to keep files within the ≤300-line review signal.
 */
import type {JsonValue} from "../types";

export class YamlError extends Error {}

export const INT_RE = /^[+-]?\d+$/;
export const FLOAT_RE = /^[+-]?(\d+\.\d*|\.\d+|\d+[eE][+-]?\d+|\d+\.\d*[eE][+-]?\d+)$/;

export function unescapeDouble(s: string): string {
	return s.replace(/\\(["\\ntr])/g, (_m, c: string) => {
		if (c === "n") return "\n";
		if (c === "t") return "\t";
		if (c === "r") return "\r";
		return c;
	});
}

export function unquote(t: string): string {
	if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return unescapeDouble(t.slice(1, -1));
	if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
	return t;
}

export function parseScalarToken(t: string): JsonValue {
	if (t === "" || t === "null" || t === "~" || t === "Null" || t === "NULL") return null;
	if (t === "true" || t === "True" || t === "TRUE") return true;
	if (t === "false" || t === "False" || t === "FALSE") return false;
	if (t.startsWith('"') || t.startsWith("'")) {
		if (t.length < 2 || !t.endsWith(t[0])) throw new YamlError(`unterminated string: ${t}`);
		return unquote(t);
	}
	if (INT_RE.test(t)) return Number(t);
	if (FLOAT_RE.test(t)) return Number(t);
	return t;
}

/** Single-line flow value: `[...]`, `{...}`, or scalar. */
export function parseFlowValue(raw: string): JsonValue {
	const s = raw.trim();
	let pos = 0;

	const ws = (): void => {
		while (pos < s.length && (s[pos] === " " || s[pos] === "\t")) pos++;
	};
	const readString = (): string => {
		const q = s[pos];
		pos++;
		let out = "";
		while (pos < s.length) {
			const c = s[pos];
			if (q === '"' && c === "\\") {
				out += c + (s[pos + 1] ?? "");
				pos += 2;
				continue;
			}
			if (c === q) {
				pos++;
				return q === '"' ? unescapeDouble(out) : out.replace(/''/g, "'");
			}
			out += c;
			pos++;
		}
		throw new YamlError(`unterminated string in flow value: ${s}`);
	};
	const readPlain = (): string => {
		const start = pos;
		while (pos < s.length && !",]})".includes(s[pos])) pos++;
		return s.slice(start, pos).trim();
	};
	const readValue = (): JsonValue => {
		ws();
		if (pos >= s.length) throw new YamlError("unexpected end of flow value");
		const c = s[pos];
		if (c === '"' || c === "'") return readString();
		if (c === "[") {
			pos++;
			const arr: JsonValue[] = [];
			ws();
			if (s[pos] === "]") {
				pos++;
				return arr;
			}
			for (;;) {
				arr.push(readValue());
				ws();
				if (s[pos] === ",") {
					pos++;
					ws();
					if (s[pos] === "]") {
						pos++;
						return arr;
					}
					continue;
				}
				if (s[pos] === "]") {
					pos++;
					return arr;
				}
				throw new YamlError(`expected "," or "]" in flow sequence: ${s}`);
			}
		}
		if (c === "{") {
			pos++;
			const obj: Record<string, JsonValue> = {};
			ws();
			if (s[pos] === "}") {
				pos++;
				return obj;
			}
			for (;;) {
				ws();
				let key: string;
				if (s[pos] === '"' || s[pos] === "'") key = readString();
				else key = readPlain();
				ws();
				if (s[pos] !== ":") throw new YamlError(`expected ":" in flow mapping: ${s}`);
				pos++;
				obj[key] = readValue();
				ws();
				if (s[pos] === ",") {
					pos++;
					ws();
					if (s[pos] === "}") {
						pos++;
						return obj;
					}
					continue;
				}
				if (s[pos] === "}") {
					pos++;
					return obj;
				}
				throw new YamlError(`expected "," or "}" in flow mapping: ${s}`);
			}
		}
		return parseScalarToken(readPlain());
	};

	const value = readValue();
	ws();
	if (pos < s.length) throw new YamlError(`trailing content in flow value: ${s}`);
	return value;
}

/** Comment-stripped single line → flow or scalar value. */
export function parseValue(rest: string): JsonValue {
	const t = rest.trim();
	if (t === "") return null;
	if (t.startsWith("[") || t.startsWith("{")) return parseFlowValue(t);
	return parseScalarToken(t);
}
