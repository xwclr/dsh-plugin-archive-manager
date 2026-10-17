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
 * Host plugin body.
 * @param ctx - host root context.
 */
export function apply(ctx) {
	const yaml = loadRuntimePackage('yaml');
	const parseYaml = typeof yaml.parse === 'function' ? yaml.parse : void 0;
	if (parseYaml === void 0) throw new Error('archive-manager: the resolved "yaml" package exposes no parse()');
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

	const skillsHandler = skills.createHandler({ parseYaml, resolveWorkspace, trustedHosts });
	ctx.effect(
		() => ctx.webServer.register({ kind: 'prefix', path: skills.ROUTE, handler: skillsHandler }),
		'archive-manager: /skill-manager/api routes'
	);

	const archiveHandler = archive.createHandler({
		trustedHosts,
		registry: () => serviceOf('workspaceRegistry'),
		query: () => serviceOf('sessionQuery'),
		sessions: () => serviceOf('sessions'),
		/* The Remote list face: the only source of the authoritative `running`
		 * flag (`SessionSummary.running`). The in-memory store cannot answer it. */
		controller: () => serviceOf('sessionController'),
		home: () => skills.dshHome()
	});
	ctx.effect(
		() => ctx.webServer.register({ kind: 'prefix', path: archive.ROUTE, handler: archiveHandler }),
		'archive-manager: /archive-manager/api routes'
	);
}

/** This plugin's one required host service. */
export const inject = ['webServer'];
