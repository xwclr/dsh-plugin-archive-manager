'use strict';

/**
 * Archive Manager — feature-switch harness.
 *
 * Boots the real `lib/index.js` against a fake Cordis context and checks the
 * three `Config` switches: a disabled feature must mount no route, the index
 * injection must always publish the resolved flags for the browser half, and
 * the schema itself must default to "everything on".
 *
 * Run with `node test/config-harness.cjs`.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-manager-config-'));
process.env.DSH_HOME = path.join(scratch, 'home');
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });
/* The plugin resolves `yaml` and `zod` from the runtime's module roots; the
 * desktop profile stands in for the runtime here. */
process.env.DSH_TEST_MODULE_ROOT = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'package.json');

let passed = 0;
const failures = [];
const check = (name, condition, detail) => {
	if (condition) {
		passed += 1;
		console.log(`ok ${passed} - ${name}`);
		return;
	}
	failures.push(name);
	console.log(`not ok ${passed + failures.length} - ${name}${detail === void 0 ? '' : `: ${detail}`}`);
};

/** A host context that records routes, index taps, and effects. */
function fakeContext() {
	const routes = [];
	const taps = [];
	const effects = [];
	const context = {
		routes,
		taps,
		effects,
		webServer: {
			register(route) {
				routes.push(route);
				return () => {};
			},
			tapIndex(transform) {
				taps.push(transform);
				return () => {};
			}
		},
		effect(callback, label) {
			effects.push(label);
			const dispose = callback();
			return () => {
				if (typeof dispose === 'function') dispose();
			};
		},
		get(name) {
			if (name === 'webServer') return context.webServer;
			if (name === 'webRuntime') return { trustedHosts: [] };
			return void 0;
		}
	};
	return context;
}

(async () => {
	try {
		const plugin = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'index.js')).href);

		/* ── schema ───────────────────────────────────────────────────── */

		check('the plugin exports a Config schema', plugin.Config !== void 0 && typeof plugin.Config === 'function');
		const defaults = plugin.Config({});
		check('every feature defaults to on', defaults.archive === true && defaults.skills === true && defaults.colors === true, JSON.stringify(defaults));
		const off = plugin.Config({ skills: false });
		check('the schema keeps one feature off', off.skills === false && off.archive === true && off.colors === true);
		const dict = plugin.Config.dict ?? {};
		check(
			'the schema documents the three switches',
			['archive', 'skills', 'colors'].every((key) => dict[key] !== void 0 && dict[key].meta !== void 0 && typeof dict[key].meta.description === 'string'),
			JSON.stringify(Object.keys(dict))
		);

		/* ── default row: everything on ───────────────────────────────── */

		const all = fakeContext();
		plugin.apply(all);
		check(
			'a default row mounts both host routes',
			all.routes.length === 2 && all.routes.some((route) => route.path === '/skill-manager/api') && all.routes.some((route) => route.path === '/archive-manager/api'),
			JSON.stringify(all.routes.map((route) => route.path))
		);
		check('a default row taps the index once', all.taps.length === 1, String(all.taps.length));

		/* ── gating ───────────────────────────────────────────────────── */

		const noSkills = fakeContext();
		plugin.apply(noSkills, { skills: false });
		check(
			'skills=false leaves only the archive route',
			noSkills.routes.length === 1 && noSkills.routes[0].path === '/archive-manager/api',
			JSON.stringify(noSkills.routes.map((route) => route.path))
		);

		const noArchive = fakeContext();
		plugin.apply(noArchive, { archive: false });
		check(
			'archive=false leaves only the skills route',
			noArchive.routes.length === 1 && noArchive.routes[0].path === '/skill-manager/api',
			JSON.stringify(noArchive.routes.map((route) => route.path))
		);

		const none = fakeContext();
		plugin.apply(none, { archive: false, skills: false, colors: false });
		check('disabling every feature mounts no route', none.routes.length === 0, String(none.routes.length));
		check('the index tap is still installed for the browser half', none.taps.length === 1);

		/* ── the index injection ──────────────────────────────────────── */

		const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>';
		const injected = none.taps[0](html);
		const match = /window\.__DSH_ARCHIVE_MANAGER_FEATURES__=(\{[^<]*\});/.exec(injected);
		check('the injected script publishes the flags', match !== null, injected.slice(0, 160));
		if (match !== null) {
			let flags = null;
			try {
				flags = JSON.parse(match[1]);
			} catch {
				flags = null;
			}
			check('the injected flags round-trip', flags !== null && flags.archive === false && flags.skills === false && flags.colors === false, String(match[1]));
		}
		check('the injection lands inside <head>', injected.indexOf('__DSH_ARCHIVE_MANAGER_FEATURES__') < injected.indexOf('</head>'));

		const partial = fakeContext();
		plugin.apply(partial, { colors: false });
		const partialHtml = partial.taps[0](html);
		check('a single switch off is published verbatim', partialHtml.includes('"colors":false') && partialHtml.includes('"skills":true'));

		console.log(`\n${failures.length === 0 ? 'ok' : 'not ok'}: ${passed} checks passed${failures.length === 0 ? '' : `, ${failures.length} failed`}`);
		process.exitCode = failures.length === 0 ? 0 : 1;
	} catch (error) {
		console.error(error);
		process.exitCode = 1;
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
})();
