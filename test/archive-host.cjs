'use strict';

/**
 * Archive Manager — host core harness.
 *
 * Exercises `lib/archive.cjs` against a throwaway DSH home: the durable archive
 * store, real session directories, real projection-cache records, and fake
 * `registry` / `query` / `sessions` services plus a fake HTTP request/response
 * pair. It covers the grouping rules, the restore call, every delete refusal,
 * the symlink guard, byte accounting, and the 403/404 fence.
 *
 * Run with `node test/archive-host.cjs`.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const archive = require('../lib/archive.cjs');

let checks = 0;
let failures = 0;

/** Print one check line and record a failure without aborting the run. */
function check(label, condition, detail) {
	checks += 1;
	if (condition) {
		console.log(`ok ${checks} - ${label}`);
		return;
	}
	failures += 1;
	process.exitCode = 1;
	console.log(`not ok ${checks} - ${label}${detail === void 0 ? '' : `: ${detail}`}`);
}

/** Structural equality for JSON-shaped values. */
function sameJson(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-host-'));
const home = path.join(scratch, 'home');
const sessionsRoot = path.join(home, 'sessions');
const storages = path.join(home, 'storages');
const workspaceFile = path.join(storages, 'workspace.json');
const encodedA = '--Users-u-work-other--';
const encodedB = '--Users-u-work-kingscript--';

/* ── ids under test ──────────────────────────────────────────────────────── */

const s1 = 'session-11111111-1111-4111-8111-111111111111';
const s2 = 'session-22222222-2222-4222-8222-222222222222';
const s3 = 'session-33333333-3333-4333-8333-333333333333';
const s4 = 'session-44444444-4444-4444-8444-444444444444';
const symlinkId = 'session-55555555-5555-4555-8555-555555555555';
const badId = 'session-nope';

/* ── fixture ─────────────────────────────────────────────────────────────── */

const pathA = '/Users/u/work/other';
const pathB = '/Users/u/work/kingscript';

const contentS1 = 'first archived session log\n';
const contentS2 = 'second archived session log with a bit more content\n';
const sizeS1 = Buffer.byteLength(contentS1);
const sizeS2 = Buffer.byteLength(contentS2);
const mtimeS1 = 1767000000123;
const mtimeS2 = 1767100000456;

const cacheS1 = '{"title":"first"}';
const cacheS2A = '{"title":"second"}';
const cacheS2B = '{"title":"second-alt"}';
const cacheRootA = path.join(storages, 'session_projcache', 'sessions');
const cacheRootB = path.join(storages, 'session_projcache_archive_manager_v2', 'sessions');

const dirS1 = path.join(sessionsRoot, encodedA, s1);
const dirS2 = path.join(sessionsRoot, encodedB, s2);
const logS1 = path.join(dirS1, 'session.v4.jsonl.zstd');
const logS2 = path.join(dirS2, 'session.v4.jsonl.zstd');
const cacheS1Path = path.join(cacheRootA, `${s1}.json`);
const cacheS2PathA = path.join(cacheRootA, `${s2}.json`);
const cacheS2PathB = path.join(cacheRootB, `${s2}.json`);

/** The fake registry's durable view; rewritten whenever it unarchives. */
const archived = new Set([s1, s2, s3]);

/** Fake workspaces, in registry order. */
const workspaces = [
	{ id: 'ws-a', path: pathA, title: 'other', sessionIds: [s1] },
	{ id: 'ws-b', path: pathB, title: 'kingscript', sessionIds: [s2] }
];
const calls = { detach: [], unarchive: [] };

/** Rewrite the durable store the way the real registry service would. */
function writeWorkspace() {
	const tables = {};
	for (const workspace of workspaces) {
		tables[workspace.id] = {
			path: workspace.path,
			title: workspace.title,
			sessionIds: workspace.sessionIds.slice(),
			createdAt: '2026-10-01T00:00:00.000Z',
			updatedAt: '2026-10-02T00:00:00.000Z'
		};
	}
	fs.mkdirSync(path.dirname(workspaceFile), { recursive: true });
	fs.writeFileSync(
		workspaceFile,
		JSON.stringify(
			{
				unit: { name: 'workspace', version: 2 },
				global: { initialized: true, archivedSessionIds: [...archived], pinnedSessionIds: [] },
				tables: { workspaces: tables }
			},
			null,
			2
		)
	);
}

for (const workspace of workspaces) {
	workspace.detachSession = async (id) => {
		calls.detach.push(`${workspace.id}:${id}`);
		const index = workspace.sessionIds.indexOf(id);
		if (index >= 0) workspace.sessionIds.splice(index, 1);
	};
}

const registry = {
	list: () => workspaces,
	async unarchiveSession(id) {
		calls.unarchive.push(id);
		if (!archived.has(id)) throw new Error(`not archived: ${id}`);
		archived.delete(id);
		writeWorkspace();
	}
};

const records = [
	{ header: { id: s2, createdAt: 2000, cwd: pathB }, live: false, persisted: true },
	{ header: { id: s1, createdAt: 1000, cwd: pathA }, live: true, persisted: true }
];

const queryCalls = { title: [] };
const query = {
	async listSessions() {
		return records;
	},
	async readTitleSnapshots(ids) {
		queryCalls.title.push(ids.slice());
		return ids.map((id) => {
			if (id === s1) {
				return {
					sessionId: id,
					status: 'fulfilled',
					value: { session: { id }, title: { title: '归档管理插件开发', eventSeq: 3, updatedAt: 500 } }
				};
			}
			if (id === s2) return { sessionId: id, status: 'fulfilled', value: { session: { id } } };
			return { sessionId: id, status: 'rejected', reason: 'session log is gone' };
		});
	}
};

const memoryCalls = [];
const sessions = {
	get(id) {
		memoryCalls.push(id);
		return id === s1 ? { id } : void 0;
	}
};

/* Files: two real sessions, one archived id with no directory, cache records. */
fs.mkdirSync(dirS1, { recursive: true });
fs.mkdirSync(dirS2, { recursive: true });
for (const root of [cacheRootA, cacheRootB]) fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(logS1, contentS1);
fs.writeFileSync(logS2, contentS2);
fs.utimesSync(logS1, new Date(mtimeS1), new Date(mtimeS1));
fs.utimesSync(logS2, new Date(mtimeS2), new Date(mtimeS2));
fs.writeFileSync(cacheS1Path, cacheS1);
fs.writeFileSync(cacheS2PathA, cacheS2A);
fs.writeFileSync(cacheS2PathB, cacheS2B);
writeWorkspace();

/** Build a handler around the fakes, with optional service overrides. */
function makeHandler(overrides) {
	return archive.createHandler({
		trustedHosts: () => [],
		registry: () => registry,
		query: () => query,
		sessions: () => sessions,
		home: () => home,
		...overrides
	});
}

/**
 * Drive the handler with a fake node request/response pair.
 * @returns `{ status, headers, body }`.
 */
function call(handler, method, body, extraHeaders) {
	const headers = {
		host: '127.0.0.1:60000',
		'content-type': 'application/json',
		...extraHeaders
	};
	return new Promise((resolve, reject) => {
		const request = {
			method: 'POST',
			url: `/archive-manager/api/${method}`,
			headers,
			async *[Symbol.asyncIterator]() {
				if (body !== void 0) yield Buffer.from(JSON.stringify(body));
			}
		};
		const response = {
			statusCode: 0,
			headers: null,
			writeHead(status, responseHeaders) {
				this.statusCode = status;
				this.headers = responseHeaders;
			},
			end(chunk) {
				let parsed;
				try {
					parsed = JSON.parse(String(chunk));
				} catch (error) {
					reject(new Error(`response was not JSON: ${String(chunk)}`));
					return;
				}
				resolve({ status: this.statusCode, headers: this.headers, body: parsed });
			}
		};
		Promise.resolve(handler(request, response)).catch(reject);
	});
}

(async () => {
	try {
		const handler = makeHandler({});
		const invoke = (method, body, extraHeaders) => call(handler, method, body, extraHeaders);

		/* ── pure helpers ──────────────────────────────────────────────── */

		check('readArchivedIds returns the durable set', sameJson(archive.readArchivedIds(home), [s1, s2, s3]));
		const indexed = archive.indexSessionFiles(home);
		check('indexSessionFiles finds both session directories', indexed.size === 2);
		check('indexSessionFiles indexes by the directory basename', indexed.get(s1).directory === dirS1);
		check('indexSessionFiles records the log size', indexed.get(s1).bytes === sizeS1, String(indexed.get(s1).bytes));
		check('indexSessionFiles records the log mtime', Math.round(indexed.get(s1).logMtimeMs) === mtimeS1);
		check('indexSessionFiles omits the archived id with no directory', indexed.has(s3) === false);
		check('readArchivedIds tolerates a missing store', sameJson(archive.readArchivedIds(path.join(scratch, 'nope')), []));

		/* ── list ──────────────────────────────────────────────────────── */

		const listed = await invoke('list', {});
		check('list responds 200', listed.status === 200, String(listed.status));
		check('list wraps the value in { ok: true }', listed.body.ok === true);
		const value = listed.body.value;
		check('list echoes the home directory', value.home === home);
		check('list totals every archived id', value.total === 3, String(value.total));
		check('list sums log bytes', value.bytes === sizeS1 + sizeS2, String(value.bytes));
		check('list returns only projects owning archived sessions', value.projects.length === 2, String(value.projects.length));
		check(
			'projects follow registry order',
			value.projects.map((project) => project.id).join(',') === 'ws-a,ws-b'
		);

		const projectA = value.projects[0];
		const projectB = value.projects[1];
		check('ws-a totals one session', projectA.total === 1 && projectA.bytes === sizeS1);
		check('ws-a keeps its title and path', projectA.title === 'other' && projectA.path === pathA);
		const rowA = projectA.sessions[0];
		check('ws-a row is the session whose cwd is under it', rowA.id === s1);
		check('the title snapshot supplies the title', rowA.title === '归档管理插件开发', JSON.stringify(rowA.title));
		check('the header cwd is reported verbatim', rowA.cwd === pathA);
		check('createdAt comes from the session header', rowA.createdAt === 1000, String(rowA.createdAt));
		check('archivedAt is the log file mtime', Math.round(rowA.archivedAt) === mtimeS1, String(rowA.archivedAt));
		check('bytes is the log file size', rowA.bytes === sizeS1, String(rowA.bytes));
		check('the row points at the discovered directory', rowA.directory === dirS1);
		check('an on-disk archived session exists', rowA.exists === true);
		check('a live session is flagged live', rowA.live === true);

		check('ws-b totals one session', projectB.total === 1 && projectB.bytes === sizeS2);
		const rowB = projectB.sessions[0];
		check('ws-b row is the session whose cwd is under it', rowB.id === s2);
		check('a session without a title snapshots to ""', rowB.title === '', JSON.stringify(rowB.title));
		check('a non-live session is not flagged live', rowB.live === false);
		check('ws-b archivedAt is its log mtime', Math.round(rowB.archivedAt) === mtimeS2, String(rowB.archivedAt));

		check('ungrouped holds the archived id with no directory', value.ungrouped.total === 1);
		check('ungrouped bytes are zero for a missing log', value.ungrouped.bytes === 0);
		const orphan = value.ungrouped.sessions[0];
		check('the orphan row is the missing session', orphan.id === s3);
		check('the orphan row is marked missing', orphan.exists === false);
		check('the orphan cwd is "" when no workspace accounts for it', orphan.cwd === '');
		check('the orphan directory is ""', orphan.directory === '');
		check('the orphan archivedAt is 0', orphan.archivedAt === 0);
		check('the orphan createdAt is 0', orphan.createdAt === 0);

		check('the orphan title is ""', orphan.title === '');
		check(
			'one title snapshot call covers every archived id',
			queryCalls.title.length === 1 && sameJson(queryCalls.title[0], [s1, s2, s3])
		);
		check('the in-memory store is consulted for liveness', memoryCalls.includes(s1));

		/* ── running vs open ──────────────────────────────────────────── */

		const controller = {
			async list() {
				return {
					items: [
						{ sessionId: s1, running: true, agentAvailable: true, blank: false, updatedAt: 1 },
						{ sessionId: s2, running: false, agentAvailable: true, blank: false, updatedAt: 2 }
					]
				};
			}
		};
		const withController = await call(makeHandler({ controller: () => controller }), 'list', {});
		const summaryRows = [];
		for (const project of withController.body.value.projects) summaryRows.push(...project.sessions);
		summaryRows.push(...withController.body.value.ungrouped.sessions);
		const byId = new Map(summaryRows.map((row) => [row.id, row]));
		check('a summary with running=true marks the row running', byId.get(s1).running === true);
		check('a summary with agentAvailable=true marks the row live', byId.get(s1).live === true);
		check('an idle open session is live but not running', byId.get(s2).live === true && byId.get(s2).running === false);
		check('a composition without a controller reports running=false', rowA.running === false);

		const brokenController = await call(
			makeHandler({ controller: () => ({ list: async () => { throw new Error('controller unavailable'); } }) }),
			'list',
			{}
		);
		check('a failing controller degrades to an empty summary map', brokenController.body.ok === true && brokenController.body.value.total === 3);

		/* ── degraded compositions ─────────────────────────────────────── */

		const noRegistry = await call(makeHandler({ registry: () => void 0 }), 'list', {});
		check('list without a registry still responds', noRegistry.status === 200 && noRegistry.body.ok === true);
		check(
			'list without a registry puts every archived session under ungrouped',
			noRegistry.body.value.projects.length === 0 && noRegistry.body.value.ungrouped.total === 3
		);
		const noQuery = await call(makeHandler({ query: () => void 0 }), 'list', {});
		check('list without session history fails cleanly', noQuery.status === 200 && noQuery.body.ok === false);
		check(
			'list without session history explains itself',
			noQuery.body.error.code === 'failed' && noQuery.body.error.message.includes('session history')
		);

		/* ── restore ───────────────────────────────────────────────────── */

		const restored = await invoke('restore', { sessionId: s1 });
		check('restore responds 200', restored.status === 200);
		check('restore reports the id', restored.body.ok === true && sameJson(restored.body.value.restored, [s1]));
		check('restore unarchives through the registry', calls.unarchive.includes(s1));
		check('restore drops the id from the durable set', !archive.readArchivedIds(home).includes(s1));
		const badRestore = await invoke('restore', { sessionId: badId });
		check('restore refuses a malformed id', badRestore.body.ok === false && badRestore.body.error.code === 'failed');

		/* ── delete refusals ───────────────────────────────────────────── */

		const detachBefore = calls.detach.length;
		const liveDelete = await invoke('delete', { sessionIds: [s1] });
		check('delete answers in the 200 envelope', liveDelete.status === 200 && liveDelete.body.ok === true);
		check('delete refuses a live session', liveDelete.body.value.deleted.length === 0 && liveDelete.body.value.failed.length === 1);
		check(
			'delete explains the live refusal',
			liveDelete.body.value.failed[0].sessionId === s1 && liveDelete.body.value.failed[0].message.includes('live agent') && liveDelete.body.value.failed[0].code === 'live'
		);
		check('a live refusal leaves the session directory alone', fs.existsSync(dirS1));
		check('a live refusal detaches nothing', calls.detach.length === detachBefore);

		const badDelete = await invoke('delete', { sessionIds: [badId] });
		check(
			'delete refuses a malformed id',
			badDelete.body.value.deleted.length === 0 &&
				badDelete.body.value.failed[0].message.includes('malformed') && badDelete.body.value.failed[0].code === 'malformed'
		);
		const notArchived = await invoke('delete', { sessionIds: [s4] });
		check(
			'delete refuses a non-archived id',
			notArchived.body.value.deleted.length === 0 &&
				notArchived.body.value.failed[0].message.includes('not archived') && notArchived.body.value.failed[0].code === 'not-archived'
		);
		const badBody = await invoke('delete', {});
		check(
			'a malformed delete body is a failed envelope',
			badBody.body.ok === false && badBody.body.error.message.includes('sessionIds')
		);
		check('a malformed delete body mutates nothing', !fs.existsSync(path.join(sessionsRoot, encodedA, s2)));

		/* ── delete: one real session ──────────────────────────────────── */

		const unarchiveBefore = calls.unarchive.length;
		const expectedBytes = sizeS2 + Buffer.byteLength(cacheS2A) + Buffer.byteLength(cacheS2B);
		const deleted = await invoke('delete', { sessionIds: [s2] });
		const deletedValue = deleted.body.value;
		check('delete succeeds in the 200 envelope', deleted.status === 200 && deleted.body.ok === true);
		check('delete reports the deleted id', sameJson(deletedValue.deleted, [s2]));
		check('delete reports no failures', deletedValue.failed.length === 0, JSON.stringify(deletedValue.failed));
		check('delete reports the freed bytes', deletedValue.bytes === expectedBytes, `${deletedValue.bytes} vs ${expectedBytes}`);
		check('delete removes the session directory', fs.existsSync(dirS2) === false);
		check('delete removes the cache record in the first projcache root', fs.existsSync(cacheS2PathA) === false);
		check('delete removes the cache record in every projcache sibling', fs.existsSync(cacheS2PathB) === false);
		check('delete leaves other sessions\u2019 cache records alone', fs.existsSync(cacheS1Path));
		check('delete detaches from the accounting workspace', calls.detach.includes(`ws-b:${s2}`));
		check('delete drops the workspace accounting', !workspaces[1].sessionIds.includes(s2));
		check('delete unarchives through the registry', calls.unarchive.length === unarchiveBefore + 1 && calls.unarchive.includes(s2));
		check('delete drops the id from the durable set', !archive.readArchivedIds(home).includes(s2));

		/* ── delete: symlink guard ─────────────────────────────────────── */

		const outside = path.join(scratch, 'outside-target');
		const outsideFile = path.join(outside, 'keep.txt');
		fs.mkdirSync(outside, { recursive: true });
		fs.writeFileSync(outsideFile, 'must not be deleted');
		const escapedRoot = path.join(sessionsRoot, '--escaped--');
		fs.mkdirSync(escapedRoot, { recursive: true });
		fs.symlinkSync(outside, path.join(escapedRoot, symlinkId), 'dir');
		archived.add(symlinkId);
		writeWorkspace();

		const symlinkIndex = archive.indexSessionFiles(home);
		check('indexSessionFiles flags a symlinked session directory', symlinkIndex.get(symlinkId).symlink === true);
		const unarchiveBeforeSymlink = calls.unarchive.length;
		const symlinkDelete = await invoke('delete', { sessionIds: [symlinkId] });
		check(
			'delete refuses a symlinked session directory',
			symlinkDelete.body.value.deleted.length === 0 &&
				symlinkDelete.body.value.failed.length === 1 &&
				symlinkDelete.body.value.failed[0].message.includes('symbolic link') && symlinkDelete.body.value.failed[0].code === 'unsafe'
		);
		check('a symlink refusal does not follow the link', fs.existsSync(outsideFile));
		check('a symlink refusal leaves the id archived', archive.readArchivedIds(home).includes(symlinkId));
		check('a symlink refusal does not unarchive', calls.unarchive.length === unarchiveBeforeSymlink);

		/* ── delete: per-item failures never abort the batch ───────────── */

		const batch = await invoke('delete', { sessionIds: [symlinkId, s3, badId] });
		const batchValue = batch.body.value;
		check('a batch keeps going past a refusal', sameJson(batchValue.deleted, [s3]));
		check('a batch reports every failure', batchValue.failed.length === 2, String(batchValue.failed.length));
		check('a batch keeps failure order', sameJson(batchValue.failed.map((item) => item.sessionId), [symlinkId, badId]));
		check('deleting an archived id with no directory still works', calls.unarchive.includes(s3));
		check('a directoryless deletion frees zero bytes', batchValue.bytes === 0);

		/* ── request fence ─────────────────────────────────────────────── */

		const forbidden = await invoke('list', {}, { host: 'evil.example.com' });
		check('an untrusted host is forbidden', forbidden.status === 403, String(forbidden.status));
		check('a refusal is the forbidden envelope', forbidden.body.error.code === 'forbidden');
		const crossSite = await invoke('list', {}, { 'sec-fetch-site': 'cross-site' });
		check('a cross-site request is forbidden', crossSite.status === 403);
		const unknown = await invoke('nope', {});
		check('an unknown method is 404', unknown.status === 404, String(unknown.status));
		check('an unknown method reports not-found', unknown.body.error.code === 'not-found');
	} catch (error) {
		failures += 1;
		process.exitCode = 1;
		console.log(`not ok ${checks + 1} - harness crashed: ${error && error.stack ? error.stack : error}`);
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}

	console.log(failures === 0 ? `ok: ${checks} checks passed` : `not ok: ${failures} of ${checks} checks failed`);
})();
