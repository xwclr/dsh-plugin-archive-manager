'use strict';

/**
 * Archive Manager — host half core.
 *
 * This module owns every decision about which archived session ids may be
 * touched and which files on disk belong to them. It is mounted as a plain JSON
 * route (`/archive-manager/api/<method>`) on the host's own web server, fenced
 * exactly like the skill-manager route next door.
 *
 * The durable source of truth for "archived" is
 * `<home>/storages/workspace.json` → `global.archivedSessionIds`. It is read
 * fresh on every request: the Workspace registry service mutates it, and a
 * cached copy would disagree after a restore or unarchive. Session directories
 * live under `<home>/sessions/<encoded-cwd>/session-<uuid>/`; the encoded cwd is
 * never decoded, the tree is scanned once per request and indexed by the
 * directory basename.
 *
 * Nothing here trusts an id that arrived over the wire. Every mutation starts
 * from the discovered directory and cache paths, and containment is decided
 * with `path.relative`, never `String.includes`. A session directory symlink is
 * refused outright: deleting through it could remove a directory outside
 * `<home>/sessions`.
 *
 * This file is CommonJS on purpose. `lib/index.js` re-requires it on every
 * apply so a locally edited copy converges through a plugin toggle instead of a
 * process restart.
 */

const fs = require('node:fs');
const path = require('node:path');

/** The route prefix the plugin owns. */
const ROUTE = '/archive-manager/api';
/** Cap on one request body, matching the skill-manager route. */
const BODY_LIMIT = 1024 * 1024;
/** The only session ids this plugin will act on. */
const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The durable session log inside one session directory. */
const SESSION_LOG = 'session.v4.jsonl.zstd';
/** Prefix of the projection-cache siblings that hold per-session records. */
const PROJECTION_PREFIX = 'session_projcache';

/** Whether a value is a well-formed session id. */
function isSessionId(value) {
	return typeof value === 'string' && SESSION_ID.test(value);
}

/** Readable text for an unknown thrown value. */
function messageOf(error) {
	return error !== null && error !== void 0 && error.message ? String(error.message) : String(error);
}

/**
 * Whether `target` is strictly below `base`, decided by path segments.
 * @param base - the containing directory.
 * @param target - the candidate path.
 * @returns true only for a proper descendant.
 */
function isInside(base, target) {
	const relative = path.relative(path.resolve(base), path.resolve(target));
	return (
		relative.length > 0 &&
		relative !== '..' &&
		!relative.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relative)
	);
}

/* ── the durable archive set ─────────────────────────────────────────────── */

/**
 * Read the archived session ids from the durable workspace store.
 *
 * A missing or unparsable file means "nothing is archived": the page must still
 * render, and no user action should fail because the store was rewritten under
 * us. Only string entries are returned, in store order, without duplicates.
 * @param home - the DSH home directory.
 * @returns the archived session ids.
 */
function readArchivedIds(home) {
	let parsed;
	try {
		parsed = JSON.parse(fs.readFileSync(path.join(home, 'storages', 'workspace.json'), 'utf8'));
	} catch {
		return [];
	}
	const ids = parsed !== null && typeof parsed === 'object' && parsed.global !== null && typeof parsed.global === 'object'
		? parsed.global.archivedSessionIds
		: void 0;
	if (!Array.isArray(ids)) return [];
	const seen = new Set();
	const archived = [];
	for (const id of ids) {
		if (typeof id !== 'string' || seen.has(id)) continue;
		seen.add(id);
		archived.push(id);
	}
	return archived;
}

/* ── on-disk discovery ───────────────────────────────────────────────────── */

/**
 * Index every session directory under `<home>/sessions` by its id.
 *
 * The scan is one level deep: `<home>/sessions/<encoded-cwd>/session-<uuid>`.
 * The encoded cwd is opaque and never decoded — the id is the directory
 * basename. A symlinked session directory is indexed but flagged, so listing can
 * show it while delete refuses to walk it. Symlinked encoded-cwd directories are
 * not descended at all.
 * @param home - the DSH home directory.
 * @returns a Map from session id to a `SessionFile` record:
 *   `{ id, directory, symlink, logPath, logMtimeMs, directoryMtimeMs, bytes }`,
 *   where `bytes` is the log size (0 when the log is missing) and
 *   `logMtimeMs` is null in that case.
 */
