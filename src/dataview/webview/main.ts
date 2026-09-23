/// <reference lib="dom" />
/**
 * Dataview webview-side progressive enhancement — browser only.
 *
 * 约束：纯浏览器代码（禁止 vscode / node:fs / node:vm import），只用无依赖 DOM API。
 * （tsconfig.json 的 lib 已包含 DOM；上面的 reference 只是让本文件独立编译时也成立。）
 * 输入是 host 侧 src/dataview/render/html.ts 产出的 v1 `data-dv-payload`（已 escapeHtml 的 JSON）。
 * 目的：1000+ 行表格 / 大量任务不进一次性 DOM —— 只挂载可视窗口/前若干块，避免长任务阻塞。
 * 另见 `./anchor.ts`：refresh 会按「进度比例」恢复滚动位置，而 dataview 块撑高/缩短文档后
 * 同一比例会落到别的源码行，预览→编辑器同步遂把编辑器滚走；该模块按源码行重新锚定。
 */
import {installAnchorPreserver} from "./anchor";

// ---------------------------------------------------------------------------
// 常量（性能契约）
// ---------------------------------------------------------------------------

/** 固定行高，单位 px —— 必须与 media/dataview.css 中 .dataview-scroll 的行高一致（互相引用）。 */
const ROW_HEIGHT = 23;
/** 视口窗口行数（overscan 之外）。 */
const WINDOW_ROWS = 60;
/** 上下缓冲行数，减少快速滚动时的空白/抖动。 */
const OVERSCAN = 20;
/** 行数超过该值才做窗口化（≤ 80 行整表渲染更快）。 */
const TABLE_WINDOW_MIN_ROWS = 80;
/** 任务列表每块挂载的顶层 <li> 数。 */
const CHUNK = 100;
/** 任务数超过该值才做分页。 */
const TASK_PAGER_MIN_TASKS = 120;

// ---------------------------------------------------------------------------
// payload 类型（v1；与 html.ts tablePayloadAttr / taskListPayloadAttr 对应）
// ---------------------------------------------------------------------------

interface TablePayloadRow {
	/** 完整 `<td>…</td>` 片段（已转义）。 */
	cells: string[];
	/** 完整 `<td colspan=N>…</td>` 片段，或 null（无分组）。 */
	group: string | null;
}

interface TablePayload {
	v: number;
	kind: "table";
	headers: string[];
	rows: TablePayloadRow[];
	total: number;
	truncated?: boolean;
}

interface TaskPayload {
	v: number;
	kind: "taskList";
	items: string[];
	total: number;
}

type Payload = TablePayload | TaskPayload;

// ---------------------------------------------------------------------------
// payload 解析 / 校验（形状不符一律不动 DOM）
// ---------------------------------------------------------------------------

function asStringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") return null;
		out.push(item);
	}
	return out;
}

function parsePayload(el: Element): Payload | null {
	const raw = el.getAttribute("data-dv-payload");
	if (raw === null || raw === "") return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		// 解析失败 → 静默保留服务端 HTML（不阻断其余区块增强），仅告警。
		console.warn("[dataview] invalid data-dv-payload; keeping server-rendered HTML", err);
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const p = parsed as Record<string, unknown>;
	if (p.v !== 1) return null; // 未知版本：不处理
	if (p.kind === "table") {
		const headers = asStringArray(p.headers);
		if (headers === null || !Array.isArray(p.rows)) return null;
		const rows: TablePayloadRow[] = [];
		for (const r of p.rows) {
			if (typeof r !== "object" || r === null) return null;
			const row = r as Record<string, unknown>;
			const cells = asStringArray(row.cells);
			if (cells === null) return null;
			const group = row.group;
			if (group !== null && group !== undefined && typeof group !== "string") return null;
			rows.push({cells, group: typeof group === "string" ? group : null});
		}
		const total = typeof p.total === "number" ? p.total : rows.length;
		return {v: 1, kind: "table", headers, rows, total, truncated: p.truncated === true};
	}
	if (p.kind === "taskList") {
		const items = asStringArray(p.items);
		if (items === null) return null;
		const total = typeof p.total === "number" ? p.total : items.length;
		return {v: 1, kind: "taskList", items, total};
	}
	return null;
}

