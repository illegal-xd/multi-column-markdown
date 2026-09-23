/**
 * Expression engine — a hand-written lexer/parser plus an ITERATIVE evaluator
 * (no eval/Function, zero npm deps, no `vscode` import).
 *
 * Grammar (Obsidian Dataview DQL expression subset), loosest → tightest:
 *   or/||  <  and/&&  <  not/!  <  =~  <  == != < <= > >=  <  + -  <  * / %
 *   <  unary -  <  call / member / index / parens
 *   lambda:  `(a, b) => expr`  |  `a => expr`  (atom; body is a full expression)
 *
 * Safety & perf:
 *   - Evaluation uses an explicit work stack (iterative) so arbitrarily long
 *     left-assoc chains (`1+2+…`) never grow the host stack — O(ast) per run.
 *   - Member/call nesting ("value descent") is capped at MAX_DEPTH (64) so
 *     cyclic values (`x.self.self…`) surface as ExpressionError, not overflow.
 *   - AND/OR short-circuit: a decided left operand never evaluates the right.
 *   - Node evaluation builds no intermediate strings except for `=~` patterns
 *     and `+` string concatenation (operations that require them).
 */
import type {DvValue} from "../types";
import {DvFunctions} from "./functions";
import {looseEquals, compareRel, truthy} from "./semantics";
import {isDataArray, isDvDate} from "../values";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ExpressionError extends Error {
	readonly line: number;
	readonly col: number;
	constructor(message: string, line: number, col: number) {
		super(message);
		this.name = "ExpressionError";
		this.line = line;
		this.col = col;
	}
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

const MAX_DEPTH = 64;

export type Expr =
	| {kind: "num"; value: number; line: number; col: number}
	| {kind: "str"; value: string; line: number; col: number}
	| {kind: "bool"; value: boolean; line: number; col: number}
	| {kind: "null"; line: number; col: number}
	| {kind: "undef"; line: number; col: number}
	| {kind: "ident"; name: string; line: number; col: number}
	| {kind: "array"; items: Expr[]; line: number; col: number}
	| {kind: "object"; pairs: Array<{key: string; value: Expr}>; line: number; col: number}
	| {kind: "member"; obj: Expr; name: string; line: number; col: number}
	| {kind: "index"; obj: Expr; index: Expr; line: number; col: number}
	| {kind: "call"; callee: Expr; args: Expr[]; line: number; col: number}
	| {kind: "lambda"; params: string[]; body: Expr; line: number; col: number}
	| {kind: "unary"; op: "-"; arg: Expr; line: number; col: number}
	| {kind: "not"; arg: Expr; line: number; col: number}
	| {kind: "logical"; op: "and" | "or"; left: Expr; right: Expr; line: number; col: number}
	| {kind: "binary"; op: BinaryOp; left: Expr; right: Expr; line: number; col: number};

type BinaryOp = "==" | "!=" | "<" | "<=" | ">" | ">=" | "+" | "-" | "*" | "/" | "%" | "=~";

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type TokKind = "num" | "str" | "ident" | "punct" | "eof";
interface Tok {
	kind: TokKind;
	text: string;
	value?: number | string;
	line: number;
	col: number;
}

/**
 * Longest match first — order matters: "=~" before "==", "=>" before "=", and
 * ">=" is unaffected because it starts with ">".
 * "=" is the Dataview alias for equality (`WHERE status = "open"` is valid in
 * Obsidian's docs); it is normalized to "==" by the parser, never evaluated.
 * "=>" is the lambda arrow (`(x) => x + 1`), consumed by the parser only in
 * parameter-list position so `x >= 1` / `status = "open"` keep working.
 */
const PUNCTS = ["=~", "==", "=>", "=", "!=", "<=", ">=", "&&", "||", "(", ")", "[", "]", "{", "}", ".", ",", ":", "+", "-", "*", "/", "%", "<", ">", "!"];

function isIdentStart(c: string): boolean {
	// Unicode letters so frontmatter keys like `标题` work as bare identifiers.
	return /[\p{L}\p{Nl}_$]/u.test(c);
}
function isIdentPart(c: string): boolean {
	return /[\p{L}\p{N}\p{M}_$]/u.test(c);
}

function lex(src: string): Tok[] {
	const toks: Tok[] = [];
	let i = 0;
	let line = 1;
	let col = 1;
	const n = src.length;
	const push = (kind: TokKind, text: string, startLine: number, startCol: number, value?: number | string): void => {
		const t: Tok = {kind, text, line: startLine, col: startCol};
		if (value !== undefined) t.value = value;
		toks.push(t);
	};
	while (i < n) {
		const c = src[i]!;
		if (c === "\n") {
			i++;
			line++;
			col = 1;
			continue;
		}
		if (c === " " || c === "\t" || c === "\r") {
			i++;
			col++;
			continue;
		}
		const sl = line;
		const sc = col;
		// strings
		if (c === "'" || c === '"') {
			const quote = c;
			i++;
			col++;
			let out = "";
			while (i < n && src[i] !== quote) {
				if (src[i] === "\\" && i + 1 < n) {
					const e = src[i + 1]!;
					out +=
						e === "n" ? "\n" : e === "r" ? "\r" : e === "t" ? "\t" : e === "u" && /^[\da-fA-F]{4}/.test(src.slice(i + 2, i + 6)) ? String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16)) : e === "u" && src[i + 2] === "{" ? readUPlus(src, i)!.ch : escapeChar(e);
					const adv = e === "u" && src[i + 2] === "{" ? readUPlus(src, i)!.len : e === "u" && /^[\da-fA-F]{4}/.test(src.slice(i + 2, i + 6)) ? 6 : 2;
					i += adv;
					col += adv;
				} else {
					if (src[i] === "\n") {
						line++;
						col = 1;
					} else col++;
					out += src[i];
					i++;
				}
			}
			if (i >= n) throw new ExpressionError("Unterminated string", sl, sc);
			i++; // closing quote
			col++;
			push("str", out, sl, sc, out);
			continue;
		}
		// numbers
		if (c >= "0" && c <= "9") {
			let j = i;
			while (j < n && src[j]! >= "0" && src[j]! <= "9") j++;
			if (j < n && src[j] === "." && j + 1 < n && src[j + 1]! >= "0" && src[j + 1]! <= "9") {
				j++;
				while (j < n && src[j]! >= "0" && src[j]! <= "9") j++;
			}
			if (j < n && (src[j] === "e" || src[j] === "E")) {
				let k = j + 1;
				if (k < n && (src[k] === "+" || src[k] === "-")) k++;
				if (k < n && src[k]! >= "0" && src[k]! <= "9") {
					k++;
					while (k < n && src[k]! >= "0" && src[k]! <= "9") k++;
					j = k;
				}
			}
			const text = src.slice(i, j);
			col += j - i;
			i = j;
			push("num", text, sl, sc, Number(text));
			continue;
		}
		// identifiers / keywords
		if (isIdentStart(c)) {
			let j = i;
			while (j < n && isIdentPart(src[j]!)) j++;
			const text = src.slice(i, j);
			col += j - i;
			i = j;
			push("ident", text, sl, sc);
			continue;
		}
		// punctuators (longest match first — PUNCTS ordered accordingly)
		let matched = "";
		for (const p of PUNCTS) {
			if (src.startsWith(p, i)) {
				matched = p;
				break;
			}
		}
		if (matched === "") throw new ExpressionError(`Unexpected character ${JSON.stringify(c)}`, sl, sc);
		col += matched.length;
		i += matched.length;
		push("punct", matched, sl, sc);
	}
	toks.push({kind: "eof", text: "", line, col});
	return toks;
}

