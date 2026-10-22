/**
 * 工作区配色 / Workspace Colors — browser feature factory.
 *
 * Lifted verbatim from the standalone `dsh-plugin-workspace-colors` client bundle
 * by `scripts/extract-factory.mjs`; only the loader wrapper was removed. The
 * feature paints workspace rows, hangs their sessions off a coloured rail, and
 * owns the "更改颜色" / "更改图标" palette overlays.
 *
 * @param require - the module table this plugin's factory received.
 * @returns the feature module: `{ apply, inject, WorkspaceColorPalette }`.
 */
(require, options) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });


		const React = require("react");
		const h = React.createElement;

		/**
		 * This feature owns two independent marks: the colour of a workspace row and
		 * the icon that replaces its `#` glyph. The bundle wrapper passes its live
		 * switch controller, and `apply` reads the pair once — every later paint
		 * and click consults the flags below, so one half can never leak in while
		 * the other is off.
		 */
		const OPTIONS = options !== null && typeof options === "object" ? options : {};
		let COLORS_ON = OPTIONS.colors !== false;
		let ICONS_ON = OPTIONS.icons !== false;

		/** Re-read the pair from the wrapper's controller (called once, in apply). */
		function readSwitches() {
			if (typeof OPTIONS.effective !== "function") return;
			try {
				const flags = OPTIONS.effective();
				if (flags === null || typeof flags !== "object") return;
				COLORS_ON = flags.colors !== false;
				ICONS_ON = flags.icons !== false;
			} catch (error) {
				/* keep the construction-time defaults */
			}
		}

		const PLUGIN_ID = "dsh-plugin-workspace-colors";
		const STORAGE_KEY = "dsh.workspace-colors.v1";
		const ICON_STORAGE_KEY = "dsh.workspace-icons.v1";
		const ROW_SELECTOR = '[data-row-key^="workspace:"]';
		const ROW_ATTR = "data-dsh-wsc";
		const ICON_ATTR = "data-dsh-wsc-icon";
		const SESSION_SELECTOR = '[data-row-key^="session:"]';
		const RAIL_ATTR = "data-dsh-wsc-rail";
		const MENU_ITEM_ATTR = "data-dsh-wsc-menu-item";
		const MENU_ICON_ITEM_ATTR = "data-dsh-wsc-menu-icon";
		const PALETTE_WIDTH = 184;
		const VIEWPORT_MARGIN = 8;

		/** The ten workspace colours, in menu order: a hue wheel, then brown. */
		const PALETTE = [
			{ id: "grey", zh: "灰色", en: "Grey", color: "#9AA0A6" },
			{ id: "red", zh: "红色", en: "Red", color: "#F0595B" },
			{ id: "orange", zh: "橙色", en: "Orange", color: "#F29A3C" },
			{ id: "yellow", zh: "黄色", en: "Yellow", color: "#E2B32B" },
			{ id: "green", zh: "绿色", en: "Green", color: "#2FB57B" },
			{ id: "teal", zh: "青色", en: "Teal", color: "#2FB3B8" },
			{ id: "blue", zh: "蓝色", en: "Blue", color: "#4C9BFF" },
			{ id: "purple", zh: "紫色", en: "Purple", color: "#A98BEA" },
			{ id: "pink", zh: "粉色", en: "Pink", color: "#E8739F" },
			{ id: "brown", zh: "棕色", en: "Brown", color: "#A97C50" }
		];
		const PALETTE_BY_ID = new Map(PALETTE.map((entry) => [entry.id, entry]));

		/**
		 * The workspace icon catalogue, in picker order. Each `body` is the inner
		 * markup of a 24x24 stroke-only glyph: geometry plus the presentation
		 * attributes, with no stroke colour — the caller supplies that, because the
		 * row badge paints dark ink and the picker paints `currentColor`.
		 */
		const ICONS = [
			{
				id: "folder",
				zh: "文件夹",
				en: "Folder",
				body:
					'<path d="M3.5 7.5a2 2 0 0 1 2-2h3.2l2.1 2.4h7.1a2 2 0 0 1 2 2v7.1a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2Z" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
			},
			{
				id: "terminal",
				zh: "终端",
				en: "Terminal",
				body:
					'<rect x="3" y="4.5" width="18" height="15" rx="2.5" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
					'<path d="m7 9.5 3 2.5-3 2.5" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
					'<line x1="12.5" y1="14.5" x2="16.5" y2="14.5" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
			},
			{
				id: "code",
				zh: "代码",
				en: "Code",
				body:
					'<path d="m8.5 7.5-4.5 4.5 4.5 4.5" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
					'<path d="m15.5 7.5 4.5 4.5-4.5 4.5" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
					'<line x1="13.5" y1="4.5" x2="10.5" y2="19.5" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
			},
			{
				id: "search",
				zh: "搜索",
				en: "Search",
				body:
					'<circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
					'<line x1="15.4" y1="15.4" x2="20.5" y2="20.5" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
			},
			{
				id: "branch",
				zh: "分支",
				en: "Branch",
				body:
					'<circle cx="6.5" cy="5.5" r="2" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
					'<circle cx="6.5" cy="18.5" r="2" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
					'<circle cx="17.5" cy="8.5" r="2" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
					'<path d="M6.5 7.5v9" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
					'<path d="M17.5 10.5v1a4 4 0 0 1-4 4h-7" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
			},
			{
				id: "cloud",
				zh: "云",
				en: "Cloud",
				body:
					'<path d="M7 18.5h9.5a3.5 3.5 0 0 0 0-7 5.5 5.5 0 0 0-10.6-1.2A4.3 4.3 0 0 0 7 18.5Z" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
			},
			{
				id: "database",
				zh: "数据库",
				en: "Database",
				body:
					'<path d="M5 6c0-1.66 3.13-3 7-3s7 1.34 7 3-3.13 3-7 3-7-1.34-7-3Z" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
					'<path d="M5 6v12c0 1.66 3.13 3 7 3s7-1.34 7-3V6" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
					'<path d="M5 12c0 1.66 3.13 3 7 3s7-1.34 7-3" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
			},
			{
				id: "globe",
				zh: "地球",
				en: "Globe",
				body:
					'<circle cx="12" cy="12" r="8.5" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
					'<path d="M3.5 12h17" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
					'<path d="M12 3.5c2.4 2.5 3.6 5.4 3.6 8.5s-1.2 6-3.6 8.5c-2.4-2.5-3.6-5.4-3.6-8.5s1.2-6 3.6-8.5Z" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
			},
			{
				id: "heart",
				zh: "心形",
				en: "Heart",
				body:
					'<path d="M12 20.5C7.06 17.14 4 14.06 4 10.58a4.55 4.55 0 0 1 8-3.14 4.55 4.55 0 0 1 8 3.14c0 3.48-3.06 6.56-8 9.92Z" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
			},
			{
				id: "star",
				zh: "星形",
				en: "Star",
				body:
					'<path d="m12 3.2 2.72 5.7 6.08.86-4.44 4.33 1.08 6.13L12 17.32l-5.44 2.9 1.08-6.13L3.2 9.76l6.08-.86Z" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
			},
			{
				id: "book",
				zh: "书本",
				en: "Book",
				body:
					'<path d="M4.5 4.5h4.6A2.9 2.9 0 0 1 12 7.4v13a2.9 2.9 0 0 0-2.9-2.9H4.5Z" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
					'<path d="M19.5 4.5h-4.6A2.9 2.9 0 0 0 12 7.4v13a2.9 2.9 0 0 1 2.9-2.9h4.6Z" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
			},
			{
				id: "chart",
				zh: "图表",
				en: "Chart",
				body:
					'<path d="M3.5 20.5h17" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
					'<rect x="6" y="12" width="3.5" height="8.5" rx="1" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
					'<rect x="11.25" y="9" width="3.5" height="11.5" rx="1" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
					'<rect x="16.5" y="5.5" width="3.5" height="15" rx="1" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
			},
			{
				id: "chat",
				zh: "对话",
				en: "Chat",
				body:
					'<path d="M20 6.5A2.5 2.5 0 0 0 17.5 4h-11A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8v4l4.5-4h5a2.5 2.5 0 0 0 2.5-2.5Z" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
			},
			{
				id: "cpu",
				zh: "芯片",
				en: "Cpu",
				body:
					'<rect x="5.5" y="5.5" width="13" height="13" rx="2.5" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
					'<rect x="9.5" y="9.5" width="5" height="5" rx="1" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
					'<path d="M9 3v2.5M15 3v2.5M9 18.5V21M15 18.5V21M3 9h2.5M3 15h2.5M18.5 9H21M18.5 15H21" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
			},
			{
				id: "gear",
				zh: "齿轮",
				en: "Gear",
				body:
					'<circle cx="12" cy="12" r="6.4" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
					'<circle cx="12" cy="12" r="2.8" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
					'<path d="M12 2.4v3.2M12 18.4v3.2M2.4 12h3.2M18.4 12h3.2M5.2 5.2l2.3 2.3M16.5 16.5l2.3 2.3M18.8 5.2l-2.3 2.3M7.5 16.5l-2.3 2.3" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
			},
			{
				id: "home",
				zh: "首页",
				en: "Home",
				body:
					'<path d="M3.5 10.8 12 3.5l8.5 7.3" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
					'<path d="M6 9.2V19a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V9.2" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
					'<path d="M9.5 20.5v-6h5v6" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
			},
			{
				id: "image",
				zh: "图片",
				en: "Image",
				body:
					'<rect x="3.5" y="4.5" width="17" height="15" rx="2.5" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
					'<circle cx="8.6" cy="9.6" r="1.6" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
					'<path d="m4.5 17.5 4.7-4.7 3.1 3.1 2.9-2.9 4.3 4.3" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
			},
			{
				id: "key",
				zh: "钥匙",
				en: "Key",
				body:
					'<circle cx="7.5" cy="12" r="4" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
					'<path d="M11.5 12H21M17.5 12v3M21 12v2.5" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
			},
			{
				id: "link",
				zh: "链接",
				en: "Link",
				body:
					'<rect x="2.5" y="7.5" width="10" height="9" rx="4.5" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
					'<rect x="11.5" y="7.5" width="10" height="9" rx="4.5" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
			},
			{
				id: "mail",
				zh: "邮件",
				en: "Mail",
				body:
					'<rect x="3" y="5" width="18" height="14" rx="2.5" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
					'<path d="m4.2 7.2 7.8 5.9 7.8-5.9" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
			},
			{
				id: "map",
				zh: "地图",
				en: "Map",
				body:
					'<path d="m9 4.5 6 2.5 5.5-2v14l-5.5 2-6-2.5-5.5 2v-14Z" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
					'<path d="M9 4.5v14M15 7v14" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
			},
			{
				id: "music",
				zh: "音乐",
				en: "Music",
				body:
					'<path d="M9 5.5 19 4" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
					'<path d="M9 5.5v11.2M19 4v11.2" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
					'<circle cx="6.5" cy="17.5" r="2.5" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
					'<circle cx="16.5" cy="16" r="2.5" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
			},
			{
				id: "zap",
				zh: "闪电",
				en: "Zap",
				body:
					'<path d="M13.5 2.5 4.5 14H11l-.5 7.5L19.5 10H13Z" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
			},
			{
				id: "shield",
				zh: "盾牌",
				en: "Shield",
				body:
					'<path d="M12 3 4.5 5.8v5.7c0 4.3 3.1 7.6 7.5 9 4.4-1.4 7.5-4.7 7.5-9V5.8Z" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
			}
		];
		const ICON_BY_ID = new Map(ICONS.map((entry) => [entry.id, entry]));

		/* Icon picker geometry: six 36px cells per row (four rows for 24 icons). */
		const ICON_COLUMNS = 6;
		const ICON_CELL_SIZE = 36;
		const ICON_CELL_GAP = 6;
		const ICON_GRID_ROWS = Math.ceil(ICONS.length / ICON_COLUMNS);
		/* 6 cells + 5 gaps, plus the card's 4px padding each side and its 0.5px border. */
		const ICON_PALETTE_WIDTH = ICON_COLUMNS * ICON_CELL_SIZE + (ICON_COLUMNS - 1) * ICON_CELL_GAP + 8 + 1;
		const ICON_PALETTE_HEIGHT = ICON_GRID_ROWS * ICON_CELL_SIZE + (ICON_GRID_ROWS - 1) * ICON_CELL_GAP + 8 + 7 + 34;
		const COLOR_PALETTE_HEIGHT = (PALETTE.length + 2) * 32 + 16;

		/**
		 * The page's language. The document hint is only the starting guess: the
		 * desktop launch flag can disagree with the product UI, so `apply` asks the
		 * client locale service and this flag flips once, before anything renders.
		 */
		let zhActive = (() => {
			const lang = (document.documentElement.getAttribute("lang") || navigator.language || "zh").toLowerCase();
			return lang.startsWith("zh");
		})();

		const L_ZH = {
			changeColor: "更改颜色",
			changeIcon: "更改图标",
			clear: "默认颜色",
			iconClear: "默认图标（#）",
			paletteLabel: "工作区颜色",
			on: "当前颜色"
		};
		const L_EN = {
			changeColor: "Change colour",
			changeIcon: "Change icon",
			clear: "Default colour",
			iconClear: "Default icon (#)",
			paletteLabel: "Workspace colour",
			on: "Current colour"
		};
		/** Live dictionary: a re-render after activation reads the resolved language. */
		const L = new Proxy(
			{},
			{
				get(_target, key) {
					const table = zhActive ? L_ZH : L_EN;
					return table[key] === void 0 ? String(key) : table[key];
				}
			}
		);

		/** Localized name of a catalogue entry (colours and icons share the shape). */
		const colourLabel = (entry) => (zhActive ? entry.zh : entry.en);

		/** Resolve the UI language from the client locale, falling back to the page hint. */
		function detectZh(ctx) {
			try {
				const locale = typeof ctx.get === "function" ? ctx.get("locale") : void 0;
				if (locale !== void 0 && locale !== null) {
					const snapshot =
						typeof locale.getLocale === "function" ? locale.getLocale() : typeof locale.getSnapshot === "function" ? locale.getSnapshot() : null;
					const id = snapshot && (snapshot.id || snapshot.locale || snapshot.language);
					if (typeof id === "string" && id.length > 0) return id.toLowerCase().startsWith("zh");
				}
			} catch (error) {
				/* fall through to the document hint */
			}
			const lang = (document.documentElement.getAttribute("lang") || navigator.language || "zh").toLowerCase();
			return String(lang).startsWith("zh");
		}

		/* ────────────────────────────────────────────────────────────────────
		 * Preference store (page-local, observable)
		 * ──────────────────────────────────────────────────────────────────── */

		const store = {
			/** @type {Record<string, string>} row key → colour id */
			colors: loadColors(),
			/** @type {Record<string, string>} row key → icon id */
			icons: loadIcons(),
			/** @type {{rowKey: string, mode: "color" | "icon", token: number, rect: DOMRect} | null} */
			palette: null,
			listeners: new Set(),
			subscribe(listener) {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			},
			emit() {
				for (const listener of Array.from(this.listeners)) listener();
			}
		};

		function loadColors() {
			try {
				const raw = localStorage.getItem(STORAGE_KEY);
				if (raw === null) return {};
				const parsed = JSON.parse(raw);
				if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
				const clean = {};
				for (const [key, value] of Object.entries(parsed)) {
					if (typeof key === "string" && typeof value === "string" && PALETTE_BY_ID.has(value)) clean[key] = value;
				}
				return clean;
			} catch {
				return {};
			}
		}

		function saveColors() {
			try {
				localStorage.setItem(STORAGE_KEY, JSON.stringify(store.colors));
			} catch {
				/* A blocked storage only costs persistence, never the feature. */
			}
		}

		function loadIcons() {
			try {
				const raw = localStorage.getItem(ICON_STORAGE_KEY);
				if (raw === null) return {};
				const parsed = JSON.parse(raw);
				if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
				const clean = {};
				for (const [key, value] of Object.entries(parsed)) {
					if (typeof key === "string" && typeof value === "string" && ICON_BY_ID.has(value)) clean[key] = value;
				}
				return clean;
			} catch {
				return {};
			}
		}

		function saveIcons() {
			try {
				localStorage.setItem(ICON_STORAGE_KEY, JSON.stringify(store.icons));
			} catch {
				/* A blocked storage only costs persistence, never the feature. */
			}
		}

		function setColor(rowKey, colorId) {
			if (typeof rowKey !== "string" || rowKey === "") return;
			if (colorId === null || colorId === void 0) delete store.colors[rowKey];
			else if (PALETTE_BY_ID.has(colorId)) store.colors[rowKey] = colorId;
			else return;
			saveColors();
			applyRowMarks();
			store.emit();
		}

		function setIcon(rowKey, iconId) {
			if (typeof rowKey !== "string" || rowKey === "") return;
			if (iconId === null || iconId === void 0) delete store.icons[rowKey];
			else if (ICON_BY_ID.has(iconId)) store.icons[rowKey] = iconId;
			else return;
			saveIcons();
			applyRowMarks();
			store.emit();
		}

		/* ────────────────────────────────────────────────────────────────────
		 * Painting the sidebar rows
		 * ──────────────────────────────────────────────────────────────────── */

		function applyRowMarks() {
			const rows = document.querySelectorAll(ROW_SELECTOR);
			for (const row of rows) {
				const key = row.getAttribute("data-row-key");
				const colorId = COLORS_ON && key !== null ? store.colors[key] : void 0;
				if (colorId !== void 0 && PALETTE_BY_ID.has(colorId)) {
					if (row.getAttribute(ROW_ATTR) !== colorId) row.setAttribute(ROW_ATTR, colorId);
				} else if (row.hasAttribute(ROW_ATTR)) {
					row.removeAttribute(ROW_ATTR);
				}
				/* The icon rides the colour chip: its CSS rule only repaints the
				 * chip's glyph, so on a row without a colour it stays inert and the
				 * shipped folder/chevron slot is untouched. */
				const iconId = ICONS_ON && key !== null ? store.icons[key] : void 0;
				if (iconId !== void 0 && ICON_BY_ID.has(iconId)) {
					if (row.getAttribute(ICON_ATTR) !== iconId) row.setAttribute(ICON_ATTR, iconId);
				} else if (row.hasAttribute(ICON_ATTR)) {
					row.removeAttribute(ICON_ATTR);
				}
			}
			if (COLORS_ON) applyRowRails();
		}

		/**
		 * The workspace row a session row hangs from, or null.
		 *
		 * The tree renders a workspace's sessions as the siblings that follow its
		 * header inside the group element the header leads, so the owner is the
		 * nearest *preceding* `workspace:` row at the row's own level — scanning
		 * backwards, then outwards. A nested sub-workspace is rendered inside a
		 * `role="group"` branch of its parent's group element and owns its own
		 * rows, so whole branches are skipped rather than descended into. Walking
		 * siblings instead of taking one `parentElement` hop also survives the
		 * HoverCard wrapper span that sits between a row and its group element.
		 */
		function owningWorkspaceRow(sessionRow) {
			let branch = sessionRow;
			let node = sessionRow.parentElement;
			while (node !== null) {
				for (let sibling = branch.previousElementSibling; sibling !== null; sibling = sibling.previousElementSibling) {
					if (sibling.getAttribute("role") === "group") continue;
					const owner = sibling.matches(ROW_SELECTOR) ? sibling : sibling.querySelector(ROW_SELECTOR);
					if (owner !== null) return owner;
				}
				branch = node;
				node = node.parentElement;
			}
			return null;
		}

		/**
		 * The element the session rail draws on: the per-row wrapper span the
		 * HoverCard renders around every row (`position:relative; display:block`,
		 * and the box the tree actually margins between rows — so a `::before`
		 * there can bridge the 2px list gap into one continuous line). That
		 * wrapper carries no stylesheet pseudo-elements of its own, unlike the row
		 * itself, whose `::before`/`::after` are the drag drop markers. The bare
		 * row is the fallback for a tree that stops wrapping.
		 */
		function railHost(sessionRow) {
			const parent = sessionRow.parentElement;
			return parent !== null && parent.tagName === "SPAN" && parent.firstElementChild === sessionRow ? parent : sessionRow;
		}

		function applyRowRails() {
			const rows = document.querySelectorAll(SESSION_SELECTOR);
			for (const row of rows) {
				const owner = owningWorkspaceRow(row);
				const key = owner === null ? null : owner.getAttribute("data-row-key");
				const colorId = key === null ? void 0 : store.colors[key];
				const host = railHost(row);
				if (colorId !== void 0 && PALETTE_BY_ID.has(colorId)) {
					if (host.getAttribute(RAIL_ATTR) !== colorId) host.setAttribute(RAIL_ATTR, colorId);
				} else if (host.hasAttribute(RAIL_ATTR)) {
					host.removeAttribute(RAIL_ATTR);
				}
			}
		}

		/* ────────────────────────────────────────────────────────────────────
		 * The workspace “...” menu row
		 * ──────────────────────────────────────────────────────────────────── */

		const ITEM_ICON =
			'<svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">' +
			'<path d="M8 1.7a6.3 6.3 0 0 0 0 12.6c.87 0 1.5-.66 1.5-1.46 0-.4-.16-.75-.4-1.02-.24-.26-.4-.6-.4-.98 0-.83.67-1.5 1.5-1.5h1.15a2.75 2.75 0 0 0 2.72-3.2C13.6 3.9 11.15 1.7 8 1.7Z" stroke="currentColor" stroke-width="1.1"/>' +
			'<circle cx="5.3" cy="6.4" r=".85" fill="currentColor"/>' +
			'<circle cx="8" cy="5.1" r=".85" fill="currentColor"/>' +
			'<circle cx="10.7" cy="6.4" r=".85" fill="currentColor"/>' +
			"</svg>";

		/*
		 * The "更改图标" row's glyph: a little catalogue of shapes, so the two
		 * spliced rows read as two different pickers even before their labels.
		 */
		const ICON_ICON =
			'<svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">' +
			'<rect x="1.8" y="1.8" width="5.4" height="5.4" rx="1.3" stroke="currentColor" stroke-width="1.2"/>' +
			'<circle cx="12.2" cy="4.5" r="2.6" stroke="currentColor" stroke-width="1.2"/>' +
			'<path d="M4.5 9.6 7.4 14.5H1.6Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>' +
			'<path d="M12.2 9.6 15 12.3l-2.8 2.7-2.8-2.7Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>' +
			"</svg>";

		/** The last visible `role="menu"` portal — the one that just opened. */
		function findOpenMenu() {
			const menus = document.querySelectorAll('div[role="menu"]');
			for (let index = menus.length - 1; index >= 0; index -= 1) {
				const menu = menus[index];
				const rect = menu.getBoundingClientRect();
				if (rect.width > 0 && rect.height > 0) return menu;
			}
			return null;
		}

		/**
		 * Splice the two workspace marks rows into an open workspace menu: 更改颜色
		 * first, then 更改图标. The menu DOM is re-created on every open, so the
		 * presence check is per-attribute: a re-render can mount the same portal
		 * again without duplicating either row.
		 * @returns whether the menu now carries both rows (idempotent).
		 */
		function injectMenuRow(menu, rowKey, row) {
			const viewport = menu.querySelector(':scope > div[role="presentation"]');
			if (viewport === null) return false;

			const append = (attr, icon, label, mode) => {
				if (viewport.querySelector("[" + attr + "]") !== null) return;
				const wrap = document.createElement("div");
				wrap.setAttribute(attr, "");
				wrap.className = "dsh-wsc-mi-wrap";

				const button = document.createElement("button");
				button.type = "button";
				button.setAttribute("role", "menuitem");
				button.className = "dsh-wsc-mi";
				button.innerHTML =
					'<span class="dsh-wsc-mi-icon">' +
					icon +
					'</span><span class="dsh-wsc-mi-label"></span><span class="dsh-wsc-mi-arrow">›</span>';
				const labelNode = button.querySelector(".dsh-wsc-mi-label");
				if (labelNode !== null) labelNode.textContent = label;

				/* A native listener, so stopping propagation keeps React's menu
				 * bookkeeping (focus return, arrow walk) out of this row; the menu
				 * closes on its own pointer-leave grace once the palette is used. */
				button.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					openPalette(rowKey, row, mode);
				});

				wrap.appendChild(button);
				viewport.appendChild(wrap);
			};

			if (COLORS_ON) append(MENU_ITEM_ATTR, ITEM_ICON, L.changeColor, "color");
			if (ICONS_ON) append(MENU_ICON_ITEM_ATTR, ICON_ICON, L.changeIcon, "icon");
			return (
				(!COLORS_ON || viewport.querySelector("[" + MENU_ITEM_ATTR + "]") !== null) &&
				(!ICONS_ON || viewport.querySelector("[" + MENU_ICON_ITEM_ATTR + "]") !== null)
			);
		}

		/* ────────────────────────────────────────────────────────────────────
		 * Palette (a `shell.overlay` occupant — real React, real floating layer)
		 * ──────────────────────────────────────────────────────────────────── */

		function openPalette(rowKey, row, mode = "color") {
			const element = row instanceof Element ? row : document.querySelector('[data-row-key="' + rowKey + '"]');
			const rect = element === null ? null : element.getBoundingClientRect();
			store.palette = {
				rowKey,
				mode: mode === "icon" && ICONS_ON ? "icon" : COLORS_ON ? "color" : "icon",
				token: (store.palette === null ? 0 : store.palette.token) + 1,
				rect: rect === null ? { left: 16, top: 16, bottom: 32, right: 160 } : { left: rect.left, top: rect.top, bottom: rect.bottom, right: rect.right }
			};
			store.emit();
		}

		function closePalette() {
			if (store.palette === null) return;
			store.palette = null;
			store.emit();
		}

		function useStoreTick() {
			const [tick, setTick] = React.useState(0);
			React.useEffect(() => store.subscribe(() => setTick((value) => value + 1)), []);
			return tick;
		}

		/**
		 * Clamp the palette card into the window.
		 * @param rect - the annotated row's viewport rect.
		 * @param width - the card width for the mode being shown.
		 * @param estimate - its natural height, before the window cap.
		 */
		function palettePosition(rect, width, estimate) {
			const height = Math.min(estimate, Math.max(0, window.innerHeight - 2 * VIEWPORT_MARGIN));
			const vw = window.innerWidth;
			const vh = window.innerHeight;
			let left = rect.left;
			let top = rect.bottom + 4;
			left = Math.min(Math.max(left, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, vw - width - VIEWPORT_MARGIN));
			if (top + height > vh - VIEWPORT_MARGIN) top = Math.max(VIEWPORT_MARGIN, rect.top - height - 4);
			if (top < VIEWPORT_MARGIN) top = VIEWPORT_MARGIN;
			return { left, top };
		}

		function WorkspaceColorPalette() {
			useStoreTick();
			const rootRef = React.useRef(null);
			const open = store.palette;
			const token = open === null ? 0 : open.token;

			React.useEffect(() => {
				if (open === null) return;
				const onPointerDown = (event) => {
					const root = rootRef.current;
					if (root !== null && event.target instanceof Node && root.contains(event.target)) return;
					closePalette();
				};
				const onKeyDown = (event) => {
					if (event.key === "Escape") closePalette();
				};
				/* Registered one tick late so the click that opened the palette
				 * cannot immediately dismiss it. */
				const timer = setTimeout(() => {
					document.addEventListener("pointerdown", onPointerDown, true);
					document.addEventListener("keydown", onKeyDown, true);
				}, 0);
				return () => {
					clearTimeout(timer);
					document.removeEventListener("pointerdown", onPointerDown, true);
					document.removeEventListener("keydown", onKeyDown, true);
				};
			}, [token]);

			if (open === null) return null;
			const iconMode = open.mode === "icon";
			if ((iconMode && !ICONS_ON) || (!iconMode && !COLORS_ON)) return null;
			const width = iconMode ? ICON_PALETTE_WIDTH : PALETTE_WIDTH;
			const position = palettePosition(open.rect, width, iconMode ? ICON_PALETTE_HEIGHT : COLOR_PALETTE_HEIGHT);

			let content;
			if (iconMode) {
				const selectedIcon = store.icons[open.rowKey];
				content = [
					h(
						"div",
						{ key: "icon-grid", className: "dsh-wsc-icon-grid" },
						ICONS.map((entry) =>
							h(
								"button",
								{
									key: entry.id,
									type: "button",
									role: "menuitem",
									className: "dsh-wsc-icon-cell",
									title: colourLabel(entry),
									"aria-label": colourLabel(entry),
									"data-current": selectedIcon === entry.id ? "true" : void 0,
									onClick: () => {
										setIcon(open.rowKey, entry.id);
										closePalette();
									}
								},
								h("svg", {
									viewBox: "0 0 24 24",
									width: 18,
									height: 18,
									fill: "none",
									stroke: "currentColor",
									strokeWidth: 2,
									strokeLinecap: "round",
									strokeLinejoin: "round",
									"aria-hidden": "true",
									dangerouslySetInnerHTML: { __html: entry.body }
								})
							)
						)
					),
					h("div", { key: "icon-separator", className: "dsh-wsc-sep" }),
					h(
						"button",
						{
							key: "icon-clear",
							type: "button",
							role: "menuitem",
							className: "dsh-wsc-row dsh-wsc-row-clear",
							onClick: () => {
								setIcon(open.rowKey, null);
								closePalette();
							}
						},
						h("span", { className: "dsh-wsc-dot dsh-wsc-dot-empty" }),
						h("span", { className: "dsh-wsc-name" }, L.iconClear)
					)
				];
			} else {
				const selected = store.colors[open.rowKey];
				content = PALETTE.map((entry) =>
					h(
						"button",
						{
							key: entry.id,
							type: "button",
							role: "menuitem",
							className: "dsh-wsc-row" + (selected === entry.id ? " dsh-wsc-row-current" : ""),
							"aria-label": colourLabel(entry),
							onClick: () => {
								setColor(open.rowKey, entry.id);
								closePalette();
							}
						},
						h("span", { className: "dsh-wsc-dot", style: { background: entry.color } }),
						h("span", { className: "dsh-wsc-name" }, colourLabel(entry)),
						selected === entry.id ? h("span", { className: "dsh-wsc-check" }, "✓") : null
					)
				);

				if (selected !== void 0) {
					content.push(h("div", { key: "separator", className: "dsh-wsc-sep" }));
					content.push(
						h(
							"button",
							{
								key: "clear",
								type: "button",
								role: "menuitem",
								className: "dsh-wsc-row dsh-wsc-row-clear",
								onClick: () => {
									setColor(open.rowKey, null);
									closePalette();
								}
							},
							h("span", { className: "dsh-wsc-dot dsh-wsc-dot-empty" }),
							h("span", { className: "dsh-wsc-name" }, L.clear)
						)
					);
				}
			}

			return h(
				"div",
				{
					ref: rootRef,
					className: "dsh-wsc-palette",
					role: "menu",
					"aria-label": L.paletteLabel,
					style: { left: position.left + "px", top: position.top + "px", width: width + "px" }
				},
				content
			);
		}

		/* ────────────────────────────────────────────────────────────────────
		 * Styles
		 * ──────────────────────────────────────────────────────────────────── */

		const COLOR_RULES = PALETTE.map(
			(entry) => '[data-row-key^="workspace:"][' + ROW_ATTR + '="' + entry.id + '"]{--dsh-wsc-color:' + entry.color + "}"
		).join("");

		/** The root of the data-URI each icon paints into the chip. */
		const ICON_SVG_OPEN =
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="rgba(0,0,0,0.74)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';

		/**
		 * A row badge's icon as a CSS data URI. `encodeURIComponent` encodes the
		 * `#` as %23 and the double quotes as %22, so the result drops straight
		 * inside `url("…")` without closing the CSS string or a fragment colour.
		 */
		function iconDataUri(entry) {
			return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(ICON_SVG_OPEN + entry.body + "</svg>");
		}

		/*
		 * One override per icon, appended after COLOR_RULES so its longhands
		 * (background-image/size/position) beat the badge rule's `background`
		 * shorthand: the coloured circle survives and only the glyph changes.
		 * `content:''` drops the default `#`.
		 */
		const ICON_RULES = ICONS.map(
			(entry) =>
				ROW_SELECTOR +
				"[" +
				ICON_ATTR +
				'="' +
				entry.id +
				'"]>span:nth-child(1)::before{content:\'\';background-image:url("' +
				iconDataUri(entry) +
				'");background-size:10px 10px;background-position:center;background-repeat:no-repeat}'
		).join("");

		/*
		 * The row's leading cell is a 16x20 icon slot: at rest it holds the folder
		 * glyph, on hover the shipped CSS swaps in the expand chevron. A coloured row
		 * trades both for one always-visible `#` badge, so the colour reads as the
		 * row's own mark instead of tinting its name.
		 *
		 * Column order in the shipped markup: 1 = folder, 2 = chevron,
		 * 3 = title (projectText), 4 = row actions.
		 */
		/* A row shows a mark when it has a colour **or** an icon: the icon picker
		 * must work on uncoloured workspaces too, hence the `:is()` list. */
		const CHIP = '[data-row-key^="workspace:"]:is([' + ROW_ATTR + '],[' + ICON_ATTR + '])';

		/*
		 * The session rail. `--dsh-wsc-color` is re-declared per colour on the
		 * wrapper so the line always reads as the workspace's own mark, and the
		 * mix is the same 70% the badge uses — the two are literally the same
		 * colour, one as a chip, one as a hairline.
		 *
		 * Geometry: the tree indents rows with `--dsh-workspace-indent` and starts
		 * their content at `8px` + that indent, where the 16px leading slot sits;
		 * the badge is centred in that slot, so `16px + indent` from the row's edge
		 * is the badge's axis, and the rail hangs from it. The wrapper is the box
		 * the tree margins between rows (`margin-top:2px` on every row after the
		 * first), so a segment running 2px past its own box bridges the gap and
		 * neighbouring segments overlap into one unbroken line that starts at the
		 * header's lower edge and ends just after the last session.
		 *
		 * The leading slot is kept `position:relative` so a running session's
		 * status dot paints over the line instead of being crossed by it.
		 */
		const RAIL_HOST = "[" + RAIL_ATTR + "]";
		const RAIL_SLOT =
			RAIL_HOST + ">div" + SESSION_SELECTOR + ">span:first-child," + RAIL_HOST + SESSION_SELECTOR + ">span:first-child";

		const RAIL_CSS =
			RAIL_HOST + "{position:relative}" +
			RAIL_HOST + "::before{content:'';box-sizing:border-box;position:absolute;" +
			"inset-inline-start:calc(16px + var(--dsh-workspace-indent,0px) - .5px);top:-2px;bottom:-2px;" +
			"width:1px;border-radius:1px;pointer-events:none;" +
			"background:color-mix(in srgb,var(--dsh-wsc-color) 70%,transparent)}" +
			RAIL_SLOT + "{position:relative}" +
			PALETTE.map((entry) => "[" + RAIL_ATTR + '="' + entry.id + '"]{--dsh-wsc-color:' + entry.color + "}").join("");

		const CSS =
			CHIP + ">span:nth-child(1)>svg{display:none!important}" +
			CHIP + ">span:nth-child(1){display:inline-flex!important}" +
			CHIP + ">span:nth-child(2){display:none!important}" +
			CHIP +
			">span:nth-child(1)::before{content:'#';box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;" +
			"width:16px;height:16px;border-radius:50%;font-size:11px;font-weight:700;line-height:1;padding-bottom:1px;" +
			/* 70% of the palette colour: the badge still reads as the colour itself
			 * rather than a pale wash, without the full-saturation weight. A fixed
			 * dark ink keeps the glyph legible on every entry in both themes. */
			"background:color-mix(in srgb,var(--dsh-wsc-color,#9AA0A6) 70%,transparent);color:rgba(0,0,0,.74)}" +
			COLOR_RULES +
			ICON_RULES +
			RAIL_CSS +
			/* Palette card (ported from the menu surface's own tokens). */
			".dsh-wsc-palette{position:fixed;z-index:1300;box-sizing:border-box;padding:4px;display:flex;flex-direction:column;pointer-events:auto;" +
			"max-height:calc(100vh - " + VIEWPORT_MARGIN * 2 + "px);overflow-y:auto;overscroll-behavior:contain;" +
			"border-radius:var(--dsw-radius-md,8px);border:.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));" +
			"background:var(--dsw-menu-surface-fill,var(--dsw-alias-bg-base,#fff));backdrop-filter:var(--dsw-menu-backdrop-filter,none);" +
			"box-shadow:var(--dsw-elevation-prominent,0 8px 28px rgba(0,0,0,.18));color:var(--dsw-alias-label-primary,#1f1f1f)}" +
			".dsh-wsc-row{display:flex;align-items:center;gap:8px;width:100%;min-height:30px;padding:4px 8px;border:0;border-radius:var(--dsw-radius-md,8px);" +
			"background:transparent;cursor:pointer;font-family:inherit;font-size:13px;line-height:20px;color:inherit;text-align:left}" +
			".dsh-wsc-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}" +
			".dsh-wsc-row:focus-visible{outline:none;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}" +
			".dsh-wsc-dot{flex:none;width:12px;height:12px;border-radius:50%;box-shadow:inset 0 0 0 .5px rgba(0,0,0,.12)}" +
			".dsh-wsc-dot-empty{background:transparent;border:.5px dashed var(--dsw-alias-border-l4,rgba(0,0,0,.3))}" +
			".dsh-wsc-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
			".dsh-wsc-check{flex:none;font-size:12px;line-height:1;color:var(--dsw-alias-label-tertiary,#8a8a8a)}" +
			".dsh-wsc-sep{height:.5px;margin:3px 2px;background:var(--dsw-alias-border-l2,rgba(0,0,0,.08))}" +
			/* Icon picker: 6x4 cells, matching the card width computed above. */
			".dsh-wsc-icon-grid{display:grid;grid-template-columns:repeat(6,36px);gap:6px;justify-content:center;padding:4px 0}" +
			".dsh-wsc-icon-cell{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;padding:0;border:0;border-radius:var(--dsw-radius-md,8px);" +
			"background:transparent;color:var(--dsw-alias-label-primary,#1f1f1f);cursor:pointer;font-family:inherit}" +
			".dsh-wsc-icon-cell:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}" +
			".dsh-wsc-icon-cell:focus-visible{outline:none;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}" +
			'.dsh-wsc-icon-cell[data-current="true"]{box-shadow:inset 0 0 0 1.5px var(--dsw-alias-brand-primary,#4C9BFF)}' +
			/* The spliced menu row mirrors the shipped menu cell. */
			".dsh-wsc-mi-wrap{position:relative}" +
			".dsh-wsc-mi{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;border:0;border-radius:var(--dsw-radius-md,8px);" +
			"background:transparent;cursor:pointer;font-family:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#1f1f1f);text-align:left}" +
			".dsh-wsc-mi:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}" +
			".dsh-wsc-mi:focus-visible{outline:none;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}" +
			".dsh-wsc-mi-icon{flex:none;display:inline-flex;width:14px;height:14px;align-items:center;justify-content:center;color:var(--dsw-alias-menu-icon,currentColor)}" +
			".dsh-wsc-mi-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
			".dsh-wsc-mi-arrow{flex:none;font-size:14px;line-height:1;opacity:.55}";

		/** Insert this package's stylesheet; the returned disposer removes it. */
		function insertStyles() {
			const tag = document.createElement("style");
			tag.dataset.plugin = PLUGIN_ID;
			tag.dataset.pluginCss = PLUGIN_ID + "/workspace-colors.css";
			tag.textContent = CSS;
			document.head.appendChild(tag);
			return () => {
				tag.remove();
			};
		}

		/* ────────────────────────────────────────────────────────────────────
		 * DOM decorator: paint rows, follow menus, offer the right-click trigger
		 * ──────────────────────────────────────────────────────────────────── */

		function startDomDecoration() {
			/** Rows whose “...” trigger was pressed, awaiting their menu to mount. */
			const candidates = new Map();
			let scheduled = false;

			const schedule = () => {
				if (scheduled) return;
				scheduled = true;
				queueMicrotask(() => {
					scheduled = false;
					service();
				});
			};

			const service = () => {
				applyRowMarks();
				const now = Date.now();
				for (const [row, info] of Array.from(candidates)) {
					if (now - info.at > 4000 || !row.isConnected) {
						candidates.delete(row);
						continue;
					}
					/* React has committed the row's open-menu state when its class
					 * list changed; that is the signal the portaled menu exists. */
					if (row.className === info.className) continue;
					const menu = findOpenMenu();
					if (menu === null) continue;
					if (injectMenuRow(menu, info.key, row)) candidates.delete(row);
				}
			};

			const onPointerDown = (event) => {
				const target = event.target;
				if (!(target instanceof Element)) return;
				const row = target.closest(ROW_SELECTOR);
				if (row === null) return;
				if (target.closest("button") === null) return;
				const key = row.getAttribute("data-row-key");
				if (key === null) return;
				candidates.set(row, { key, className: row.className, at: Date.now() });
				schedule();
			};

			const onContextMenu = (event) => {
				const target = event.target;
				if (!(target instanceof Element)) return;
				const row = target.closest(ROW_SELECTOR);
				if (row === null) return;
				const key = row.getAttribute("data-row-key");
				if (key === null) return;
				event.preventDefault();
				openPalette(key, row);
			};

			const observer = new MutationObserver(schedule);
			/* `childList` catches the portaled menu mounting, `class` catches the
			 * row's own open-menu state — whichever React commits first. */
			observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
			document.addEventListener("pointerdown", onPointerDown, true);
			document.addEventListener("contextmenu", onContextMenu, true);
			applyRowMarks();

			return () => {
				observer.disconnect();
				document.removeEventListener("pointerdown", onPointerDown, true);
				document.removeEventListener("contextmenu", onContextMenu, true);
				candidates.clear();
				for (const row of document.querySelectorAll("[" + ROW_ATTR + "]")) row.removeAttribute(ROW_ATTR);
				for (const row of document.querySelectorAll("[" + ICON_ATTR + "]")) row.removeAttribute(ICON_ATTR);
				for (const host of document.querySelectorAll("[" + RAIL_ATTR + "]")) host.removeAttribute(RAIL_ATTR);
			};
		}

		/* ────────────────────────────────────────────────────────────────────
		 * Plugin body
		 * ──────────────────────────────────────────────────────────────────── */

		/** Cordis services this browser half needs. */
		const inject = ["slots"];

		/**
		 * Browser plugin body.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			try {
				readSwitches();
				zhActive = detectZh(ctx);
				ctx.effect(() => insertStyles(), "workspace-colors: stylesheet");
				ctx.effect(() => startDomDecoration(), "workspace-colors: workspace rows");
				ctx.effect(() => exposeDebugApi(), "workspace-colors: debug handle");
				ctx.slots.inject("shell.overlay", () =>
					ctx.slots.register(
						{
							name: "shell.overlay",
							id: "workspace-colors.palette",
							order: 900,
							label: () => L.paletteLabel
						},
						WorkspaceColorPalette
					)
				);
			} catch (error) {
				console.error("[workspace-colors] activation failed:", error);
				throw error;
			}
		}

		/**
		* Publish a small read/write handle on the page for troubleshooting and for
		* scripted setup; it is removed with the plugin.
		*/
		function exposeDebugApi() {
			const api = {
				id: PLUGIN_ID,
				features: { colors: COLORS_ON, icons: ICONS_ON },
				colors: COLORS_ON ? PALETTE.map((entry) => entry.id) : [],
				icons: ICONS_ON ? ICONS.map((entry) => entry.id) : [],
				get: (rowKey) => store.colors[rowKey] ?? null,
				set: (rowKey, colorId) => setColor(rowKey, colorId),
				clear: (rowKey) => setColor(rowKey, null),
				getIcon: (rowKey) => store.icons[rowKey] ?? null,
				setIcon: (rowKey, iconId) => setIcon(rowKey, iconId),
				/* Both preference maps; each keyed by workspace row key. */
				all: () => ({ colors: Object.assign({}, store.colors), icons: Object.assign({}, store.icons) })
			};
			window.__DSH_WORKSPACE_COLORS__ = api;
			return () => {
				if (window.__DSH_WORKSPACE_COLORS__ === api) delete window.__DSH_WORKSPACE_COLORS__;
			};
		}

		exports.WorkspaceColorPalette = WorkspaceColorPalette;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
}
