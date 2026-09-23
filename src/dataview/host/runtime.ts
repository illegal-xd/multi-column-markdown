/**
 * Dataview runtime composition root (VSCode side).
 *
 * Owns the lifecycle of the three dataview subsystems and hands the preview a
 * single `BlockResultProvider`:
 *
 *   vscodeWorkspaceFs ─▶ indexer ─▶ IndexStore ─┐
 *                                               ├─▶ DataviewService ─▶ fencePlugin
 *   dist/dataviewWorker.js ─▶ ExecService ──────┘        │
 *                                                        └─▶ markdown.preview.refresh
 *
 * Lifecycle choices:
 *   - LAZY: nothing is indexed or spawned until the first dataview block is
 *     actually rendered. A user who never writes ```dataviewjs pays zero cost
 *     (no watcher, no worker, no boost).
 *   - Index readiness gates block execution (`isIndexReady`): blocks render a
 *     placeholder until bootstrap completes, then one refresh fills them in.
 *   - Worker path is resolved from the extension folder; if the bundle is
 *     missing (dev environment without a build) the failure is reported inside
 *     the document instead of breaking the preview.
 */
import * as vscode from "vscode";
import type MarkdownIt from "markdown-it";
import {createIndexStore} from "../index/store";
import {getMetrics} from "../perf/metrics";
import {renderErrorHtml} from "../render/html";
import type {BlockResultProvider, BlockState, DataviewRenderEnv} from "../types";
import {createWorkspaceIndexer} from "./indexer";
import {createDataviewService, type DataviewService, type DataviewServiceStats} from "./service";
import {createVscodeHostIo, createVscodeWorkspaceFs, resolveWorkerPath, toRelativeDocPath} from "./vscodeFs";

const CONFIG_SECTION = "multiColumnMarkdown";

export interface DataviewSettings {
	enabled: boolean;
	timeoutMs: number;
	maxRows: number;
	workerPoolSize: number;
	cacheSize: number;
	indexExclude: string;
	// Dataview-compatible render settings (upstream DEFAULT_SETTINGS names in parens).
	renderNullAs: string;
	dateFormat: string;
	maxRenderDepth: number;
	showResultCount: boolean;
	inlineQueries: boolean;
	inlinePrefix: string;
	jsInlinePrefix: string;
}

const DEFAULT_INDEX_EXCLUDE = "**/{node_modules,.git,dist,out,.obsidian,.trash}/**";

export function readDataviewSettings(): DataviewSettings {
	const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return {
		enabled: cfg.get<boolean>("dataview.enabled", true),
		timeoutMs: cfg.get<number>("dataview.timeoutMs", 5000),
		maxRows: cfg.get<number>("dataview.maxRows", 1000),
		workerPoolSize: cfg.get<number>("dataview.workerPoolSize", 2),
		cacheSize: cfg.get<number>("dataview.cacheSize", 500),
		indexExclude: cfg.get<string>("dataview.indexExclude", DEFAULT_INDEX_EXCLUDE),
		renderNullAs: cfg.get<string>("dataview.renderNullAs", "-"),
		dateFormat: cfg.get<string>("dataview.dateFormat", "yyyy-MM-dd"),
		maxRenderDepth: cfg.get<number>("dataview.maxRenderDepth", 3),
		showResultCount: cfg.get<boolean>("dataview.showResultCount", false),
		inlineQueries: cfg.get<boolean>("dataview.inlineQueries", true),
		inlinePrefix: cfg.get<string>("dataview.inlinePrefix", "="),
		jsInlinePrefix: cfg.get<string>("dataview.jsInlinePrefix", "$="),
	};
}

export interface DataviewRuntimeStats {
	service?: DataviewServiceStats;
	index: ReturnType<ReturnType<typeof createWorkspaceIndexer>["stats"]>;
	metrics: ReturnType<typeof getMetrics>;
}

export interface DataviewRuntime {
	readonly provider: BlockResultProvider;
	/** Gives the service a markdown renderer for inline cell text. */
	attachMarkdownIt(md: MarkdownIt): void;
	/** Prints index/cache/worker stats to the output channel. */
	showStats(): void;
	stats(): DataviewRuntimeStats;
	dispose(): Promise<void>;
}

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