/**
 * Resolve a single backslash escape inside a string literal.
 * `\"` `\'` `\\` yield the literal character; any other escape keeps its
 * backslash (Dataview semantics — `"\w+"` is the regex `\w+`, not `w+`).
 * (`\n` `\r` `\t` `\uXXXX` / `\u{…}` are handled by the lexer before this.)
 */
function escapeChar(e: string): string {
	return e === "\\" || e === '"' || e === "'" ? e : "\\" + e;
}

function readUPlus(src: string, i: number): {ch: string; len: number} | null {
	const end = src.indexOf("}", i + 3);
	if (end < 0) return null;
	const hex = src.slice(i + 3, end);
	const code = parseInt(hex, 16);
	if (Number.isNaN(code)) return null;
	return {ch: String.fromCodePoint(code), len: end + 1 - i};
}

// ---------------------------------------------------------------------------
// Parser (recursive descent; binary levels iterate — no stack growth)
// ---------------------------------------------------------------------------

class Parser {
	private readonly toks: Tok[];
	private p = 0;
	private depth = 0;

	constructor(src: string) {
		this.toks = lex(src);
	}

	parse(): Expr {
		const e = this.parseOr();
		const t = this.peek();
		if (t.kind !== "eof") throw new ExpressionError(`Unexpected token ${JSON.stringify(t.text)}`, t.line, t.col);
		return e;
	}

