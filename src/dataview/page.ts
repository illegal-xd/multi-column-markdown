/**
 * Golden page-object builder — PageMeta (index) → page object exposed by
 * dv.page()/dv.pages() and used as the expression scope root.
 *
 * Semantics (Dataview parity):
 *   page = { ...fields, file: { path, name, folder, ext, link, tags, etags,
 *           aliases, lists, tasks, inlinks, outlinks, frontmatter,
 *           ctime, mtime, cday, mday, size, starred } }
 *   fields = frontmatter ∪ inline fields (inline wins on conflict).
 *
 * `file.size` is a plain NUMBER and ctime/mtime/cday/mday are DateTime values —
 * both match upstream SMarkdownPage. (`size` used to be `{bytes}` here; the
 * difference docs list that as a breaking change of this release.)
 */
import type {Link, LinkMeta, PageFile, PageMeta, PageObject} from "./types";
import {createLink, linkFromMeta as linkFromMetaImpl} from "./link";
import {parseDate} from "./query/datetime";
import {buildListItem, fromJsonValue} from "./values";

export function linkFromMeta(m: LinkMeta | {path: string; display?: string; subpath?: string; embed?: boolean}): Link {
	return linkFromMetaImpl(m);
}

/**
 * Page-object memo (perf, measured).
 *
 * `dv.pages()` / an DQL scan build one page object per page: on a 1000-page
 * workspace that cost ~2.4ms per job *for the objects alone* — and the objects
 * are rebuilt from scratch on every block, every refresh, every query.
 *
 * Keyed by `PageMeta`, which IS the correctness argument: `IndexStore` replaces
 * published PageMeta objects instead of mutating them (`{...page, inlinks}`),
 * so a WeakMap entry can never go stale — it is collected together with the
 * page's last revision. No version tracking, no invalidation protocol.
 *
 * Trade-off (documented, accepted): the same page object instance is now shared
 * by every block in a worker thread, so a dataviewjs block that MUTATES a page
 * object can affect a later block in the same worker. Obsidian's Dataview has
 * the same shared-index behavior; writing dataviewjs that mutates index objects
 * is already unsupported.
 */
const pageObjectCache = new WeakMap<PageMeta, PageObject>();
const pageFileCache = new WeakMap<PageMeta, PageFile>();

export function buildPageFile(page: PageMeta): PageFile {
	const cached = pageFileCache.get(page);
	if (cached) return cached;
	const ctime = parseDate(page.ctime) ?? parseDate(page.mtime)!;
	const mtime = parseDate(page.mtime) ?? ctime;
	const file: PageFile = {
		path: page.path,
		name: page.name,
		folder: page.folder,
		ext: page.ext,
		link: createLink({path: page.path, embed: false}),
		tags: page.tags.slice(),
		etags: page.etags.slice(),
		aliases: page.aliases.slice(),
		// Upstream `file.lists` = every list item (tasks AND plain), nested.
		// Defensive `?? []`: PageMeta values also arrive from callers that build
		// them directly (tests, DQL fixtures) and pre-date the listItems field.
		lists: (page.listItems ?? []).map((item) => buildListItem(item, page.path)),
		tasks: (page.tasks ?? []).map((item) => buildListItem(item, page.path)),
		inlinks: page.inlinks.map(linkFromMeta),
		outlinks: page.outlinks.map(linkFromMeta),
		frontmatter: page.frontmatter,
		ctime,
		mtime,
		cday: ctime.startOf("day"),
		mday: mtime.startOf("day"),
		size: page.size,
		// No bookmark concept in VSCode — upstream exposes `file.starred`; we keep
		// the field so `contains(file, "starred")` and `file.starred` do not break.
		starred: false,
	};
	pageFileCache.set(page, file);
	return file;
}

export function buildPageObject(page: PageMeta): PageObject {
	const cached = pageObjectCache.get(page);
	if (cached) return cached;
	const obj: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(page.fields)) {
		if (k === "file") continue; // `file` is reserved — Dataview behavior
		obj[k] = fromJsonValue(v);
	}
	obj.file = buildPageFile(page);
	pageObjectCache.set(page, obj as PageObject);
	return obj as PageObject;
}

/** Build expression scope: page fields as top-level variables + `this`. */
export function buildPageScope(page: PageMeta): Record<string, unknown> {
	const obj = buildPageObject(page);
	const scope: Record<string, unknown> = {...obj};
	scope["this"] = obj;
	scope["self"] = obj;
	return scope;
}
