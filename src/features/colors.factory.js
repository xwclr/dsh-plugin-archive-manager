/**
 * 工作区配色 / Workspace Colors — browser feature factory.
 *
 * Lifted verbatim from the standalone `dsh-plugin-workspace-colors` client bundle
 * by `scripts/extract-factory.mjs`; only the loader wrapper was removed. The
 * feature paints workspace rows, hangs their sessions off a coloured rail, and
 * owns the "更改颜色" palette overlay.
 *
 * @param require - the module table this plugin's factory received.
 * @returns the feature module: `{ apply, inject, WorkspaceColorPalette }`.
 */
(require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });


		const React = require("react");
		const h = React.createElement;

		const PLUGIN_ID = "dsh-plugin-workspace-colors";
		const STORAGE_KEY = "dsh.workspace-colors.v1";
		const ROW_SELECTOR = '[data-row-key^="workspace:"]';
		const ROW_ATTR = "data-dsh-wsc";
		const SESSION_SELECTOR = '[data-row-key^="session:"]';
		const RAIL_ATTR = "data-dsh-wsc-rail";
		const MENU_ITEM_ATTR = "data-dsh-wsc-menu-item";
		const PALETTE_WIDTH = 184;
		const VIEWPORT_MARGIN = 8;

		/** The seven workspace colours, in menu order. */
		const PALETTE = [
			{ id: "grey", zh: "灰色", en: "Grey", color: "#9AA0A6" },
			{ id: "red", zh: "红色", en: "Red", color: "#F0595B" },
			{ id: "orange", zh: "橙色", en: "Orange", color: "#F29A3C" },
			{ id: "yellow", zh: "黄色", en: "Yellow", color: "#E2B32B" },
			{ id: "green", zh: "绿色", en: "Green", color: "#2FB57B" },
			{ id: "blue", zh: "蓝色", en: "Blue", color: "#4C9BFF" },
			{ id: "purple", zh: "紫色", en: "Purple", color: "#A98BEA" }
		];
		const PALETTE_BY_ID = new Map(PALETTE.map((entry) => [entry.id, entry]));

		/** The page's language, read once: this package owns no locale namespace. */
		const ZH = (() => {
			const lang = (document.documentElement.getAttribute("lang") || navigator.language || "zh").toLowerCase();
			return lang.startsWith("zh");
		})();
		const L = ZH
			? {
					changeColor: "更改颜色",
					clear: "默认颜色",
					paletteLabel: "工作区颜色",
					on: "当前颜色"
			  }
			: {
					changeColor: "Change colour",
					clear: "Default colour",
					paletteLabel: "Workspace colour",
					on: "Current colour"
			  };

		const colourLabel = (entry) => (ZH ? entry.zh : entry.en);

		/* ────────────────────────────────────────────────────────────────────
		 * Preference store (page-local, observable)
		 * ──────────────────────────────────────────────────────────────────── */

		const store = {
			/** @type {Record<string, string>} row key → colour id */
			colors: loadColors(),
			/** @type {{rowKey: string, token: number, rect: DOMRect} | null} */
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

		function setColor(rowKey, colorId) {
			if (typeof rowKey !== "string" || rowKey === "") return;
			if (colorId === null || colorId === void 0) delete store.colors[rowKey];
			else if (PALETTE_BY_ID.has(colorId)) store.colors[rowKey] = colorId;
			else return;
			saveColors();
			applyRowColors();
			store.emit();
		}

		/* ────────────────────────────────────────────────────────────────────
		 * Painting the sidebar rows
		 * ──────────────────────────────────────────────────────────────────── */

		function applyRowColors() {
			const rows = document.querySelectorAll(ROW_SELECTOR);
			for (const row of rows) {
				const key = row.getAttribute("data-row-key");
				const colorId = key === null ? void 0 : store.colors[key];
				if (colorId !== void 0 && PALETTE_BY_ID.has(colorId)) {
					if (row.getAttribute(ROW_ATTR) !== colorId) row.setAttribute(ROW_ATTR, colorId);
				} else if (row.hasAttribute(ROW_ATTR)) {
					row.removeAttribute(ROW_ATTR);
				}
			}
			applyRowRails();
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
		 * Splice the colour row into an open workspace menu.
		 * @returns whether the menu now carries the row (idempotent).
		 */
		function injectMenuRow(menu, rowKey, row) {
			const viewport = menu.querySelector(':scope > div[role="presentation"]');
			if (viewport === null) return false;
			if (viewport.querySelector("[" + MENU_ITEM_ATTR + "]") !== null) return true;

			const wrap = document.createElement("div");
			wrap.setAttribute(MENU_ITEM_ATTR, "");
			wrap.className = "dsh-wsc-mi-wrap";

			const button = document.createElement("button");
			button.type = "button";
			button.setAttribute("role", "menuitem");
			button.className = "dsh-wsc-mi";
			button.innerHTML =
				'<span class="dsh-wsc-mi-icon">' +
				ITEM_ICON +
				'</span><span class="dsh-wsc-mi-label"></span><span class="dsh-wsc-mi-arrow">›</span>';
			const label = button.querySelector(".dsh-wsc-mi-label");
			if (label !== null) label.textContent = L.changeColor;

			/* A native listener, so stopping propagation keeps React's menu
			 * bookkeeping (focus return, arrow walk) out of this row; the menu
			 * closes on its own pointer-leave grace once the palette is used. */
			button.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				openPalette(rowKey, row);
			});

			wrap.appendChild(button);
			viewport.appendChild(wrap);
			return true;
		}

		/* ────────────────────────────────────────────────────────────────────
		 * Palette (a `shell.overlay` occupant — real React, real floating layer)
		 * ──────────────────────────────────────────────────────────────────── */

		function openPalette(rowKey, row) {
			const element = row instanceof Element ? row : document.querySelector('[data-row-key="' + rowKey + '"]');
			const rect = element === null ? null : element.getBoundingClientRect();
			store.palette = {
				rowKey,
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

		function palettePosition(rect) {
			const height = (PALETTE.length + 1) * 32 + 16;
			const vw = window.innerWidth;
			const vh = window.innerHeight;
			let left = rect.left;
			let top = rect.bottom + 4;
			left = Math.min(Math.max(left, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, vw - PALETTE_WIDTH - VIEWPORT_MARGIN));
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
			const position = palettePosition(open.rect);
			const selected = store.colors[open.rowKey];

			const rows = PALETTE.map((entry) =>
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
				rows.push(h("div", { key: "separator", className: "dsh-wsc-sep" }));
				rows.push(
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

			return h(
				"div",
				{
					ref: rootRef,
					className: "dsh-wsc-palette",
					role: "menu",
					"aria-label": L.paletteLabel,
					style: { left: position.left + "px", top: position.top + "px", width: PALETTE_WIDTH + "px" }
				},
				rows
			);
		}

		/* ────────────────────────────────────────────────────────────────────
		 * Styles
		 * ──────────────────────────────────────────────────────────────────── */

		const COLOR_RULES = PALETTE.map(
			(entry) => '[data-row-key^="workspace:"][' + ROW_ATTR + '="' + entry.id + '"]{--dsh-wsc-color:' + entry.color + "}"
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
		const CHIP = '[data-row-key^="workspace:"][' + ROW_ATTR + "]";

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
			"background:color-mix(in srgb,var(--dsh-wsc-color) 70%,transparent);color:rgba(0,0,0,.74)}" +
			COLOR_RULES +
			RAIL_CSS +
			/* Palette card (ported from the menu surface's own tokens). */
			".dsh-wsc-palette{position:fixed;z-index:1300;box-sizing:border-box;padding:4px;display:flex;flex-direction:column;pointer-events:auto;" +
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
				applyRowColors();
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
			applyRowColors();

			return () => {
				observer.disconnect();
				document.removeEventListener("pointerdown", onPointerDown, true);
				document.removeEventListener("contextmenu", onContextMenu, true);
				candidates.clear();
				for (const row of document.querySelectorAll("[" + ROW_ATTR + "]")) row.removeAttribute(ROW_ATTR);
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
				colors: PALETTE.map((entry) => entry.id),
				get: (rowKey) => store.colors[rowKey] ?? null,
				set: (rowKey, colorId) => setColor(rowKey, colorId),
				clear: (rowKey) => setColor(rowKey, null),
				all: () => Object.assign({}, store.colors)
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
