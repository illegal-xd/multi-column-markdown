/**
 * DQL parser — turns raw block source into the golden `DqlQuery` shape.
 *
 * Clause rules (per spec):
 *   - First non-blank line must start with TABLE | LIST | TASKS | CALENDAR
 *     (case-insensitive).
 *   - Clauses are line-leading keywords (case-insensitive, leading indent ok):
 *     FROM, WHERE, SORT, GROUP BY, FLATTEN, LIMIT.
 *   - Expressions may span lines: continuation lines are absorbed until the
 *     next line-leading clause keyword.
 *   - TABLE/LIST accept `WITHOUT ID` (no implicit file column/prefix) →
 *     `withoutId: true` on the returned query.
 *   - TABLE fields: top-level comma split (paren/bracket/quote depth aware).
 *     `FIELD AS alias` is NOT supported (documented deviation → header = expr).
 *   - GROUP BY / FLATTEN accept `expr AS name` aliases
 *     → `groupByAlias` / `flattenAliases` (parallel to `flatten`).
 *   - CALENDAR parses to `type: "calendar"` with the date field in `fields`
 *     (execution is handled elsewhere; this parser only produces the shape).
 *   - FROM source is passed to matchSource; compound sources (`or`/`and`/
 *     negation/`incoming(...)`/`outgoing(...)`) are emitted as ONE raw string
 *     literal so the boolean structure survives expression evaluation, while
 *     plain sources keep the legacy per-token rewrite (#tag → string literal,
 *     [[path]] → link(...)).
 *   - Every expression region is validated here; failures wrap into DqlError
 *     so malformed input never escapes as an unhandled parser crash.
 */
import type {DqlField, DqlQuery} from "../types";
import {ExpressionError, parseExpression} from "./expression";
import {isCompoundSource} from "./source";

export class DqlError extends Error {
	readonly line?: number;
	constructor(message: string, line?: number) {
		super(message);
		this.name = "DqlError";
		this.line = line;
	}
}

const CLAUSE_RE = /^\s*(FROM|WHERE|SORT|GROUP\s+BY|FLATTEN|LIMIT)\b/i;

function isClauseLine(line: string): boolean {
	return CLAUSE_RE.test(line);
}