function indexSessionFiles(home) {
	const index = new Map();
	const root = path.join(home, 'sessions');
	let rootStat;
	try {
		rootStat = fs.lstatSync(root);
	} catch {
		return index;
	}
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return index;
	let encodedDirectories;
	try {
		encodedDirectories = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return index;
	}
	encodedDirectories.sort((left, right) => left.name.localeCompare(right.name));
	for (const encoded of encodedDirectories) {
		if (!encoded.isDirectory()) continue;
		const encodedPath = path.join(root, encoded.name);
		if (!isInside(root, encodedPath)) continue;
		let children;
		try {
			children = fs.readdirSync(encodedPath);
		} catch {
			continue;
		}
		children.sort();
		for (const name of children) {
			if (!isSessionId(name) || index.has(name)) continue;
			const directory = path.join(encodedPath, name);
			if (!isInside(root, directory)) continue;
			let directoryStat;
			try {
				directoryStat = fs.lstatSync(directory);
			} catch {
				continue;
			}
			if (!directoryStat.isSymbolicLink() && !directoryStat.isDirectory()) continue;
			const record = {
				id: name,
				directory,
				symlink: directoryStat.isSymbolicLink(),
				logPath: null,
				logMtimeMs: null,
				directoryMtimeMs: directoryStat.mtimeMs,
				bytes: 0
			};
			if (!record.symlink) {
				const logPath = path.join(directory, SESSION_LOG);
				try {
					const logStat = fs.lstatSync(logPath);
					if (logStat.isFile()) {
						record.logPath = logPath;
						record.logMtimeMs = logStat.mtimeMs;
						record.bytes = logStat.size;
					}
				} catch {
					/* no log: the directory still exists, so the row stays */
				}
			}
			index.set(name, record);
		}
	}
	return index;
}

/**
 * Sum the regular-file bytes under a path without following symlinks.
 * Used to report the space a delete actually frees.
 * @param target - a file or directory.
 * @returns the total size in bytes.
 */
function measureBytes(target) {
	let total = 0;
	const pending = [target];
	while (pending.length > 0) {
		const current = pending.pop();
		let stat;
		try {
			stat = fs.lstatSync(current);
		} catch {
			continue;
		}
		if (stat.isSymbolicLink()) continue;
		if (stat.isDirectory()) {
			let children;
			try {
				children = fs.readdirSync(current);
			} catch {
				continue;
			}
			for (const child of children) pending.push(path.join(current, child));
			continue;
		}
		if (stat.isFile()) total += stat.size;
	}
	return total;
}

/** Reject a directory chain whose every segment must be a real directory. */
function assertRealDirectory(base, target) {
	const baseStat = fs.lstatSync(base);
	if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) {
		throw new Error(`refusing to remove ${target}: ${base} is not a real directory`);
	}
	const relative = path.relative(base, target);
	if (
		relative.length === 0 ||
		relative === '..' ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		throw new Error(`refusing to remove ${target}: it is outside ${base}`);
	}
	let current = base;
	for (const segment of relative.split(path.sep)) {
		current = path.join(current, segment);
		let stat;
		try {
			stat = fs.lstatSync(current);
		} catch {
			throw new Error(`refusing to remove ${target}: ${current} does not exist`);
		}
		if (stat.isSymbolicLink()) {
			throw new Error(`refusing to remove ${target}: ${current} is a symbolic link`);
		}
		if (!stat.isDirectory()) {
			throw new Error(`refusing to remove ${target}: ${current} is not a directory`);
		}
	}
}

/**
 * The real projection-cache sibling directories, sorted for determinism.
 * A symlinked sibling is ignored: only real directories under
 * `<home>/storages` are deletion targets.
 * @param home - the DSH home directory.
 * @returns absolute cache-root directories.
 */