// ---------------------------------------------------------------------------
// 片段构建（禁止 innerHTML 赋值）
// ---------------------------------------------------------------------------

/**
 * 用 Range.createContextualFragment 解析片段：不执行脚本、不触发 innerHTML 的整段解析，
 * 且保留上游 html.ts 的转义结果（我们不重新转义 payload 内容）。
 */
function fragmentOf(html: string): DocumentFragment {
	return document.createRange().createContextualFragment(html);
}

/**
 * 表格片段（`<td>`/`<th>`）必须在 **`<tr>` 上下文** 里解析。
 *
 * `createContextualFragment` 用 Range 的 startContainer 作为解析上下文；新建 Range 的容器
 * 是 document，即 "in body" 插入模式 —— 那里 `<td>`/`<th>`/`<tr>` 开始标签会被忽略，单元格
 * 内容退化为 `<tr>` 里的裸文本，浏览器再把它并进一个匿名单元格（宽表窗口化后「所有数据挤在
 * 第一列」）。把 Range 锚在分离的 `<tr>` 上等价于浏览器里的 `tr.innerHTML = "<td>…"`，
 * 表格结构得以保留。（`<li>` 这类 body 合法标签继续走 `fragmentOf`。）
 */
let tableContext: HTMLElement | null = null;

/** 导出仅供测试断言「解析上下文 = <tr>」这一契约（浏览器行为无法在 node 里跑）。 */
export function tableFragment(markup: string): DocumentFragment {
	tableContext ??= document.createElement("tr");
	const range = document.createRange();
	range.selectNodeContents(tableContext);
	return range.createContextualFragment(markup);
}

/** payload 里 cell/group 通常是完整 <td>；兼容裸内容形态以防契约漂移。 */
export function cellFragment(html: string): DocumentFragment {
	return tableFragment(/^\s*<td[\s>]/i.test(html) ? html : `<td>${html}</td>`);
}

// ---------------------------------------------------------------------------
// 待渲染态（.dataview-pending）
// ---------------------------------------------------------------------------

function enhancePending(el: Element): void {
	if (el.children.length > 0) return; // 已有子节点 → 不重复插入骨架
	const skeleton = document.createElement("div");
	skeleton.className = "dataview-skeleton";
	skeleton.setAttribute("aria-hidden", "true"); // 装饰性：状态由容器的 data-dv-status 提供
	for (let i = 0; i < 3; i++) {
		const bar = document.createElement("div");
		bar.className = "dataview-skeleton-bar";
		skeleton.appendChild(bar);
	}
	el.appendChild(skeleton);
	el.setAttribute("aria-busy", "true");
	el.setAttribute("data-dv-status", "Loading dataview results…");
}

// ---------------------------------------------------------------------------
// 表格窗口化
// ---------------------------------------------------------------------------

type TableEntry = {type: "group"; html: string} | {type: "row"; cells: string[]};

/** 分组行同样占 1 行高，因此 flatten 后按 entry 索引窗口化。 */
function flattenEntries(payload: TablePayload): TableEntry[] {
	const out: TableEntry[] = [];
	for (const row of payload.rows) {
		if (row.group !== null) out.push({type: "group", html: row.group});
		out.push({type: "row", cells: row.cells});
	}
	return out;
}

function columnCount(payload: TablePayload): number {
	if (payload.headers.length > 0) return payload.headers.length;
	for (const row of payload.rows) {
		if (row.cells.length > 0) return row.cells.length;
	}
	return 1;
}

function spacerRow(cols: number, heightPx: number): HTMLTableRowElement {
	const tr = document.createElement("tr");
	tr.className = "dataview-window-spacer";
	const td = document.createElement("td");
	td.colSpan = cols;
	// 高度必须精确等于 ROW_HEIGHT 的倍数（与 media/dataview.css 的行高常量一致），
	// 否则窗口偏移会累积误差 → 顶部/底部出现空洞或重叠。
	td.style.height = `${heightPx}px`;
	td.style.padding = "0";
	td.style.border = "0";
	tr.appendChild(td);
	return tr;
}