/** Split on top-level commas only ((), [], {} depth + string quotes respected). */
export function splitTopLevel(text: string, sep: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let quote: string | null = null;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!;
		if (quote !== null) {
			if (c === "\\") i++;
			else if (c === quote) quote = null;
			continue;
		}
		if (c === "'" || c === '"') quote = c;
		else if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") depth--;
		else if (c === sep && depth === 0) {
			parts.push(text.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(text.slice(start));
	return parts;
}

/** Wrap raw text as a single-quoted expression string literal. */
function sourceTextLiteral(text: string): string {
	const escaped = text.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r?\n/g, "\\n");
	return "'" + escaped + "'";
}

/**
 * Rewrite source-position sugar so the expression evaluator can consume it:
 *   #tag          → '#tag'
 *   [[path|disp]] → link("path", "disp")
 *   ![[path]]     → link("path", undefined, true)
 * Quote-aware; content inside '…' / "…" is left untouched.
 *
 * Compound sources (`#a or -#b`, `outgoing([[x]])`, …) are emitted as one raw
 * string literal instead: evaluating them as an expression would collapse the
 * boolean structure to a single truthy value. matchSource re-parses the text.
 */
export function rewriteSourceExpr(src: string): string {
	if (isCompoundSource(src)) return sourceTextLiteral(src);
	let out = "";
	let i = 0;
	const n = src.length;
	let quote: string | null = null;
	while (i < n) {
		const c = src[i]!;
		if (quote !== null) {
			out += c;
			if (c === "\\" && i + 1 < n) {
				out += src[i + 1];
				i += 2;
				continue;
			}
			if (c === quote) quote = null;
			i++;
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			out += c;
			i++;
			continue;
		}
		// embed link: ![[…]] — the '!' is consumed with it
		if (c === "!" && src.startsWith("[[", i + 1)) {
			const end = src.indexOf("]]", i + 3);
			if (end < 0) {
				out += c;
				i++;
				continue;
			}
			out += linkCall(src.slice(i + 3, end), true);
			i = end + 2;
			continue;
		}
		if (src.startsWith("[[", i)) {
			const end = src.indexOf("]]", i + 2);
			if (end < 0) {
				out += c;
				i++;
				continue;
			}
			out += linkCall(src.slice(i + 2, end), false);
			i = end + 2;
			continue;
		}
		if (c === "#" && i + 1 < n && /[\p{L}\p{N}_/-]/u.test(src[i + 1]!)) {
			let j = i + 1;
			while (j < n && /[\p{L}\p{N}_/-]/u.test(src[j]!)) j++;
			out += "'" + src.slice(i, j) + "'";
			i = j;
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

function linkCall(inner: string, embed: boolean): string {
	// Subpath/display are irrelevant to source matching — keep path only.
	let path = inner;
	const pipe = path.indexOf("|");
	if (pipe >= 0) path = path.slice(0, pipe);
	const hash = path.indexOf("#");
	if (hash >= 0) path = path.slice(0, hash);
	path = path.trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const args = embed ? `"${path}", undefined, true` : `"${path}"`;
	return `link(${args})`;
}

function validateExpr(src: string, line: number): string {
	const trimmed = src.trim();
	if (trimmed === "") throw new DqlError("Missing expression", line);
	try {
		parseExpression(trimmed);
	} catch (e) {
		if (e instanceof ExpressionError) throw new DqlError(`Invalid expression: ${e.message} (line ${e.line}, col ${e.col})`, line);
		throw e;
	}
	return trimmed;
}

/** Normalize whitespace so headers stay single-line for the renderer. */
function headerName(expr: string): string {
	return expr.replace(/\s+/g, " ").trim();
}

function parseSortSpec(text: string, line: number): Array<{expr: string; dir: "asc" | "desc"}> {
	const parts = splitTopLevel(text, ",");
	const out: Array<{expr: string; dir: "asc" | "desc"}> = [];
	for (const raw of parts) {
		const part = raw.trim();
		if (part === "") throw new DqlError("SORT requires an expression", line);
		let expr = part;
		let dir: "asc" | "desc" = "asc";
		const m = /\s+(asc|desc)$/i.exec(part);
		if (m) {
			dir = m[1]!.toLowerCase() as "asc" | "desc";
			expr = part.slice(0, m.index).trim();
		}
		if (expr === "") throw new DqlError("SORT requires an expression before ASC/DESC", line);
		out.push({expr: validateExpr(expr, line), dir});
	}
	return out;
}

function unquoteAlias(alias: string): string {
	if (alias.length >= 2) {
		const q = alias[0];
		if ((q === '"' || q === "'") && alias[alias.length - 1] === q) {
			return alias.slice(1, -1).replace(/\\(.)/g, "$1");
		}
	}
	return alias;
}

/**
 * Top-level `expr AS name` split (quote/paren aware). The LAST top-level `AS`
 * wins so `x AS name AS other` fails validation on the expression instead of
 * silently swallowing the tail into an alias.
 */
function splitAlias(text: string): {expr: string; alias?: string} {
	let depth = 0;
	let quote: string | null = null;
	let cut = -1;
	let cutLen = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!;
		if (quote !== null) {
			if (c === "\\") i++;
			else if (c === quote) quote = null;
			continue;
		}
		if (c === "'" || c === '"') quote = c;
		else if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") depth--;
		else if (depth === 0 && /\s/.test(c)) {
			const m = /^\s+as\s+/i.exec(text.slice(i));
			if (m) {
				cut = i;
				cutLen = m[0].length;
			}
		}
	}
	if (cut < 0) return {expr: text.trim()};
	const expr = text.slice(0, cut).trim();
	const alias = unquoteAlias(text.slice(cut + cutLen).trim());
	if (expr === "" || alias === "") return {expr: text.trim()}; // malformed → validateExpr rejects
	return {expr, alias};
}

function parseFieldList(text: string, line: number): DqlField[] {
	if (text.trim() === "") throw new DqlError("TABLE requires at least one field", line);
	const parts = splitTopLevel(text, ",");
	const fields: DqlField[] = [];
	for (const raw of parts) {
		// `TABLE rating AS "Rating"` — the alias (unquoted) is the column header;
		// without one the expression text is used (upstream `headerName`).
		const {expr: bare, alias} = splitAlias(raw);
		const expr = validateExpr(bare, line);
		fields.push({name: alias ?? headerName(expr), expr});
	}
	return fields;
}

interface ClauseHit {
	kind: "from" | "where" | "sort" | "groupby" | "flatten" | "limit";
	text: string;
	line: number;
}

/**
 * Parsed DQL shape + the additive fields this parser already produces.
 * `DqlQuery` in types.ts is the frozen contract (owned by the integrator); the
 * `type` cast below and this extension exist only until the reported patch
 * lands. Everything here is runtime-present regardless.
 */
export interface ParsedDqlQuery extends DqlQuery {
	/** TABLE/LIST WITHOUT ID — no implicit file column/prefix. */
	withoutId?: boolean;
	/** GROUP BY `... AS name` — display name of the group key column. */
	groupByAlias?: string;
	/** Parallel to `flatten`; `undefined` for entries without an alias. */
	flattenAliases?: Array<string | undefined>;
}

/** Query types this parser emits (types.ts DqlQuery.type gains "calendar"). */
type ParsedQueryType = DqlQuery["type"] | "calendar";

const TYPE_BY_WORD: Record<string, ParsedQueryType> = {TABLE: "table", LIST: "list", TASKS: "tasks", CALENDAR: "calendar"};

/**
 * Clauses the docs write inline on the type line:
 *   `TABLE rating AS "Rating" FROM #games SORT rating DESC`
 * `isClauseLine` only recognises clauses at line start, so split the type line
 * at top-level keywords first. Keywords must be written UPPERCASE to split —
 * that keeps a lowercase field named `from` (`TABLE from`) intact, while every
 * documented query uses uppercase keywords.
 */
function splitInlineClauses(line: string): string[] {
	const out: string[] = [];
	let buf = "";
	let depth = 0;
	let quote: string | null = null;
	for (let i = 0; i < line.length; i++) {
		const c = line[i]!;
		if (quote !== null) {
			buf += c;
			if (c === "\\") {
				buf += line[++i] ?? "";
			} else if (c === quote) {
				quote = null;
			}
			continue;
		}
		if (c === '"' || c === "'") {
			quote = c;
			buf += c;
			continue;
		}
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") depth--;
		if (depth === 0 && /[A-Z]/.test(c)) {
			const m = /^(FROM|WHERE|SORT|GROUP\s+BY|FLATTEN|LIMIT)\b/.exec(line.slice(i));
			if (m && (buf === "" || /\s$/.test(buf))) {
				out.push(buf.trimEnd());
				buf = m[1]!.replace(/\s+/g, " ") + " ";
				i += m[1]!.length - 1;
				continue;
			}
		}
		buf += c;
	}
	out.push(buf.trimEnd());
	return out.filter((part) => part !== "");
}

export function parseDql(src: string): ParsedDqlQuery {
	const lines = src.split(/\r?\n/);
	let i = 0;
	while (i < lines.length && lines[i]!.trim() === "") i++;
	if (i >= lines.length) throw new DqlError("Empty query");
	const head = /^\s*(TABLE|LIST|TASKS|CALENDAR)\b/i.exec(lines[i]!);
	if (!head) throw new DqlError("Query must start with TABLE, LIST, TASKS or CALENDAR", i + 1);
	// Inline clauses on the type line become their own logical lines (docs form).
	const expanded = splitInlineClauses(lines[i]!);
	if (expanded.length > 1) {
		lines.splice(i, 1, ...expanded);
	}
	const type = TYPE_BY_WORD[head[1]!.toUpperCase()]!;
	const firstLineNo = i + 1;

	// Header region: rest of the type line + following lines until a clause.
	const headerParts: string[] = [lines[i]!.slice(head[0].length)];
	let j = i + 1;
	while (j < lines.length && !isClauseLine(lines[j]!)) {
		headerParts.push(lines[j]!);
		j++;
	}
	let headerText = headerParts.join("\n").trim();

	// `WITHOUT ID` (TABLE/LIST): suppress the implicit file column/prefix.
	let withoutId = false;
	if (type === "table" || type === "list") {
		const m = /^WITHOUT\s+ID\b/i.exec(headerText);
		if (m) {
			withoutId = true;
			headerText = headerText.slice(m[0].length).trim();
		}
	}

	let fields: DqlField[] | null = null;
	if (type === "table") {
		fields = parseFieldList(headerText, firstLineNo);
	} else if (type === "list") {
		if (headerText !== "") {
			const expr = validateExpr(headerText, firstLineNo);
			fields = [{name: headerName(expr), expr}];
		}
	} else if (type === "calendar") {
		// CALENDAR takes exactly one date field; execution consumes fields[0].
		const expr = validateExpr(headerText, firstLineNo);
		fields = [{name: headerName(expr), expr}];
	} else if (headerText !== "") {
		throw new DqlError("TASKS does not take a field list", firstLineNo);
	}

	const query: ParsedDqlQuery = {
		// Cast: types.ts DqlQuery.type does not list "calendar" yet (patch reported).
		type: type as DqlQuery["type"],
		fields,
		source: "",
		sort: [],
		flatten: [],
		flattenAliases: [],
	};
	if (withoutId) query.withoutId = true;

	// Clause loop — later scalar clauses win; FLATTEN appends; SORT replaces.
	while (j < lines.length) {
		const m = CLAUSE_RE.exec(lines[j]!);
		if (!m) {
			j++;
			continue;
		}
		const lineNo = j + 1;
		const kwRaw = m[0].replace(/^\s+/, "");
		const kind = kwRaw.toLowerCase().replace(/\s+/g, "") as ClauseHit["kind"];
		const parts: string[] = [lines[j]!.slice(m[0].length)];
		j++;
		while (j < lines.length && !isClauseLine(lines[j]!)) {
			parts.push(lines[j]!);
			j++;
		}
		const text = parts.join("\n").trim();
		const hit: ClauseHit = {kind, text, line: lineNo};
		applyClause(query, hit);
	}
	return query;
}

function applyClause(q: ParsedDqlQuery, hit: ClauseHit): void {
	switch (hit.kind) {
		case "from":
			// Validate the REWRITTEN form (bare #tag is not valid expr syntax).
			if (hit.text !== "") validateExpr(rewriteSourceExpr(hit.text), hit.line);
			q.source = hit.text;
			break;
		case "where":
			q.where = validateExpr(hit.text, hit.line);
			break;
		case "sort":
			q.sort = parseSortSpec(hit.text, hit.line);
			break;
		case "groupby": {
			const {expr, alias} = splitAlias(hit.text);
			q.groupBy = validateExpr(expr, hit.line);
			if (alias !== undefined) q.groupByAlias = alias;
			break;
		}
		case "flatten": {
			const parts = splitTopLevel(hit.text, ",");
			if (q.flattenAliases === undefined) q.flattenAliases = [];
			const aliases = q.flattenAliases;
			for (const raw of parts) {
				const {expr, alias} = splitAlias(raw);
				q.flatten.push(validateExpr(expr, hit.line));
				aliases.push(alias);
			}
			break;
		}
		case "limit": {
			if (!/^\d+$/.test(hit.text)) throw new DqlError(`LIMIT expects a non-negative integer, got ${JSON.stringify(hit.text)}`, hit.line);
			q.limit = Number(hit.text);
			break;
		}
	}
}