	private peek(): Tok {
		return this.toks[this.p]!;
	}
	private next(): Tok {
		return this.toks[this.p++]!;
	}
	private isPunct(t: Tok, s: string): boolean {
		return t.kind === "punct" && t.text === s;
	}
	private isIdent(t: Tok, s: string): boolean {
		return t.kind === "ident" && t.text === s;
	}
	private enter(t: Tok): void {
		if (++this.depth > MAX_DEPTH) throw new ExpressionError("Expression nesting too deep", t.line, t.col);
	}
	private leave(): void {
		this.depth--;
	}

	private parseOr(): Expr {
		let left = this.parseAnd();
		for (;;) {
			const t = this.peek();
			if (this.isIdent(t, "or") || this.isPunct(t, "||")) {
				this.next();
				const right = this.parseAnd();
				left = {kind: "logical", op: "or", left, right, line: left.line, col: left.col};
			} else return left;
		}
	}

	private parseAnd(): Expr {
		let left = this.parseNot();
		for (;;) {
			const t = this.peek();
			if (this.isIdent(t, "and") || this.isPunct(t, "&&")) {
				this.next();
				const right = this.parseNot();
				left = {kind: "logical", op: "and", left, right, line: left.line, col: left.col};
			} else return left;
		}
	}

	private parseNot(): Expr {
		const t = this.peek();
		if (this.isIdent(t, "not") || this.isPunct(t, "!")) {
			this.next();
			this.enter(t);
			const arg = this.parseNot();
			this.leave();
			return {kind: "not", arg, line: t.line, col: t.col};
		}
		return this.parseMatch();
	}

	private parseMatch(): Expr {
		let left = this.parseCmp();
		while (this.isPunct(this.peek(), "=~")) {
			const op = this.next();
			const right = this.parseCmp();
			left = {kind: "binary", op: "=~", left, right, line: op.line, col: op.col};
		}
		return left;
	}

	private parseCmp(): Expr {
		let left = this.parseAdd();
		for (;;) {
			const t = this.peek();
			if (t.kind === "punct" && (t.text === "==" || t.text === "=" || t.text === "!=" || t.text === "<" || t.text === "<=" || t.text === ">" || t.text === ">=")) {
				this.next();
				const right = this.parseAdd();
				// "=" is Dataview's alias for "==" — normalized here so the
				// evaluator only ever sees one equality operator.
				const op = (t.text === "=" ? "==" : t.text) as BinaryOp;
				left = {kind: "binary", op, left, right, line: t.line, col: t.col};
			} else return left;
		}
	}

	private parseAdd(): Expr {
		let left = this.parseMul();
		for (;;) {
			const t = this.peek();
			if (this.isPunct(t, "+") || this.isPunct(t, "-")) {
				this.next();
				const right = this.parseMul();
				left = {kind: "binary", op: t.text as BinaryOp, left, right, line: t.line, col: t.col};
			} else return left;
		}
	}

	private parseMul(): Expr {
		let left = this.parseUnary();
		for (;;) {
			const t = this.peek();
			if (this.isPunct(t, "*") || this.isPunct(t, "/") || this.isPunct(t, "%")) {
				this.next();
				const right = this.parseUnary();
				left = {kind: "binary", op: t.text as BinaryOp, left, right, line: t.line, col: t.col};
			} else return left;
		}
	}

	private parseUnary(): Expr {
		const t = this.peek();
		if (this.isPunct(t, "-")) {
			this.next();
			this.enter(t);
			const arg = this.parseUnary();
			this.leave();
			return {kind: "unary", op: "-", arg, line: t.line, col: t.col};
		}
		return this.parsePostfix();
	}

