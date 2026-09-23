/**
 * Dataview data index layer (Plan Step B1) — public barrel.
 *
 * - parsePageFile: pure single-file parser → PageMeta
 * - createIndexStore: incremental store with reverse indexes + snapshots
 * - parseYamlValue: frontmatter YAML subset parser (never throws)
 */
export {parsePageFile} from "./parse";
export {createIndexStore} from "./store";
export {parseYamlValue} from "./yaml";
export type {YamlParseResult} from "./yaml";