function enhanceTable(el: Element, payload: TablePayload): void {
	const entries = flattenEntries(payload);
	const cols = columnCount(payload);
	// 复用服务端 thead（sticky 由 CSS 负责）；缺失时用 payload.headers 重建。
	let table = el.querySelector<HTMLTableElement>("table.dataview-table");
	let notices: Element[] = [];
	if (table === null) {
		table = document.createElement("table");
		table.className = "dataview-table";
		const thead = document.createElement("thead");
		const headRow = document.createElement("tr");
		// 表头格同样是表片段：必须用 `<tr>` 上下文，否则 `<th>` 会被丢弃。
		for (const h of payload.headers) headRow.appendChild(tableFragment(h));
		thead.appendChild(headRow);
		table.appendChild(thead);
	} else {
		const oldBody = table.querySelector("tbody");
		if (oldBody !== null) {
			// 保留服务端截断提示行（cell/rows 上限）——窗口化会替换 tbody，提示不应丢失。
			notices = Array.from(oldBody.querySelectorAll("tr.dataview-notice-row"));
			oldBody.remove();
		}
	}
	const tbody = document.createElement("tbody");
	table.appendChild(tbody);

	const scroll = document.createElement("div");
	scroll.className = "dataview-scroll";
	const parent = table.parentNode;
	if (parent !== null) {
		parent.replaceChild(scroll, table);
		scroll.appendChild(table);
	} else {
		el.appendChild(scroll);
		scroll.appendChild(table);
	}

	let start = -1; // 初始 -1 保证首次 paint 一定重建
	let end = -1;

	/** 仅在窗口范围变化时重建行 DOM（避免每帧重建）。 */
	const paint = (nextStart: number, nextEnd: number): void => {
		if (nextStart === start && nextEnd === end) return;
		start = nextStart;
		end = nextEnd;
		const frag = document.createDocumentFragment();
		frag.appendChild(spacerRow(cols, start * ROW_HEIGHT));
		for (let i = start; i < end; i++) {
			const entry = entries[i];
			const tr = document.createElement("tr");
			if (entry.type === "group") {
				tr.className = "dataview-group-row";
				tr.appendChild(cellFragment(entry.html));
			} else {
				tr.className = "dataview-row";
				for (const cell of entry.cells) tr.appendChild(cellFragment(cell));
			}
			frag.appendChild(tr);
		}
		frag.appendChild(spacerRow(cols, (entries.length - end) * ROW_HEIGHT));
		for (const notice of notices) frag.appendChild(notice);
		// 单次批量替换（DocumentFragment）→ 一次 reflow。
		tbody.replaceChildren(frag);
	};

	const updateFromScroll = (): void => {
		const first = Math.max(0, Math.floor(scroll.scrollTop / ROW_HEIGHT) - OVERSCAN);
		const last = Math.min(entries.length, first + WINDOW_ROWS + OVERSCAN * 2);
		paint(first, last);
	};

	/** 预览 refresh 后容器被替换 → 监听器自我停止（同时释放闭包引用）。 */
	const detach = (): void => scroll.removeEventListener("scroll", onScroll);

	let rafId = 0;
	const onScroll = (): void => {
		if (!scroll.isConnected) {
			detach();
			return;
		}
		if (rafId !== 0) return; // 同一帧内多次 scroll 只重算一次（rAF 合并）
		rafId = requestAnimationFrame(() => {
			rafId = 0;
			if (!scroll.isConnected) {
				detach();
				return;
			}
			updateFromScroll();
		});
	};
	// passive: 声明不调用 preventDefault，滚动不被主线程 JS 阻塞。
	scroll.addEventListener("scroll", onScroll, {passive: true});

	updateFromScroll();
}

// ---------------------------------------------------------------------------
// 任务列表分页
// ---------------------------------------------------------------------------