	private parsePostfix(): Expr {
		let e = this.parsePrimary();
		for (;;) {
			const t = this.peek();
			if (this.isPunct(t, ".")) {
				this.next();
				const name = this.next();
				if (name.kind !== "ident") throw new ExpressionError("Expected property name after '.'", name.line, name.col);
				e = {kind: "member", obj: e, name: name.text, line: e.line, col: e.col};
			} else if (this.isPunct(t, "[")) {
				this.next();
				this.enter(t);
				const idx = this.parseOr();
				this.leave();
				const close = this.next();
				if (!this.isPunct(close, "]")) throw new ExpressionError("Expected ']'", close.line, close.col);
				e = {kind: "index", obj: e, index: idx, line: e.line, col: e.col};
			} else if (this.isPunct(t, "(")) {
				this.next();
				const args: Expr[] = [];
				if (!this.isPunct(this.peek(), ")")) {
					for (;;) {
						this.enter(t);
						args.push(this.parseOr());
						this.leave();
						if (this.isPunct(this.peek(), ",")) {
							this.next();
							continue;
						}
						break;
					}
				}
				const close = this.next();
				if (!this.isPunct(close, ")")) throw new ExpressionError("Expected ')'", close.line, close.col);
				e = {kind: "call", callee: e, args, line: e.line, col: e.col};
			} else return e;
		}
	}

	/**
	 * Attempt `(a, b) => body` starting just after the consumed "(".
	 * Returns null (restoring the token cursor) when the paren group is not a
	 * parameter list, so ordinary parenthesised expressions keep working.
	 * Upstream grammar requires the parenthesised form; the bare `x => body`
	 * form is accepted by parsePrimary as well.
	 */
	private tryParseLambda(open: Tok): Expr | null {
		const start = this.p;
		const params: string[] = [];
		let ok = true;
		if (!this.isPunct(this.peek(), ")")) {
			for (;;) {
				const id = this.peek();
				if (id.kind !== "ident" || id.text === "and" || id.text === "or" || id.text === "not") {
					ok = false;
					break;
				}
				this.next();
				params.push(id.text);
				if (this.isPunct(this.peek(), ",")) {
					this.next();
					continue;
				}
				break;
			}
		}
		if (ok && this.isPunct(this.peek(), ")")) {
			this.next();
			if (this.isPunct(this.peek(), "=>")) {
				this.next();
				this.enter(open);
				const body = this.parseOr();
				this.leave();
				return {kind: "lambda", params, body, line: open.line, col: open.col};
			}
		}
		this.p = start;
		return null;
	}

	private parsePrimary(): Expr {
		const t = this.next();
		switch (t.kind) {
			case "num":
				return {kind: "num", value: t.value as number, line: t.line, col: t.col};
			case "str":
				return {kind: "str", value: t.value as string, line: t.line, col: t.col};
			case "ident":
				if (t.text === "true") return {kind: "bool", value: true, line: t.line, col: t.col};
				if (t.text === "false") return {kind: "bool", value: false, line: t.line, col: t.col};
				if (t.text === "null") return {kind: "null", line: t.line, col: t.col};
				if (t.text === "undefined") return {kind: "undef", line: t.line, col: t.col};
				if (t.text === "and" || t.text === "or" || t.text === "not") throw new ExpressionError(`Unexpected keyword ${t.text}`, t.line, t.col);
				// Bare single-parameter lambda: `x => expr`.
				if (this.isPunct(this.peek(), "=>")) {
					this.next();
					const body = this.parseOr();
					return {kind: "lambda", params: [t.text], body, line: t.line, col: t.col};
				}
				return {kind: "ident", name: t.text, line: t.line, col: t.col};
			case "punct": {
				if (t.text === "(") {
					const lambda = this.tryParseLambda(t);
					if (lambda !== null) return lambda;
					this.enter(t);
					const e = this.parseOr();
					this.leave();
					const close = this.next();
					if (!this.isPunct(close, ")")) throw new ExpressionError("Expected ')'", close.line, close.col);
					return e;
				}
				if (t.text === "[") {
					this.enter(t);
					const items: Expr[] = [];
					if (!this.isPunct(this.peek(), "]")) {
						for (;;) {
							items.push(this.parseOr());
							if (this.isPunct(this.peek(), ",")) {
								this.next();
								continue;
							}
							break;
						}
					}
					this.leave();
					const close = this.next();
					if (!this.isPunct(close, "]")) throw new ExpressionError("Expected ']'", close.line, close.col);
					return {kind: "array", items, line: t.line, col: t.col};
				}
				if (t.text === "{") {
					this.enter(t);
					const pairs: Array<{key: string; value: Expr}> = [];
					if (!this.isPunct(this.peek(), "}")) {
						for (;;) {
							const keyTok = this.next();
							let key: string;
							if (keyTok.kind === "ident" || keyTok.kind === "str") key = keyTok.text;
							else throw new ExpressionError("Expected object key", keyTok.line, keyTok.col);
							const colon = this.next();
							if (!this.isPunct(colon, ":")) throw new ExpressionError("Expected ':' in object literal", colon.line, colon.col);
							const value = this.parseOr();
							pairs.push({key, value});
							if (this.isPunct(this.peek(), ",")) {
								this.next();
								continue;
							}
							break;
						}
					}
					this.leave();
					const close = this.next();
					if (!this.isPunct(close, "}")) throw new ExpressionError("Expected '}'", close.line, close.col);
					return {kind: "object", pairs, line: t.line, col: t.col};
				}
				throw new ExpressionError(`Unexpected token ${JSON.stringify(t.text)}`, t.line, t.col);
			}
			case "eof":
				throw new ExpressionError("Unexpected end of expression", t.line, t.col);
		}
	}
}