function listCacheRoots(home) {
	const storages = path.join(home, 'storages');
	let storagesStat;
	try {
		storagesStat = fs.lstatSync(storages);
	} catch {
		return [];
	}
	if (storagesStat.isSymbolicLink() || !storagesStat.isDirectory()) return [];
	let entries;
	try {
		entries = fs.readdirSync(storages, { withFileTypes: true });
	} catch {
		return [];
	}
	const roots = [];
	for (const entry of entries) {
		if (!entry.name.startsWith(PROJECTION_PREFIX) || !entry.isDirectory()) continue;
		roots.push(path.join(storages, entry.name));
	}
	roots.sort();
	return roots;
}

/* ── grouping (pure) ─────────────────────────────────────────────────────── */

/** Resolve a path for comparison, or '' when it is not a usable string. */
function comparablePath(value) {
	if (typeof value !== 'string' || value.length === 0) return '';
	try {
		return path.resolve(value);
	} catch {
		return '';
	}
}

/** Coerce a timestamp that may arrive as a number or an ISO string. */
function timestampOf(value) {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.length > 0) {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : 0;
	}
	return 0;
}

/** The proxy archive timestamp for one indexed session. */
function archiveTimestamp(file) {
	if (file === void 0) return 0;
	if (typeof file.logMtimeMs === 'number' && Number.isFinite(file.logMtimeMs)) return file.logMtimeMs;
	if (typeof file.directoryMtimeMs === 'number' && Number.isFinite(file.directoryMtimeMs)) return file.directoryMtimeMs;
	return 0;
}

/** Normalize the workspace objects the registry service hands us. */
function normalizeWorkspaces(workspaces) {
	const normalized = [];
	if (!Array.isArray(workspaces)) return normalized;
	const seen = new Set();
	for (const workspace of workspaces) {
		if (workspace === null || typeof workspace !== 'object') continue;
		const id = workspace.id === void 0 || workspace.id === null ? '' : String(workspace.id);
		if (id !== '' && seen.has(id)) continue;
		if (id !== '') seen.add(id);
		normalized.push({
			id,
			path: typeof workspace.path === 'string' ? workspace.path : '',
			title: typeof workspace.title === 'string' ? workspace.title : '',
			sessionIds: Array.isArray(workspace.sessionIds)
				? workspace.sessionIds.filter((entry) => typeof entry === 'string')
				: []
		});
	}
	return normalized;
}

/** Normalize a title map (Map or plain object) into a Map. */
function normalizeTitles(titles) {
	if (titles instanceof Map) return titles;
	const normalized = new Map();
	if (titles !== null && typeof titles === 'object') {
		for (const id of Object.keys(titles)) {
			if (typeof titles[id] === 'string') normalized.set(id, titles[id]);
		}
	}
	return normalized;
}

/** Normalize a live-id collection into a Set. */
function normalizeLiveIds(liveIds) {
	if (liveIds instanceof Set) return liveIds;
	if (Array.isArray(liveIds)) return new Set(liveIds.filter((id) => typeof id === 'string'));
	return new Set();
}

/**
 * Resolve a session's project from its cwd: exact match first, then the longest
 * `workspace + separator` prefix.
 * @param cwd - the recorded session cwd.
 * @param workspaces - normalized workspaces in registry order.
 * @returns the matching workspace, or undefined.
 */
function workspaceForCwd(cwd, workspaces) {
	const resolved = comparablePath(cwd);
	if (resolved === '') return void 0;
	let match;
	let matchLength = -1;
	for (const workspace of workspaces) {
		const base = comparablePath(workspace.path);
		if (base === '') continue;
		if (base === resolved) return workspace;
		const prefix = base.endsWith(path.sep) ? base : `${base}${path.sep}`;
		if (resolved.startsWith(prefix) && base.length > matchLength) {
			match = workspace;
			matchLength = base.length;
		}
	}
	return match;
}

