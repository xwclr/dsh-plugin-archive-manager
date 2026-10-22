/**
 * 插件功能 / Plugin features — browser feature factory.
 *
 * The three capabilities of this package ship as one Loader row, so the only
 * on/off controls the Host row carries are the ones a deployment writes into
 * its `config`. This page gives the user the same three switches where they
 * actually look for them: a Settings section that is **always** registered,
 * even when every feature is currently off.
 *
 * The choice is page-local (localStorage) and is combined with the Host row's
 * config: a feature runs only when both say yes. Registrations happen once at
 * page load, so a change is applied by reloading the page — the page says so
 * and offers the button.
 *
 * @param require - the module table this plugin's factory received.
 * @param controls - `{ host, readPrefs, writePrefs, reload }` from the bundle
 *   wrapper (the one place that owns the flags).
 * @returns the feature module: `{ apply, inject, FeaturesPage }`.
 */
(require, controls) => {
	'use strict';
	var module = { exports: {} };
	var exports = module.exports;
	Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

	const React = require('react');
	const h = React.createElement;

	/** The design system is an implicit external; a deployment may not answer it. */
	let design = null;
	try {
		design = require('@deepseek-ai/dsh-client-ui-primitives');
	} catch (failure) {
		design = null;
	}

	const PLUGIN_ID = 'dsh-plugin-archive-manager';

	/** An icon component, or an inert placeholder when the design system is absent. */
	const icon = (name) =>
		(design && design[name]) ||
		((props) => {
			const size = props && props.size ? props.size : 16;
			return h('span', { className: 'dsh-amf-glyph', style: { width: size, height: size } });
		});
	const IconPlug = icon('IconPlugOutlineRegular');

	/** The design system switch, with a plain role=switch fallback. */
	const Switch =
		(design && design.Switch) ||
		((props) =>
			h(
				'button',
				{
					type: 'button',
					role: 'switch',
					'aria-checked': props.checked === true,
					'aria-label': props.label,
					disabled: props.disabled,
					className: 'dsh-amf-plainSwitch',
					onClick: () => {
						if (props.disabled !== true) props.onChange(props.checked !== true);
					}
				},
				props.checked === true ? 'on' : 'off'
			));

	/** The design system button, with a plain fallback. */
	const Button =
		(design && design.Button) ||
		((props) =>
			h(
				'button',
				{ type: 'button', className: 'dsh-amf-plainButton', disabled: props.disabled, onClick: props.onClick },
				props.children
			));

	const STRINGS = {
		zh: {
			nav: '插件功能',
			intro: '这些功能装在同一个插件里，可以分别开关。开关保存在本机，与插件的 config 同时生效——刷新页面后按新开关重新注册。',
			archive: '归档会话',
			archiveHint: '「设置 → 归档会话」页：按项目管理已归档会话，以及会话「…」菜单里的「删除会话」。',
			skills: '技能管理',
			skillsHint: '侧边栏「技能」页：导入、启用/停用、删除技能。',
			colors: '工作区配色',
			colorsHint: '工作区的颜色：彩色 # 徽标、颜色调色板与同色会话竖线。',
			icons: '工作区图标',
			iconsHint: '用 24 个内置图标替换工作区的 # 徽标（与颜色互不影响，可单独开启）。',
			hostOff: '已被插件配置（config）关闭，这里无法开启。',
			dirty: '开关已保存，刷新页面后生效。',
			reload: '立即刷新',
			statusOn: '已启用',
			statusOff: '已停用'
		},
		en: {
			nav: 'Plugin features',
			intro: 'These features ship as one plugin and can be switched separately. Choices are stored on this machine and combined with the plugin config; the page reloads them into registration.',
			archive: 'Archived sessions',
			archiveHint: 'The Settings page that lists archived sessions by project, plus “Delete session” in a session’s “…” menu.',
			skills: 'Skill manager',
			skillsHint: 'The sidebar “Skills” page: import, enable/disable and delete skills.',
			colors: 'Workspace colors',
			colorsHint: 'Workspace colours: the coloured badge, the palette, and the matching session rail.',
			icons: 'Workspace icons',
			iconsHint: 'Replace the workspace # badge with one of 24 built-in icons (independent of colours).',
			hostOff: 'Disabled by the plugin config; it cannot be turned on here.',
			dirty: 'Saved. Reload the page to apply.',
			reload: 'Reload now',
			statusOn: 'On',
			statusOff: 'Off'
		}
	};

	/** Set once at activation, before the slot component can render. */
	let zhActive = false;
	const L = new Proxy(
		{},
		{
			get(_target, key) {
				const table = STRINGS[zhActive ? 'zh' : 'en'];
				return table[key] === void 0 ? String(key) : table[key];
			}
		}
	);

	/** Resolve the UI language from the client locale, falling back to the page hint. */
	function detectZh(ctx) {
		try {
			const locale = typeof ctx.get === 'function' ? ctx.get('locale') : void 0;
			if (locale !== void 0 && locale !== null) {
				const snapshot =
					typeof locale.getLocale === 'function' ? locale.getLocale() : typeof locale.getSnapshot === 'function' ? locale.getSnapshot() : null;
				const id = snapshot && (snapshot.id || snapshot.locale || snapshot.language);
				if (typeof id === 'string' && id.length > 0) return id.toLowerCase().startsWith('zh');
			}
		} catch (error) {
			/* fall through to the document hint */
		}
		const lang = (document.documentElement.getAttribute('lang') || navigator.language || 'zh').toLowerCase();
		return String(lang).startsWith('zh');
	}

	const CSS = `
.dsh-amf-glyph{display:inline-block;flex:none;border-radius:4px;background:currentColor;opacity:.25}
.dsh-amf-plainButton{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:transparent;color:inherit;padding:6px 12px;font:inherit;font-size:13px;line-height:20px;cursor:pointer}
.dsh-amf-plainButton:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.dsh-amf-page{box-sizing:border-box;display:flex;flex-direction:column;gap:12px;width:100%;min-width:0;color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.55;overflow-wrap:anywhere}
.dsh-amf-head{display:flex;align-items:center;gap:8px;min-width:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.dsh-amf-list{display:flex;flex-direction:column;gap:8px;min-width:0}
.dsh-amf-row{box-sizing:border-box;display:flex;align-items:center;gap:12px;min-width:0;padding:12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.dsh-amf-rowMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dsh-amf-rowTitle{display:flex;align-items:center;gap:6px;font-size:14px;font-weight:500;line-height:21px}
.dsh-amf-rowHint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsh-amf-rowOff .dsh-amf-rowHint{color:var(--dsw-alias-state-warn-primary)}
.dsh-amf-badge{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;font-weight:500;white-space:nowrap}
.dsh-amf-banner{box-sizing:border-box;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);font-size:13px;line-height:20px}
.dsh-amf-bannerText{flex:1 1 220px;min-width:0}
.dsh-amf-plainSwitch{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:inherit;padding:2px 10px;font:inherit;font-size:12px;line-height:18px;cursor:pointer;min-width:44px}
.dsh-amf-plainSwitch[aria-checked=true]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
`;

	/** Insert this section's stylesheet; the returned disposer removes it. */
	function insertStyles() {
		const tag = document.createElement('style');
		tag.dataset.plugin = PLUGIN_ID;
		tag.dataset.pluginCss = PLUGIN_ID + '/features.css';
		tag.textContent = CSS;
		document.head.appendChild(tag);
		return () => {
			tag.remove();
		};
	}

	const ROWS = [
		{ key: 'archive', label: () => L.archive, hint: () => L.archiveHint },
		{ key: 'skills', label: () => L.skills, hint: () => L.skillsHint },
		{ key: 'colors', label: () => L.colors, hint: () => L.colorsHint },
		{ key: 'icons', label: () => L.icons, hint: () => L.iconsHint }
	];

	/**
	 * The Settings section: one switch per bundled feature.
	 *
	 * The Host row's `config` is the outer bound (a deployment can force a
	 * feature off), the local preference is the user's own choice; a feature
	 * runs only while both say yes, so a host-disabled row renders its switch
	 * locked instead of pretending the user can re-enable it here.
	 */
	function FeaturesPage() {
		const [prefs, setPrefs] = React.useState(() => controls.readPrefs());
		const [dirty, setDirty] = React.useState(false);
		const host = controls.host();

		const toggle = (key, value) => {
			const next = Object.assign({}, prefs);
			next[key] = value === true;
			setPrefs(controls.writePrefs(next));
			setDirty(true);
		};

		return h(
			'div',
			{ className: 'dsh-amf-page' },
			h('div', { className: 'dsh-amf-head' }, h(IconPlug, { size: 15 }), h('span', null, L.intro)),
			dirty
				? h(
						'div',
						{ className: 'dsh-amf-banner', role: 'status' },
						h('span', { className: 'dsh-amf-bannerText' }, L.dirty),
						h(Button, { onClick: () => controls.reload() }, L.reload)
					)
				: null,
			h(
				'div',
				{ className: 'dsh-amf-list' },
				ROWS.map((row) => {
					const forcedOff = host[row.key] === false;
					const checked = forcedOff ? false : prefs[row.key] !== false;
					return h(
						'div',
						{ key: row.key, className: 'dsh-amf-row' + (forcedOff ? ' dsh-amf-rowOff' : ''), 'data-feature': row.key },
						h(
							'div',
							{ className: 'dsh-amf-rowMain' },
							h(
								'div',
								{ className: 'dsh-amf-rowTitle' },
								h('span', null, row.label()),
								h('span', { className: 'dsh-amf-badge' }, forcedOff ? L.hostOff : checked ? L.statusOn : L.statusOff)
							),
							h('div', { className: 'dsh-amf-rowHint' }, forcedOff ? L.hostOff : row.hint())
						),
						h(Switch, {
							checked,
							disabled: forcedOff,
							label: row.label(),
							onChange: (value) => toggle(row.key, value)
						})
					);
				})
			)
		);
	}

	/**
	 * Browser plugin body. Always registered: this page is where a user turns a
	 * disabled feature back on, so it must not be gated by the same switches.
	 * @param ctx - client root context.
	 */
	function apply(ctx) {
		try {
			zhActive = detectZh(ctx);
			ctx.slots.inject('settings.section', () =>
				ctx.slots.register(
					{ name: 'settings.section', id: 'archive-manager.features', order: 34, label: () => L.nav },
					FeaturesPage
				)
			);
			ctx.effect(() => insertStyles(), 'archive-manager: feature switch stylesheet');
		} catch (error) {
			console.error('[archive-manager] feature switch page failed to activate:', error);
		}
	}

	exports.FeaturesPage = FeaturesPage;
	exports.apply = apply;
	exports.inject = ['slots'];
	return module.exports;
}
