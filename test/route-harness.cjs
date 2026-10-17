'use strict';

/**
 * Archive Manager — host route harness.
 *
 * Boots the real `lib/index.js` plugin against a minimal fake Cordis context and
 * a real `node:http` server, then drives both mounts over HTTP with `fetch`:
 * the carried-over `/skill-manager/api` surface and the new
 * `/archive-manager/api` one. This is the layer the browser halves actually talk
 * to, so it verifies the things neither core harness can: the route prefixes,
 * the request-trust fence, the `{ok, value}` envelope, method dispatch,
 * workspace validation, and that an error never escapes as a non-JSON response.
 *
 * Run with `node test/route-harness.cjs`.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-manager-route-'));
const home = path.join(scratch, 'home');
const workspace = path.join(scratch, 'workspace');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(path.join(workspace, '.git'), { recursive: true });
process.env.DSH_HOME = home;
/* The plugin resolves `yaml` from the runtime's own module roots. In the app
 * that is the asar or a profile; here the real desktop profile is the only place
 * that ships it, so it stands in for the runtime. */
process.env.DSH_TEST_MODULE_ROOT = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'package.json');

/** Events the plugin emitted (the browser-facing session catalog). */
const emitted = [];

/** One registered route, as the plugin registered it. */
const routes = [];
const registered = [];

/** One workspace the fake registry reports; archive tests append sessions. */
const fakeWorkspaces = [
	{
		id: 'ws-1',
		path: workspace,
		title: 'scratch',
		sessionIds: [],
		async detachSession(sessionId) {
			const owner = fakeWorkspaces.find((entry) => entry.sessionIds.includes(sessionId));
			if (owner !== void 0) owner.sessionIds = owner.sessionIds.filter((entry) => entry !== sessionId);
		}
	}
];

/** Sessions the fake `sessionQuery` reports, newest first is the tests' job. */
const sessionRecords = [];

/** Summaries the fake `sessionController` reports (running / agentAvailable). */
const controllerItems = [];

/** Ids the fake registry says are archived (the host reads the store instead). */
const unarchived = [];

/** The durable archive store as the fake registry last wrote it. */
let archivedStore = [];

/** The fake `sessionQuery` service. */
const fakeQuery = {
	async listSessions() {
		return sessionRecords.slice();
	},
	async readTitleSnapshots(ids) {
		return ids.map((sessionId) => {
			const record = sessionRecords.find((entry) => entry.header.id === sessionId);
			return record === void 0
				? { sessionId, status: 'rejected', reason: new Error('unknown session') }
				: {
						sessionId,
						status: 'fulfilled',
						value: { session: record.header, title: record.title === void 0 ? void 0 : { title: record.title } }
					};
		});
	}
};

/** Write the durable archive store the host half reads. */
function writeArchiveStore(ids) {
	archivedStore = ids.slice();
	const storages = path.join(home, 'storages');
	fs.mkdirSync(storages, { recursive: true });
	fs.writeFileSync(
		path.join(storages, 'workspace.json'),
		JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: { archivedSessionIds: ids }, tables: {} })
	);
}

/**
 * Build the minimal host context `lib/index.js` needs.
 *
 * A declared `inject` entry arrives as a plain property (`ctx.webServer`), which
 * is what the plugin reads; optional services go through `get`.
 */
function fakeContext() {
	const context = {
		/* Cordis injects declared services as properties. */
		webServer: { register: (route) => (routes.push(route), () => {}) },
		emit(name, sessionId) {
			emitted.push({ name, sessionId });
		},
		effect(callback, label) {
			registered.push(label);
			const dispose = callback();
			return () => {
				if (typeof dispose === 'function') dispose();
			};
		},
		get(name) {
			if (name === 'webServer') return context.webServer;
			if (name === 'workspaceRegistry') {
				return {
					list: () => fakeWorkspaces,
					async unarchiveSession(sessionId) {
						unarchived.push(sessionId);
						writeArchiveStore(archivedStore.filter((entry) => entry !== sessionId));
					}
				};
			}
			if (name === 'sessionQuery') return fakeQuery;
			if (name === 'sessionController') {
				return { list: async () => ({ items: controllerItems }) };
			}
			if (name === 'sessions') return { get: () => void 0 };
			if (name === 'skills') {
				return {
					snapshot: async () => ({
						skills: listCatalog().map((skill) => ({ name: skill }))
					})
				};
			}
			if (name === 'webRuntime') return { trustedHosts: [] };
			return void 0;
		}
	};
	return context;
}