/** Newest activity first, then newest creation, then id — deterministic. */
function compareSessions(left, right) {
	return (
		right.archivedAt - left.archivedAt ||
		right.createdAt - left.createdAt ||
		(left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
	);
}

/**
 * Build the `list` value from already-gathered facts. Pure.
 *
 * Project resolution follows the contract: a session's header `cwd` first
 * (exact path, then longest prefix), then the workspace whose `sessionIds`
 * still accounts for the id, else `ungrouped`. Only workspaces owning at least
 * one archived session are returned, in registry order.
 * @param input - `{ archivedIds, workspaces, records, files, titles, liveIds }`
 *   where `records` are `sessionQuery.listSessions()` entries, `files` is an
 *   `indexSessionFiles()` Map, `titles` is a Map/object of id → title, and
 *   `liveIds` is a Set/array of ids known to be live.
 * @returns `{ total, bytes, projects, ungrouped }` in the documented shape.
 */
function groupSessions(input) {
	const source = input === null || input === void 0 ? {} : input;
	const archivedIds = Array.isArray(source.archivedIds) ? source.archivedIds : [];
	const workspaces = normalizeWorkspaces(source.workspaces);
	const records = Array.isArray(source.records) ? source.records : [];
	const files = source.files instanceof Map ? source.files : new Map();
	const titles = normalizeTitles(source.titles);
	const liveIds = normalizeLiveIds(source.liveIds);
	const runningIds = normalizeLiveIds(source.runningIds);

	const recordById = new Map();
	for (const record of records) {
		if (record === null || typeof record !== 'object') continue;
		const header = record.header;
		const id = header !== null && typeof header === 'object' && typeof header.id === 'string' ? header.id : void 0;
		if (id !== void 0 && !recordById.has(id)) recordById.set(id, record);
	}

	const buckets = new Map();
	const ungrouped = [];
	const seen = new Set();
	for (const archivedId of archivedIds) {
		if (typeof archivedId !== 'string' || seen.has(archivedId)) continue;
		seen.add(archivedId);
		const record = recordById.get(archivedId);
		const header = record !== null && record !== void 0 && record.header !== null && typeof record.header === 'object'
			? record.header
			: {};
		const rawCwd = typeof header.cwd === 'string' ? header.cwd : '';
		let workspace = rawCwd === '' ? void 0 : workspaceForCwd(rawCwd, workspaces);
		if (workspace === void 0) workspace = workspaces.find((candidate) => candidate.sessionIds.includes(archivedId));
		const file = files.get(archivedId);
		const title = titles.get(archivedId);
		const entry = {
			id: archivedId,
			title: typeof title === 'string' ? title : '',
			cwd: rawCwd !== '' ? rawCwd : workspace === void 0 ? '' : workspace.path,
			createdAt: timestampOf(header.createdAt),
			archivedAt: archiveTimestamp(file),
			bytes: file !== void 0 && typeof file.bytes === 'number' && Number.isFinite(file.bytes) ? file.bytes : 0,
			directory: file !== void 0 && typeof file.directory === 'string' ? file.directory : '',
			exists: file !== void 0,
			live: liveIds.has(archivedId),
			running: runningIds.has(archivedId)
		};
		if (workspace === void 0) {
			ungrouped.push(entry);
			continue;
		}
		let bucket = buckets.get(workspace.id);
		if (bucket === void 0) {
			bucket = { workspace, sessions: [] };
			buckets.set(workspace.id, bucket);
		}
		bucket.sessions.push(entry);
	}

	const summarize = (sessions) => {
		sessions.sort(compareSessions);
		let bytes = 0;
		for (const session of sessions) bytes += session.bytes;
		return { total: sessions.length, bytes, sessions };
	};

	const projects = [];
	let total = 0;
	let bytes = 0;
	for (const workspace of workspaces) {
		const bucket = buckets.get(workspace.id);
		if (bucket === void 0 || bucket.sessions.length === 0) continue;
		const summary = summarize(bucket.sessions);
		projects.push({
			id: workspace.id,
			title: workspace.title,
			path: workspace.path,
			total: summary.total,
			bytes: summary.bytes,
			sessions: summary.sessions
		});
		total += summary.total;
		bytes += summary.bytes;
	}
	const rest = summarize(ungrouped);
	total += rest.total;
	bytes += rest.bytes;
	return { total, bytes, projects, ungrouped: rest };
}

/* ── the HTTP surface ────────────────────────────────────────────────────── */

/** Read a request body as JSON, with a size cap. */
async function readJsonBody(request) {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of request) {
		bytes += chunk.length;
		if (bytes > BODY_LIMIT) throw new Error('request body too large');
		chunks.push(chunk);
	}
	if (chunks.length === 0) return {};
	const text = Buffer.concat(chunks).toString('utf8').trim();
	return text.length === 0 ? {} : JSON.parse(text);
}

