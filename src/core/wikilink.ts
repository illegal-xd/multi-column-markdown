export interface WikilinkTarget {
	target: string;
	alias?: string;
	fragment?: string;
}

/** Parse Obsidian-style target, alias, and heading/block fragment. */
export function parseWikilinkTarget(raw: string): WikilinkTarget {
	const [targetAndFragment, alias] = raw.split("|", 2);
	const fragmentIndex = targetAndFragment.search(/[#^]/);
	if (fragmentIndex < 0) return {target: targetAndFragment.trim(), alias: alias?.trim() || undefined};
	return {
		target: targetAndFragment.slice(0, fragmentIndex).trim(),
		fragment: targetAndFragment.slice(fragmentIndex).trim(),
		alias: alias?.trim() || undefined,
	};
}

/** Convert a heading/block fragment to a browser-safe anchor suffix. */
export function wikilinkFragment(fragment: string | undefined): string {
	if (!fragment) return "";
	if (fragment.startsWith("^") || fragment.startsWith("#")) {
		return `#${encodeURIComponent(fragment.slice(1).trim().toLowerCase().replace(/\s+/g, "-"))}`;
	}
	return `#${encodeURIComponent(fragment)}`;
}

export function isMarkdownTarget(target: string): boolean {
	return /(?:^|[\\/])[^\\/]+\.md$/i.test(target) || !/\.[a-z0-9]+$/i.test(target);
}