/** Names the fake registry reports, kept in step with what the test writes. */
let catalog = [];
const listCatalog = () => catalog;

/** Serve every registered prefix route on one ephemeral port. */
async function serve() {
	const server = http.createServer((request, response) => {
		const url = new URL(request.url, 'http://127.0.0.1');
		const route = routes.find((candidate) => candidate.kind === 'prefix' && url.pathname.startsWith(candidate.path));
		if (route === void 0) {
			response.writeHead(404, { 'content-type': 'text/plain' });
			response.end('no route');
			return;
		}
		Promise.resolve(route.handler(request, response)).catch((error) => {
			if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
			response.end(String(error && error.message ? error.message : error));
		});
	});
	server.on('error', (error) => console.log('   [server error]', error.message));
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	console.log(`   [listening on ${address.address}:${address.port}]`);
	return { server, port: address.port };
}

/** One API call. */
async function call(port, method, payload, init) {
	const response = await fetch(`http://127.0.0.1:${port}/skill-manager/api/${method}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload ?? {}),
		...init
	});
	const text = await response.text();
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`response was not JSON (status ${response.status}): ${text.slice(0, 200)}`);
	}
	return { status: response.status, body: parsed };
}

/** One archive API call. */
async function archiveCall(port, method, payload, init) {
	const response = await fetch(`http://127.0.0.1:${port}/archive-manager/api/${method}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload ?? {}),
		...init
	});
	const text = await response.text();
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`response was not JSON (status ${response.status}): ${text.slice(0, 200)}`);
	}
	return { status: response.status, body: parsed };
}

/** Write one bundle skill. */
function bundle(root, folder, frontmatter, assets) {
	const directory = path.join(root, folder);
	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(path.join(directory, 'SKILL.md'), ['---', ...frontmatter, '---', '', `# ${folder}`].join('\n'));
	for (const [name, body] of Object.entries(assets === void 0 ? {} : assets)) {
		fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
		fs.writeFileSync(path.join(directory, name), body);
	}
	return directory;
}

const cases = [];
const test = (name, body) => cases.push({ name, body });