export function parseExpression(src: string): Expr {
	return new Parser(src).parse();
}

// ---------------------------------------------------------------------------
// Iterative evaluator
// ---------------------------------------------------------------------------

interface Frame {
	node: Expr;
	stage: number;
	acc: DvValue[];
	depth: number; // value-descent depth (member/call chain), capped at MAX_DEPTH
}

function isDescent(n: Expr): boolean {
	return n.kind === "member" || n.kind === "index" || n.kind === "call";
}

function lookupVar(scope: Record<string, unknown>, name: string): DvValue {
	// Own-property walk up the scope chain (lambda closure frames are linked via
	// Object.create) but never through Object.prototype — otherwise `toString` /
	// `constructor` leak in. Miss → null (Dataview-loose).
	for (let cur: object | null = scope; cur !== null && cur !== Object.prototype; cur = Object.getPrototypeOf(cur) as object | null) {
		if (Object.prototype.hasOwnProperty.call(cur, name)) return (cur as Record<string, unknown>)[name] as DvValue;
	}
	// Own-property check on the table too — otherwise `toString`/`constructor`
	// leak in via Object.prototype.
	if (Object.prototype.hasOwnProperty.call(DvFunctions, name)) return DvFunctions[name] as DvValue;
	return null;
}

function memberGet(obj: DvValue, key: DvValue, node: Expr): DvValue {
	if (obj === null || obj === undefined) return null;
	const k: string | number = typeof key === "number" ? key : typeof key === "string" ? key : String(key);
	// strings
	if (typeof obj === "string") {
		if (k === "length") return obj.length;
		if (typeof k === "number" || (typeof k === "string" && /^\d+$/.test(k))) return obj[Number(k)] ?? null;
		return null;
	}
	// DvDate: whitelist own fields + bound methods (prototype getters are not own props)
	if (isDvDate(obj)) {
		if (typeof k === "string") {
			switch (k) {
				case "iso":
				case "year":
				case "month":
				case "day":
				case "hour":
				case "minute":
				case "second":
				case "weekday":
					return obj[k] as DvValue;
				case "isValid":
					return obj.isValid as DvValue;
				/**
				 * Date methods are dispatched generically because `memberGet` hands
				 * back a DETACHED function (the call site in the evaluator drops the
				 * receiver) — each method is re-bound to `obj` here. Covers the whole
				 * DvDate surface (upstream: the full Luxon DateTime API).
				 */
				case "toFormat":
				case "toISO":
				case "toMillis":
				case "startOf":
				case "endOf":
				case "set":
				case "diff":
				case "until":
				case "hasSame":
				case "toISODate":
				case "toISOTime":
				case "toISOWeekDate":
				case "toRelative":
				case "toObject":
				case "weekdayLong":
				case "monthLong":
				case "daysInMonth":
				case "plus":
				case "minus":
				case "equals": {
					const fn = (obj as unknown as Record<string, (...args: DvValue[]) => DvValue>)[k]!;
					return ((...args: DvValue[]) => fn.apply(obj, args)) as DvValue;
				}
				default:
					return null;
			}
		}
		return null;
	}
	// arrays / DataArray: length, index, else field projection (Dataview-style)
	const arr = isDataArray(obj) ? (obj as {array(): DvValue[]}).array() : Array.isArray(obj) ? obj : null;
	if (arr !== null) {
		if (k === "length") return arr.length;
		if (typeof k === "number" || (typeof k === "string" && /^\d+$/.test(k))) return arr[Number(k)] ?? null;
		// project member over elements → new array (no method exposure)
		return arr.map((el) => memberGet(el, k, node));
	}
	if (typeof obj === "function") return null;
	// plain objects / links / durations: own properties only (no prototype walk)
	if (typeof obj === "object") {
		const rec = obj as Record<string, unknown>;
		if (Object.prototype.hasOwnProperty.call(rec, k)) return rec[k as string] as DvValue;
		return null;
	}
	return null;
}