/** Write one JSON response. */
function writeJson(response, status, payload) {
	const body = JSON.stringify(payload);
	response.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'content-length': Buffer.byteLength(body)
	});
	response.end(body);
}

/** Whether an authority names this machine. */
function isLoopback(hostname) {
	if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true;
	const parts = hostname.split('.');
	return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255);
}

/**
 * Whether one request may reach this plugin's routes.
 * @param request - node HTTP request.
 * @param trustedHosts - non-loopback authorities this deployment serves.
 * @returns true when the Host is ours and the browser markers are same-origin.
 */
function isTrustedRequest(request, trustedHosts) {
	const header = (name) => {
		const value = request.headers[name];
		return Array.isArray(value) ? value[0] : value;
	};
	const host = header('host');
	if (typeof host !== 'string' || host.length === 0) return false;
	let hostname;
	try {
		hostname = new URL(`http://${host}`).hostname;
	} catch {
		return false;
	}
	const trusted = isLoopback(hostname) || trustedHosts.some((entry) => String(entry).startsWith(hostname));
	if (!trusted) return false;
	if (header('sec-fetch-site') === 'cross-site') return false;
	const origin = header('origin');
	if (origin === undefined) return true;
	try {
		return new URL(origin).hostname === hostname;
	} catch {
		return false;
	}
}

/**
 * Build the request handler this plugin mounts.
 *
 * Every dependency is a getter: sibling services may still be activating when
 * the plugin applies, so each one is looked up at request time rather than once
 * at construction.
 * @param deps - `{ trustedHosts, registry, query, sessions, home }`, each a
 *   zero-argument function.
 * @returns a `(request, response) => Promise<void>` handler.
 */
function createHandler({ trustedHosts, registry, query, sessions, controller, home, emit }) {
	const methods = createApi({ trustedHosts, registry, query, sessions, controller, home, emit });
	return async (request, response) => {
		if (!isTrustedRequest(request, trustedHosts())) {
			writeJson(response, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } });
			return;
		}
		const method = new URL(request.url === void 0 ? '/' : request.url, 'http://dsh.internal').pathname.slice(ROUTE.length + 1);
		const handler = Object.hasOwn(methods, method) ? methods[method] : void 0;
		if (handler === void 0) {
			writeJson(response, 404, { ok: false, error: { code: 'not-found', message: `unknown archive-manager method "${method}"` } });
			return;
		}
		try {
			const payload = request.method === 'POST' ? await readJsonBody(request) : {};
			writeJson(response, 200, { ok: true, value: await handler(payload) });
		} catch (error) {
			writeJson(response, 200, {
				ok: false,
				error: { code: 'failed', message: messageOf(error) }
			});
		}
	};
}

/**
 * The method table. Lives here so a host-side edit takes effect on the next
 * plugin toggle; `lib/index.js` re-requires this module on every apply.
 * @param deps - the getters described on `createHandler`.
 * @returns the method table, keyed by wire method name.
 */