async function main() {
	const plugin = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'index.js')).href);
	const context = fakeContext();
	plugin.apply(context);
	assert.ok(registered.length > 0, 'apply must register an effect');
	assert.equal(routes.length, 2, 'apply must register both mounts');
	assert.equal(routes[0].kind, 'prefix');
	assert.equal(routes[0].path, '/skill-manager/api');
	assert.equal(routes[1].kind, 'prefix');
	assert.equal(routes[1].path, '/archive-manager/api');

	const { server, port } = await serve();
	const globalRoot = path.join(home, 'skills');
	fs.mkdirSync(globalRoot, { recursive: true });

	test('lists skills with the workspace and roots', async () => {
		bundle(globalRoot, 'route-skill', ['name: route-skill', 'description: Over HTTP.']);
		catalog = ['route-skill'];
		const result = await call(port, 'list', { workspacePath: workspace });
		assert.equal(result.status, 200);
		assert.equal(result.body.ok, true);
		assert.equal(result.body.value.workspacePath, workspace);
		const row = result.body.value.skills.find((skill) => skill.name === 'route-skill');
		assert.ok(row, 'the skill must be listed');
		assert.equal(row.shadowed, false);
		assert.equal(row.scope, 'global');
		assert.ok(result.body.value.roots.some((root) => root.scope === 'project'));
	});

	test('marks a same-named skill in the lower-precedence root as shadowed', async () => {
		bundle(globalRoot, 'shadow-global', ['name: shadow-race', 'description: Global copy.']);
		bundle(path.join(workspace, '.dsh', 'skills'), 'shadow-project', ['name: shadow-race', 'description: Project copy.']);
		const result = await call(port, 'list', { workspacePath: workspace });
		const rows = result.body.value.skills.filter((skill) => skill.name === 'shadow-race');
		assert.equal(rows.length, 2);
		assert.equal(rows.find((row) => row.scope === 'project').shadowed, false);
		assert.equal(rows.find((row) => row.scope === 'global').shadowed, true);
	});

	test('rejects a workspace that is not registered', async () => {
		const result = await call(port, 'list', { workspacePath: '/tmp' });
		assert.equal(result.body.ok, false);
		assert.match(result.body.error.message, /not registered/u);
	});

	test('the user scope needs no workspace: the global root is the target', async () => {
		/* Regression: a refactor made every method require a workspacePath, which
		 * broke the page's default view — the “用户” scope is the global root and
		 * deliberately sends no workspace at all. */
		const listed = await call(port, 'list', {});
		assert.equal(listed.body.ok, true, `list without a workspace must serve the global root: ${listed.body.error && listed.body.error.message}`);
		assert.deepEqual(listed.body.value.roots.map((root) => root.scope), ['global'], 'no project root may appear');
		assert.equal(listed.body.value.workspacePath, null);
	});

	test('a project-scoped write still requires a workspace', async () => {
		const result = await call(port, 'create', { scope: 'project', name: 'no-workspace', description: 'x' });
		assert.equal(result.body.ok, false);
		assert.match(result.body.error.message, /workspace|needs a workspace/u);
	});

	test('disables and re-enables a skill over HTTP', async () => {
		const entry = path.join(globalRoot, 'route-skill');
		const off = await call(port, 'toggle', { workspacePath: workspace, path: entry, enabled: false });
		assert.equal(off.body.ok, true);
		assert.equal(fs.existsSync(path.join(entry, 'SKILL.md.disabled')), true);
		const on = await call(port, 'toggle', { workspacePath: workspace, path: entry, enabled: true });
		assert.equal(on.body.ok, true);
		assert.equal(fs.existsSync(path.join(entry, 'SKILL.md')), true);
	});

	test('surfaces a refused toggle as a failed envelope, not a crash', async () => {
		const entry = path.join(globalRoot, 'route-skill');
		const result = await call(port, 'toggle', { workspacePath: workspace, path: entry, enabled: true });
		assert.equal(result.status, 200);
		assert.equal(result.body.ok, false);
		assert.match(result.body.error.message, /already enabled/u);
	});

	test('refuses a toggle aimed outside the skill roots', async () => {
		const outside = path.join(scratch, 'outside.md');
		fs.writeFileSync(outside, 'not a skill');
		const result = await call(port, 'toggle', { workspacePath: workspace, path: outside, enabled: false });
		assert.equal(result.body.ok, false);
		assert.match(result.body.error.message, /outside the global and workspace/u);
		assert.equal(fs.existsSync(outside), true);
	});

	test('imports a picked folder over HTTP', async () => {
		const source = path.join(scratch, 'incoming');
		bundle(source, 'imported', ['name: route-imported', 'description: Arrived over HTTP.']);
		const result = await call(port, 'import', { workspacePath: workspace, scope: 'global', source: path.join(source, 'imported') });
		assert.equal(result.body.ok, true);
		assert.equal(result.body.value.imported.length, 1);
		assert.equal(fs.existsSync(path.join(globalRoot, 'route-imported', 'SKILL.md')), true);
	});

	test('imports into the workspace root', async () => {
		const source = path.join(scratch, 'project-incoming');
		bundle(source, 'project-imported', ['name: route-project-imported', 'description: Into the workspace.']);
		const result = await call(port, 'import', { workspacePath: workspace, scope: 'project', source });
		assert.equal(result.body.ok, true);
		assert.equal(fs.existsSync(path.join(workspace, '.dsh', 'skills', 'route-project-imported', 'SKILL.md')), true);
	});

	test('deletes a skill over HTTP', async () => {
		const entry = path.join(globalRoot, 'shadow-global');
		const result = await call(port, 'remove', { workspacePath: workspace, path: entry });
		assert.equal(result.body.ok, true);
		assert.equal(result.body.value.directory, true);
		assert.equal(fs.existsSync(entry), false);
	});

	test('lists a dangling skill link as broken but deletable', async () => {
		const link = path.join(globalRoot, 'gone-skill');
		fs.symlinkSync(path.join(scratch, 'gone-source'), link, 'dir');
		const listed = await call(port, 'list', { workspacePath: workspace });
		const row = listed.body.value.skills.find((skill) => skill.entry === 'gone-skill');
		assert.ok(row !== void 0, 'a dangling link must still be listed');
		assert.equal(row.dangling, true);
		assert.equal(row.enabled, false);
		assert.equal(row.problem, 'missing-file');
		assert.equal(row.linkTarget, null);

		const refused = await call(port, 'toggle', { workspacePath: workspace, path: row.entryPath, enabled: true });
		assert.equal(refused.body.ok, false);
		assert.match(refused.body.error.message, /dangling/u);

		const removed = await call(port, 'remove', { workspacePath: workspace, path: row.entryPath });
		assert.equal(removed.body.ok, true, `remove failed: ${JSON.stringify(removed.body)}`);
		assert.equal(removed.body.value.link, true);
		assert.equal(removed.body.value.dangling, true);
		assert.throws(() => fs.lstatSync(link), /ENOENT/u);
	});

	test('lists and removes a dangling link parked under .system', async () => {
		const parked = path.join(workspace, '.dsh', 'skills', '.system', 'parked-gone');
		fs.mkdirSync(path.dirname(parked), { recursive: true });
		fs.symlinkSync(path.join(scratch, 'never-was'), parked, 'dir');
		const listed = await call(port, 'list', { workspacePath: workspace });
		const row = listed.body.value.skills.find((skill) => skill.entry === 'parked-gone');
		assert.ok(row !== void 0, 'a parked dangling link must be listed');
		assert.equal(row.parked, true);
		assert.equal(row.dangling, true);
		assert.equal(row.problem, 'missing-file');

		const removed = await call(port, 'remove', { workspacePath: workspace, path: row.entryPath });
		assert.equal(removed.body.ok, true, `remove failed: ${JSON.stringify(removed.body)}`);
		assert.equal(removed.body.value.dangling, true);
		assert.throws(() => fs.lstatSync(parked), /ENOENT/u);
	});

	test('creates a skill and reports it in the list', async () => {
		const created = await call(port, 'create', { workspacePath: workspace, scope: 'global', name: 'route-created', description: 'Scaffolded over HTTP.' });
		assert.equal(created.body.ok, true);
		assert.equal(created.body.value.name, 'route-created');
		const file = path.join(globalRoot, 'route-created', 'SKILL.md');
		assert.equal(fs.existsSync(file), true);
		const listed = await call(port, 'list', { workspacePath: workspace });
		const row = listed.body.value.skills.find((skill) => skill.name === 'route-created');
		assert.ok(row, 'the created skill must appear');
		assert.equal(row.description, 'Scaffolded over HTTP.');
		assert.equal(row.problem, undefined);
	});

	test('refuses to create a skill whose name is invalid', async () => {
		const result = await call(port, 'create', { workspacePath: workspace, scope: 'global', name: 'Not Valid', description: 'x' });
		assert.equal(result.body.ok, false);
		assert.match(result.body.error.message, /kebab-case/u);
	});

	test('refuses to create a skill that already exists', async () => {
		const result = await call(port, 'create', { workspacePath: workspace, scope: 'global', name: 'route-created', description: 'again' });
		assert.equal(result.body.ok, false);
		assert.match(result.body.error.message, /already exists/u);
	});

	test('offers external sources with their skills', async () => {
		const source = path.join(workspace, '.claude', 'skills');
		bundle(source, 'external-one', ['name: external-one', 'description: From Claude Code.']);
		const result = await call(port, 'externalSources', { workspacePath: workspace });
		assert.equal(result.body.ok, true);
		const found = result.body.value.sources.find((entry) => entry.path === source);
		assert.ok(found !== void 0, 'the project-level Claude Code source must be offered');
		assert.equal(found.scope, 'project');
		assert.ok(found.skills.some((skill) => skill.name === 'external-one'));
	});

	test('imports an external skill by copy over HTTP', async () => {
		const source = path.join(workspace, '.claude', 'skills');
		const bundlePath = bundle(source, 'external-copy', ['name: external-copy', 'description: Copy.']);
		const result = await call(port, 'importExternal', { workspacePath: workspace, scope: 'project', mode: 'copy', picks: [bundlePath] });
		assert.equal(result.body.ok, true, `import failed: ${JSON.stringify(result.body.error || result.body).slice(0, 200)}`);
		assert.equal(result.body.value.mode, 'copy');
		assert.equal(fs.existsSync(path.join(workspace, '.dsh', 'skills', 'external-copy', 'SKILL.md')), true);
	});

	test('imports an external skill by link over HTTP', async () => {
		const source = path.join(workspace, '.claude', 'skills');
		const bundlePath = bundle(source, 'external-link', ['name: external-link', 'description: Link.']);
		const result = await call(port, 'importExternal', { workspacePath: workspace, scope: 'project', mode: 'link', picks: [bundlePath] });
		assert.equal(result.body.ok, true);
		assert.equal(result.body.value.mode, 'link');
		const destination = path.join(workspace, '.dsh', 'skills', 'external-link');
		assert.equal(fs.lstatSync(destination).isSymbolicLink(), true);
		assert.equal(fs.realpathSync(destination), fs.realpathSync(bundlePath));
	});

	test('refuses an external pick no source offered', async () => {
		const stray = path.join(scratch, 'stray-skill');
		bundle(stray, 'stray', ['name: stray', 'description: Stray.']);
		const result = await call(port, 'importExternal', { workspacePath: workspace, scope: 'project', mode: 'copy', picks: [path.join(stray, 'stray')] });
		assert.equal(result.body.ok, false);
		assert.match(result.body.error.message, /not a skill offered/u);
		assert.equal(fs.existsSync(path.join(workspace, '.dsh', 'skills', 'stray')), false);
	});

	test('reports link state in the skill list', async () => {
		const listed = await call(port, 'list', { workspacePath: workspace });
		const linked = listed.body.value.skills.find((skill) => skill.name === 'external-link');
		assert.ok(linked !== void 0);
		assert.equal(linked.linkTarget !== null, true, 'a linked skill must report its target');
	});

	test('disabling a linked skill over HTTP never writes into its source', async () => {
		const source = path.join(workspace, '.claude', 'skills');
		const bundlePath = bundle(source, 'link-safe', ['name: link-safe', 'description: Safe.']);
		await call(port, 'importExternal', { workspacePath: workspace, scope: 'project', mode: 'link', picks: [bundlePath] });
		const entry = path.join(workspace, '.dsh', 'skills', 'link-safe');
		const off = await call(port, 'toggle', { workspacePath: workspace, path: entry, enabled: false });
		assert.equal(off.body.ok, true);
		/* The source directory must be byte-identical: no SKILL.md.disabled. */
		assert.equal(fs.existsSync(path.join(bundlePath, 'SKILL.md')), true);
		assert.equal(fs.existsSync(path.join(bundlePath, 'SKILL.md.disabled')), false);
		const on = await call(port, 'toggle', { workspacePath: workspace, path: entry, enabled: true });
		assert.equal(on.body.ok, true);
		assert.equal(fs.lstatSync(entry).isSymbolicLink(), true);
	});

	test('lists import suggestions without a native picker', async () => {
		const result = await call(port, 'suggestions', {});
		assert.equal(result.body.ok, true);
		assert.ok(Array.isArray(result.body.value.suggestions));
	});

	test('lists no archived sessions on a home with no archive store', async () => {
		writeArchiveStore([]);
		const result = await archiveCall(port, 'list', {});
		assert.equal(result.status, 200);
		assert.equal(result.body.ok, true);
		assert.equal(result.body.value.total, 0);
		assert.deepEqual(result.body.value.projects, []);
		assert.deepEqual(result.body.value.ungrouped, { total: 0, bytes: 0, sessions: [] });
	});

	test('groups an archived session by its project', async () => {
		const id = 'session-11111111-2222-4333-8444-555555555555';
		const directory = path.join(home, 'sessions', '--scratch-workspace--', id);
		fs.mkdirSync(directory, { recursive: true });
		fs.writeFileSync(path.join(directory, 'session.v4.jsonl.zstd'), Buffer.alloc(2048));
		writeArchiveStore([id]);
		sessionRecords.push({ header: { id, cwd: workspace, createdAt: 1000 }, live: false, persisted: true, title: '归档的那个' });
		controllerItems.push({ sessionId: id, running: true, agentAvailable: true, blank: false, updatedAt: 1000 });
		fakeWorkspaces[0].sessionIds = [id];
		const result = await archiveCall(port, 'list', {});
		assert.equal(result.body.ok, true, `list failed: ${result.body.error && result.body.error.message}`);
		assert.equal(result.body.value.total, 1);
		assert.equal(result.body.value.projects.length, 1);
		const project = result.body.value.projects[0];
		assert.equal(project.path, workspace);
		assert.equal(project.total, 1);
		assert.equal(project.sessions[0].title, '归档的那个');
		assert.equal(project.sessions[0].exists, true);
		assert.equal(project.sessions[0].bytes, 2048);
		assert.ok(project.sessions[0].archivedAt > 0, 'the log mtime stands in for the archive time');
		assert.equal(project.sessions[0].running, true, 'the controller summary supplies the running flag');
		assert.equal(project.sessions[0].live, true, 'agentAvailable marks the row live');
	});

	test('restores an archived session over HTTP', async () => {
		const id = fakeWorkspaces[0].sessionIds[0];
		const result = await archiveCall(port, 'restore', { sessionId: id });
		assert.equal(result.body.ok, true);
		assert.deepEqual(result.body.value.restored, [id]);
		assert.deepEqual(unarchived, [id]);
	});

	test('refuses a malformed session id on restore', async () => {
		const result = await archiveCall(port, 'restore', { sessionId: '../../etc/passwd' });
		assert.equal(result.body.ok, false);
		assert.match(result.body.error.message, /valid session id/u);
	});

	test('refuses to delete while a turn is running', async () => {
		const id = fakeWorkspaces[0].sessionIds[0];
		controllerItems.length = 0;
		controllerItems.push({ sessionId: id, running: true, agentAvailable: true, blank: false, updatedAt: 1000 });
		const result = await archiveCall(port, 'delete', { sessionIds: [id] });
		assert.equal(result.body.ok, true, `delete failed: ${result.body.error && result.body.error.message}`);
		assert.deepEqual(result.body.value.deleted, []);
		assert.equal(result.body.value.failed[0].code, 'running');
		assert.equal(fs.existsSync(path.join(home, 'sessions', '--scratch-workspace--', id)), true, 'a running session keeps its log');
		controllerItems.length = 0;
	});

	test('deletes an archived session and its log over HTTP', async () => {
		const id = fakeWorkspaces[0].sessionIds[0];
		const directory = path.join(home, 'sessions', '--scratch-workspace--', id);
		assert.equal(fs.existsSync(directory), true);
		/* The restore test above unarchived it; put it back for this one. */
		writeArchiveStore([id]);
		const result = await archiveCall(port, 'delete', { sessionIds: [id] });
		assert.equal(result.body.ok, true, `delete failed: ${result.body.error && result.body.error.message}`);
		assert.deepEqual(result.body.value.deleted, [id]);
		assert.deepEqual(result.body.value.failed, []);
		assert.ok(result.body.value.bytes >= 2048);
		assert.equal(fs.existsSync(directory), false, 'the session directory must be gone');
		assert.equal(fakeWorkspaces[0].sessionIds.includes(id), false, 'the workspace must forget it');
		assert.ok(unarchived.includes(id), 'the archive set must forget it');
		assert.ok(
			emitted.some((entry) => entry.name === 'api-session/removed' && entry.sessionId === id),
			'the browser must be told the session is gone'
		);
		const listed = await archiveCall(port, 'list', {});
		assert.equal(listed.body.value.total, 0);
	});

	test('answers an unknown archive method with a not-found envelope', async () => {
		const result = await archiveCall(port, 'nope', {});
		assert.equal(result.status, 404);
		assert.equal(result.body.ok, false);
		assert.match(result.body.error.message, /unknown archive-manager method/u);
	});

	test('fences the archive mount like the skill mount', async () => {
		const result = await archiveCall(port, 'list', {}, { headers: { 'content-type': 'application/json', origin: 'http://evil.example' } });
		assert.equal(result.status, 403);
		assert.equal(result.body.ok, false);
	});

	test('answers an unknown method with a not-found envelope', async () => {
		const result = await call(port, 'nope', {});
		assert.equal(result.status, 404);
		assert.equal(result.body.ok, false);
		assert.match(result.body.error.message, /unknown skill-manager method/u);
	});

	test('refuses a cross-site request before dispatch', async () => {
		const result = await call(port, 'list', { workspacePath: workspace }, { headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' } });
		assert.equal(result.status, 403);
		assert.equal(result.body.ok, false);
	});

	test('refuses a request whose Origin disagrees with the Host', async () => {
		const result = await call(port, 'list', { workspacePath: workspace }, { headers: { 'content-type': 'application/json', origin: 'http://evil.example' } });
		assert.equal(result.status, 403);
		assert.equal(result.body.ok, false);
	});

	let failed = 0;
	for (const item of cases) {
		try {
			await item.body();
			console.log(`  ok   ${item.name}`);
		} catch (error) {
			failed += 1;
			console.log(`  FAIL ${item.name}`);
			console.log(`       ${error && error.message ? error.message : error}`);
			if (error && error.cause) console.log(`       cause: ${error.cause && error.cause.message ? error.cause.message : error.cause}`);
		}
	}
	await new Promise((resolve) => server.close(resolve));
	console.log(`\n${cases.length - failed}/${cases.length} passed`);
	fs.rmSync(scratch, { recursive: true, force: true });
	process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error(error);
	fs.rmSync(scratch, { recursive: true, force: true });
	process.exit(1);
});
