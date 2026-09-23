/**
 * Link factory with the Dataview `Link` method surface.
 *
 * The stored shape stays duck-type compatible with the plain index links
 * (`values.ts` `isLink` = `path: string` + `embed` present): the data fields are
 * own enumerable properties in the historical order (path, display, subpath,
 * embed) while every method / derived field is non-enumerable. Consequences:
 *   - `JSON.stringify(link)` and `Object.keys(link)` are byte-identical to the
 *     legacy plain object (methods + type/external stay invisible),
 *   - `assert.deepStrictEqual(link, {path, embed:false})` still passes,
 *   - structured clone drops methods, so clones are rebuilt with `createLink`
 *     (integrator wiring in values.ts / page.ts / createDvApi.ts / functions.ts).
 *
 * Upstream parity notes (dataview `src/data-model/value.ts`):
 *   - `toString()` === `markdown()` (upstream `Link.toString`), and `equals`
 *     compares path + type + subpath only (display/embed are ignored).
 *   - upstream master exposes `toFile`/`toEmbed`/`fromEmbed`/`withPath`/`fileName`;
 *     this port only ships the requested surface (`asFile`/`asEmbed`).
 *   - `markdown()` here always emits `[[path#sub|display]]`; upstream appends a
 *     file-title alias and `> subpath` when no display is set.
 */
import type {Link, LinkMeta} from "./types";

export interface LinkInit {
	path: string;
	display?: string;
	subpath?: string;
	embed?: boolean;
	/** Explicit external flag; when omitted it is inferred from the path scheme. */
	external?: boolean;
}

export type LinkType = "file" | "header" | "block";


type LinkSelf = Link & {external?: boolean};

/** `http://`, `https://`, any `scheme://`, or `mailto:` (index links are workspace-relative). */
const EXTERNAL_PATH_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/|mailto:)/i;

function isExternalPath(path: string): boolean {
	return EXTERNAL_PATH_RE.test(path);
}

/** Subpath convention of this port: "#Heading" / "#^block-id" (leading # kept). */
function linkType(subpath: string | undefined): LinkType {
	if (subpath === undefined) return "file";
	if (subpath.startsWith("#^")) return "block";
	if (subpath.startsWith("#")) return "header";
	return "file";
}

function linkMarkdown(l: Link): string {
	return (l.embed ? "!" : "") + "[[" + l.path + (l.subpath ?? "") + (l.display ? "|" + l.display : "") + "]]";
}

function cloneLink(l: Link, patch: Partial<LinkInit>): Link {
	return createLink({
		path: l.path,
		display: l.display,
		subpath: l.subpath,
		embed: l.embed,
		external: (l as LinkSelf).external ?? isExternalPath(l.path),
		...patch,
	});
}

/**
 * One non-enumerable accessor per method, returning the method bound to this
 * link: own properties keep `JSON.stringify`/`Object.keys`/clone behaviour
 * unchanged, and the DQL expression engine (own props only, detached call)
 * can still invoke them.
 */
function methodDescriptors(methods: Record<string, unknown>): PropertyDescriptorMap {
	const out: PropertyDescriptorMap = {};
	for (const name of Object.keys(methods)) {
		const fn = methods[name] as (this: unknown, ...args: never[]) => unknown;
		out[name] = {
			get(this: unknown) {
				return fn.bind(this);
			},
			enumerable: false,
			configurable: true,
		};
	}
	return out;
}

const LINK_METHODS = {
	withDisplay(this: Link, display: string | undefined): Link {
		return cloneLink(this, {display});
	},
	/** `withHeader("H")` → subpath "#H" (a leading "#" is not doubled). */
	withHeader(this: Link, header: string): Link {
		return cloneLink(this, {subpath: header.startsWith("#") ? header : "#" + header});
	},
	/** `withBlock("id")` → subpath "#^id" (a leading "#^" is not doubled). */
	withBlock(this: Link, block: string): Link {
		return cloneLink(this, {subpath: block.startsWith("#^") ? block : "#^" + block});
	},
	withSubpath(this: Link, subpath: string | undefined): Link {
		return cloneLink(this, {subpath});
	},
	asFile(this: Link): Link {
		return cloneLink(this, {subpath: undefined});
	},
	asEmbed(this: Link, embed: boolean): Link {
		return cloneLink(this, {embed});
	},
	/** Upstream: `toString()` is the markdown form. */
	toString(this: Link): string {
		return linkMarkdown(this);
	},
	/** Serialization shape of the legacy plain link (keeps `toJsonValue` output stable). */
	toJSON(this: Link): Record<string, unknown> {
		const out: Record<string, unknown> = {path: this.path};
		if (this.display !== undefined) out["display"] = this.display;
		if (this.subpath !== undefined) out["subpath"] = this.subpath;
		out["embed"] = this.embed;
		return out;
	},
	toObject(this: Link): Record<string, unknown> {
		return {
			path: this.path,
			type: linkType(this.subpath),
			subpath: this.subpath,
			display: this.display,
			embed: this.embed,
			external: (this as LinkSelf).external ?? isExternalPath(this.path),
		};
	},
	/** Upstream semantics: same target (path + type + subpath), display/embed ignored. */
	equals(this: Link, other: unknown): boolean {
		if (other === null || other === undefined) return false;
		if (typeof other !== "object") return false;
		const o = other as Partial<Link>;
		if (typeof o.path !== "string") return false;
		return this.path === o.path && linkType(this.subpath) === linkType(o.subpath) && (this.subpath ?? "") === (o.subpath ?? "");
	},
	markdown(this: Link): string {
		return linkMarkdown(this);
	},
	obsidianLink(this: Link): string {
		return `[${this.display ?? this.path}](${this.path})`;
	},
};

const LINK_DESCRIPTORS: PropertyDescriptorMap = (() => {
	const out = methodDescriptors(LINK_METHODS as unknown as Record<string, unknown>);
	out["type"] = {get(this: Link) { return linkType(this.subpath); }, enumerable: false, configurable: true};
	// NOTE: `external` is deliberately NOT a descriptor here. It is written as an
	// own ENUMERABLE data property by createLink (only when true) because external
	// links must survive `structuredClone` across the worker→host boundary — the
	// renderer on the host decides between an internal file link and a plain
	// anchor from that flag, and non-enumerable properties are dropped by clone.
	return out;
})();

/** Build a Link value (own data fields + non-enumerable Dataview method surface). */
export function createLink(init: LinkInit): Link {
	const l = {path: init.path} as LinkSelf;
	if (init.display !== undefined) l.display = init.display;
	if (init.subpath !== undefined) l.subpath = init.subpath;
	l.embed = init.embed ?? false;
	// Enumerable ONLY when true: keeps `{path, embed}` deep-equality and JSON
	// shape of ordinary (internal) links byte-identical to pre-change behavior,
	// while external links stay recognisable after a structured clone.
	if (init.external === true || (init.external === undefined && isExternalPath(l.path))) {
		l.external = true;
	}
	Object.defineProperties(l, LINK_DESCRIPTORS);
	return l;
}

/**
 * Index `LinkMeta` (or any `{path, display?, subpath?, embed?}`) → runtime Link.
 * Mirror of `page.ts`'s local helper, kept here so the link surface lives in one module.
 */
export function linkFromMeta(m: LinkMeta | LinkInit): Link {
	return createLink({path: m.path, display: m.display, subpath: m.subpath, embed: m.embed ?? false});
}
