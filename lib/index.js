/**
 * Archive Manager — host half.
 *
 * This package is the single install of three features that used to ship as
 * separate plugins:
 *
 * 1. **归档会话 / Archive Manager** (`/archive-manager/api`) — the Settings page
 *    that groups archived sessions by project and can restore or delete them.
 *    `lib/archive.cjs` owns every decision about which session ids may be
 *    touched and which files belong to them.
 * 2. **技能管理 / Skill Manager** (`/skill-manager/api`) — the sidebar page that
 *    lists, imports, toggles and removes skills. `lib/skills.cjs` is that
 *    feature's filesystem core, carried over unchanged.
 * 3. **工作区配色 / Workspace Colors** — browser presentation only; it needs a
 *    Loader row (this one) but no host behaviour.
 *
 * The row's `Config` turns each feature on or off independently. The host half
 * simply does not mount a disabled feature's route, and the page is told the
 * same three flags through an index injection so the browser half skips the
 * matching slot registrations — one package, three switches.
 *
 * Both HTTP surfaces are plain JSON routes on the host's own web server rather
 * than Remote namespaces: managing session logs and skill directories is a
 * host-plane operation with no Agent in it, so a generated Typert manifest would
 * add ceremony without adding a boundary. Each route is fenced the way the
 * shipped code fences its own plugin routes — the request must address the host
 * we are running on and must not be a cross-site browser request.
 *
 * The two `.cjs` cores are re-required on every apply so a locally edited copy
 * converges through a plugin toggle instead of a process restart: Node caches an
 * ES module by URL for the life of the process, and the shipped HMR watcher does
 * not watch a linked plugin's real path.
 */

import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Resolve a package the host runtime ships but this plugin does not depend on.
 *
 * A profile-linked plugin resolves relative to its own real path, so the
 * runtime's own module roots are asked explicitly. `yaml` is the one package
 * the skill feature needs and does not declare: the shipped skill provider
 * parses frontmatter with it, so parsing with anything else could disagree with
 * discovery about whether a skill is valid, and an import that disagreed would
 * write a skill the provider then silently drops.
 * @param name - package specifier.
 * @returns the resolved module exports.
 */
function loadRuntimePackage(name) {
	const bases = [];
	const push = (value) => {
		if (typeof value === 'string' && value.length > 0 && !bases.includes(value)) bases.push(value);
	};
	const resources = process.resourcesPath;
	if (typeof resources === 'string') {
		push(join(resources, 'app.asar', 'dsh', 'package.json'));
		push(join(resources, 'app.asar', 'package.json'));
	}
	/* A harness can name the module root standing in for the runtime. */
	push(process.env.DSH_TEST_MODULE_ROOT);
	const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
	push(join(home, 'package.json'));
	try {
		for (const entry of readdirSync(join(home, 'profiles'))) push(join(home, 'profiles', entry, 'package.json'));
	} catch {
		/* no profile directory: the other bases still apply */
	}
	push(import.meta.url);
	for (const base of bases) {
		try {
			const loaded = createRequire(base)(name);
			return loaded.default ?? loaded;
		} catch {
			/* try the next module root */
		}
	}
	throw new Error(`archive-manager: cannot resolve "${name}" from any known module root (${bases.join(', ')})`);
}

/**
 * Re-require a CommonJS implementation so local edits apply on the next toggle.
 *
 * The cache is keyed by the path Node resolved, which for a linked package is
 * the symlinked path rather than its realpath, so every entry naming this
 * package's implementation is dropped rather than only the exact match.
 * @param file - implementation file name beside this entry.
 * @returns the freshly loaded implementation module.
 */
function loadImplementation(file) {
	const target = require.resolve(`./${file}`);
	for (const key of Object.keys(require.cache)) {
		if (key === target || key.includes(`dsh-plugin-archive-manager/lib/${file}`)) delete require.cache[key];
	}
	if (!existsSync(target)) throw new Error(`archive-manager: missing implementation at ${target}`);
	return require(`./${file}`);
}

/**
 * Resolve zod from the runtime, exactly like `yaml`: the package is shipped by
 * the host but is not a dependency of this linked plugin.
 *
 * A deployment that cannot answer it still runs every feature (the schema is
 * only used by the configuration form), so the failure is swallowed rather than
 * thrown at import time.
 */
const zod = (() => {
	try {
		const loaded = loadRuntimePackage('zod');
		return loaded.z !== void 0 ? loaded.z : loaded;
	} catch {
		return void 0;
	}
})();

/** The row configuration: one switch per bundled feature, all on by default. */
export const Config =
	zod === void 0
		? void 0
		: zod
				.object({
					archive: zod.boolean().default(true).describe('归档会话：设置里的归档会话页，以及会话「…」菜单中的「删除会话」'),
					skills: zod.boolean().default(true).describe('技能管理：侧边栏「技能」页与 /skill-manager/api'),
					colors: zod.boolean().default(true).describe('工作区配色：工作区颜色徽标、同色竖线与调色板')
				});

