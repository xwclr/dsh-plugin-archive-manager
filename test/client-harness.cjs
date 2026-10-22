'use strict';

/**
 * Skill Manager — browser-half harness.
 *
 * Loads `lib/client.js` the way the Web shell does (a page-global module facade
 * handing the factory a `require`), then drives the page with a small but real
 * React: hooks keep their state across renders, `setState` schedules a re-render,
 * and effects run to quiescence. That is the part worth testing, because the
 * page's whole job is an asynchronous round trip — load, mutate, reload — and a
 * one-pass renderer would only prove the loading state exists.
 *
 * The reconciler is not React. It evaluates function components and host
 * elements and ignores the DOM; className strings, props and handlers are all
 * preserved, which is what the assertions read.
 *
 * Run with `node test/client-harness.cjs`.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const BUNDLE = path.join(__dirname, '..', 'lib', 'client.js');

/* ── a small React ───────────────────────────────────────────────────────── */

/**
 * Build a React stand-in with persistent hook state and a synchronous render
 * loop.
 * @returns the runtime: the `react` module face, a `render` entry point, and
 *   test hooks for draining effects and inspecting the last tree.
 */
function createRuntime() {
	/** Component instances keyed by their position in the tree. */
	let instances = new Map();
	let path_ = [];
	let rendering = null;
	let pending = false;
	let flushDepth = 0;
	const effectQueue = [];
	let lastTree = null;
	/** The component and props the current instance tree belongs to. */
	let root = null;

	const React = {
		createElement(type, props, ...children) {
			const merged = { ...(props === null || props === void 0 ? {} : props) };
			const meaningful = children.filter((child) => child !== void 0);
			if (meaningful.length > 0 && merged.children === void 0) merged.children = meaningful.length === 1 ? meaningful[0] : meaningful;
			return { kind: 'element', type, props: merged };
		},
		Fragment: Symbol('Fragment'),
		useState(initial) {
			const hook = slot();
			if (!Object.hasOwn(hook, 'value')) hook.value = typeof initial === 'function' ? initial() : initial;
			if (hook.set === void 0) {
				hook.set = (next) => {
					const value = typeof next === 'function' ? next(hook.value) : next;
					if (Object.is(value, hook.value)) return;
					hook.value = value;
					schedule();
				};
			}
			return [hook.value, hook.set];
		},
		useRef(initial) {
			const hook = slot();
			if (!Object.hasOwn(hook, 'value')) hook.value = { current: initial };
			return hook.value;
		},
		useCallback(fn, deps) {
			const hook = slot();
			if (!Object.hasOwn(hook, 'value') || !sameDeps(hook.deps, deps)) {
				hook.value = fn;
				hook.deps = deps;
			}
			return hook.value;
		},
		useMemo(fn, deps) {
			const hook = slot();
			if (!Object.hasOwn(hook, 'value') || !sameDeps(hook.deps, deps)) {
				hook.value = fn();
				hook.deps = deps;
			}
			return hook.value;
		},
		useEffect(fn, deps) {
			const hook = slot();
			if (!Object.hasOwn(hook, 'value') || !sameDeps(hook.deps, deps)) {
				hook.value = fn;
				hook.deps = deps;
				effectQueue.push(fn);
			}
		}
	};

	/** The hook slot at the current position. */
	function slot() {
		const instance = rendering;
		const index = instance.cursor;
		instance.cursor += 1;
		instance.hooks[index] = instance.hooks[index] || {};
		return instance.hooks[index];
	}

	/** React's dependency comparison. */
	function sameDeps(left, right) {
		if (left === void 0 || right === void 0) return false;
		if (left.length !== right.length) return false;
		return left.every((value, index) => Object.is(value, right[index]));
	}

	/** Mark that a state change wants a re-render. */
	function schedule() {
		pending = true;
	}

	/**
	 * Evaluate one element tree.
	 * @param node - the element (or primitive) to evaluate.
	 * @param key - this node's identity path.
	 * @returns the evaluated tree: host elements keep their type and props, with
	 *   `children` evaluated.
	 */
	function evaluate(node, key) {
		if (node === null || node === void 0 || typeof node === 'boolean') return null;
		if (typeof node === 'string' || typeof node === 'number') return node;
		if (Array.isArray(node)) return node.map((child, index) => evaluate(child, `${key}.${index}`));
		if (typeof node !== 'object' || node.kind !== 'element') return null;
		const { type, props } = node;
		if (type === React.Fragment) return evaluate(props.children, `${key}:f`);
		if (typeof type === 'function') {
			const instance = instances.get(key) || { hooks: [], cursor: 0 };
			instances.set(key, instance);
			const previousRendering = rendering;
			const previousPath = path_;
			rendering = instance;
			path_ = [...path_, key];
			instance.cursor = 0;
			let output;
			try {
				output = type(props);
			} finally {
				rendering = previousRendering;
				path_ = previousPath;
			}
			return { kind: 'component', name: type.name || 'anonymous', props, children: evaluate(output, `${key}>`) };
		}
		return {
			kind: 'host',
			type,
			props,
			children: evaluate(props.children, `${key}<${String(type)}`)
		};
	}

	/**
	 * Render a component and settle: effects run, state updates re-render, and
	 * the loop stops when nothing is left pending.
	 * @param Component - the root component.
	 * @param props - its props.
	 * @param options - `async: true` also drains microtasks between passes.
	 * @returns the last evaluated tree.
	 */
	async function render(Component, props, options) {
		root = { Component, props };
		instances = new Map();
		lastTree = null;
		await flush(options);
		return lastTree;
	}

	/**
	 * Run render passes until nothing is pending.
	 *
	 * State updates made after the initial render — a click handler, a resolved
	 * host call — set the pending flag and are picked up by the next flush. That
	 * is the whole loop: render, settle async work, run effects, repeat.
	 * @param options - `async: false` skips the settling waits.
	 */
	async function flush(options) {
		if (root === null) return lastTree;
		const async_ = options === void 0 ? true : options.async !== false;
		pending = true;
		for (let pass = 0; pass < 40; pass += 1) {
			pending = false;
			lastTree = evaluate(React.createElement(root.Component, root.props), 'root');
			/* A host call resolves through several microtask ticks (fetch,
			 * .json(), the setState), so a macrotask turn is the settle point. */
			if (async_) await settle();
			await drainEffects();
			if (async_) await settle();
			if (!pending && effectQueue.length === 0) break;
		}
		return lastTree;
	}

	/** Let every queued microtask and one macrotask turn complete. */
	async function settle() {
		for (let index = 0; index < 8; index += 1) await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
		for (let index = 0; index < 8; index += 1) await Promise.resolve();
	}

	/** Run queued effects; a returned cleanup is stored for the next run. */
	async function drainEffects() {
		if (flushDepth > 4) return;
		flushDepth += 1;
		try {
			let guard = 0;
			while (effectQueue.length > 0 && guard < 60) {
				guard += 1;
				const effect = effectQueue.shift();
				const cleanup = effect();
				if (typeof cleanup === 'function') cleanup();
				await Promise.resolve();
			}
		} finally {
			flushDepth -= 1;
		}
	}

	return { React, render, flush, getTree: () => lastTree };
}

/* ── tree helpers ────────────────────────────────────────────────────────── */