function concatValues(a: DvValue, b: DvValue): string {
	const fmt = (v: DvValue): string => {
		if (v === null || v === undefined) return "";
		if (typeof v === "string") return v;
		if (typeof v === "number" || typeof v === "boolean") return String(v);
		if (v instanceof Date) return v.toISOString();
		if (isDvDate(v)) return v.toISO();
		return String(v);
	};
	return fmt(a) + fmt(b);
}

function applyBinary(n: Expr & {kind: "binary"}, a: DvValue, b: DvValue): DvValue {
	switch (n.op) {
		case "==":
			return looseEquals(a, b);
		case "!=":
			return !looseEquals(a, b);
		case "<":
			return compareRel(a, b) < 0;
		case "<=":
			return compareRel(a, b) <= 0;
		case ">":
			return compareRel(a, b) > 0;
		case ">=":
			return compareRel(a, b) >= 0;
		case "+": {
			if (typeof a === "string" || typeof b === "string") return concatValues(a, b);
			if (a === null || a === undefined || b === null || b === undefined) return null;
			if (typeof a === "number" && typeof b === "number") return a + b;
			return null;
		}
		case "-":
		case "*":
		case "/":
		case "%": {
			if (a === null || a === undefined || b === null || b === undefined) return null;
			if (typeof a === "number" && typeof b === "number") {
				if (n.op === "-") return a - b;
				if (n.op === "*") return a * b;
				if (n.op === "/") return a / b;
				return a % b;
			}
			return null;
		}
		case "=~": {
			if (a === null || a === undefined || b === null || b === undefined) return false;
			const pattern = typeof b === "string" ? b : isDvDate(b) ? b.toISO() : String(b);
			let re: RegExp;
			try {
				re = new RegExp(pattern);
			} catch (e) {
				throw new ExpressionError(`Invalid regular expression: ${(e as Error).message}`, n.line, n.col);
			}
			const target = typeof a === "string" ? a : isDvDate(a) ? a.toISO() : String(a);
			return re.test(target);
		}
	}
}