export function createDataviewRuntime(context: vscode.ExtensionContext): DataviewRuntime {
	const channel = vscode.window.createOutputChannel("Multi Column: Dataview");
	context.subscriptions.push(channel);

	const store = createIndexStore();
	let indexReady = false;
	let indexStarted = false;
	let service: DataviewService | undefined;
	let serviceError: Error | undefined;
	let markdownIt: MarkdownIt | undefined;
	let disposed = false;

	const indexer = createWorkspaceIndexer(
		createVscodeWorkspaceFs({exclude: () => readDataviewSettings().indexExclude}),
		store,
		{
			onIndexChanged: ({version, paths}) => {
				service?.requestRefresh();
				channel.appendLine(`[index] v${version} · ${paths.length} path(s) touched`);
			},
			onError: (e) => channel.appendLine(`[index] error: ${errMsg(e)}`),
		},
	);

	function ensureIndexStarted(): void {
		if (indexStarted || disposed) return;
		indexStarted = true;
		const t0 = Date.now();
		void indexer
			.start()
			.then(() => {
				indexReady = true;
				const stats = indexer.stats();
				channel.appendLine(
					`[index] ready · ${stats.files} file(s) · bootstrap ${stats.bootstrapMs.toFixed(1)}ms · total ${Date.now() - t0}ms`,
				);
				service?.requestRefresh();
			})
			.catch((e: unknown) => {
				// Bootstrap failure must not hang the preview in "pending" forever:
				// unblock blocks (they will report "no results") and surface the cause.
				indexReady = true;
				channel.appendLine(`[index] bootstrap failed: ${errMsg(e)}`);
				service?.requestRefresh();
			});
	}

	function ensureService(): DataviewService | undefined {
		if (service || serviceError) return service;
		const settings = readDataviewSettings();
		try {
			service = createDataviewService({
				workerPath: resolveWorkerPath(context),
				store,
				toRelativePath: toRelativeDocPath,
				refresh: () => void vscode.commands.executeCommand("markdown.preview.refresh"),
				// Captured lazily: the markdown-it instance only exists once the
				// preview asks for it, which happens before any block renders.
				renderInline: markdownIt ? (text: string) => markdownIt!.renderInline(text) : undefined,
				// Block renderer for dv.markdown()/block dv.el(): the preview's own
				// markdown-it, so code fences/tables inside that text highlight exactly
				// like the document body.
				renderMarkdownBlock: markdownIt ? (text: string) => markdownIt!.render(text) : undefined,
				renderSettings: {
					renderNullAs: settings.renderNullAs,
					dateFormat: settings.dateFormat,
					maxRenderDepth: settings.maxRenderDepth,
					displayResultCount: settings.showResultCount,
				},
				hostIo: createVscodeHostIo(),
				isIndexReady: () => indexReady,
				timeoutMs: settings.timeoutMs,
				maxRows: settings.maxRows,
				poolSize: settings.workerPoolSize,
				cacheSize: settings.cacheSize,
				log: (level, message) => {
					channel.appendLine(`[${level}] ${message}`);
					if (level === "error") console.error("[dataview]", message);
				},
			});
		} catch (e) {
			serviceError = e instanceof Error ? e : new Error(String(e));
			channel.appendLine(`[service] unavailable: ${errMsg(e)}`);
		}
		return service;
	}

	const provider: BlockResultProvider = {
		getBlock(env: DataviewRenderEnv, kind: "dataview" | "dataviewjs", code: string): BlockState {
			if (disposed) {
				return {status: "error", html: renderErrorHtml("Dataview runtime is disposed")};
			}
			ensureIndexStarted();
			const svc = ensureService();
			if (!svc) {
				return {
					status: "error",
					html: renderErrorHtml(
						serviceError?.message ?? "Dataview service unavailable",
						"Build the extension (pnpm build) so dist/dataviewWorker.js exists.",
					),
				};
			}
			return svc.getBlock(env, kind, code);
		},
	};

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (!e.affectsConfiguration(`${CONFIG_SECTION}.dataview`)) return;
			// Settings feed into cache keys indirectly (maxRows/timeouts), so drop
			// the cache and re-render rather than trying to patch entries.
			service?.invalidateAll();
			service?.requestRefresh();
		}),
	);

	function showStats(): void {
		const stats = {service: service?.stats(), index: indexer.stats(), metrics: getMetrics()};
		channel.appendLine(JSON.stringify(stats, null, 2));
		channel.show(true);
		const svc = stats.service;
		void vscode.window.showInformationMessage(
			svc
				? `Dataview: ${stats.index.files} files · cache ${svc.cacheSize}/${svc.cacheCapacity} (hit ${(svc.cacheHitRate * 100).toFixed(0)}%) · ${svc.exec.completed} jobs · ${svc.refreshes} refreshes`
				: `Dataview: not started yet (${stats.index.files} files indexed)`,
		);
	}

	return {
		provider,
		attachMarkdownIt(md: MarkdownIt): void {
			markdownIt = md;
		},
		showStats,
		stats(): DataviewRuntimeStats {
			return {service: service?.stats(), index: indexer.stats(), metrics: getMetrics()};
		},
		async dispose(): Promise<void> {
			disposed = true;
			indexer.dispose();
			// Await the worker pool teardown: VSCode kills the extension host
			// shortly after deactivate(), and orphaned worker threads would keep
			// the process alive (or leak on reload).
			await service?.dispose();
			channel.dispose();
		},
	};
}