function enhanceTaskList(el: Element, payload: TaskPayload): void {
	const items = payload.items;
	if (items.length <= TASK_PAGER_MIN_TASKS) return;
	// html.ts: wrap("taskList", …, `<ul class="dataview-task-list">…`）→ 取容器的直接子 ul。
	let ul: HTMLUListElement | null = null;
	for (const child of Array.from(el.children)) {
		if (child instanceof HTMLUListElement && child.classList.contains("dataview-task-list")) {
			ul = child;
			break;
		}
	}
	if (ul === null) return;

	/** 批量挂载 [from, from+count) 的顶层 <li>；返回实际挂载数。 */
	const mount = (from: number, count: number): number => {
		const stop = Math.min(items.length, from + count);
		const frag = document.createDocumentFragment();
		for (let i = from; i < stop; i++) frag.appendChild(fragmentOf(items[i]));
		ul!.appendChild(frag);
		return stop - from;
	};

	// 服务端首次可能已渲染全部 li → 清空后按块重挂（否则 DOM 不会变小）。
	ul.replaceChildren();
	let mounted = mount(0, CHUNK);

	const more = document.createElement("button");
	more.type = "button";
	more.className = "dataview-more";
	const remaining = (): number => items.length - mounted;
	const syncLabel = (): void => {
		more.textContent = `Show ${CHUNK} more (${remaining()} remaining)`;
	};
	syncLabel();
	more.addEventListener("click", () => {
		if (!more.isConnected) return;
		mounted += mount(mounted, CHUNK);
		if (remaining() <= 0) more.remove();
		else syncLabel();
	});
	el.insertBefore(more, ul.nextSibling);
}

// ---------------------------------------------------------------------------
// 扫描 / 观察
// ---------------------------------------------------------------------------

/** WeakSet：已处理节点标记 —— 幂等（预览 refresh 会重复扫描），且不阻止节点被 GC。 */
const processed = new WeakSet<Element>();

function enhanceElement(el: Element): void {
	if (processed.has(el)) return;
	if (el.classList.contains("dataview-pending")) {
		processed.add(el);
		enhancePending(el);
	}
	if (!el.hasAttribute("data-dv-payload")) return;
	processed.add(el);
	const payload = parsePayload(el);
	if (payload === null) return; // 字段缺失/类型不符 → 不改动 DOM
	if (payload.kind === "table") {
		if (payload.rows.length > TABLE_WINDOW_MIN_ROWS) enhanceTable(el, payload);
	} else if (payload.items.length > TASK_PAGER_MIN_TASKS) {
		enhanceTaskList(el, payload);
	}
}

function processSubtree(root: Element): void {
	enhanceElement(root);
	for (const el of Array.from(root.querySelectorAll("[data-dv-payload], .dataview-pending"))) {
		enhanceElement(el);
	}
}

function scanAll(): void {
	if (typeof document === "undefined" || document.body === null) return;
	for (const el of Array.from(document.body.querySelectorAll("[data-dv-payload], .dataview-pending"))) {
		enhanceElement(el);
	}
}

let observer: MutationObserver | null = null;

/**
 * 立即扫描 + 持续观察。VSCode 预览刷新（markdown.preview.refresh）会整体替换 DOM，
 * 一次性扫描无法覆盖后插入的节点，故用 MutationObserver 增量处理。
 */
export function activateDataviewView(): void {
	if (typeof document === "undefined") return;
	if (document.body === null) {
		document.addEventListener("DOMContentLoaded", () => activateDataviewView(), {once: true});
		return;
	}
	scanAll();
	installAnchorPreserver(window, document);
	if (observer !== null) return; // 幂等：重复激活不重复 observe
	// 老环境降级：无 MutationObserver 时仅保留一次性扫描。
	if (typeof MutationObserver === "undefined") return;
	observer = new MutationObserver((records) => {
		for (const record of records) {
			for (const node of Array.from(record.addedNodes)) {
				if (node.nodeType === 1) processSubtree(node as Element);
			}
		}
	});
	observer.observe(document.body, {childList: true, subtree: true});
}

// 作为 IIFE 注入预览时自执行；测试可显式调用 activateDataviewView()（重复调用幂等）。
if (typeof document !== "undefined") activateDataviewView();