export function evalExpr(root: Expr, scope: Record<string, unknown>): DvValue {
	const rootDepth = isDescent(root) ? 1 : 0;
	if (rootDepth > MAX_DEPTH) throw new ExpressionError("Expression nesting too deep", root.line, root.col);
	const stack: Frame[] = [{node: root, stage: 0, acc: [], depth: rootDepth}];
	let result: DvValue = null;
	const pushChild = (parent: Frame, child: Expr): void => {
		// Value-descent cap guards cyclic member/call chains; binary frames reset it
		// so long arithmetic chains stay unlimited (heap stack, O(ast)).
		const d = isDescent(child) ? parent.depth + 1 : 0;
		if (d > MAX_DEPTH) throw new ExpressionError("Expression nesting too deep", child.line, child.col);
		stack.push({node: child, stage: 0, acc: [], depth: d});
	};
	/** Pop current frame; deliver value to parent. Returns true when root finished. */
	const complete = (v: DvValue): boolean => {
		stack.pop();
		if (stack.length === 0) {
			result = v;
			return true;
		}
		stack[stack.length - 1]!.acc.push(v);
		return false;
	};
	for (;;) {
		const f = stack[stack.length - 1]!;
		const n = f.node;
		switch (n.kind) {
			case "num": {
				if (complete(n.value)) return result;
				break;
			}
			case "str": {
				if (complete(n.value)) return result;
				break;
			}
			case "bool": {
				if (complete(n.value)) return result;
				break;
			}
			case "null": {
				if (complete(null)) return result;
				break;
			}
			case "undef": {
				if (complete(undefined)) return result;
				break;
			}
			case "ident": {
				if (complete(lookupVar(scope, n.name))) return result;
				break;
			}
			case "array": {
				if (f.stage < n.items.length) {
					const child = n.items[f.stage]!;
					f.stage++;
					pushChild(f, child);
				} else if (complete(f.acc)) return result;
				break;
			}
			case "object": {
				if (f.stage < n.pairs.length) {
					const child = n.pairs[f.stage]!.value;
					f.stage++;
					pushChild(f, child);
				} else {
					// null-proto so `{__proto__: x}` cannot pollute the prototype.
					const obj: Record<string, DvValue> = Object.create(null) as Record<string, DvValue>;
					for (let i = 0; i < n.pairs.length; i++) obj[n.pairs[i]!.key] = f.acc[i]!;
					if (complete(obj as DvValue)) return result;
				}
				break;
			}
			case "member": {
				if (f.stage === 0) {
					f.stage = 1;
					pushChild(f, n.obj);
				} else if (complete(memberGet(f.acc[0]!, n.name, n))) return result;
				break;
			}
			case "index": {
				if (f.stage === 0) {
					f.stage = 1;
					pushChild(f, n.obj);
				} else if (f.stage === 1) {
					f.stage = 2;
					pushChild(f, n.index);
				} else if (complete(memberGet(f.acc[0]!, f.acc[1]!, n))) return result;
				break;
			}
			case "call": {
				const total = 1 + n.args.length;
				if (f.stage < total) {
					const child = f.stage === 0 ? n.callee : n.args[f.stage - 1]!;
					f.stage++;
					pushChild(f, child);
				} else {
					const fn = f.acc[0];
					if (typeof fn !== "function") throw new ExpressionError("Value is not a function", n.line, n.col);
					const v = (fn as (...args: DvValue[]) => DvValue)(...f.acc.slice(1));
					if (complete(v)) return result;
				}
				break;
			}
			case "lambda": {
				// First-class function value. Upstream: a lambda is a value that can
				// be passed to map/filter/…, stored, and closed over. The closure
				// captures the *current* scope; parameters shadow outer names; the
				// chain (Object.create) keeps outer variables visible. Body errors
				// surface as ExpressionError with the body node's line/col.
				const parent = scope;
				const params = n.params;
				const body = n.body;
				const fn = (...args: DvValue[]): DvValue => {
					const inner: Record<string, unknown> = Object.create(parent) as Record<string, unknown>;
					for (let i = 0; i < params.length; i++) inner[params[i]!] = i < args.length ? args[i] : null;
					return evalExpr(body, inner);
				};
				if (complete(fn as DvValue)) return result;
				break;
			}
			case "unary": {
				if (f.stage === 0) {
					f.stage = 1;
					pushChild(f, n.arg);
				} else {
					const a = f.acc[0]!;
					let v: DvValue;
					if (a === null || a === undefined) v = null;
					else if (typeof a === "number") v = -a;
					else if (typeof a === "string" && a.trim() !== "" && Number.isFinite(Number(a))) v = -Number(a);
					else v = null;
					if (complete(v)) return result;
				}
				break;
			}
			case "not": {
				if (f.stage === 0) {
					f.stage = 1;
					pushChild(f, n.arg);
				} else if (complete(!truthy(f.acc[0]!))) return result;
				break;
			}
			case "logical": {
				// Short-circuit: decided left operand skips evaluating the right child.
				if (f.stage === 0) {
					f.stage = 1;
					pushChild(f, n.left);
				} else if (f.stage === 1) {
					const l = f.acc[0]!;
					if (n.op === "and") {
						if (!truthy(l)) {
							if (complete(false)) return result;
							break;
						}
					} else if (truthy(l)) {
						if (complete(true)) return result;
						break;
					}
					f.stage = 2;
					pushChild(f, n.right);
				} else if (complete(truthy(f.acc[1]!))) return result;
				break;
			}
			case "binary": {
				if (f.stage === 0) {
					f.stage = 1;
					pushChild(f, n.left);
				} else if (f.stage === 1) {
					f.stage = 2;
					pushChild(f, n.right);
				} else if (complete(applyBinary(n, f.acc[0]!, f.acc[1]!))) return result;
				break;
			}
		}
	}
}

/** Public API: parse + evaluate; throws ExpressionError (with line/col) on failure. */
export function evaluateExpression(src: string, scope: Record<string, unknown>): DvValue {
	const ast = parseExpression(src);
	return evalExpr(ast, scope);
}