/**
 * Turn one row config into three booleans. Anything but an explicit `false`
 * keeps a feature on, so an older row without a `config` block behaves exactly
 * as before.
 * @param config - the row's parsed config, or undefined.
 * @returns the resolved flags.
 */
function resolveFeatureFlags(config) {
	const source = config !== null && typeof config === 'object' ? config : {};
	return {
		archive: source.archive !== false,
		skills: source.skills !== false,
		colors: source.colors !== false
	};
}

/**
 * Publish the flags to the page.
 *
 * One browser module carries all three features, so it cannot ask the Host per
 * feature at boot; the index injection hands it the same three booleans the row
 * declared. A disabled feature then registers nothing at all.
 * @param html - the index document.
 * @param flags - the resolved flags.
 * @returns the document with the flags scripted in.
 */
function injectFeatureFlags(html, flags) {
	if (typeof html !== 'string') return html;
	const payload = JSON.stringify(flags).replace(/</gu, '\\u003c');
	const tag = `<script>window.__DSH_ARCHIVE_MANAGER_FEATURES__=${payload};</script>`;
	return html.includes('</head>') ? html.replace('</head>', `${tag}</head>`) : `${tag}${html}`;
}

/**
 * Host plugin body.
 * @param ctx - host root context.
 * @param config - the row configuration (see `Config`).
 */
export function apply(ctx, config) {
	const flags = resolveFeatureFlags(config);
	const skills = loadImplementation('skills.cjs');
	const archive = loadImplementation('archive.cjs');

	/**
	 * The workspaces this plugin accepts as a scope.
	 *
	 * A path arriving from the browser is only used after it matches a registered
	 * workspace, so a malformed or hostile request cannot aim the skill manager at
	 * an arbitrary directory on disk.
	 * @returns the registered workspaces, or null when this composition has none.
	 */
	const registeredWorkspaces = () => {
		const registry = ctx.get('workspaceRegistry');
		if (registry === void 0 || registry === null || typeof registry.list !== 'function') return null;
		try {
			return registry.list().map((workspace) => ({ id: String(workspace.id), path: workspace.path, title: workspace.title }));
		} catch {
			return null;
		}
	};

	/** Resolve the requested workspace path against the registry. */
	const resolveWorkspace = (requested) => {
		if (typeof requested !== 'string' || requested.length === 0) throw new Error('a workspace path is required');
		const list = registeredWorkspaces();
		if (list === null) return requested;
		if (!list.some((workspace) => workspace.path === requested)) throw new Error('the requested workspace is not registered');
		return requested;
	};

	/** The deployment's own trusted hosts, read live so a config change is seen. */
	const trustedHosts = () => {
		const runtime = ctx.get('webRuntime');
		return runtime !== null && runtime !== void 0 && Array.isArray(runtime.trustedHosts) ? runtime.trustedHosts : [];
	};

	/** Live lookups: a sibling row may still be activating when this applies. */
	const serviceOf = (name) => {
		try {
			return ctx.get(name);
		} catch {
			return void 0;
		}
	};

	if (flags.skills) {
		const yaml = loadRuntimePackage('yaml');
		const parseYaml = typeof yaml.parse === 'function' ? yaml.parse : void 0;
		if (parseYaml === void 0) throw new Error('archive-manager: the resolved "yaml" package exposes no parse()');
		const skillsHandler = skills.createHandler({ parseYaml, resolveWorkspace, trustedHosts });
		ctx.effect(
			() => ctx.webServer.register({ kind: 'prefix', path: skills.ROUTE, handler: skillsHandler }),
			'archive-manager: /skill-manager/api routes'
		);
	}

	const archiveHandler = archive.createHandler({
		trustedHosts,
		registry: () => serviceOf('workspaceRegistry'),
		query: () => serviceOf('sessionQuery'),
		sessions: () => serviceOf('sessions'),
		/* The Remote list face: the only source of the authoritative `running`
		 * flag (`SessionSummary.running`). The in-memory store cannot answer it. */
		controller: () => serviceOf('sessionController'),
		home: () => skills.dshHome(),
		/* A deleted Session must leave the browser's catalog too, or the sidebar
		 * keeps rendering a row whose log no longer exists. */
		emit: (sessionId) => ctx.emit('api-session/removed', sessionId)
	});
	if (flags.archive) {
		ctx.effect(
			() => ctx.webServer.register({ kind: 'prefix', path: archive.ROUTE, handler: archiveHandler }),
			'archive-manager: /archive-manager/api routes'
		);
	}

	/* The page needs the same three flags; the client module is one bundle. */
	ctx.effect(() => {
		const webServer = ctx.webServer;
		if (typeof webServer.tapIndex !== 'function') return () => {};
		return webServer.tapIndex((html) => injectFeatureFlags(html, flags));
	}, 'archive-manager: client feature flags');
}

/** This plugin's one required host service. */
export const inject = ['webServer'];
