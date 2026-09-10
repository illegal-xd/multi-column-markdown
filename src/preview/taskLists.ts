/**
 * GFM task list rendering (`- [ ]` / `- [x]`) → checkbox input + label.
 *
 * VSCode's built-in markdown preview no longer renders task lists on the
 * supported versions (verified: `- [ ]` stays as literal text), so the
 * plugin renders them itself. Logic ported from markdown-it-task-lists
 * (MIT, https://github.com/revin/markdown-it-task-lists) with the same
 * output shape VSCode used: `<li class="task-list-item">` containing
 * `<input class="task-list-item-checkbox" disabled>` and a
 * `<label class="task-list-item-label">`.
 *
 * Idempotent: if the host already rendered a task list (no `[ ]` text
 * remains), the rule finds nothing to do.
 */
import type MarkdownIt from "markdown-it";
import type {CoreRuleState, CoreTokenLike, MarkdownItLike} from "./markdownItTypes";

function attrSet(token: CoreTokenLike, name: string, value: string): void {
	const index = token.attrIndex(name);
	if (index < 0) token.attrPush([name, value]);
	else token.attrs[index] = [name, value];
}

function parentToken(tokens: CoreTokenLike[], index: number): number {
	const targetLevel = tokens[index]!.level - 1;
	for (let i = index - 1; i >= 0; i--) {
		if (tokens[i]!.level === targetLevel) return i;
	}
	return -1;
}

function isTodoItem(tokens: CoreTokenLike[], index: number): boolean {
	const t = tokens[index];
	return (
		t !== undefined &&
		t.type === "inline" &&
		tokens[index - 1]?.type === "paragraph_open" &&
		tokens[index - 2]?.type === "list_item_open" &&
		(t.content.startsWith("[ ] ") || t.content.startsWith("[x] ") || t.content.startsWith("[X] "))
	);
}

function todoify(token: CoreTokenLike, Token: CoreRuleState["Token"]): void {
	const id = "task-item-" + Math.ceil(Math.random() * (10000 * 1000) - 1000);
	const checked = token.content.startsWith("[x] ") || token.content.startsWith("[X] ") ? ' checked=""' : "";
	// html_inline tokens keep markdown-it's default renderer — no custom
	// renderer rule needed.
	const checkbox = new Token("html_inline", "", 0);
	checkbox.content = `<input class="task-list-item-checkbox"${checked} disabled="" type="checkbox" id="${id}">`;
	const label = new Token("html_inline", "", 0);
	label.content = `<label class="task-list-item-label" for="${id}">${token.content.slice(3)}</label>`;
	token.children = [checkbox, label];
	token.content = token.content.slice(3);
}

export function installTaskLists(md: MarkdownIt): void {
	const m = md as unknown as MarkdownItLike;
	m.core.ruler.after("inline", "amc-task-lists", (state: CoreRuleState) => {
		const tokens = state.tokens;
		for (let i = 2; i < tokens.length; i++) {
			if (isTodoItem(tokens, i)) {
				todoify(tokens[i]!, state.Token);
				attrSet(tokens[i - 2]!, "class", "task-list-item");
				attrSet(tokens[parentToken(tokens, i - 2)]!, "class", "contains-task-list");
			}
		}
	});
}