function createApi({ trustedHosts, registry, query, sessions, controller, home, emit }) {
	/* `trustedHosts` is read by the handler, not by the methods. */
	void trustedHosts;

	/** The home directory, re-read per request; a composition without one fails loudly. */
	function requireHome() {
		const value = home === void 0 || home === null ? void 0 : home();
		if (typeof value !== 'string' || value.length === 0) throw new Error('the DSH home directory is unavailable');
		return value;
	}

	/** The live workspace registry, or undefined when this composition has none. */
	function registryService() {
		const service = registry === void 0 || registry === null ? void 0 : registry();
		return service === void 0 || service === null ? void 0 : service;
	}

	/** The live sessions (in-memory) service, or undefined. */
	function sessionsService() {
		const service = sessions === void 0 || sessions === null ? void 0 : sessions();
		return service === void 0 || service === null ? void 0 : service;
	}

	/** The live session-query service, or undefined. */
	function queryService() {
		const service = query === void 0 || query === null ? void 0 : query();
		return service === void 0 || service === null ? void 0 : service;
	}

	/** The live session controller (the Remote list face), or undefined. */
	function controllerService() {
		const service = controller === void 0 || controller === null ? void 0 : controller();
		return service === void 0 || service === null ? void 0 : service;
	}

	/**
	 * The controller's session summaries, keyed by id.
	 *
	 * A summary carries the two facts archiving deliberately leaves alone:
	 * `agentAvailable` (a live agent still exists) and `running` (a turn is
	 * executing right now). They are different states — an archived session can
	 * be open and idle — so the page must not derive one from the other. A
	 * composition without this service, or a failing call, degrades to an empty
	 * map rather than failing the page.
	 * @param service - the live `sessionController`, or undefined.
	 * @returns `{ summaries, known }`: the summaries by session id and whether the
	 *   service answered at all.
	 */
	async function summariesOf(service) {
		const summaries = new Map();
		if (service === void 0 || typeof service.list !== 'function') return { summaries, known: false };
		let value;
		try {
			value = await service.list({}, AbortSignal.timeout(4000));
		} catch {
			return { summaries, known: false };
		}
		const items = value !== null && typeof value === 'object' && Array.isArray(value.items) ? value.items : [];
		for (const item of items) {
			if (item === null || typeof item !== 'object' || typeof item.sessionId !== 'string') continue;
			summaries.set(item.sessionId, item);
		}
		return { summaries, known: true };
	}

	/**
	 * Tell the browser that one Session no longer exists.
	 *
	 * Removing the log makes the Host's session list drop the id on its next read,
	 * but nothing refetches on its own: the archive row would vanish while the
	 * sidebar kept showing the deleted session under its workspace. The
	 * `api-session/removed` event is the documented catalog removal — the browser
	 * store applies it as a `remove` mutation — so a deletion walks out of both
	 * surfaces at once.
	 * @param sessionId - the Session that was deleted.
	 */
	function announceRemoved(sessionId) {
		if (typeof emit !== 'function') return;
		try {
			emit(sessionId);
		} catch {
			/* a browser that is not listening must never fail a completed delete */
		}
	}
	/** The registry's workspaces in registry order (empty when unavailable or broken). */
	function workspacesOf(service) {
		if (service === void 0 || typeof service.list !== 'function') return [];
		try {
			const list = service.list();
			return Array.isArray(list) ? list : [];
		} catch {
			return [];
		}
	}

	/** `listSessions()`, normalized to an array; an unavailable service yields []. */
	async function recordsOf(service) {
		if (service === void 0 || typeof service.listSessions !== 'function') return [];
		const records = await service.listSessions();
		return Array.isArray(records) ? records : [];
	}

	/** Ids the query service reports live. */
	function liveFromRecords(records) {
		const live = new Set();
		for (const record of records) {
			if (record === null || typeof record !== 'object' || record.live !== true) continue;
			const id = record.header !== null && typeof record.header === 'object' ? record.header.id : void 0;
			if (typeof id === 'string') live.add(id);
		}
		return live;
	}

	/**
	 * Extra live check through the in-memory store.
	 * A store that throws is treated as "live" so a broken composition refuses
	 * deletion instead of risking a live session.
	 */
	function isLiveInMemory(service, id) {
		if (service === void 0 || typeof service.get !== 'function') return false;
		try {
			return Boolean(service.get(id));
		} catch {
			return true;
		}
	}

	/** One `readTitleSnapshots` call; per-id failures become an empty title. */
	async function titlesOf(service, ids) {
		const titles = new Map();
		if (service === void 0 || typeof service.readTitleSnapshots !== 'function' || ids.length === 0) return titles;
		let snapshots;
		try {
			snapshots = await service.readTitleSnapshots(ids);
		} catch {
			return titles;
		}
		if (!Array.isArray(snapshots)) return titles;
		for (const snapshot of snapshots) {
			if (snapshot === null || typeof snapshot !== 'object' || snapshot.status !== 'fulfilled') continue;
			const id = snapshot.sessionId;
			const value = snapshot.value;
			const title = value !== null && typeof value === 'object' && value.title !== null && typeof value.title === 'object'
				? value.title.title
				: void 0;
			if (typeof id === 'string' && typeof title === 'string' && title.length > 0) titles.set(id, title);
		}
		return titles;
	}

	/**
	 * Plan a deletion without mutating anything.
	 *
	 * Proves the session directory is a real directory chain inside
	 * `<home>/sessions`, skips symlinked cache records, and measures the bytes a
	 * successful removal would free. Throws a per-item message when the target is
	 * unsafe; the caller adds it to `failed[]` and keeps going.
	 */
	function planRemoval(id, dshHome, files, cacheRoots) {
		const file = files.get(id);
		let directory = null;
		let bytes = 0;
		if (file !== void 0) {
			if (file.symlink) throw new Error('the session directory is a symbolic link; refusing to remove it');
			if (path.basename(file.directory) !== id) throw new Error('the session directory does not match its id');
			const sessionsRoot = path.join(dshHome, 'sessions');
			if (!isInside(sessionsRoot, file.directory)) throw new Error('the session directory is outside the sessions root');
			assertRealDirectory(sessionsRoot, file.directory);
			directory = file.directory;
			bytes += measureBytes(directory);
		}
		const storagesRoot = path.join(dshHome, 'storages');
		const cacheFiles = [];
		for (const cacheRoot of cacheRoots) {
			const target = path.join(cacheRoot, 'sessions', `${id}.json`);
			if (!isInside(storagesRoot, target)) continue;
			try {
				assertRealDirectory(storagesRoot, path.dirname(target));
			} catch {
				continue;
			}
			let stat;
			try {
				stat = fs.lstatSync(target);
			} catch {
				continue;
			}
			/* A symlinked cache record is skipped, never followed. */
			if (stat.isSymbolicLink() || !stat.isFile()) continue;
			cacheFiles.push({ path: target, bytes: stat.size });
			bytes += stat.size;
		}
		return { directory, cacheFiles, bytes };
	}

	return {
		/** Group every archived session by its registered project. */
		async list() {
			const dshHome = requireHome();
			const service = queryService();
			if (service === void 0) {
				throw new Error('cannot list archived sessions: this composition has no session history service');
			}
			const archivedIds = readArchivedIds(dshHome);
			const records = await recordsOf(service);
			const files = indexSessionFiles(dshHome);
			const liveIds = liveFromRecords(records);
			const memory = sessionsService();
			/* The query records already answer for most ids; the in-memory store is
			 * the second opinion and can still see a session the history missed. */
			for (const id of archivedIds) {
				if (isLiveInMemory(memory, id)) liveIds.add(id);
			}
			const runningIds = new Set();
			const summaryInfo = await summariesOf(controllerService());
			for (const [id, summary] of summaryInfo.summaries) {
				if (summary.agentAvailable === true) liveIds.add(id);
				if (summary.running === true) runningIds.add(id);
			}
			const titles = await titlesOf(service, archivedIds);
			const grouped = groupSessions({
				archivedIds,
				workspaces: workspacesOf(registryService()),
				records,
				files,
				titles,
				liveIds,
				runningIds
			});
			return {
				home: dshHome,
				total: grouped.total,
				bytes: grouped.bytes,
				projects: grouped.projects,
				ungrouped: grouped.ungrouped
			};
		},

		/** Drop one id from the durable archive set. */
		async restore(payload) {
			const id = payload === null || payload === void 0 ? void 0 : payload.sessionId;
			if (!isSessionId(id)) throw new Error('a valid session id is required');
			const service = registryService();
			if (service === void 0 || typeof service.unarchiveSession !== 'function') {
				throw new Error('cannot restore: this composition has no workspace registry');
			}
			await service.unarchiveSession(id);
			return { restored: [id] };
		},

		/**
		 * Delete archived sessions: detach, unarchive, remove the directory and the
		 * projection-cache records. Validation happens before any mutation, and a
		 * per-item refusal never aborts the rest of the batch.
		 */
		async delete(payload) {
			const sessionIds = payload === null || payload === void 0 ? void 0 : payload.sessionIds;
			if (!Array.isArray(sessionIds)) throw new Error('"sessionIds" must be an array of session ids');
			const dshHome = requireHome();
			const service = registryService();
			if (service === void 0 || typeof service.unarchiveSession !== 'function') {
				throw new Error('cannot delete: this composition has no workspace registry');
			}
			const history = queryService();
			const memory = sessionsService();
			if (history === void 0 && memory === void 0) {
				throw new Error('cannot verify live sessions: neither session history nor the session store is available');
			}
			const archived = new Set(readArchivedIds(dshHome));
			/* The session menu deletes a row that was never archived; the settings page
			 * only ever deletes archived ids. The flag names that difference instead of
			 * adding a second method with the same guards. */
			const anyId = payload !== null && typeof payload === 'object' && payload.any === true;
			const workspaces = workspacesOf(service);
			const files = indexSessionFiles(dshHome);
			const cacheRoots = listCacheRoots(dshHome);
			const records = await recordsOf(history);
			const live = liveFromRecords(records);
			const summaryInfo = await summariesOf(controllerService());
			const runningIds = new Set();
			for (const [id, summary] of summaryInfo.summaries) {
				if (summary.running === true) runningIds.add(id);
			}

			const failed = [];
			const deleted = [];
			let bytes = 0;
			const refuse = (sessionId, message, code) => failed.push({ sessionId, code: code === void 0 ? 'failed' : code, message });
			for (const rawId of sessionIds) {
				const id = typeof rawId === 'string' ? rawId : '';
				if (!isSessionId(id)) {
					refuse(typeof rawId === 'string' ? rawId : String(rawId), 'malformed session id', 'malformed');
					continue;
				}
				if (runningIds.has(id)) {
					refuse(id, 'a turn is running for this session: stop it before deleting', 'running');
					continue;
				}
				/* An archived session normally stays open in a window: that is a display
				 * state, not a reason to refuse. Only a composition that cannot answer the
				 * running flag keeps the conservative live guard. */
				if (!summaryInfo.known && (live.has(id) || isLiveInMemory(memory, id))) {
					refuse(id, 'a live agent owns this session and its running state is unavailable; switch to another session first', 'live');
					continue;
				}
				if (!anyId && !archived.has(id)) {
					refuse(id, 'session is not archived', 'not-archived');
					continue;
				}
				let plan;
				try {
					plan = planRemoval(id, dshHome, files, cacheRoots);
				} catch (error) {
					refuse(id, messageOf(error), 'unsafe');
					continue;
				}
				const owner = workspaces.find(
					(workspace) => Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(id)
				);
				try {
					if (owner !== void 0) await owner.detachSession(id);
					if (archived.has(id)) await service.unarchiveSession(id);
					/* Announce before the log disappears: the browser catalog removal is what
					 * stops the sidebar from resurrecting the row, and it must resolve while
					 * the session is still there. */
					announceRemoved(id);
					if (plan.directory !== null) fs.rmSync(plan.directory, { recursive: true, force: true });
					for (const file of plan.cacheFiles) fs.rmSync(file.path, { force: true });
					archived.delete(id);
					deleted.push(id);
					bytes += plan.bytes;
				} catch (error) {
					refuse(id, messageOf(error));
				}
			}
			return { deleted, bytes, failed };
		}
	};
}

module.exports = {
	PROJECTION_PREFIX,
	ROUTE,
	SESSION_ID,
	SESSION_LOG,
	assertRealDirectory,
	createApi,
	createHandler,
	groupSessions,
	indexSessionFiles,
	isInside,
	isLoopback,
	isSessionId,
	isTrustedRequest,
	listCacheRoots,
	measureBytes,
	readArchivedIds,
	readJsonBody,
	writeJson
};
