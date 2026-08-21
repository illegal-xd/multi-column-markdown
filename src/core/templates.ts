/**
 * Column layout templates.
 *
 * Ported 1:1 from amatya-aditya/advanced-multi-column main.ts (AGPL-3.0).
 */
import {buildStandaloneBlockInsertion} from "./serializer";

export const NESTED_TEMPLATE = [
	"%% col-start %%",
	"%% col-break:40,b:secondary %%",
	"Top-level content.",
	"%% col-break:60,b:secondary %%",
	"This column contains nested columns.",
	"",
	"%% col-start %%",
	"%% col-break:b:secondary %%",
	"Child column 1",
	"%% col-break:b:secondary %%",
	"Child column 2",
	"%% col-end %%",
	"%% col-end %%",
].join("\n");

export const SIDEBAR_TEMPLATE = [
	"%% col-start %%",
	"%% col-break:30,b:secondary %%",
	"Sidebar",
	"%% col-break:70,b:secondary %%",
	"Main content",
	"%% col-end %%",
].join("\n");

export const STACKED_TEMPLATE = [
	"%% col-start %%",
	"%% col-break:40,stk:1,b:secondary %%",
	"Stacked row 1",
	"%% col-break:stk:1,b:secondary %%",
	"Stacked row 2",
	"%% col-break:stk:1,b:secondary %%",
	"Stacked row 3",
	"%% col-break:60,b:secondary %%",
	"Wide column",
	"%% col-end %%",
].join("\n");

export const CORNELL_TEMPLATE = [
	"%% col-start %%",
	"%% col-break:stk:1,b:secondary %%",
	"**Topic / Title**",
	"%% col-break:30,stk:1,b:secondary %%",
	"**Cues / Questions**",
	"",
	"- Key term 1",
	"- Key question",
	"- Concept",
	"%% col-break:70,b:secondary %%",
	"**Notes**",
	"",
	"Main lecture or reading notes go here.",
	"%% col-end %%",
].join("\n");

export const KANBAN_TEMPLATE = [
	"%% col-start:sb:1,bc:muted %%",
	"%% col-break:b:alt,sb:1,bc:gray %%",
	"### Backlog",
	"- [ ] Task 1",
	"- [ ] Task 2",
	"%% col-break:b:cyan-soft,sb:1,bc:cyan %%",
	"### In Progress",
	"- [ ] Task 3",
	"%% col-break:b:yellow-soft,sb:1,bc:yellow %%",
	"### Review",
	"- [ ] Task 4",
	"%% col-break:b:green-soft,sb:1,bc:green %%",
	"### Done",
	"- [x] Task 5",
	"%% col-end %%",
].join("\n");

export const INFO_CARD_TEMPLATE = [
	"%% col-start:sb:1,bc:muted %%",
	"%% col-break:35,b:accent-soft,sb:1,bc:accent,sep:1,sc:accent %%",
	"### Subject Name",
	"",
	"| | |",
	"| --- | --- |",
	"| **Field** | Value |",
	"| **Category** | Type |",
	"| **Date** | 2025-01 |",
	"%% col-break:65 %%",
	"### Details",
	"",
	"Main content and description.",
	"%% col-end %%",
].join("\n");

/** Build an N-column layout (equal width, secondary background). */
export function buildColumnsTemplate(count: number): string {
	const parts: string[] = ["%% col-start %%"];
	for (let i = 0; i < count; i++) {
		parts.push("%% col-break:b:secondary %%");
		parts.push(`Column ${i + 1}`);
	}
	parts.push("%% col-end %%");
	return parts.join("\n");
}

/** Insert a template at a position in a document, with standalone-block spacing. */
export function buildTemplateInsertion(doc: string, cursorPos: number, block: string): string {
	return buildStandaloneBlockInsertion(doc, cursorPos, block);
}