/** Every node in an evaluated tree, depth first. */
function* walk(node) {
	if (node === null || node === void 0 || typeof node === 'boolean') return;
	if (typeof node === 'string' || typeof node === 'number') return;
	if (Array.isArray(node)) {
		for (const child of node) yield* walk(child);
		return;
	}
	yield node;
	yield* walk(node.children);
}

/** Every node matching a predicate. */
function findAll(tree, predicate) {
	const found = [];
	for (const node of walk(tree)) if (predicate(node)) found.push(node);
	return found;
}

/** All visible text in a subtree. */
function textOf(node) {
	if (node === null || node === void 0 || typeof node === 'boolean') return '';
	if (typeof node === 'string' || typeof node === 'number') return String(node);
	if (Array.isArray(node)) return node.map(textOf).join('');
	if (typeof node === 'object') return textOf(node.children);
	return '';
}

/** Nodes carrying a `data-skill` attribute. */
const skillNodes = (tree) => findAll(tree, (node) => node.kind === 'host' && node.props && typeof node.props['data-skill'] === 'string');

/** The switch control inside one skill row. */
function switchIn(row) {
	const found = findAll(row, (node) => node.kind === 'host' && node.props && node.props.role === 'switch');
	assert.equal(found.length, 1, `expected one switch in the row for ${row.props['data-skill']}`);
	return found[0];
}

/** Find one element by a prop value. */
const byProp = (tree, key, value) => findAll(tree, (node) => node.kind === 'host' && node.props && node.props[key] === value);

/* ── fixtures ────────────────────────────────────────────────────────────── */

/** The fake design system: every primitive records its name. */
function fakeDesign(React) {
	const inert = (name) => {
		const Component = (props) => React.createElement('span', { 'data-primitive': name, 'data-size': props && props.size });
		Component.displayName = name;
		return Component;
	};
	const design = {};
	for (const name of [
		'IconSkillOutlineRegular',
		'IconTrashOutlineRegular',
		'IconPlusOutlineRegular',
		'IconRefreshOutlineRegular',
		'IconSearchOutlineRegular',
		'IconChevronDownOutlineRegular',
		'IconCheckOutlineRegular',
		'IconWarningTriangleOutlineRegular',
		'IconInfoOutlineRegular',
		'IconCloseOutlineRegular',
		'IconEllipsisOutlineRegular',
		'IconGlobeOutlineRegular',
		'IconFolderOpenOutlineRegular',
		'IconLoadingOutlineRegular',
		'IconBrowseOutlineRegular'
	]) {
		design[name] = inert(name);
	}
	design.Button = function Button(props) {
		return React.createElement('button', { 'data-primitive': 'Button', disabled: props.disabled, onClick: props.onClick }, props.children);
	};
	design.Switch = function Switch(props) {
		return React.createElement(
			'button',
			{ 'data-primitive': 'Switch', role: 'switch', 'aria-checked': props.checked, 'aria-label': props.label, disabled: props.disabled, onClick: () => props.onChange(!props.checked) },
			props.checked ? 'on' : 'off'
		);
	};
	return design;
}

/** A skill row fixture. */
function skill(name, overrides) {
	return {
		name,
		description: `${name} description`,
		heading: name,
		entry: name,
		entryPath: `/home/u/.dsh/skills/${name}`,
		file: `/home/u/.dsh/skills/${name}/SKILL.md`,
		directory: true,
		scope: 'global',
		source: 'user-dsh',
		enabled: true,
		parked: false,
		bytes: 100,
		discovered: true,
		problem: void 0,
		...overrides
	};
}

const sample = {
	home: '/home/u/.dsh',
	workspacePath: '/work/proj',
	roots: [
		{ scope: 'project', path: '/work/proj/.dsh/skills', source: 'project-dsh', exists: true },
		{ scope: 'global', path: '/home/u/.dsh/skills', source: 'user-dsh', exists: true }
	],
	skills: [
		skill('alpha-skill', { description: 'Does alpha things.' }),
		skill('beta-skill', {
			entry: 'beta-skill.md.disabled',
			entryPath: '/home/u/.dsh/skills/beta-skill.md',
			file: '/home/u/.dsh/skills/beta-skill.md.disabled',
			directory: false,
			enabled: false,
			parked: true,
			discovered: false
		}),
		skill('broken-skill', { description: '', heading: void 0, discovered: false, problem: 'frontmatter is missing the required "name" field' })
	]
};

/* ── the harness ─────────────────────────────────────────────────────────── */

const cases = [];
const test = (name, body) => cases.push({ name, body });

