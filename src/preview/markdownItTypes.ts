/**
 * Minimal structural types for the pieces of markdown-it the preview plugin
 * touches. Keeps the plugin free of `any` without depending on markdown-it's
 * internals (the instance is provided by VSCode at runtime).
 */

export interface BlockRuleState {
	src: string;
	bMarks: number[];
	eMarks: number[];
	blkIndent: number;
	line: number;
	level: number;
	env: Record<string, unknown>;
	push(type: string, tag: string, nesting: number): {content: string; map: [number, number]; level: number};
	getLines(begin: number, end: number, indent: number, keepLastLF: boolean): string;
}

export interface InlineRuleState {
	src: string;
	pos: number;
	push(type: string, tag: string, nesting: number): {attrSet(k: string, v: string): void; content: string};
}

export interface RenderToken {
	content: string;
	attrGet(name: string): string | null;
	/** Fence language hint + optional title ("dataviewjs" | "dataviewjs title"). */
	info?: string;
	/** Source line range [start, end) — used as a stable block identity. */
	map?: [number, number] | null;
}

export interface MarkdownItLike {
	block: {
		ruler: {
			before(
				anchorName: string,
				ruleName: string,
				rule: (state: BlockRuleState, startLine: number, endLine: number, silent: boolean) => boolean,
			): void;
		};
	};
	inline: {
		ruler: {
			before(anchorName: string, ruleName: string, rule: (state: InlineRuleState, silent: boolean) => boolean): void;
		};
	};
	renderer: {
		rules: Record<string, (tokens: RenderToken[], idx: number, options?: unknown, env?: unknown, self?: unknown) => string>;
	};
	core: {
		ruler: {
			after(anchor: string, name: string, rule: (state: CoreRuleState) => void): void;
		};
	};
	render(src: string, env?: unknown): string;
}

export interface CoreTokenLike {
	type: string;
	level: number;
	content: string;
	children: CoreTokenLike[];
	attrs: Array<[string, string]>;
	attrIndex(name: string): number;
	attrPush(attr: [string, string]): void;
}

export interface CoreRuleState {
	tokens: CoreTokenLike[];
	Token: new (type: string, tag: string, nesting: number) => CoreTokenLike;
}

/** Line texts of `[from, to)` as markdown-it sees them. */
export function blockLines(state: BlockRuleState, from: number, to: number): string[] {
	const lines: string[] = [];
	for (let i = from; i < to; i++) {
		lines.push(state.src.slice(state.bMarks[i]!, state.eMarks[i]!));
	}
	return lines;
}
