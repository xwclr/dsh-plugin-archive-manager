/**
 * 归档会话 / Archived Sessions — browser feature factory.
 *
 * The Settings page of the archive manager: it lists every archived session
 * grouped by project, filters them, and restores or deletes sessions one at a
 * time or by project. The host half owns the decisions (which ids may be
 * touched, whether a log still exists, whether a live agent owns a session);
 * this page only renders its JSON envelope from `docs/API.md` and asks again
 * after every mutation.
 *
 * The page is registered into the shipped `settings.section` slot, so the
 * Settings panel itself provides the section label and the content column.
 *
 * @param require - the module table this plugin's factory received.
 * @returns the feature module: `{ apply, inject, ArchiveManagerPage }`.
 */
(require) => {
	'use strict';
	var module = { exports: {} };
	var exports = module.exports;
	Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

	const React = require('react');
	const h = React.createElement;

	/**
	 * The design system is an implicit baseline external. A deployment that
	 * cannot answer it must still mount the page, so the require is guarded and
	 * every atom has a plain fallback below.
	 */
	let design = null;
	try {
		design = require('@deepseek-ai/dsh-client-ui-primitives');
	} catch (failure) {
		design = null;
	}

	const PLUGIN_ID = 'dsh-plugin-archive-manager';
	/** Where the host half mounts its JSON API. */
	const API = '/archive-manager/api';
	/** Group/filter key of the pseudo-project the host calls `ungrouped`. */
	const UNGROUPED_KEY = '__ungrouped__';
	/** Prefix of a busy/confirm key owned by one session row. */
	const ROW_PREFIX = 'row:';

	/** An icon component, or an inert placeholder when the design system is absent. */
	const icon = (name) =>
		(design && design[name]) ||
		((props) => {
			const size = props && props.size ? props.size : 16;
			return h('span', { className: 'dsh-am-glyph', style: { width: size, height: size } });
		});
	const IconRefresh = icon('IconRefreshOutlineRegular');
	const IconSearch = icon('IconSearchOutlineRegular');
	const IconClose = icon('IconCloseOutlineRegular');
	const IconChevronDown = icon('IconChevronDownOutlineRegular');
	const IconChevronRight = icon('IconChevronRightOutlineRegular');
	const IconWarning = icon('IconWarningTriangleOutlineRegular');
	const IconLoading = icon('IconLoadingOutlineRegular');
	const IconArchive = icon('IconArchiveOutlineRegular');

	/** The one design-system atom the page uses where it fits, with a plain fallback. */
	const Button =
		(design && design.Button) ||
		((props) =>
			h(
				'button',
				{
					type: 'button',
					className: 'dsh-am-plainButton' + (props.className ? ' ' + props.className : ''),
					disabled: props.disabled,
					onClick: props.onClick,
					title: props.title,
					'aria-label': props['aria-label']
				},
				props.icon === void 0 ? null : props.icon,
				props.children
			));

	/** Page copy. Plain dictionaries so the active language is resolved at render time. */
	const STRINGS = {
		zh: {
			nav: '归档会话',
			summary: '共 {total} 个已归档会话 · 合计 {bytes}',
			summaryFiltered: '共 {total} 个已归档会话 · 合计 {bytes} · 筛选出 {shown} 个',
			refresh: '刷新',
			refreshing: '刷新中…',
			search: '搜索标题、路径或项目',
			clearSearch: '清除搜索',
			all: '全部',
			ungrouped: '未分组',
			unnamed: '未命名会话',
			unnamedProject: '未命名项目',
			logMissing: '日志缺失',
			running: '运行中',
			openBadge: '已打开',
			runningHint: '这一轮正在执行',
			openHint: '会话仍在窗口中打开；切换到其他会话后即可删除',
			failLive: '会话仍在窗口中打开，先切换到其他会话再删除',
			failNotArchived: '该会话已不在归档列表中',
			failMalformed: '会话 id 不合法',
			restore: '重新激活',
			restoreAll: '全部重新激活',
			delete: '删除',
			deleteAll: '全部删除',
			confirmDelete: '确认删除？',
			confirmDeleteGroup: '确认删除 {count} 个会话？',
			confirm: '确认',
			cancel: '取消',
			processing: '处理中…',
			loadFailed: '无法读取归档会话',
			retry: '重试',
			emptyTitle: '没有已归档的会话',
			emptyBody: '在会话的「...」菜单中选择「归档」，归档的会话会显示在这里。',
			noMatchTitle: '没有匹配的过滤条件',
			noMatchBody: '换个关键词，或选择其他项目。',
			loading: '正在读取归档会话…',
			deleteFailed: '{count} 个删除失败',
			restoreFailed: '{count} 个重新激活失败',
			unknownTime: '时间未知',
			justNow: '刚刚',
			archivedAtTitle: '最近活动（会话目录的最后修改时间）',
			sessionCount: '{count} 个',
			moreFailures: '还有 {count} 条',
			clearFilters: '清除筛选',
			projectFilterLabel: '按项目筛选'
		},
		en: {
			nav: 'Archived sessions',
			summary: '{total} archived sessions · {bytes} total',
			summaryFiltered: '{total} archived sessions · {bytes} total · {shown} shown',
			refresh: 'Refresh',
			refreshing: 'Refreshing…',
			search: 'Search title, path or project',
			clearSearch: 'Clear search',
			all: 'All',
			ungrouped: 'Ungrouped',
			unnamed: 'Untitled session',
			unnamedProject: 'Untitled project',
			logMissing: 'Log missing',
			running: 'Running',
			openBadge: 'Open',
			runningHint: 'A turn is executing right now',
			openHint: 'Still open in a window; switch to another session to delete it',
			failLive: 'The session is still open in a window; switch to another session first',
			failNotArchived: 'The session is no longer archived',
			failMalformed: 'Malformed session id',
			restore: 'Restore',
			restoreAll: 'Restore all',
			delete: 'Delete',
			deleteAll: 'Delete all',
			confirmDelete: 'Delete?',
			confirmDeleteGroup: 'Delete {count} sessions?',
			confirm: 'Confirm',
			cancel: 'Cancel',
			processing: 'Working…',
			loadFailed: 'Could not load archived sessions',
			retry: 'Retry',
			emptyTitle: 'No archived sessions',
			emptyBody: 'Choose “Archive” from a session’s “...” menu and it will show up here.',
			noMatchTitle: 'No sessions match these filters',
			noMatchBody: 'Try another keyword or choose another project.',
			loading: 'Loading archived sessions…',
			deleteFailed: '{count} failed to delete',
			restoreFailed: '{count} failed to restore',
			unknownTime: 'Unknown time',
			justNow: 'just now',
			archivedAtTitle: 'Last activity (the session folder’s last-modified time)',
			sessionCount: '{count} sessions',
			moreFailures: '+{count} more',
			clearFilters: 'Clear filters',
			projectFilterLabel: 'Filter by project'
		}
	};

	/**
	 * Resolve the active language without requiring the locale service.
	 *
	 * `ctx.get('locale')` is looked up live and tolerated being absent; the
	 * document/navigator hint is only a fallback because a desktop launch flag
	 * can disagree with the product UI. Chinese is the default when nothing
	 * conclusive is available.
	 * @param ctx - client root context.
	 * @returns whether Chinese copy should be used.
	 */
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
		let lang = '';
		try {
			if (typeof document !== 'undefined' && document.documentElement) lang = document.documentElement.getAttribute('lang') || '';
			if (lang === '' && typeof navigator !== 'undefined') lang = navigator.language || '';
		} catch (error) {
			/* keep the default */
		}
		if (typeof lang === 'string' && lang.length > 0) {
			const lower = lang.toLowerCase();
			if (lower.startsWith('zh')) return true;
			if (lower.startsWith('en')) return false;
		}
		return true;
	}

	/** Set once at activation, before the slot component can render. */
	let zhActive = false;
	/** Live string table: `L.title` always reads the currently active language. */
	const L = new Proxy(
		{},
		{
			get(_target, key) {
				const table = STRINGS[zhActive ? 'zh' : 'en'];
				const value = table[key];
				return value === void 0 ? String(key) : value;
			}
		}
	);

	/** Fill `{placeholder}` slots in one copy string. */
	function format(text, values) {
		return String(text).replace(/\{(\w+)\}/gu, (whole, key) =>
			Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole
		);
	}

	/* ────────────────────────────────────────────────────────────────────────
	 * Small pure helpers (time, sizes, grouping, labels)
	 * ──────────────────────────────────────────────────────────────────────── */

	function pad2(value) {
		return value < 10 ? '0' + value : String(value);
	}

	/** A local absolute timestamp, for the meta line next to the relative one. */
	function absoluteTime(ms) {
		const value = Number(ms);
		if (!Number.isFinite(value) || value <= 0) return '';
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return '';
		return (
			date.getFullYear() +
			'-' +
			pad2(date.getMonth() + 1) +
			'-' +
			pad2(date.getDate()) +
			' ' +
			pad2(date.getHours()) +
			':' +
			pad2(date.getMinutes())
		);
	}

	/** "3 天前" / "3 days ago" (and friends), from an epoch-millisecond value. */
	function relativeTime(ms) {
		const value = Number(ms);
		if (!Number.isFinite(value) || value <= 0) return L.unknownTime;
		const diff = Math.max(0, Date.now() - value);
		const minute = 60 * 1000;
		const hour = 60 * minute;
		const day = 24 * hour;
		if (diff < minute) return L.justNow;
		if (diff < hour) {
			const count = Math.floor(diff / minute);
			return zhActive ? count + ' 分钟前' : count + ' min ago';
		}
		if (diff < day) {
			const count = Math.floor(diff / hour);
			return zhActive ? count + ' 小时前' : count + (count === 1 ? ' hour ago' : ' hours ago');
		}
		if (diff < 30 * day) {
			const count = Math.floor(diff / day);
			return zhActive ? count + ' 天前' : count + (count === 1 ? ' day ago' : ' days ago');
		}
		if (diff < 365 * day) {
			const count = Math.floor(diff / (30 * day));
			return zhActive ? count + ' 个月前' : count + (count === 1 ? ' month ago' : ' months ago');
		}
		const count = Math.floor(diff / (365 * day));
		return zhActive ? count + ' 年前' : count + (count === 1 ? ' year ago' : ' years ago');
	}

	function roundedNumber(value) {
		return String(Math.round(value * 10) / 10);
	}

	/** B / KB / MB, with one decimal only while it is useful. */
	function formatBytes(bytes) {
		const value = Number(bytes);
		if (!Number.isFinite(value) || value <= 0) return '0 B';
		if (value < 1024) return String(Math.round(value)) + ' B';
		const kb = value / 1024;
		if (kb < 1024) return (kb >= 100 ? String(Math.round(kb)) : roundedNumber(kb)) + ' KB';
		const mb = kb / 1024;
		if (mb < 1024) return (mb >= 100 ? String(Math.round(mb)) : roundedNumber(mb)) + ' MB';
		return (mb / 1024 >= 100 ? String(Math.round(mb / 1024)) : roundedNumber(mb / 1024)) + ' GB';
	}

	function pathBase(path) {
		const text = String(path === null || path === void 0 ? '' : path).replace(/[\\/]+$/u, '');
		const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
		return cut >= 0 ? text.slice(cut + 1) : text;
	}

	function isSession(value) {
		return value !== null && typeof value === 'object' && typeof value.id === 'string' && value.id.length > 0;
	}

	function sessionTitle(session) {
		const title = session && typeof session.title === 'string' ? session.title.trim() : '';
		return title.length > 0 ? title : L.unnamed;
	}

	function projectTitle(project) {
		const title = project && typeof project.title === 'string' ? project.title.trim() : '';
		if (title.length > 0) return title;
		const base = project && typeof project.path === 'string' ? pathBase(project.path) : '';
		return base.length > 0 ? base : L.unnamedProject;
	}

	function projectKey(project) {
		if (project && typeof project.id === 'string' && project.id.length > 0) return 'id:' + project.id;
		if (project && typeof project.path === 'string' && project.path.length > 0) return 'path:' + project.path;
		return 'project:';
	}

	function sumBytes(sessions) {
		let total = 0;
		for (const session of sessions) {
			const value = session && Number(session.bytes);
			if (Number.isFinite(value) && value > 0) total += value;
		}
		return total;
	}

	function countSessions(groups) {
		let total = 0;
		for (const group of groups) total += group.sessions.length;
		return total;
	}

	function totalBytes(groups) {
		let total = 0;
		for (const group of groups) total += sumBytes(group.sessions);
		return total;
	}

	/** Normalize the host envelope's groups; empty/absent projects are dropped. */
	function collectGroups(data) {
		const groups = [];
		if (data === null || data === void 0 || typeof data !== 'object') return groups;
		const projects = Array.isArray(data.projects) ? data.projects : [];
		for (const project of projects) {
			if (project === null || typeof project !== 'object') continue;
			const sessions = Array.isArray(project.sessions) ? project.sessions.filter(isSession) : [];
			if (sessions.length === 0) continue;
			groups.push({
				key: projectKey(project),
				ungrouped: false,
				title: projectTitle(project),
				path: typeof project.path === 'string' ? project.path : '',
				sessions
			});
		}
		const ungrouped = data.ungrouped;
		if (ungrouped !== null && typeof ungrouped === 'object') {
			const sessions = Array.isArray(ungrouped.sessions) ? ungrouped.sessions.filter(isSession) : [];
			if (sessions.length > 0) {
				groups.push({ key: UNGROUPED_KEY, ungrouped: true, title: L.ungrouped, path: '', sessions });
			}
		}
		return groups;
	}

	/** Case-insensitive match over title, cwd, project title and session id. */
	function matchesQuery(session, group, query) {
		const title = typeof session.title === 'string' ? session.title : '';
		const cwd = typeof session.cwd === 'string' ? session.cwd : '';
		const project = group && typeof group.title === 'string' ? group.title : '';
		const id = typeof session.id === 'string' ? session.id : '';
		return (title + '\n' + cwd + '\n' + project + '\n' + id).toLowerCase().indexOf(query) !== -1;
	}

	/** Apply the selected project and the search query; empty groups disappear. */
	function filterGroups(groups, query, projectFilter) {
		const result = [];
		for (const group of groups) {
			if (projectFilter !== 'all' && group.key !== projectFilter) continue;
			const sessions =
				query.length === 0
					? group.sessions.slice()
					: group.sessions.filter((session) => matchesQuery(session, group, query));
			if (sessions.length === 0) continue;
			result.push({
				key: group.key,
				ungrouped: group.ungrouped,
				title: group.title,
				path: group.path,
				sessions,
				bytes: sumBytes(sessions)
			});
		}
		return result;
	}

	/** Escape while an inline confirmation is focused cancels it, like the buttons. */
	function cancelOnEscape(cancel) {
		return (event) => {
			if (event && event.key === 'Escape') {
				event.stopPropagation();
				cancel();
			}
		};
	}

	/* ────────────────────────────────────────────────────────────────────────
	 * Host calls
	 * ──────────────────────────────────────────────────────────────────────── */

	/** A failed call, in the shape the page renders. */
	function failure(message) {
		return { ok: false, error: { message } };
	}

	/**
	 * One JSON call to the host half.
	 *
	 * The envelope is returned rather than thrown, so a refusal is rendered
	 * inline instead of taking the page down. `docs/API.md` fixes the transport:
	 * POST, a JSON object body, always HTTP 200 with `{ok,value}` or `{ok,error}`.
	 * @param method - API method name.
	 * @param payload - request body.
	 * @returns the `{ok, value}` envelope, or a synthesized failure.
	 */
	async function call(method, payload) {
		let response;
		try {
			response = await fetch(API + '/' + method, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload === void 0 ? {} : payload)
			});
		} catch (error) {
			return failure(error && error.message ? error.message : String(error));
		}
		let parsed = null;
		try {
			parsed = await response.json();
		} catch (error) {
			return failure('HTTP ' + response.status);
		}
		if (parsed !== null && typeof parsed === 'object' && typeof parsed.ok === 'boolean') return parsed;
		return failure('HTTP ' + response.status);
	}

	/** The message out of a failed envelope. */
	function errorText(result) {
		if (result && result.ok === false && result.error) return String(result.error.message || result.error);
		return L.loadFailed;
	}

	/* ────────────────────────────────────────────────────────────────────────
	 * Stylesheet (theme tokens only; no light-only palette)
	 * ──────────────────────────────────────────────────────────────────────── */

	const CSS = `
.dsh-am-glyph{display:inline-block;flex:none;border-radius:4px;background:currentColor;opacity:.25}
.dsh-am-plainButton{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:transparent;color:inherit;padding:6px 12px;font:inherit;font-size:13px;line-height:20px;cursor:pointer}
.dsh-am-plainButton:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.dsh-am-plainButton:disabled{opacity:.5;cursor:not-allowed}
.dsh-am-page{box-sizing:border-box;display:flex;flex-direction:column;gap:12px;width:100%;max-width:100%;min-width:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.55;overflow-wrap:anywhere}
.dsh-am-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}
.dsh-am-summary{display:flex;align-items:center;gap:8px;flex:1 1 220px;min-width:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.dsh-am-refreshing{display:inline-flex;align-items:center;gap:4px;flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:nowrap}
.dsh-am-toolbarActions{display:flex;align-items:center;gap:8px;flex:none;margin-left:auto}
.dsh-am-refresh{white-space:nowrap}
.dsh-am-controls{display:flex;flex-direction:column;gap:8px;min-width:0}
.dsh-am-search{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;min-width:0;height:36px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);transition:border-color .15s}
.dsh-am-search:focus-within{border-color:var(--dsw-alias-brand-primary)}
.dsh-am-search input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px}
.dsh-am-search input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.75}
.dsh-am-searchClear{display:inline-flex;align-items:center;justify-content:center;flex:none;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);padding:2px;cursor:pointer}
.dsh-am-searchClear:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsh-am-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.dsh-am-chip{box-sizing:border-box;display:inline-flex;align-items:center;max-width:100%;min-width:0;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:20px;padding:3px 10px;cursor:pointer}
.dsh-am-chip:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.dsh-am-chip[data-active=true]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
.dsh-am-chip:disabled{opacity:.5;cursor:not-allowed}
.dsh-am-chipLabel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-am-banner{box-sizing:border-box;display:flex;align-items:flex-start;gap:8px;min-width:0;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}
.dsh-am-banner[data-tone=error]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsh-am-bannerGlyph{display:inline-flex;flex:none;margin-top:2px}
.dsh-am-bannerMain{flex:1;min-width:0;overflow-wrap:anywhere}
.dsh-am-bannerText{font-weight:500}
.dsh-am-failList{margin:4px 0 0;padding-left:18px;color:var(--dsw-alias-label-secondary)}
.dsh-am-failList li{margin:2px 0}
.dsh-am-bannerMore{margin-top:2px;color:var(--dsw-alias-label-secondary)}
.dsh-am-bannerActions{display:flex;align-items:center;gap:6px;flex:none;flex-wrap:wrap}
.dsh-am-groups{display:flex;flex-direction:column;gap:10px;min-width:0}
.dsh-am-group{display:flex;flex-direction:column;min-width:0;border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.dsh-am-groupHead{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;min-width:0;padding:10px 12px}
.dsh-am-groupToggle{display:flex;align-items:flex-start;gap:8px;flex:1 1 220px;min-width:0;padding:2px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dsh-am-groupToggle:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-am-groupToggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-am-chevron{display:inline-flex;flex:none;padding-top:2px;color:var(--dsw-alias-label-secondary)}
.dsh-am-groupText{display:flex;flex-direction:column;gap:1px;flex:1;min-width:0}
.dsh-am-groupTitle{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;min-width:0;font-size:14px;font-weight:600;line-height:21px}
.dsh-am-groupTitleText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-am-groupCount{flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:400;font-variant-numeric:tabular-nums}
.dsh-am-groupPath{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dsh-am-groupActions{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex:none;flex-wrap:wrap;max-width:100%;margin-left:auto}
.dsh-am-linkButton{display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:20px;padding:2px 4px;white-space:nowrap;cursor:pointer}
.dsh-am-linkButton:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsh-am-linkButton[data-danger=true]{color:var(--dsw-alias-state-error-primary)}
.dsh-am-linkButton[data-danger=true]:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-error-primary)}
.dsh-am-linkButton:disabled{opacity:.45;cursor:not-allowed}
.dsh-am-confirm{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:wrap;min-width:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:20px}
.dsh-am-confirmText{white-space:nowrap}
.dsh-am-confirmGo{box-sizing:border-box;border:.5px solid var(--dsw-alias-state-error-primary);border-radius:7px;background:transparent;color:var(--dsw-alias-state-error-primary);font:inherit;font-size:12px;line-height:20px;padding:1px 8px;white-space:nowrap;cursor:pointer}
.dsh-am-confirmGo:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.dsh-am-confirmGo:disabled{opacity:.45;cursor:not-allowed}
.dsh-am-processing{display:inline-flex;align-items:center;gap:5px;flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;white-space:nowrap}
.dsh-am-rows{display:flex;flex-direction:column;min-width:0;border-top:.5px solid var(--dsw-alias-border-l1)}
.dsh-am-row{display:flex;align-items:flex-start;gap:12px;min-width:0;padding:9px 12px;outline:none}
.dsh-am-row+.dsh-am-row{border-top:.5px solid var(--dsw-alias-border-l1)}
.dsh-am-row:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-am-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dsh-am-rowMain{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}
.dsh-am-rowTitle{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0;font-size:14px;font-weight:500;line-height:21px}
.dsh-am-rowTitleText{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-am-badge{display:inline-flex;align-items:center;gap:3px;flex:none;height:18px;padding:0 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;font-weight:500;white-space:nowrap}
.dsh-am-badge[data-tone=warn]{color:var(--dsw-alias-state-warn-primary)}
.dsh-am-badge[data-tone=success]{color:var(--dsw-alias-state-success-primary)}
.dsh-am-rowMeta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsh-am-rowMeta>span{white-space:nowrap}
.dsh-am-dim{opacity:.55}
.dsh-am-rowPath{flex:1 1 200px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dsh-am-rowActions{display:flex;align-items:center;justify-content:flex-end;gap:4px;flex:none;flex-wrap:wrap;max-width:100%}
.dsh-am-spin{display:inline-flex;flex:none;animation:dsh-am-spin 1s linear infinite}
@keyframes dsh-am-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
.dsh-am-empty{display:flex;flex-direction:column;align-items:center;gap:6px;min-width:0;padding:40px 20px;border:.5px dashed var(--dsw-alias-border-l2);border-radius:12px;text-align:center}
.dsh-am-emptyGlyph{display:inline-flex;margin-bottom:2px;color:var(--dsw-alias-label-secondary);opacity:.7}
.dsh-am-emptyTitle{font-size:14px;font-weight:500}
.dsh-am-emptyBody{max-width:52ch;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsh-am-emptyActions{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:8px}
.dsh-am-loadingWrap{display:flex;flex-direction:column;gap:10px;min-height:180px;min-width:0}
.dsh-am-loading{display:flex;align-items:center;gap:8px;padding:4px 0;color:var(--dsw-alias-label-secondary);font-size:13px}
.dsh-am-skeleton{display:flex;flex-direction:column;gap:8px;min-width:0}
.dsh-am-skeletonRow{display:flex;flex-direction:column;gap:8px;min-width:0;padding:12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.dsh-am-bar{height:10px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);animation:dsh-am-pulse 1.4s ease-in-out infinite}
.dsh-am-bar[data-w=wide]{width:70%}
.dsh-am-bar[data-w=mid]{width:48%}
.dsh-am-bar[data-w=short]{width:30%}
@keyframes dsh-am-pulse{0%,100%{opacity:.55}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){.dsh-am-spin{animation:none}.dsh-am-bar{animation:none}}
@media (max-width:520px){.dsh-am-groupActions{justify-content:flex-start;margin-left:0}.dsh-am-row{flex-wrap:wrap}.dsh-am-rowActions{justify-content:flex-start;width:100%}}
`;

	/** Insert this package's stylesheet; the returned disposer removes it. */
	function insertStyles() {
		const tag = document.createElement('style');
		tag.dataset.plugin = PLUGIN_ID;
		tag.dataset.pluginCss = PLUGIN_ID + '/settings.css';
		tag.textContent = CSS;
		document.head.appendChild(tag);
		return () => {
			tag.remove();
		};
	}

	/* ────────────────────────────────────────────────────────────────────────
	 * Components (declared once in this closure, never inside a render)
	 * ──────────────────────────────────────────────────────────────────────── */

	/** A small rotating glyph used by every busy hint. */
	function Spinner(props) {
		const size = props && props.size ? props.size : 13;
		return h('span', { className: 'dsh-am-spin', 'aria-hidden': 'true' }, h(IconLoading, { size }));
	}

	/** Inline error banner: message, optional per-item failures, optional retry. */
	function Notice(props) {
		const tone = props.tone === void 0 ? 'error' : props.tone;
		const details = Array.isArray(props.details) ? props.details : [];
		return h(
			'div',
			{ className: 'dsh-am-banner', 'data-tone': tone, role: 'alert' },
			h('span', { className: 'dsh-am-bannerGlyph', 'aria-hidden': 'true' }, h(IconWarning, { size: 14 })),
			h(
				'div',
				{ className: 'dsh-am-bannerMain' },
				h('div', { className: 'dsh-am-bannerText' }, props.message),
				details.length > 0 ? h('ul', { className: 'dsh-am-failList' }, details.map((detail, index) => h('li', { key: index }, detail))) : null,
				props.more !== void 0 && props.more > 0 ? h('div', { className: 'dsh-am-bannerMore' }, format(L.moreFailures, { count: props.more })) : null
			),
			props.onRetry === void 0 || props.onRetry === null
				? null
				: h('div', { className: 'dsh-am-bannerActions' }, h(Button, { variant: 'outline', size: 'sm', onClick: props.onRetry }, L.retry))
		);
	}

	/** First-load placeholder: fixed-height content so the list does not jump in. */
	function LoadingSkeleton() {
		return h(
			'div',
			{ className: 'dsh-am-loadingWrap' },
			h('div', { className: 'dsh-am-loading', role: 'status' }, h(Spinner, { size: 14 }), L.loading),
			h(
				'div',
				{ className: 'dsh-am-skeleton', 'aria-hidden': 'true' },
				[0, 1, 2].map((index) =>
					h(
						'div',
						{ className: 'dsh-am-skeletonRow', key: index },
						h('div', { className: 'dsh-am-bar', 'data-w': 'wide' }),
						h('div', { className: 'dsh-am-bar', 'data-w': 'mid' }),
						h('div', { className: 'dsh-am-bar', 'data-w': 'short' })
					)
				)
			)
		);
	}

	/** One archived session row. */
	function SessionRow(props) {
		const { session, showPath, acting, confirming, disabled } = props;
		const title = sessionTitle(session);
		const archivedAt = Number(session.archivedAt) || 0;
		const relative = relativeTime(archivedAt);
		const absolute = absoluteTime(archivedAt);
		const cwd = typeof session.cwd === 'string' ? session.cwd : '';
		const badges = [];
		if (session.exists === false) {
			badges.push(h('span', { key: 'missing', className: 'dsh-am-badge', 'data-tone': 'warn' }, L.logMissing));
		}
		if (session.running === true) {
			badges.push(h('span', { key: 'running', className: 'dsh-am-badge', 'data-tone': 'warn', title: L.runningHint }, L.running));
		} else if (session.live === true) {
			/* Archiving hides a session from the workspace list; it does not close
			 * the window that still has it open, so a live-but-idle archived
			 * session is a normal state, not a running turn. */
			badges.push(h('span', { key: 'open', className: 'dsh-am-badge', 'data-tone': 'info', title: L.openHint }, L.openBadge));
		}
		return h(
			'div',
			{
				className: 'dsh-am-row',
				role: 'listitem',
				tabIndex: 0,
				'data-session': session.id,
				'aria-busy': acting ? true : void 0
			},
			h(
				'div',
				{ className: 'dsh-am-rowMain' },
				h('div', { className: 'dsh-am-rowTitle' }, h('span', { className: 'dsh-am-rowTitleText', title }, title), badges),
				h(
					'div',
					{ className: 'dsh-am-rowMeta' },
					h('span', { className: 'dsh-am-time', title: L.archivedAtTitle }, relative),
					absolute.length > 0 ? h('span', { className: 'dsh-am-dim', 'aria-hidden': 'true' }, '·') : null,
					absolute.length > 0 ? h('span', { className: 'dsh-am-abs' }, absolute) : null,
					h('span', { className: 'dsh-am-dim', 'aria-hidden': 'true' }, '·'),
					h('span', { className: 'dsh-am-size' }, formatBytes(session.bytes)),
					showPath && cwd.length > 0 ? h('span', { className: 'dsh-am-rowPath', title: cwd }, cwd) : null
				)
			),
			h(
				'div',
				{ className: 'dsh-am-rowActions' },
				acting
					? h('span', { className: 'dsh-am-processing', role: 'status' }, h(Spinner), L.processing)
					: confirming
						? h(
								'div',
								{ className: 'dsh-am-confirm', onKeyDown: cancelOnEscape(props.onCancelConfirm) },
								h('span', { className: 'dsh-am-confirmText' }, L.confirmDelete),
								h(
									'button',
									{ type: 'button', className: 'dsh-am-confirmGo', disabled, onClick: props.onConfirmDelete },
									L.confirm
								),
								h('button', { type: 'button', className: 'dsh-am-linkButton', disabled, onClick: props.onCancelConfirm }, L.cancel)
							)
						: [
								h(
									'button',
									{ key: 'restore', type: 'button', className: 'dsh-am-linkButton', disabled, onClick: props.onRestore },
									L.restore
								),
								h(
									'button',
									{
										key: 'delete',
										type: 'button',
										className: 'dsh-am-linkButton',
										'data-danger': 'true',
										disabled,
										onClick: props.onAskDelete
									},
									L.delete
								)
							]
			)
		);
	}

	/** One collapsible project block with its group-level actions. */
	function ArchiveGroup(props) {
		const { group, expanded, panelId, showPath, groupActing, rowActingId, groupConfirm, rowConfirmId, disabled } = props;
		const count = group.sessions.length;
		const size = formatBytes(group.bytes === void 0 ? sumBytes(group.sessions) : group.bytes);
		const actions = groupActing
			? h('span', { className: 'dsh-am-processing', role: 'status' }, h(Spinner), L.processing)
			: groupConfirm
				? h(
						'div',
						{ className: 'dsh-am-confirm', onKeyDown: cancelOnEscape(props.onCancelConfirm) },
						h('span', { className: 'dsh-am-confirmText' }, format(L.confirmDeleteGroup, { count })),
						h('button', { type: 'button', className: 'dsh-am-confirmGo', disabled, onClick: props.onDeleteAll }, L.confirm),
						h('button', { type: 'button', className: 'dsh-am-linkButton', disabled, onClick: props.onCancelConfirm }, L.cancel)
					)
				: [
						h(
							'button',
							{ key: 'restore', type: 'button', className: 'dsh-am-linkButton', disabled, onClick: props.onRestoreAll },
							L.restoreAll
						),
						h(
							'button',
							{
								key: 'delete',
								type: 'button',
								className: 'dsh-am-linkButton',
								'data-danger': 'true',
								disabled,
								onClick: props.onAskDeleteAll
							},
							L.deleteAll
						)
					];
		return h(
			'section',
			{ className: 'dsh-am-group', 'data-group': group.key, 'aria-busy': groupActing ? true : void 0 },
			h(
				'div',
				{ className: 'dsh-am-groupHead' },
				h(
					'button',
					{
						type: 'button',
						className: 'dsh-am-groupToggle',
						'aria-expanded': expanded,
						'aria-controls': panelId,
						onClick: props.onToggle
					},
					h('span', { className: 'dsh-am-chevron', 'aria-hidden': 'true' }, expanded ? h(IconChevronDown, { size: 14 }) : h(IconChevronRight, { size: 14 })),
					h(
						'span',
						{ className: 'dsh-am-groupText' },
						h(
							'span',
							{ className: 'dsh-am-groupTitle' },
							h('span', { className: 'dsh-am-groupTitleText', title: group.title }, group.title),
							h('span', { className: 'dsh-am-groupCount' }, format(L.sessionCount, { count }) + ' · ' + size)
						),
						group.path.length > 0 ? h('span', { className: 'dsh-am-groupPath', title: group.path }, group.path) : null
					)
				),
				h('div', { className: 'dsh-am-groupActions' }, actions)
			),
			expanded
				? h(
						'div',
						{ className: 'dsh-am-rows', id: panelId, role: 'list' },
						group.sessions.map((session, index) =>
							h(SessionRow, {
								key: session.id || 'session-' + index,
								session,
								showPath,
								acting: rowActingId === session.id,
								confirming: rowConfirmId === session.id,
								disabled,
								onRestore: () => props.onRestoreRow(session),
								onAskDelete: () => props.onAskDeleteRow(session),
								onConfirmDelete: () => props.onDeleteRow(session),
								onCancelConfirm: props.onCancelConfirm
							})
						)
					)
				: null
		);
	}

	/**
	 * The Settings page.
	 *
	 * It owns no page chrome: the Settings panel already prints the section
	 * label, and the content column scrolls, so the page starts with the compact
	 * summary/refresh toolbar and keeps the old list mounted during refetches.
	 */
	function ArchiveManagerPage() {
		const [phase, setPhase] = React.useState('loading');
		const [data, setData] = React.useState(null);
		const [loadError, setLoadError] = React.useState(null);
		const [actionError, setActionError] = React.useState(null);
		const [refreshing, setRefreshing] = React.useState(false);
		const [busy, setBusy] = React.useState(null);
		const [confirm, setConfirm] = React.useState(null);
		const [query, setQuery] = React.useState('');
		const [projectFilter, setProjectFilter] = React.useState('all');
		const [collapsed, setCollapsed] = React.useState({});

		const dataRef = React.useRef(null);
		const busyRef = React.useRef(null);

		const beginBusy = React.useCallback((next) => {
			busyRef.current = next;
			setBusy(next);
		}, []);
		const endBusy = React.useCallback(() => {
			busyRef.current = null;
			setBusy(null);
		}, []);

		/** Fetch the catalog. A refetch never clears the old list. */
		const load = React.useCallback(async () => {
			const hadData = dataRef.current !== null;
			if (hadData) setRefreshing(true);
			else setPhase('loading');
			setLoadError(null);
			setActionError(null);
			setConfirm(null);
			const result = await call('list', {});
			if (hadData) setRefreshing(false);
			if (result.ok !== true) {
				setLoadError(errorText(result));
				if (!hadData) setPhase('error');
				return result;
			}
			const value = result.value === null || result.value === void 0 ? {} : result.value;
			dataRef.current = value;
			setData(value);
			setPhase('ready');
			return result;
		}, []);

		/** Human label of a session id, for per-item failure messages. */
		const sessionLabel = React.useCallback((id) => {
			const current = dataRef.current;
			if (current !== null && current !== void 0 && typeof current === 'object') {
				const sessions = [];
				for (const project of Array.isArray(current.projects) ? current.projects : []) {
					if (project && Array.isArray(project.sessions)) {
						for (const session of project.sessions) sessions.push(session);
					}
				}
				const ungrouped = current.ungrouped;
				if (ungrouped && Array.isArray(ungrouped.sessions)) {
					for (const session of ungrouped.sessions) sessions.push(session);
				}
				const found = sessions.find((session) => session && session.id === id);
				if (found) return sessionTitle(found);
			}
			return typeof id === 'string' && id.length > 0 ? id : L.unnamed;
		}, []);

		/** Localized text for one host failure: its per-item code wins over the raw message. */
		const failureText = React.useCallback((item) => {
			const code = item !== null && item !== void 0 && typeof item.code === 'string' ? item.code : '';
			if (code === 'live') return L.failLive;
			if (code === 'not-archived') return L.failNotArchived;
			if (code === 'malformed') return L.failMalformed;
			return item !== null && item !== void 0 && typeof item.message === 'string' ? item.message : L.unavailable;
		}, []);

		const restoreSessions = React.useCallback(
			async (ids, busyInfo) => {
				const targets = Array.from(
					new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id.length > 0))
				);
				if (targets.length === 0 || busyRef.current !== null) return;
				const info = busyInfo && typeof busyInfo === 'object' ? busyInfo : { kind: 'row', key: ROW_PREFIX + targets[0] };
				beginBusy(info);
				setActionError(null);
				const failed = [];
				for (const id of targets) {
					const result = await call('restore', { sessionId: id });
					if (result.ok !== true) failed.push({ sessionId: id, message: errorText(result) });
				}
				await load();
				endBusy();
				if (failed.length > 0) {
					setActionError({
						message: format(L.restoreFailed, { count: failed.length }),
						details: failed.slice(0, 3).map((item) => sessionLabel(item.sessionId) + (zhActive ? '：' : ': ') + failureText(item)),
						more: Math.max(0, failed.length - 3),
						retry: { kind: 'restore', ids: failed.map((item) => item.sessionId), busyInfo: info }
					});
				}
			},
			[beginBusy, endBusy, failureText, load, sessionLabel]
		);

		const deleteSessions = React.useCallback(
			async (ids, busyInfo) => {
				const targets = Array.from(
					new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id.length > 0))
				);
				if (targets.length === 0 || busyRef.current !== null) return;
				const info = busyInfo && typeof busyInfo === 'object' ? busyInfo : { kind: 'row', key: ROW_PREFIX + targets[0] };
				beginBusy(info);
				setActionError(null);
				setConfirm(null);
				const result = await call('delete', { sessionIds: targets });
				let failure = null;
				let succeeded = 0;
				if (result.ok !== true) {
					failure = {
						message: errorText(result),
						details: [],
						more: 0,
						retry: { kind: 'delete', ids: targets, busyInfo: info }
					};
				} else {
					const value = result.value !== null && typeof result.value === 'object' ? result.value : {};
					const deleted = Array.isArray(value.deleted) ? value.deleted : [];
					const failed = Array.isArray(value.failed) ? value.failed : [];
					succeeded = deleted.length;
					if (failed.length > 0) {
						const failedIds = failed
							.map((entry) => (entry && typeof entry.sessionId === 'string' ? entry.sessionId : ''))
							.filter((id) => id.length > 0);
						failure = {
							message: format(L.deleteFailed, { count: failed.length }),
							details: failed.slice(0, 3).map((entry) => {
								const id = entry && typeof entry.sessionId === 'string' ? entry.sessionId : '';
								return sessionLabel(id) + (zhActive ? '：' : ': ') + failureText(entry);
							}),
							more: Math.max(0, failed.length - 3),
							retry: failedIds.length > 0 ? { kind: 'delete', ids: failedIds, busyInfo: info } : null
						};
					}
				}
				if (succeeded > 0) await load();
				endBusy();
				if (failure !== null) setActionError(failure);
			},
			[beginBusy, endBusy, load, sessionLabel]
		);

		const retryAction = React.useCallback(() => {
			const failure = actionError;
			if (!failure || !failure.retry) return;
			if (failure.retry.kind === 'restore') void restoreSessions(failure.retry.ids, failure.retry.busyInfo);
			else if (failure.retry.kind === 'delete') void deleteSessions(failure.retry.ids, failure.retry.busyInfo);
		}, [actionError, restoreSessions, deleteSessions]);

		const clearFilters = React.useCallback(() => {
			setQuery('');
			setProjectFilter('all');
			setConfirm(null);
		}, []);

		/* First data load. */
		React.useEffect(() => {
			void load();
		}, [load]);

		/* Debug handle keeps a live page refresh when the section is mounted. */
		React.useEffect(() => {
			const refresh = () => load();
			pageRefresh = refresh;
			return () => {
				if (pageRefresh === refresh) pageRefresh = null;
			};
		}, [load]);

		const normalizedQuery = query.trim().toLowerCase();

		/* A filter change cancels an inline confirmation and re-expands the list,
		 * so a confirmation can never point at a row that is no longer visible. */
		React.useEffect(() => {
			setConfirm(null);
			setCollapsed({});
		}, [normalizedQuery, projectFilter]);

		/* A project that vanished from the new listing cannot stay selected. */
		React.useEffect(() => {
			if (data === null || projectFilter === 'all') return;
			const groups = collectGroups(data);
			if (!groups.some((group) => group.key === projectFilter)) setProjectFilter('all');
		}, [data, projectFilter]);

		const allGroups = data === null ? [] : collectGroups(data);
		const groups = filterGroups(allGroups, normalizedQuery, projectFilter);
		const counted = countSessions(allGroups);
		const totalCount = data !== null && typeof data.total === 'number' && data.total >= 0 ? data.total : counted;
		const totalSize = data !== null && typeof data.bytes === 'number' && data.bytes >= 0 ? data.bytes : totalBytes(allGroups);
		const visibleCount = countSessions(groups);
		const filtering = normalizedQuery.length > 0 || projectFilter !== 'all';
		const anyBusy = busy !== null;
		const blocked = anyBusy || refreshing;
		const firstLoading = phase === 'loading' && data === null;
		const showControls = data !== null && allGroups.length > 0;

		const summary = format(filtering ? L.summaryFiltered : L.summary, {
			total: totalCount,
			bytes: formatBytes(totalSize),
			shown: visibleCount
		});

		const chips = [];
		chips.push(
			h(
				'button',
				{
					key: 'all',
					type: 'button',
					className: 'dsh-am-chip',
					'data-active': projectFilter === 'all' ? 'true' : 'false',
					'aria-pressed': projectFilter === 'all',
					onClick: () => setProjectFilter('all')
				},
				h('span', { className: 'dsh-am-chipLabel', title: L.all }, L.all + ' (' + counted + ')')
			)
		);
		for (const group of allGroups) {
			const active = projectFilter === group.key;
			chips.push(
				h(
					'button',
					{
						key: group.key,
						type: 'button',
						className: 'dsh-am-chip',
						'data-active': active ? 'true' : 'false',
						'aria-pressed': active,
						onClick: () => setProjectFilter(group.key)
					},
					h('span', { className: 'dsh-am-chipLabel', title: group.title }, group.title + ' (' + group.sessions.length + ')')
				)
			);
		}

		const groupElements = groups.map((group, index) => {
			const groupActing = busy !== null && busy.kind === 'group' && busy.key === group.key;
			const rowActingId =
				busy !== null && busy.kind === 'row' && typeof busy.key === 'string' && busy.key.indexOf(ROW_PREFIX) === 0
					? busy.key.slice(ROW_PREFIX.length)
					: null;
			const groupConfirm = confirm !== null && confirm.kind === 'group' && confirm.key === group.key;
			const rowConfirmId = confirm !== null && confirm.kind === 'row' ? confirm.key : null;
			const panelId = 'dsh-am-group-panel-' + index;
			const ids = group.sessions.map((session) => session.id);
			return h(ArchiveGroup, {
				key: group.key,
				group,
				panelId,
				expanded: collapsed[group.key] !== true,
				showPath: group.ungrouped || (normalizedQuery.length > 0 && projectFilter === 'all'),
				groupActing,
				rowActingId,
				groupConfirm,
				rowConfirmId,
				disabled: blocked,
				onToggle: () =>
					setCollapsed((current) => {
						const next = Object.assign({}, current);
						if (current[group.key] === true) delete next[group.key];
						else next[group.key] = true;
						return next;
					}),
				onRestoreAll: () => {
					void restoreSessions(ids, { kind: 'group', key: group.key });
				},
				onAskDeleteAll: () => setConfirm({ kind: 'group', key: group.key }),
				onDeleteAll: () => {
					void deleteSessions(ids, { kind: 'group', key: group.key });
				},
				onCancelConfirm: () => setConfirm(null),
				onRestoreRow: (session) => {
					void restoreSessions([session.id], { kind: 'row', key: ROW_PREFIX + session.id });
				},
				onAskDeleteRow: (session) => setConfirm({ kind: 'row', key: session.id }),
				onDeleteRow: (session) => {
					void deleteSessions([session.id], { kind: 'row', key: ROW_PREFIX + session.id });
				}
			});
		});

		let body = null;
		if (firstLoading) {
			body = h(LoadingSkeleton);
		} else if (data !== null) {
			if (counted === 0 || totalCount === 0) {
				body = h(
					'div',
					{ className: 'dsh-am-empty' },
					h('span', { className: 'dsh-am-emptyGlyph', 'aria-hidden': 'true' }, h(IconArchive, { size: 28 })),
					h('div', { className: 'dsh-am-emptyTitle' }, L.emptyTitle),
					h('div', { className: 'dsh-am-emptyBody' }, L.emptyBody)
				);
			} else if (groups.length === 0) {
				body = h(
					'div',
					{ className: 'dsh-am-empty' },
					h('span', { className: 'dsh-am-emptyGlyph', 'aria-hidden': 'true' }, h(IconSearch, { size: 26 })),
					h('div', { className: 'dsh-am-emptyTitle' }, L.noMatchTitle),
					h('div', { className: 'dsh-am-emptyBody' }, L.noMatchBody),
					h(
						'div',
						{ className: 'dsh-am-emptyActions' },
						h(Button, { variant: 'outline', size: 'sm', onClick: clearFilters }, L.clearFilters)
					)
				);
			} else {
				body = h('div', { className: 'dsh-am-groups' }, groupElements);
			}
		}

		return h(
			'div',
			{
				className: 'dsh-am-page',
				'data-testid': 'archive-manager-page',
				'aria-busy': anyBusy || refreshing ? true : void 0
			},
			h(
				'div',
				{ className: 'dsh-am-toolbar' },
				h(
					'div',
					{ className: 'dsh-am-summary' },
					data === null ? (phase === 'error' ? L.loadFailed : L.loading) : summary,
					refreshing ? h('span', { className: 'dsh-am-refreshing', role: 'status' }, h(Spinner, { size: 12 }), L.refreshing) : null
				),
				h(
					'div',
					{ className: 'dsh-am-toolbarActions' },
					h(
						Button,
						{
							variant: 'outline',
							size: 'sm',
							className: 'dsh-am-refresh',
							icon: refreshing ? h(Spinner, { size: 13 }) : h(IconRefresh, { size: 13 }),
							disabled: firstLoading || refreshing || anyBusy,
							onClick: () => {
								void load();
							}
						},
						L.refresh
					)
				)
			),
			showControls
				? h(
						'div',
						{ className: 'dsh-am-controls' },
						h(
							'label',
							{ className: 'dsh-am-search' },
							h(IconSearch, { size: 14 }),
							h('input', {
								type: 'search',
								value: query,
								placeholder: L.search,
								'aria-label': L.search,
								onChange: (event) => setQuery(event.target.value)
							}),
							query.length > 0
								? h(
										'button',
										{
											type: 'button',
											className: 'dsh-am-searchClear',
											'aria-label': L.clearSearch,
											onClick: () => setQuery('')
										},
										h(IconClose, { size: 13 })
									)
								: null
						),
						h('div', { className: 'dsh-am-chips', role: 'group', 'aria-label': L.projectFilterLabel }, chips)
					)
				: null,
			loadError !== null
				? h(Notice, {
						key: 'load-error',
						tone: 'error',
						message: L.loadFailed + ' — ' + loadError,
						onRetry: () => {
							void load();
						}
					})
				: null,
			actionError !== null
				? h(Notice, {
						key: 'action-error',
						tone: 'error',
						message: actionError.message,
						details: actionError.details,
						more: actionError.more,
						onRetry: actionError.retry ? retryAction : null
					})
				: null,
			body
		);
	}

	/* ────────────────────────────────────────────────────────────────────────
	 * Plugin body
	 * ──────────────────────────────────────────────────────────────────────── */

	/** Cordis client services this feature needs: the slot registry, nothing more. */
	const inject = ['slots'];

	/**
	 * Debug handle for the Lead's browser verification. `refresh` drives the
	 * mounted page (or falls back to a raw list call); `list` returns the raw
	 * envelope so it can be inspected from the console.
	 */
	let pageRefresh = null;

	function exposeDebugApi() {
		if (typeof window === 'undefined') return () => {};
		const api = {
			refresh: () => {
				if (typeof pageRefresh === 'function') {
					try {
						return Promise.resolve(pageRefresh());
					} catch (error) {
						return call('list', {});
					}
				}
				return call('list', {});
			},
			list: () => call('list', {})
		};
		window.__DSH_ARCHIVE_MANAGER__ = api;
		return () => {
			if (window.__DSH_ARCHIVE_MANAGER__ === api) delete window.__DSH_ARCHIVE_MANAGER__;
		};
	}

	/**
	 * Browser plugin body.
	 * @param ctx - client root context.
	 */
	function apply(ctx) {
		try {
			zhActive = detectZh(ctx);
			ctx.slots.inject('settings.section', () =>
				ctx.slots.register(
					{ name: 'settings.section', id: 'archive-manager', order: 35, label: () => L.nav },
					ArchiveManagerPage
				)
			);
			ctx.effect(() => insertStyles(), 'archive-manager: stylesheet');
			ctx.effect(() => exposeDebugApi(), 'archive-manager: debug handle');
		} catch (error) {
			console.error('[archive-manager] activation failed:', error);
		}
	}

	exports.ArchiveManagerPage = ArchiveManagerPage;
	exports.apply = apply;
	exports.inject = inject;
	return module.exports;
}