async function main() {
	const runtime = createRuntime();
	const { React, render } = runtime;

	/** One recorded API request. */
	const requests = [];
	/** Queued answers, by method. A function receives the payload. */
	const answers = new Map();
	/** Recorded `/archive-manager/api` requests. */
	const archiveRequests = [];
	/** Queued archive answers, by method. A function receives the payload. */
	const archiveAnswers = new Map();

	/** A canned archive catalog: two projects, one lost log, one untitled session. */
	const sampleArchive = {
		home: '/home/u/.dsh',
		total: 3,
		bytes: 3072,
		projects: [
			{
				id: 'p-other',
				title: 'other',
				path: '/Users/u/work/other',
				total: 2,
				bytes: 3072,
				sessions: [
					{
						id: 'session-aaaaaaaa-1111-4222-8333-444444444444',
						title: '归档的会话 A',
						cwd: '/Users/u/work/other',
						createdAt: 1000,
						archivedAt: Date.now() - 86_400_000,
						bytes: 2048,
						directory: '/home/u/.dsh/sessions/a/session-aaaaaaaa-1111-4222-8333-444444444444',
						exists: true,
						live: true,
						running: true
					},
					{
						id: 'session-bbbbbbbb-1111-4222-8333-444444444444',
						title: '',
						cwd: '/Users/u/work/other',
						createdAt: 2000,
						archivedAt: Date.now() - 3_600_000,
						bytes: 1024,
						directory: '/home/u/.dsh/sessions/a/session-bbbbbbbb-1111-4222-8333-444444444444',
						exists: true,
						live: true,
						running: false
					}
				]
			},
			{
				id: 'p-kd',
				title: '金蝶套件',
				path: '/Users/u/work/kd',
				total: 1,
				bytes: 0,
				sessions: [
					{
						id: 'session-cccccccc-1111-4222-8333-444444444444',
						title: '日志已经不在的会话',
						cwd: '/Users/u/work/kd',
						createdAt: 3000,
						archivedAt: 0,
						bytes: 0,
						directory: '',
						exists: false,
						live: false,
						running: false
					}
				]
			}
		],
		ungrouped: { total: 0, bytes: 0, sessions: [] }
	};

	/** The default answer for an archive method. */
	const archiveDefaultAnswer = (method) => {
		if (method === 'list') return { ok: true, value: sampleArchive };
		if (method === 'restore') return { ok: true, value: { restored: [] } };
		if (method === 'delete') return { ok: true, value: { deleted: [], failed: [], bytes: 0 } };
		return { ok: true, value: {} };
	};

	/** The default answer for a method. */
	const defaultAnswer = (method) => {
		if (method === 'list') return { ok: true, value: sample };
		if (method === 'toggle') return { ok: true, value: { changed: true } };
		if (method === 'remove') return { ok: true, value: { removed: '/x', directory: true } };
		if (method === 'create') return { ok: true, value: { name: 'new-skill' } };
		if (method === 'import') return { ok: true, value: { imported: [{ name: 'imported-skill' }], shadowed: [] } };
		return { ok: true, value: {} };
	};

	/**
	 * Build a browser-like sandbox whose `fetch` records every call.
	 * @param options - `posted` collects raw `{url, body, respond}` records for
	 *   routes that are not plugin API methods (the reveal launch, notably).
	 * @returns the sandbox object.
	 */
	function buildSandbox(options) {
		const settings = options === void 0 ? {} : options;
		const posted = Array.isArray(settings.posted) ? settings.posted : [];
		return {
			document: {
				documentElement: { getAttribute: () => 'zh-CN', setAttribute: () => {}, style: {} },
				head: { appendChild: () => {} },
				body: { appendChild: () => {}, removeChild: () => {} },
				createElement: () => ({ dataset: {}, style: {}, remove: () => {}, select: () => {} }),
				addEventListener: () => {},
				removeEventListener: () => {},
				execCommand: () => true,
				/* The bundled workspace-colors feature decorates rows; the
				 * sandbox has no DOM, so it must find an empty document rather
				 * than throw during activation. */
				querySelector: () => null,
				querySelectorAll: () => []
			},
			MutationObserver: class {
				observe() {}
				disconnect() {}
				takeRecords() {
					return [];
				}
			},
			innerWidth: 1280,
			innerHeight: 800,
			addEventListener: () => {},
			removeEventListener: () => {},
			localStorage: {
				getItem: () => null,
				setItem: () => {},
				removeItem: () => {}
			},
			navigator: { language: 'zh-CN', clipboard: void 0 },
			console: { log: () => {}, info: () => {}, warn: () => {}, error: () => {} },
			fetch: async (url, init) => {
				const target = String(url);
				const payload = init && init.body ? JSON.parse(init.body) : {};
				if (target.startsWith('/archive-manager/api')) {
					const method = target.split('/').pop();
					archiveRequests.push({ method, payload });
					const queued = archiveAnswers.has(method) ? archiveAnswers.get(method) : archiveDefaultAnswer(method);
					const envelope = typeof queued === 'function' ? queued(payload) : queued;
					return { status: 200, json: async () => (envelope && typeof envelope.then === 'function' ? envelope : envelope) };
				}
				/* A non-API route is a launch request: record it raw and answer with
				 * the scripted response, so tests can assert the exact wire shape. */
				if (!target.startsWith('/skill-manager/api')) {
					const record = { url: target, body: payload };
					posted.push(record);
					return { status: 200, ok: true, json: async () => ({ ok: true }) };
				}
				const method = target.split('/').pop();
				requests.push({ method, payload });
				const queued = answers.has(method) ? answers.get(method) : defaultAnswer(method);
				const envelope = typeof queued === 'function' ? queued(payload) : queued;
				return { status: 200, json: async () => (envelope && typeof envelope.then === 'function' ? envelope : envelope) };
			},
			setTimeout,
			clearTimeout,
			Promise,
			JSON,
			Object,
			Array,
			String,
			Number,
			Boolean,
			Error,
			Math,
			Date,
			Symbol,
			RegExp,
			Map,
			Set
		};
	}

	let sandbox = buildSandbox();
	sandbox.globalThis = sandbox;
	sandbox.window = sandbox;

	/** Load the bundle into a sandbox and return the page it registers. */
	function loadBundle(sandbox) {
		let registered = null;
		sandbox.__ModuleLoader__ = {
			load(definition) {
				registered = definition;
			}
		};
		const context = vm.createContext(sandbox);
		vm.runInContext(fs.readFileSync(BUNDLE, 'utf8'), context, { filename: 'client.js' });
		assert.ok(registered !== null, 'the bundle must register itself on the module facade');
		assert.equal(registered.id, 'dsh-plugin-archive-manager');
		const design = fakeDesign(React);
		return registered.factory((name) => {
			if (name === 'react') return React;
			if (name === '@deepseek-ai/dsh-client-ui-primitives') return design;
			throw new Error(`unexpected require: ${name}`);
		});
	}

	let bundle = loadBundle(sandbox);

	/** Render the page with one set of seats and data. */
	async function page(options) {
		const settings = options === void 0 ? {} : options;
		if (settings.answers !== void 0) {
			for (const [method, value] of Object.entries(settings.answers)) answers.set(method, value);
		} else {
			answers.clear();
		}
		requests.length = 0;
		const workspaces = settings.workspaces === void 0 ? [] : settings.workspaces;
		const sessions = settings.sessions === void 0 ? { byId: {} } : settings.sessions;
		return render(bundle.SkillManagerPage, {
			useWorkspaces: (selector) => (typeof selector === 'function' ? selector({ items: workspaces }) : { items: workspaces }),
			useSessions: (selector) => (typeof selector === 'function' ? selector(sessions) : sessions),
			pickDirectory: settings.pickDirectory === void 0 ? async () => null : settings.pickDirectory,
			openPath:
				settings.openPath === void 0
					? (target) => {
							const record = { url: '/open-in-app/open', body: { app: 'finder', path: target } };
							if (typeof settings.launches === 'object' && settings.launches !== null && typeof settings.launches.push === 'function') settings.launches.push(record);
							return Promise.resolve({ ok: true });
						}
					: settings.openPath,
			detectLanguage: () => (settings.zh === void 0 ? true : settings.zh)
		});
	}

	/** Render the archived-sessions page with one set of canned answers. */
	async function archivePage(options) {
		const settings = options === void 0 ? {} : options;
		archiveAnswers.clear();
		if (settings.answers !== void 0) {
			for (const [method, value] of Object.entries(settings.answers)) archiveAnswers.set(method, value);
		}
		archiveRequests.length = 0;
		return render(bundle.ArchiveManagerPage, {});
	}

	/** Host buttons whose visible text is exactly `label`. */
	const buttonsLabelled = (tree, label) =>
		findAll(
			tree,
			(node) => node.kind === 'host' && node.props && typeof node.props.onClick === 'function' && textOf(node) === label
		);

	/* ── registration ─────────────────────────────────────────────────────── */

	test('exports apply, a short inject list, and both components', () => {
		assert.equal(typeof bundle.apply, 'function');
		assert.deepEqual(Array.from(bundle.inject), ['slots', 'remote', 'uiWorkspace']);
		assert.equal(typeof bundle.SkillManagerPage, 'function');
		assert.equal(typeof bundle.SkillManagerIcon, 'function');
	});

	test('registers the sidebar entry below the shipped rows and a matching panel', () => {
		const registrations = [];
		const injected = [];
		bundle.apply({
			get: () => void 0,
			effect: (callback) => callback(),
			slots: {
				inject(key, callback) {
					injected.push(key);
					callback();
					return () => {};
				},
				register(options, component) {
					registrations.push({ options, component });
					return () => {};
				}
			}
		});
		for (const key of ['main', 'sidebar.panellist', 'shell.overlay', 'settings.section', 'sidebar.workspaces.session.menu.item']) {
			assert.ok(injected.includes(key), `${key} must be injected`);
		}
		/* The bundled workspace-colors feature activates too and publishes its
		 * debug handle, which is the only place the palette catalogue is visible
		 * without a DOM. */
		const colorsApi = sandbox.__DSH_WORKSPACE_COLORS__;
		assert.ok(colorsApi !== void 0, 'the colors feature must expose its debug handle');
		assert.equal(colorsApi.colors.length, 10, 'ten workspace colours');
		for (const id of ['teal', 'pink', 'brown']) {
			assert.ok(colorsApi.colors.includes(id), `${id} must be offered`);
		}
		assert.equal(colorsApi.colors[0], 'grey', 'the palette keeps its order');
		assert.equal(colorsApi.icons.length, 24, 'twenty-four workspace icons');
		for (const id of ['folder', 'terminal', 'branch', 'shield']) {
			assert.ok(colorsApi.icons.includes(id), `${id} must be offered`);
		}
		assert.equal(typeof colorsApi.setIcon, 'function', 'the icon choice is writable');
		colorsApi.setIcon('workspace:test', 'terminal');
		assert.equal(colorsApi.getIcon('workspace:test'), 'terminal', 'the icon choice round-trips');
		colorsApi.setIcon('workspace:test', null);
		assert.equal(colorsApi.getIcon('workspace:test'), null, 'clearing the icon works');
		const sidebar = registrations.find((entry) => entry.options.name === 'sidebar.panellist');
		const panel = registrations.find((entry) => entry.options.name === 'main');
		assert.ok(sidebar !== void 0, 'the sidebar entry must be registered');
		assert.equal(sidebar.options.id, 'skills');
		/* Plugins is 0 and Automation tasks is 10; the requirement is below both. */
		assert.ok(sidebar.options.order > 10, `expected an order below the shipped rows, got ${sidebar.options.order}`);
		assert.equal(sidebar.options.label(), '技能');
		assert.ok(panel !== void 0, 'the main panel must be registered');
		assert.equal(panel.options.key, sidebar.options.id);
	});

	/* ── rendering ────────────────────────────────────────────────────────── */

	test('renders every skill, grouped, with a switch per row', async () => {
		const tree = await page();
		assert.equal(requests.filter((request) => request.method === 'list').length, 1, 'the page loads once');
		const rows = skillNodes(tree);
		/* Order is the page's own: the enabled group first, then the disabled
		 * one, each in the host's order. */
		assert.deepEqual(
			rows.map((row) => row.props['data-skill']),
			['alpha-skill', 'broken-skill', 'beta-skill']
		);
		const text = textOf(tree);
		assert.match(text, /技能/u);
		assert.match(text, /已安装/u);
		assert.match(text, /已停用/u);
		assert.match(text, /无法解析/u);
		assert.match(text, /Does alpha things\./u);
		assert.match(text, /3/u, 'the count must be shown');
		for (const row of rows) switchIn(row);
	});

	test('leaves the window draggable above the content', async () => {
		/* The desktop window is frameless, so the shell's own stylesheet turns
		 * every `[data-window-drag]` element into an app-region drag handle. A
		 * full-page panel must contribute one, or the strip at the top of the
		 * window stops moving it — it becomes a dead band. */
		const tree = await page();
		const drags = findAll(tree, (node) => node.kind === 'host' && node.props && node.props['data-window-drag'] === true);
		assert.ok(drags.length > 0, 'the page must expose at least one drag region');
		const strip = drags.find((node) => node.props.className === 'dsh-skm-titlebar');
		assert.ok(strip !== void 0, 'the pinned title-bar strip must be a drag region');
		assert.equal(strip.props['aria-hidden'], 'true', 'the strip is decorative');
		/* The strip must sit above the scrolling area, not inside it: inside, the
		 * drag band would scroll away and the window would be stuck again. */
		const body = findAll(tree, (node) => node.kind === 'host' && node.props && node.props.className === 'dsh-skm-scroll')[0];
		assert.ok(body !== void 0, 'the scroll container must exist');
		const insideScroll = findAll(body, (node) => node.kind === 'host' && node.props && node.props.className === 'dsh-skm-titlebar').length;
		assert.equal(insideScroll, 0, 'the drag strip must be a sibling of the scroll area, not inside it');
	});

	test('marks row state so the stylesheet can dim a disabled skill', async () => {
		const tree = await page();
		const rows = new Map(skillNodes(tree).map((row) => [row.props['data-skill'], row]));
		assert.equal(rows.get('alpha-skill').props['data-state'], 'on');
		assert.equal(rows.get('beta-skill').props['data-state'], 'off');
		assert.equal(rows.get('broken-skill').props['data-state'], 'broken');
	});

	test('carries the switch state and the parked badge', async () => {
		const tree = await page();
		const rows = new Map(skillNodes(tree).map((row) => [row.props['data-skill'], row]));
		assert.equal(switchIn(rows.get('alpha-skill')).props['aria-checked'], true);
		assert.equal(switchIn(rows.get('beta-skill')).props['aria-checked'], false);
		assert.match(textOf(rows.get('beta-skill')), /beta-skill\.md\.disabled/u, 'the parked path must be visible');
	});

	test('renders the empty state with both actions, and says so in English too', async () => {
		const tree = await page({ answers: { list: { ok: true, value: { ...sample, skills: [] } } } });
		const text = textOf(tree);
		assert.match(text, /尚未安装技能/u);
		assert.match(text, /新建/u);
		/* The empty state now offers both import routes. */
		assert.match(text, /从磁盘导入/u);
		assert.match(text, /导入外部 Agent 技能/u);
		const english = await page({ zh: false, answers: { list: { ok: true, value: { ...sample, skills: [] } } } });
		assert.match(textOf(english), /No skills installed/u);
		assert.match(textOf(english), /Import from disk/u);
		assert.match(textOf(english), /Import external agent skills/u);
	});

	test('renders an error with a retry, not a blank page', async () => {
		answers.set('list', { ok: false, error: { message: 'host exploded' } });
		const tree = await render(bundle.SkillManagerPage, {
			useWorkspaces: () => [],
			useSessions: () => ({ byId: {} }),
			pickDirectory: async () => null,
			openPath: async () => {},
			detectLanguage: () => true
		});
		answers.delete('list');
		const text = textOf(tree);
		assert.match(text, /无法读取技能列表/u);
		assert.match(text, /host exploded/u);
		assert.match(text, /重试/u);
	});

	/* ── interaction ──────────────────────────────────────────────────────── */

	test('flipping a switch posts a toggle for that exact row and reloads', async () => {
		const tree = await page();
		requests.length = 0;
		const row = skillNodes(tree).find((candidate) => candidate.props['data-skill'] === 'alpha-skill');
		switchIn(row).props.onClick();
		await runtime.flush();
		const toggle = requests.find((request) => request.method === 'toggle');
		assert.ok(toggle !== void 0, 'a toggle must be posted');
		assert.equal(toggle.payload.path, '/home/u/.dsh/skills/alpha-skill');
		assert.equal(toggle.payload.enabled, false);
		assert.equal(toggle.payload.workspacePath, void 0, 'the user scope omits the workspace');
	});

	test('the delete button asks first, and confirming posts the removal', async () => {
		const tree = await page();
		const row = skillNodes(tree).find((candidate) => candidate.props['data-skill'] === 'alpha-skill');
		const trash = findAll(row, (node) => node.kind === 'host' && node.props && node.props['data-danger'] === 'true' && node.props['aria-label'] !== void 0 && String(node.props['aria-label']).includes('删除'))[0];
		assert.ok(trash !== void 0, 'the delete button must render');
		requests.length = 0;
		trash.props.onClick();
		await runtime.flush();
		assert.equal(requests.filter((request) => request.method === 'remove').length, 0, 'nothing may be deleted before confirmation');
		const confirm = findAll(runtime.getTree(), (node) => node.kind === 'host' && node.props && node.props['data-primitive'] === 'Button' && textOf(node).includes('删除'))[0];
		assert.ok(confirm !== void 0, 'the confirmation dialog must offer a delete button');
		confirm.props.onClick();
		await runtime.flush();
		const removal = requests.find((request) => request.method === 'remove');
		assert.ok(removal !== void 0, 'confirming must post the removal');
		assert.equal(removal.payload.path, '/home/u/.dsh/skills/alpha-skill');
	});

	test('a scope switch asks the host for that workspace', async () => {
		const tree = await page({ workspaces: [{ workspaceId: 'w1', path: '/work/proj', title: 'proj' }] });
		requests.length = 0;
		const trigger = byProp(tree, 'aria-haspopup', 'listbox')[0];
		assert.ok(trigger !== void 0, 'the scope switcher must render');
		trigger.props.onClick();
		await runtime.flush();
		const option = findAll(runtime.getTree(), (node) => node.kind === 'host' && node.props && node.props.role === 'option' && node.props['aria-selected'] === false)[0];
		assert.ok(option !== void 0, 'the workspace option must be offered');
		requests.length = 0;
		option.props.onClick();
		await runtime.flush();
		const list = requests.find((request) => request.method === 'list');
		assert.ok(list !== void 0, 'selecting a workspace must reload');
		assert.equal(list.payload.workspacePath, '/work/proj');
	});

	test('the import button offers both a disk pick and an external scan', async () => {
		await page({ pickDirectory: async () => '/somewhere/my-skill' });
		const importButton = findAll(runtime.getTree(), (node) => node.kind === 'host' && node.props && node.props['aria-label'] === '导入技能')[0];
		assert.ok(importButton !== void 0, 'the import button must render');
		assert.equal(importButton.props['aria-haspopup'], 'menu');
		importButton.props.onClick();
		await runtime.flush();
		const items = findAll(runtime.getTree(), (node) => node.kind === 'host' && node.props && node.props.role === 'menuitem');
		assert.equal(items.length, 2, 'the menu offers exactly two routes');
		assert.match(textOf(runtime.getTree()), /从磁盘导入/u);
		assert.match(textOf(runtime.getTree()), /导入外部 Agent 技能/u);
	});

	test('imports the picked directory into the active scope', async () => {
		await page({ pickDirectory: async () => '/somewhere/my-skill' });
		/* The disk route lives one level down, in the import menu. */
		findAll(runtime.getTree(), (node) => node.kind === 'host' && node.props && node.props['aria-label'] === '导入技能')[0].props.onClick();
		await runtime.flush();
		const diskItem = findAll(runtime.getTree(), (node) => node.kind === 'host' && node.props && node.props.role === 'menuitem')[0];
		requests.length = 0;
		diskItem.props.onClick();
		await runtime.flush();
		const imported = requests.find((request) => request.method === 'import');
		assert.ok(imported !== void 0, 'an import must be posted');
		assert.equal(imported.payload.source, '/somewhere/my-skill');
		assert.equal(imported.payload.scope, 'global');
	});

	test('reports a refused toggle next to the list instead of crashing', async () => {
		const tree = await page({ answers: { toggle: { ok: false, error: { message: 'this skill is already enabled' } } } });
		const row = skillNodes(tree).find((candidate) => candidate.props['data-skill'] === 'alpha-skill');
		switchIn(row).props.onClick();
		await runtime.flush();
		assert.match(textOf(runtime.getTree()), /already enabled/u);
	});

	test('follows the session into its workspace', async () => {
		const tree = await page({
			workspaces: [{ workspaceId: 'w1', path: '/work/proj', title: 'proj' }],
			sessions: { byId: { 'session-1': { id: 'session-1', cwd: '/work/proj/sub', retainedBy: { mainView: 1 } } } }
		});
		void tree;
		await runtime.flush();
		const listCalls = requests.filter((request) => request.method === 'list');
		assert.ok(listCalls.length >= 1);
		assert.equal(listCalls[listCalls.length - 1].payload.workspacePath, '/work/proj', 'the page follows the session workspace');
	});

	test('the external dialog scans, selects and imports with a chosen mode', async () => {
		const externalSources = {
			ok: true,
			value: {
				sources: [
					{
						id: 'claude',
						label: 'Claude Code',
						scope: 'user',
						path: '/home/u/.claude/skills',
						display: '~/.claude/skills',
						skills: [
							{ name: 'alpha-ext', description: 'Alpha external.', path: '/home/u/.claude/skills/alpha-ext', flat: false, nested: false },
							{ name: 'beta-ext', description: 'Beta external.', path: '/home/u/.claude/skills/beta-ext', flat: false, nested: false }
						]
					},
					{
						id: 'zcode',
						label: 'ZCode',
						scope: 'project',
						path: '/work/proj/.zcode/skills',
						display: '.zcode/skills',
						skills: [{ name: 'nested-ext', description: 'Nested.', path: '/work/proj/.zcode/skills/@ns/nested-ext', flat: false, nested: true }]
					}
				]
			}
		};
		await page({ answers: { externalSources } });
		/* Open the import menu, then the external route. */
		findAll(runtime.getTree(), (node) => node.kind === 'host' && node.props && node.props['aria-label'] === '导入技能')[0].props.onClick();
		await runtime.flush();
		const externalItem = findAll(runtime.getTree(), (node) => node.kind === 'host' && node.props && node.props.role === 'menuitem')[1];
		requests.length = 0;
		externalItem.props.onClick();
		await runtime.flush();

		const scan = requests.find((request) => request.method === 'externalSources');
		assert.ok(scan !== void 0, 'opening the dialog must scan external sources');
		const text = textOf(runtime.getTree());
		assert.match(text, /导入外部 Agent 技能/u, 'the dialog title must show');
		assert.match(text, /Claude Code/u);
		assert.match(text, /ZCode/u);
		assert.match(text, /已选 0\/3/u, 'nothing is selected initially');
		assert.match(text, /分层/u, 'a nested skill must be flagged');
		assert.match(text, /软链/u, 'the link mode must be offered');

		/* Select the whole first group, then import in copy mode. */
		const groupButtons = findAll(runtime.getTree(), (node) => node.kind === 'host' && node.props && node.props.className === 'dsh-skm-extRow' && textOf(node).includes('Claude Code'));
		assert.ok(groupButtons.length > 0, 'the source group must be selectable');
		groupButtons[0].props.onClick();
		await runtime.flush();
		assert.match(textOf(runtime.getTree()), /已选 2\/3/u);

		/* Switch to copy. */
		const copyRadio = findAll(runtime.getTree(), (node) => node.kind === 'host' && node.props && node.props.className === 'dsh-skm-radio' && textOf(node).includes('复制'))[0];
		assert.ok(copyRadio !== void 0);
		copyRadio.props.onClick();
		await runtime.flush();

		requests.length = 0;
		const importButton = findAll(runtime.getTree(), (node) => node.kind === 'host' && node.props && node.props['data-primitive'] === 'Button' && textOf(node).trim() === '导入')[0];
		assert.ok(importButton !== void 0, 'the dialog must offer an import action');
		importButton.props.onClick();
		await runtime.flush();
		const call = requests.find((request) => request.method === 'importExternal');
		assert.ok(call !== void 0, 'the import must be posted');
		assert.deepEqual(call.payload.picks, ['/home/u/.claude/skills/alpha-ext', '/home/u/.claude/skills/beta-ext']);
		assert.equal(call.payload.mode, 'copy');
		assert.equal(call.payload.scope, 'global');
	});

	test('the external dialog reports when a machine has nothing to import', async () => {
		await page({ answers: { externalSources: { ok: true, value: { sources: [] } } } });
		findAll(runtime.getTree(), (node) => node.kind === 'host' && node.props && node.props['aria-label'] === '导入技能')[0].props.onClick();
		await runtime.flush();
		findAll(runtime.getTree(), (node) => node.kind === 'host' && node.props && node.props.role === 'menuitem')[1].props.onClick();
		await runtime.flush();
		const text = textOf(runtime.getTree());
		assert.match(text, /没有发现外部技能/u);
		assert.match(text, /重新扫描/u, 'an empty scan must offer a rescan');
	});

	test('the external dialog surfaces a scan failure', async () => {
		await page({ answers: { externalSources: { ok: false, error: { message: 'scan exploded' } } } });
		findAll(runtime.getTree(), (node) => node.kind === 'host' && node.props && node.props['aria-label'] === '导入技能')[0].props.onClick();
		await runtime.flush();
		findAll(runtime.getTree(), (node) => node.kind === 'host' && node.props && node.props.role === 'menuitem')[1].props.onClick();
		await runtime.flush();
		assert.match(textOf(runtime.getTree()), /scan exploded/u);
	});

	test('a linked skill is labelled in the list', async () => {
		const linked = skill('linked-skill-2', { linkTarget: '/home/u/.claude/skills/linked-skill-2' });
		await page({ answers: { list: { ok: true, value: { ...sample, skills: [linked] } } } });
		const row = skillNodes(runtime.getTree()).find((candidate) => candidate.props['data-skill'] === 'linked-skill-2');
		assert.ok(row !== void 0, 'a linked skill must be listed');
		const path = findAll(row, (node) => node.kind === 'host' && node.props && node.props.className === 'dsh-skm-rowPath')[0];
		assert.match(textOf(path), /linked-skill-2/u);
		assert.match(textOf(row), /软链/u, 'a linked skill must be labelled as linked');
	});

	test('the path is bidi-isolated so an absolute path keeps its leading slash', async () => {
		const tree = await page();
		const row = skillNodes(tree).find((candidate) => candidate.props['data-skill'] === 'alpha-skill');
		const path = findAll(row, (node) => node.kind === 'host' && node.props && node.props.className === 'dsh-skm-rowPath')[0];
		const bdi = findAll(path, (node) => node.kind === 'host' && node.type === 'bdi')[0];
		assert.ok(bdi !== void 0, 'the path must live in a <bdi>; with direction:rtl the raw string moves the leading slash to the end');
		assert.equal(textOf(bdi), '/home/u/.dsh/skills/alpha-skill/SKILL.md');
	});

	test('a dangling link is explained, cannot be switched, and can be deleted', async () => {
		const dangling = skill('dangling-skill', {
			description: '',
			heading: void 0,
			enabled: false,
			parked: true,
			problem: 'missing-file',
			dangling: true,
			linkTarget: null
		});
		const tree = await page({ answers: { list: { ok: true, value: { ...sample, skills: [dangling] } } } });
		const row = skillNodes(tree).find((candidate) => candidate.props['data-skill'] === 'dangling-skill');
		assert.ok(row !== void 0, 'a dangling link must be listed');
		assert.match(textOf(row), /断开的软链接/u, 'the row must explain what is broken');
		assert.equal(switchIn(row).props.disabled, true, 'a dangling link has no target to switch');

		requests.length = 0;
		const trash = findAll(row, (node) => node.kind === 'host' && node.props && node.props['data-danger'] === 'true' && node.props['aria-label'] !== void 0 && String(node.props['aria-label']).includes('删除'))[0];
		assert.ok(trash !== void 0, 'the delete button must render');
		trash.props.onClick();
		await runtime.flush();
		assert.match(textOf(runtime.getTree()), /删除只会移除这个链接本身/u, 'the dialog must say only the link is removed');
		const confirm = findAll(runtime.getTree(), (node) => node.kind === 'host' && node.props && node.props['data-primitive'] === 'Button' && textOf(node).includes('删除'))[0];
		assert.ok(confirm !== void 0, 'the confirmation dialog must offer a delete button');
		confirm.props.onClick();
		await runtime.flush();
		const removal = requests.find((request) => request.method === 'remove');
		assert.ok(removal !== void 0, 'confirming must post the removal');
		assert.equal(removal.payload.path, '/home/u/.dsh/skills/dangling-skill');
	});

	test('reveal asks the host Finder route for the directory that holds the skill', async () => {
		const launches = [];
		await page({ launches, answers: { list: { ok: true, value: { ...sample, skills: [skill('reveal-me')] } } } });
		const row = skillNodes(runtime.getTree()).find((candidate) => candidate.props['data-skill'] === 'reveal-me');
		const menu = findAll(row, (node) => node.kind === 'host' && node.props && node.props['aria-haspopup'] === 'menu')[0];
		assert.ok(menu !== void 0, 'the row menu must render');
		menu.props.onClick();
		await runtime.flush();
		const revealItem = findAll(runtime.getTree(), (node) => node.kind === 'host' && node.props && node.props.role === 'menuitem' && textOf(node).includes('在访达中显示'))[0];
		assert.ok(revealItem !== void 0, 'the reveal item must render');
		revealItem.props.onClick();
		await runtime.flush();
		assert.equal(launches.length, 1, 'exactly one launch request');
		assert.equal(launches[0].url, '/open-in-app/open', 'it must use the host launch route');
		assert.equal(launches[0].body.app, 'finder', 'the file manager is the Finder catalog entry');
		/* The route takes a directory: a bundle row carries SKILL.md, so the
		 * launch target is the folder that holds it — the skill's own folder. */
		assert.equal(launches[0].body.path, '/home/u/.dsh/skills/reveal-me');
	});

	test('a reveal failure names the reason instead of a generic error', async () => {
		await page({ openPath: () => Promise.reject(new Error('failed to launch finder')), answers: { list: { ok: true, value: { ...sample, skills: [skill('reveal-fail')] } } } });
		const row = skillNodes(runtime.getTree()).find((candidate) => candidate.props['data-skill'] === 'reveal-fail');
		findAll(row, (node) => node.kind === 'host' && node.props && node.props['aria-haspopup'] === 'menu')[0].props.onClick();
		await runtime.flush();
		findAll(runtime.getTree(), (node) => node.kind === 'host' && node.props && node.props.role === 'menuitem' && textOf(node).includes('在访达中显示'))[0].props.onClick();
		await runtime.flush();
		assert.match(textOf(runtime.getTree()), /无法在访达中显示/u);
		assert.doesNotMatch(textOf(runtime.getTree()), /宿主侧接口不可用/u);
	});

	test('a flat skill reveals the folder that holds it', async () => {
		const launches = [];
		const flatRow = skill('flat-reveal', {
			directory: false,
			file: '/home/u/.dsh/skills/flat-reveal.md'
		});
		await page({ launches, answers: { list: { ok: true, value: { ...sample, skills: [flatRow] } } } });
		const row = skillNodes(runtime.getTree()).find((candidate) => candidate.props['data-skill'] === 'flat-reveal');
		findAll(row, (node) => node.kind === 'host' && node.props && node.props['aria-haspopup'] === 'menu')[0].props.onClick();
		await runtime.flush();
		findAll(runtime.getTree(), (node) => node.kind === 'host' && node.props && node.props.role === 'menuitem' && textOf(node).includes('在访达中显示'))[0].props.onClick();
		await runtime.flush();
		assert.equal(launches.length, 1);
		assert.equal(launches[0].body.path, '/home/u/.dsh/skills', 'a flat skill reveals its parent directory');
	});

	/* ── feature switches ─────────────────────────────────────────────────── */

	/** Apply the bundle with explicit flags and collect what it registered. */
	function applyWithFlags(flags) {
		const injected = [];
		const registrations = [];
		if (flags === void 0) delete sandbox.__DSH_ARCHIVE_MANAGER_FEATURES__;
		else sandbox.__DSH_ARCHIVE_MANAGER_FEATURES__ = flags;
		try {
			bundle.apply({
				get: () => void 0,
				effect: (callback) => callback(),
				slots: {
					inject(key, callback) {
						injected.push(key);
						callback();
						return () => {};
					},
					register(options, component) {
						registrations.push({ options, component });
						return () => {};
					}
				}
			});
		} finally {
			delete sandbox.__DSH_ARCHIVE_MANAGER_FEATURES__;
		}
		return { injected, registrations };
	}

	test('a disabled archive feature registers neither the page nor the menu row', () => {
		const result = applyWithFlags({ archive: false });
		assert.ok(!result.registrations.some((entry) => entry.options.id === 'archive-manager'), 'no archived-sessions page');
		assert.ok(!result.injected.includes('sidebar.workspaces.session.menu.item'), 'no menu row');
		assert.ok(result.injected.includes('main'), 'the skills page still activates');
	});

	test('a disabled skills feature registers neither the sidebar row nor the panel', () => {
		const result = applyWithFlags({ skills: false });
		assert.ok(!result.injected.includes('main'));
		assert.ok(!result.injected.includes('sidebar.panellist'));
		assert.ok(result.injected.includes('settings.section'), 'the archive page still activates');
	});

	test('a disabled colors feature registers no palette', () => {
		const result = applyWithFlags({ colors: false });
		assert.ok(!result.registrations.some((entry) => entry.options.id === 'workspace-colors.palette'));
		assert.ok(
			result.registrations.some((entry) => entry.options.id === 'archive-manager.delete-dialog'),
			'the archive confirmation overlay still registers'
		);
	});

	test('disabling every feature registers nothing at all', () => {
		const result = applyWithFlags({ archive: false, skills: false, colors: false });
		assert.equal(result.registrations.length, 1, 'only the feature switch page remains');
		assert.equal(result.registrations[0].options.id, 'archive-manager.features');
		assert.deepEqual(result.injected, ['settings.section']);
	});

	test('the feature switch page lists three switches and saves a change', async () => {
		delete sandbox.__DSH_ARCHIVE_MANAGER_FEATURES__;
		const tree = await render(bundle.FeaturesPage, {});
		const text = textOf(tree);
		assert.match(text, /归档会话/u);
		assert.match(text, /技能管理/u);
		assert.match(text, /工作区配色/u);
		const switches = findAll(tree, (node) => node.kind === 'host' && node.props && node.props.role === 'switch');
		assert.equal(switches.length, 3, 'one switch per feature');
		switches[1].props.onClick();
		await runtime.flush();
		assert.match(textOf(runtime.getTree()), /刷新页面后生效/u, 'the change asks for a reload');
	});

	test('a host-disabled feature is locked in the switch page', async () => {
		sandbox.__DSH_ARCHIVE_MANAGER_FEATURES__ = { archive: true, skills: false, colors: true };
		const tree = await render(bundle.FeaturesPage, {});
		const text = textOf(tree);
		assert.match(text, /已被插件配置/u);
		const skillsRow = findAll(tree, (node) => node.kind === 'host' && node.props && node.props['data-feature'] === 'skills')[0];
		assert.ok(skillsRow !== void 0, 'the skills row must render');
		const locked = findAll(skillsRow, (node) => node.kind === 'host' && node.props && node.props.role === 'switch')[0];
		assert.equal(locked.props.disabled, true, 'the switch cannot re-enable a host-disabled feature');
		delete sandbox.__DSH_ARCHIVE_MANAGER_FEATURES__;
	});

	/* ── the session menu row ─────────────────────────────────────────────── */

	test('the session menu row asks before deleting and then posts an unrestricted delete', async () => {
		let menuClosed = null;
		const tree = await render(bundle.SessionDeleteMenuItem, {
			sessionId: 'session-dddddddd-1111-4222-8333-444444444444',
			displayTitle: '要删的会话',
			useMenuOpenState: () => [true, (value) => { menuClosed = value; }]
		});
		const row = findAll(tree, (node) => node.kind === 'host' && node.props && node.props.role === 'menuitem')[0];
		assert.ok(row !== void 0, 'the menu row must render a menuitem');
		archiveRequests.length = 0;
		/* The design system's MenuItemButton owns its own onSelect; the plain
		 * fallback is a button with onClick. */
		(typeof row.props.onSelect === 'function' ? row.props.onSelect : row.props.onClick)();
		assert.equal(menuClosed, false, 'selecting the row closes the menu first');

		const dialog = await render(bundle.DeleteSessionDialog, {});
		const text = textOf(dialog);
		assert.match(text, /删除会话？/u);
		assert.match(text, /要删的会话/u);
		const go = findAll(dialog, (node) => node.kind === 'host' && node.props && node.props.className === 'dsh-am-dialogGo')[0];
		assert.ok(go !== void 0, 'the dialog must offer the destructive action');
		go.props.onClick();
		await runtime.flush();
		const posted = archiveRequests.find((request) => request.method === 'delete');
		assert.ok(posted !== void 0, 'confirming must post the delete');
		assert.equal(posted.payload.any, true, 'a menu delete may target an unarchived session');
		assert.deepEqual(posted.payload.sessionIds, ['session-dddddddd-1111-4222-8333-444444444444']);
	});

	test('a refused menu delete keeps the dialog open and explains why', async () => {
		archiveAnswers.set('delete', {
			ok: true,
			value: {
				deleted: [],
				bytes: 0,
				failed: [{ sessionId: 'session-dddddddd-1111-4222-8333-444444444444', code: 'running', message: 'a turn is running for this session: stop it before deleting' }]
			}
		});
		await render(bundle.SessionDeleteMenuItem, {
			sessionId: 'session-dddddddd-1111-4222-8333-444444444444',
			displayTitle: '要删的会话',
			useMenuOpenState: () => [true, () => {}]
		});
		const row = findAll(runtime.getTree(), (node) => node.kind === 'host' && node.props && node.props.role === 'menuitem')[0];
		(typeof row.props.onSelect === 'function' ? row.props.onSelect : row.props.onClick)();
		const dialog = await render(bundle.DeleteSessionDialog, {});
		const go = findAll(dialog, (node) => node.kind === 'host' && node.props && node.props.className === 'dsh-am-dialogGo')[0];
		go.props.onClick();
		await runtime.flush();
		const text = textOf(runtime.getTree());
		assert.match(text, /正在执行/u, 'the coded refusal is localized');
		assert.ok(
			findAll(runtime.getTree(), (node) => node.kind === 'host' && node.props && node.props.className === 'dsh-am-dialog').length > 0,
			'the dialog stays open after a refusal'
		);
	});

	/* ── the settings page ────────────────────────────────────────────────── */

	test('the archive page loads once and renders projects, rows and badges', async () => {
		const tree = await archivePage();
		assert.equal(archiveRequests.filter((request) => request.method === 'list').length, 1, 'one list call on mount');
		const text = textOf(tree);
		assert.match(text, /归档的会话 A/u);
		assert.match(text, /未命名会话/u, 'an untitled session gets a localized fallback');
		assert.match(text, /金蝶套件/u);
		assert.match(text, /日志缺失/u, 'a missing log is labelled');
		assert.match(text, /运行中/u, 'a session with running=true is labelled 运行中');
		assert.match(text, /已打开/u, 'a live-but-idle session is labelled 已打开, not 运行中');
		assert.match(text, /重新激活/u);
		assert.match(text, /删除/u);
		const rows = findAll(tree, (node) => node.kind === 'host' && node.props && node.props['data-session'] !== void 0);
		assert.equal(rows.length, 3, 'every archived session must have a row');
		assert.equal(rows.filter((row) => String(row.props['data-session']).includes('aaaaaaaa')).length, 1);
	});

	test('a refused delete explains that a turn is still running', async () => {
		const tree = await archivePage({
			answers: {
				delete: (payload) => ({
					ok: true,
					value: {
						deleted: [],
						bytes: 0,
						failed: payload.sessionIds.map((id) => ({ sessionId: id, code: 'running', message: 'a turn is running for this session: stop it before deleting' }))
					}
				})
			}
		});
		const row = findAll(tree, (node) => node.kind === 'host' && String(node.props && node.props['data-session']).includes('aaaaaaaa'))[0];
		buttonsLabelled(row, '删除')[0].props.onClick();
		await runtime.flush();
		findAll(runtime.getTree(), (node) => node.kind === 'host' && node.props && node.props.className === 'dsh-am-confirmGo')[0].props.onClick();
		await runtime.flush();
		const text = textOf(runtime.getTree());
		assert.match(text, /删除失败/u);
		assert.match(text, /正在执行/u, 'the coded refusal is localized, not the raw English message');
		assert.doesNotMatch(text, /a turn is running/u);
	});

	test('the archive search box filters rows by title, project and path', async () => {
		const tree = await archivePage();
		const input = findAll(tree, (node) => node.kind === 'host' && node.props && node.props.type === 'search')[0];
		assert.ok(input !== void 0, 'the toolbar must carry a search field');
		input.props.onChange({ target: { value: '金蝶' } });
		await runtime.flush();
		const rows = findAll(runtime.getTree(), (node) => node.kind === 'host' && node.props && node.props['data-session'] !== void 0);
		assert.equal(rows.length, 1, 'only the matching project survives the filter');
		assert.match(textOf(rows[0]), /日志已经不在的会话/u);
	});

	test('restoring one session posts its id and reloads the list', async () => {
		const tree = await archivePage({ answers: { restore: (payload) => ({ ok: true, value: { restored: [payload.sessionId] } }) } });
		const row = findAll(tree, (node) => node.kind === 'host' && String(node.props && node.props['data-session']).includes('aaaaaaaa'))[0];
		const restore = buttonsLabelled(row, '重新激活')[0];
		assert.ok(restore !== void 0, 'the row must offer 重新激活');
		archiveRequests.length = 0;
		restore.props.onClick();
		await runtime.flush();
		const posted = archiveRequests.find((request) => request.method === 'restore');
		assert.ok(posted !== void 0, 'the restore call must be posted');
		assert.equal(posted.payload.sessionId, 'session-aaaaaaaa-1111-4222-8333-444444444444');
		assert.ok(archiveRequests.some((request) => request.method === 'list'), 'the page must reload after a restore');
	});

	test('deleting asks for confirmation before anything is posted', async () => {
		const tree = await archivePage({
			answers: { delete: (payload) => ({ ok: true, value: { deleted: payload.sessionIds, failed: [], bytes: 10 } }) }
		});
		const row = findAll(tree, (node) => node.kind === 'host' && String(node.props && node.props['data-session']).includes('bbbbbbbb'))[0];
		const remove = buttonsLabelled(row, '删除')[0];
		assert.ok(remove !== void 0, 'the row must offer 删除');
		archiveRequests.length = 0;
		remove.props.onClick();
		await runtime.flush();
		assert.equal(archiveRequests.filter((request) => request.method === 'delete').length, 0, 'nothing may be deleted before confirmation');
		const confirmation = findAll(runtime.getTree(), (node) => node.kind === 'host' && node.props && node.props.className === 'dsh-am-confirm')[0];
		assert.ok(confirmation !== void 0, 'the inline confirmation must render');
		assert.match(textOf(confirmation), /仍在窗口中打开/u, 'an open session warns that deleting it invalidates the window');
		const go = findAll(runtime.getTree(), (node) => node.kind === 'host' && node.props && node.props.className === 'dsh-am-confirmGo')[0];
		assert.ok(go !== void 0, 'the inline confirmation must render a confirm button');
		go.props.onClick();
		await runtime.flush();
		const posted = archiveRequests.find((request) => request.method === 'delete');
		assert.ok(posted !== void 0, 'confirming must post the delete');
		assert.deepEqual(posted.payload.sessionIds, ['session-bbbbbbbb-1111-4222-8333-444444444444']);
	});

	test('an empty archive explains where sessions get archived', async () => {
		const tree = await archivePage({
			answers: { list: { ok: true, value: { home: '/home/u/.dsh', total: 0, bytes: 0, projects: [], ungrouped: { total: 0, bytes: 0, sessions: [] } } } }
		});
		const text = textOf(tree);
		assert.match(text, /没有已归档的会话/u);
		assert.match(text, /归档/u);
		assert.equal(findAll(tree, (node) => node.kind === 'host' && node.props && node.props['data-session'] !== void 0).length, 0);
	});

	test('a failed load keeps the page usable and offers a retry', async () => {
		const tree = await archivePage({ answers: { list: { ok: false, error: { message: 'boom' } } } });
		const text = textOf(tree);
		assert.match(text, /无法读取归档会话/u);
		assert.match(text, /重试/u);
		assert.ok(buttonsLabelled(tree, '重试').length > 0, 'the retry button must be clickable');
	});

	/* ── run ──────────────────────────────────────────────────────────────── */

	let failed = 0;
	for (const item of cases) {
		try {
			await item.body();
			console.log(`  ok   ${item.name}`);
		} catch (error) {
			failed += 1;
			console.log(`  FAIL ${item.name}`);
			console.log(`       ${error && error.message ? error.message : error}`);
		}
	}
	console.log(`\n${cases.length - failed}/${cases.length} passed`);
	process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error(error && error.stack ? error.stack : error);
	process.exit(1);
});
