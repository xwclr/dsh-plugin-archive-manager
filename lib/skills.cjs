'use strict';

/**
 * Skill Manager — filesystem core.
 *
 * Everything that decides *where* a skill lives and *how* it is switched off or
 * removed happens here, in one place, with the invariants of the shipped
 * discovery provider encoded as guards rather than assumed:
 *
 * - A skill root is `$DSH_HOME/skills` (global, rank 400) or
 *   `<projectRoot>/.dsh/skills` (workspace, rank 100), where the project root is
 *   the nearest ancestor holding `.git` and otherwise the workspace directory
 *   itself — `findProjectRoot` in `@deepseek-ai/dsh-skill-filesystem`.
 * - Discovery reads a root exactly one level deep. A skill is either a
 *   directory containing `SKILL.md`, or a flat `<name>.md` file.
 * - The catalogued **name** comes from the frontmatter `name:` field, not the
 *   directory name, and must match `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`. A file with
 *   a missing `name`/`description`, invalid YAML, or a bad name is dropped
 *   *silently* by the provider, so this module validates before it writes:
 *   importing something undiscoverable is worse than refusing.
 * - Disabling renames `SKILL.md` to `SKILL.md.disabled` in place. That file
 *   satisfies neither locator predicate (`=== "SKILL.md"` for a directory,
 *   `endsWith(".md")` for a flat entry), so it can never be rediscovered, and
 *   it stays a sibling — the resource base the skill's own scripts resolve
 *   against does not move.
 *
 * Nothing here trusts a path that arrived over the wire: every mutation
 * re-derives its target from a fresh listing of the roots it is willing to
 * write, and containment is decided with `path.relative`, never `includes`.
 *
 * This file is CommonJS on purpose: `lib/index.js` re-requires it on every
 * apply, deleting it from the module cache first, so a locally developed copy
 * converges through a plugin toggle instead of a process restart.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Suffix that parks a disabled skill's instruction file. */
const DISABLED_SUFFIX = '.disabled';
/** The public skill-name grammar, mirrored from `@deepseek-ai/dsh-skill`. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Frontmatter keys rejected by the provider; they drop the whole skill. */
const LEGACY_INVOCATION_KEYS = ['disableModelInvocation', 'modelInvocable', 'userInvocable'];
/** Upper bound on files copied out of one picked directory. */
const IMPORT_FILE_LIMIT = 2000;
/** Upper bound on bytes copied out of one picked directory. */
const IMPORT_BYTE_LIMIT = 64 * 1024 * 1024;

/** Harness home, matching the filesystem provider's own default. */
function dshHome() {
	return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** The global skill root the provider scans at rank 400. */
function globalRoot() {
	return path.join(dshHome(), 'skills');
}

/** Nearest ancestor holding `.git`, else the directory itself. */
function projectRootOf(start) {
	let current = path.resolve(start);
	for (;;) {
		if (fs.existsSync(path.join(current, '.git'))) return current;
		const parent = path.dirname(current);
		if (parent === current) return path.resolve(start);
		current = parent;
	}
}

/** The workspace skill root the provider scans at rank 100. */
function workspaceRoot(workspacePath) {
	return path.join(projectRootOf(workspacePath), '.dsh', 'skills');
}

/* ── path safety ─────────────────────────────────────────────────────────── */

/**
 * Real path when it exists, lexical resolution otherwise.
 *
 * Symlinked roots are the reason this exists: the provider follows symlinks, so
 * a containment check against a lexical root would reject a real location.
 * @param target - path to canonicalize.
 * @returns the canonical path.
 */
function canonical(target) {
	try {
		return fs.realpathSync(target);
	} catch {
		return path.resolve(target);
	}
}

/**
 * Whether the path itself is a symlink, even when its target is gone.
 *
 * `existsSync` follows the link, so a dangling symlink answers `false` even
 * though the link is sitting right there. That distinction is what makes a
 * broken link removable instead of invisible.
 * @param target - candidate path.
 * @returns true when the entry exists and is a symlink.
 */
function isSymlinkAt(target) {
	try {
		return fs.lstatSync(target).isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * Whether `child` is strictly inside `parent`, using segment comparison.
 *
 * `String.includes` would accept `/roots/skills-evil` for `/roots/skills`;
 * `path.relative` cannot. An empty relative path means "the same directory",
 * which is not "inside it" — a root itself is never a mutation target.
 * @param parent - containing directory.
 * @param child - candidate descendant.
 * @returns true when child is a strict descendant of parent.
 */
function isInside(parent, child) {
	const rel = path.relative(parent, child);
	return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Remove a BOM so a frontmatter opener is actually the first line. */
function stripBom(text) {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Parse a skill's YAML frontmatter with the provider's own rules.
 *
 * Quotes, flow mappings and block scalars are decoded by the real YAML parser
 * rather than a line regex: a `description: >` folded block is common, and a
 * naive reader would import the skill and then watch the provider drop it.
 * @param text - the SKILL.md content.
 * @param parseYaml - the `yaml` package's `parse`.
 * @returns the data object and body, or undefined when there is no frontmatter.
 */
function parseFrontmatter(text, parseYaml) {
	const raw = stripBom(String(text ?? ''));
	const firstLineEnd = raw.indexOf('\n');
	if (firstLineEnd < 0) return void 0;
	if (raw.slice(0, firstLineEnd).replace(/\r$/u, '') !== '---') return void 0;
	const start = firstLineEnd + 1;
	let lineStart = start;
	let closing;
	let bodyStart = raw.length;
	while (lineStart <= raw.length) {
		const nextNewline = raw.indexOf('\n', lineStart);
		const lineEnd = nextNewline < 0 ? raw.length : nextNewline;
		if (raw.slice(lineStart, lineEnd).replace(/\r$/u, '') === '---') {
			closing = lineStart;
			bodyStart = nextNewline < 0 ? raw.length : nextNewline + 1;
			break;
		}
		if (nextNewline < 0) break;
		lineStart = nextNewline + 1;
	}
	if (closing === undefined) return void 0;
	let data;
	try {
		data = parseYaml(raw.slice(start, closing));
	} catch (error) {
		throw new Error(`invalid YAML frontmatter: ${error && error.message ? error.message : String(error)}`);
	}
	if (data === null || typeof data !== 'object' || Array.isArray(data)) return void 0;
	return { data, body: raw.slice(bodyStart) };
}

/**
 * Validate one frontmatter object against the provider's acceptance rules.
 *
 * Returns the catalogued name and a description, or throws with the reason the
 * provider would have dropped the skill — the message is shown to the user, so
 * it names the field rather than the rule.
 * @param data - parsed frontmatter data.
 * @returns the validated name and description.
 */
function validateFrontmatter(data) {
	const raw = (key) => {
		const value = data[key];
		return typeof value === 'string' ? value : void 0;
	};
	for (const legacy of LEGACY_INVOCATION_KEYS) {
		if (Object.hasOwn(data, legacy)) {
			throw new Error(`frontmatter field "${legacy}" is unsupported; use the kebab-case spelling`);
		}
	}
	const name = raw('name');
	if (name === void 0 || name.trim().length === 0) throw new Error('frontmatter is missing the required "name" field');
	if (!SKILL_NAME.test(name)) throw new Error(`frontmatter name "${name}" is not kebab-case (a-z, 0-9 and single dashes)`);
	const description = raw('description');
	if (description === void 0 || description.trim().length === 0) {
		throw new Error('frontmatter is missing the required "description" field');
	}
	return { name, description: description.trim() };
}

/* ── discovery ───────────────────────────────────────────────────────────── */

/** Root descriptors this manager is allowed to read, and to write. */
function roots({ workspacePath }) {
	const list = [];
	if (typeof workspacePath === 'string' && workspacePath.length > 0 && fs.existsSync(workspacePath)) {
		/* Rank 100 in the provider: the workspace root outranks every user root. */
		list.push({ scope: 'project', path: workspaceRoot(workspacePath), source: 'project-dsh', rank: 100 });
	}
	/* Rank 400 in the provider. */
	list.push({ scope: 'global', path: globalRoot(), source: 'user-dsh', rank: 400 });
	for (const root of list) {
		root.real = canonical(root.path);
		root.writable = true;
	}
	return list;
}

/**
 * Read one candidate entry into a skill row.
 *
 * A candidate that cannot be read is reported with its reason instead of being
 * hidden: a broken skill is exactly what a manager page has to show.
 * @param root - owning root descriptor.
 * @param entryPath - the entry's own path.
 * @param isDirectory - whether the entry is a directory bundle.
 * @param parseYaml - the `yaml` package's `parse`.
 * @returns one skill row.
 */
function readSkill(root, entryPath, isDirectory, parseYaml, fileOverride) {
	const file = fileOverride ?? (isDirectory ? path.join(entryPath, 'SKILL.md') : entryPath);
	/* A symlinked entry is followed on purpose: the shipped provider resolves a
	 * listed child through `stat`, so a link to a bundle reports as a directory
	 * and IS discovered. Leaving this row out would make the page lie about the
	 * catalog. `linkTarget` records where it actually points, because that is the
	 * directory an unsafe mutation would damage. */
	let linkTarget = null;
	let linkedEntry = false;
	try {
		linkedEntry = fs.lstatSync(entryPath).isSymbolicLink();
		if (linkedEntry) linkTarget = fs.realpathSync(entryPath);
	} catch {
		linkTarget = null;
	}
	/* A parked entry keeps the suffix, so the fallback name drops it first:
	 * `foo.md.disabled` is the parked form of `foo.md`, and the fallback is only
	 * ever shown when the frontmatter itself could not be read. */
	const fallback = path.basename(entryPath).replace(/\.md(?:\.disabled)?$/u, '');
	const row = {
		root: root.path,
		scope: root.scope,
		source: root.source,
		/* The provider's precedence rank for this root; the shadow rule needs it. */
		rank: root.rank,
		entry: path.basename(entryPath),
		/* The route back to the host: always the canonical entry, so one row
		 * keeps one identity while its switch flips (a parked flat skill's file
		 * name changes, the row's address does not). */
		entryPath: isDirectory ? entryPath : entryPath.replace(/\.disabled$/u, ''),
		directory: isDirectory,
		/* Non-null when this entry is a symlink, holding its resolved target. */
		linkTarget,
		/* A symlink whose target is gone: the link is still on disk and can be
		 * deleted, but nothing behind it can be read or switched. */
		dangling: linkedEntry && linkTarget === null,
		file,
		parked: false,
		enabled: true,
		name: fallback,
		description: '',
		problem: void 0,
		bytes: 0
	};
	let text;
	try {
		const stat = fs.statSync(file);
		row.bytes = stat.size;
		text = fs.readFileSync(file, 'utf8');
	} catch {
		row.enabled = false;
		row.parked = true;
		row.problem = 'missing-file';
		return row;
	}
	try {
		const parsed = parseFrontmatter(text, parseYaml);
		if (parsed === void 0) throw new Error('the file has no YAML frontmatter');
		const valid = validateFrontmatter(parsed.data);
		row.name = valid.name;
		row.description = valid.description;
		row.heading = firstHeading(parsed.body);
	} catch (error) {
		row.problem = error && error.message ? error.message : String(error);
	}
	return row;
}

/** First Markdown heading of a body, used as a fallback title. */
function firstHeading(body) {
	const match = /^\s{0,3}#\s+(.+)$/mu.exec(String(body ?? ''));
	return match === null ? void 0 : match[1].trim();
}

/**
 * Mark which rows lose a same-name race.
 *
 * Precedence is the provider's: the lowest `rank` wins, and a tie inside one
 * root is broken by the entry name's `localeCompare` order. This is computed
 * from the roots themselves rather than from the skill registry, because in the
 * shipped Web composition discovery lives inside an agent preset — the
 * host-plane registry is empty, and asking it would mark every skill unshadowed
 * (or, worse, every skill invisible).
 *
 * Only enabled rows compete: a parked skill is not in the catalog at all, so it
 * can neither shadow nor be shadowed.
 * @param skills - the rows from one listing.
 */
function markShadowed(skills) {
	const byName = new Map();
	for (const row of skills) {
		if (!row.enabled || row.problem !== void 0) continue;
		const group = byName.get(row.name);
		if (group === void 0) byName.set(row.name, [row]);
		else group.push(row);
	}
	for (const row of skills) row.shadowed = false;
	for (const group of byName.values()) {
		if (group.length < 2) continue;
		const sorted = [...group].sort((left, right) => left.rank - right.rank || (left.entry < right.entry ? -1 : left.entry > right.entry ? 1 : 0));
		for (const row of sorted.slice(1)) row.shadowed = true;
	}
}

/**
 * Read the entries parked under one root's `.system/` directory.
 *
 * A parked entry is either a symlink the manager moved aside (it cannot be
 * switched off any other way) or a whole bundle parked as a unit. Its live
 * location is reconstructed from its name so a toggle can restore it; the row
 * keeps the canonical in-root path as its identity, exactly like a parked flat
 * skill.
 * @param root - the owning root descriptor.
 * @param parseYaml - the `yaml` package's `parse`.
 * @returns the parked skill rows.
 */
function parkedEntriesOf(root, parseYaml) {
	const directory = systemDirOf(root.path);
	let entries;
	try {
		entries = fs.readdirSync(directory, { withFileTypes: true });
	} catch {
		return [];
	}
	const rows = [];
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		if (entry.name.startsWith('.')) continue;
		const parkedPath = path.join(directory, entry.name);
		const kind = entryKind(parkedPath, entry);
		/* A parked symlink whose target disappeared has no kind to report, but
		 * it is still an entry the page has to be able to clean up. */
		const dangling = kind === 'other' && entry.isSymbolicLink();
		if (kind !== 'directory' && !dangling) continue;
		const live = path.join(root.path, entry.name);
		const row = readSkill(root, live, true, parseYaml, path.join(parkedPath, 'SKILL.md'));
		row.parked = true;
		row.enabled = false;
		row.parkedPath = parkedPath;
		row.problem = dangling ? 'missing-file' : void 0;
		row.dangling = dangling;
		rows.push(row);
	}
	return rows;
}

/**
 * The real kind behind one root entry, following a symlink.
 *
 * The shipped provider resolves each listed child with `stat`, so a link to a
 * bundle is a directory as far as discovery is concerned. `Dirent` answers the
 * question about the link itself, which would hide every linked skill.
 * @param entryPath - the entry's own path.
 * @param entry - its `Dirent`.
 * @returns 'directory', 'file', or 'other'.
 */
function entryKind(entryPath, entry) {
	if (entry.isSymbolicLink()) {
		try {
			const stat = fs.statSync(entryPath);
			if (stat.isDirectory()) return 'directory';
			if (stat.isFile()) return 'file';
			return 'other';
		} catch {
			/* A dangling link has no target kind. */
			return 'other';
		}
	}
	if (entry.isDirectory()) return 'directory';
	if (entry.isFile()) return 'file';
	return 'other';
}

/**
 * List every skill this manager can see, including parked ones.
 *
 * Parked skills are found by their `.disabled` sibling: the instruction file is
 * gone from discovery's point of view, so that parked path is the only record
 * of the skill. `SKILL.md.disabled` keeps the original file name in front of the
 * suffix, which is what makes `<name>.md.disabled` (flat) and
 * `SKILL.md.disabled` (bundle) distinguishable.
 * @param options - workspace path and the YAML parser.
 * @returns the skill rows plus the roots that were scanned.
 */
function listSkills({ workspacePath, parseYaml }) {
	const scanned = roots({ workspacePath });
	const skills = [];
	for (const root of scanned) {
		/* Parked entries live one level below the root, in `.system/`, which
		 * discovery never scans. They are listed so a switch can be flipped back
		 * on and so deletion can reach them. */
		for (const parked of parkedEntriesOf(root, parseYaml)) skills.push(parked);
		let entries;
		try {
			entries = fs.readdirSync(root.path, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			if (entry.name === '.system') continue;
			const entryPath = path.join(root.path, entry.name);
			/* `Dirent.isDirectory()` is false for a symlink, but the provider
			 * follows links (`stat`) and discovers them; resolve the real kind so
			 * the two agree. A broken link resolves to nothing and is skipped. */
			const kind = entryKind(entryPath, entry);
			/* A broken link has no target kind, so `entryKind` cannot classify it.
			 * It is still listed — as an unreadable row — because a dangling entry
			 * is precisely what a manager page must show rather than hide. */
			if (entry.isSymbolicLink() && kind === 'other') {
				const row = readSkill(root, entryPath, true, parseYaml);
				row.enabled = false;
				row.problem = 'missing-file';
				skills.push(row);
				continue;
			}
			if (kind === 'directory') {
				const parked = path.join(entryPath, 'SKILL.md' + DISABLED_SUFFIX);
				if (fs.existsSync(parked)) {
					const row = readSkill(root, entryPath, true, parseYaml, parked);
					row.parked = true;
					row.enabled = false;
					row.problem = void 0;
					skills.push(row);
					continue;
				}
				if (!fs.existsSync(path.join(entryPath, 'SKILL.md'))) continue;
				skills.push(readSkill(root, entryPath, true, parseYaml));
				continue;
			}
			if (kind !== 'file') continue;
			if (entry.name.endsWith('.md' + DISABLED_SUFFIX)) {
				const row = readSkill(root, entryPath, false, parseYaml, entryPath);
				row.parked = true;
				row.enabled = false;
				row.problem = void 0;
				skills.push(row);
				continue;
			}
			if (!entry.name.endsWith('.md')) continue;
			skills.push(readSkill(root, entryPath, false, parseYaml));
		}
	}
	markShadowed(skills);
	return { skills, roots: scanned.map((root) => ({ scope: root.scope, path: root.path, source: root.source, rank: root.rank, exists: fs.existsSync(root.path) })) };
}

/** Parse a parked instruction file for its frontmatter only. */
function readSkillFromText(file, parseYaml) {
	try {
		const parsed = parseFrontmatter(fs.readFileSync(file, 'utf8'), parseYaml);
		if (parsed === void 0) return void 0;
		const valid = validateFrontmatter(parsed.data);
		return { name: valid.name, description: valid.description, heading: firstHeading(parsed.body) };
	} catch {
		return void 0;
	}
}


/* ── mutation targets ────────────────────────────────────────────────────── */

/**
 * Resolve one wire-supplied target back to a live path inside a writable root.
 *
 * Two spellings name the same skill and both are accepted, so a stored row keeps
 * one stable identity across a toggle: the canonical entry (`foo.md`,
 * `my-bundle/`) and, for a flat skill that is currently parked, the path that
 * exists on disk (`foo.md.disabled`). A bundle never carries the suffix on its
 * own name, so the suffix is only stripped when the result actually exists.
 *
 * The re-derivation is also the security boundary: anything that is not a direct
 * child of a scanned root is refused, so a malformed or hostile request cannot
 * aim a rename or a recursive delete at some other file on disk.
 * @param options - workspace path and the wire path.
 * @returns the root descriptor and the resolved paths.
 */
function resolveTarget({ workspacePath, path: wirePath }) {
	if (typeof wirePath !== 'string' || wirePath.length === 0) throw new Error('a skill path is required');
	const absolute = path.resolve(wirePath);
	const exists = (target) => {
		try {
			return fs.existsSync(target);
		} catch {
			return false;
		}
	};
	/* A parked flat skill is the only thing whose name ends in `.md.disabled`;
	 * a *directory* could legitimately be named that way and be a bundle, so the
	 * suffix is stripped by kind rather than by spelling. When neither spelling
	 * exists the stripped one is still the canonical address — the caller gets
	 * the "no longer on disk" error below either way. */
	let entry = absolute;
	if (absolute.endsWith('.md' + DISABLED_SUFFIX)) {
		let isDirectory = false;
		try {
			isDirectory = exists(absolute) && fs.lstatSync(absolute).isDirectory();
		} catch {
			isDirectory = false;
		}
		if (!isDirectory) entry = absolute.slice(0, -DISABLED_SUFFIX.length);
	}
	let root;
	for (const candidate of roots({ workspacePath })) {
		if (!exists(candidate.path)) continue;
		if (isInside(candidate.real, canonical(entry)) || isInside(candidate.path, entry)) {
			root = candidate;
			break;
		}
	}
	if (root === void 0) throw new Error('the skill is outside the global and workspace skill directories');
	const live = exists(entry);
	const parkedFlat = exists(entry + DISABLED_SUFFIX);
	/* An entry parked under `.system/` no longer sits at its canonical path, so
	 * the parking area is consulted before the path is declared gone. */
	const parkedUnitPath = path.join(systemDirOf(root.path), path.basename(entry));
	const parkedUnit = exists(parkedUnitPath);
	/* A dangling symlink is the one entry whose own path still exists while
	 * `exists` (which follows the link) says it does not. It has no target to
	 * toggle, but it IS the thing delete has to unlink. */
	const danglingLive = !live && !parkedFlat && !parkedUnit && isSymlinkAt(entry);
	const danglingParked = !live && !parkedFlat && !parkedUnit && !danglingLive && isSymlinkAt(parkedUnitPath);
	if (!live && !parkedFlat && !parkedUnit && !danglingLive && !danglingParked) {
		throw new Error('the skill is no longer on disk; refresh the list');
	}
	const at = danglingLive ? entry : live ? entry : parkedFlat ? entry + DISABLED_SUFFIX : parkedUnitPath;
	if (danglingLive || danglingParked) {
		return { root, entry, absolute: at, directory: false, canonicalEntry: entry, linkTarget: null, dangling: true };
	}
	/* A link is NOT rejected here: the provider discovers linked skills, so the
	 * manager has to be able to switch them off. It is reported instead, because
	 * every mutation below has to take the link-safe path — writing `SKILL.md`
	 * through the link would edit the other tool's directory. */
	let linkTarget = null;
	if (fs.lstatSync(at).isSymbolicLink()) {
		try {
			linkTarget = fs.realpathSync(at);
		} catch {
			throw new Error('this skill is a broken symbolic link; remove it instead');
		}
	}
	return { root, entry, absolute: at, directory: fs.statSync(at).isDirectory(), canonicalEntry: entry, linkTarget, dangling: false };
}

/**
 * The parking area inside one root.
 *
 * Moving an entry under `<root>/.system/` hides it from discovery in EVERY root,
 * not only the user one: discovery scans a root exactly one level deep, so a
 * bundle one level further down is simply never reached. That makes this the
 * only safe way to switch off a skill whose own directory must not be written
 * to — a symlinked one — and the only way to park a whole bundle as a unit.
 * @param rootPath - the owning root.
 * @returns the parking directory path.
 */
function systemDirOf(rootPath) {
	return path.join(rootPath, '.system');
}

/**
 * Hide or restore one entry by moving it into the root's `.system` parking area.
 * @param target - a resolved target.
 * @param hidden - true to park it, false to bring it back.
 * @returns the path it now occupies.
 */
function parkEntry(target, hidden) {
	const parked = path.join(systemDirOf(target.root.path), path.basename(target.canonicalEntry));
	/* The entry may already BE the parked one: a toggle on a disabled skill
	 * addresses the canonical path, and `absolute` follows it to `.system/`. */
	const alreadyParked = target.absolute === parked;
	if (hidden) {
		if (alreadyParked) throw new Error('this skill is already disabled');
		if (fs.existsSync(parked)) throw new Error(`cannot disable: .system/${path.basename(parked)} already exists`);
		fs.mkdirSync(systemDirOf(target.root.path), { recursive: true });
		fs.renameSync(target.absolute, parked);
		return parked;
	}
	if (!alreadyParked) throw new Error('this skill is already enabled');
	if (fs.existsSync(target.canonicalEntry)) throw new Error(`cannot enable: ${path.relative(target.root.path, target.canonicalEntry)} already exists`);
	fs.renameSync(parked, target.canonicalEntry);
	return target.canonicalEntry;
}

/** The `.disabled` sibling path for one entry. */
function parkedPathOf(entry, directory) {
	return directory ? path.join(entry, 'SKILL.md' + DISABLED_SUFFIX) : entry + DISABLED_SUFFIX;
}

/** The live instruction path for one entry. */
function livePathOf(entry, directory) {
	return directory ? path.join(entry, 'SKILL.md') : entry;
}

/**
 * Enable or disable one skill by parking or restoring its instruction file.
 *
 * Parking is a same-directory rename, so it is atomic and the skill's own
 * resources keep resolving: a bundle's scripts sit next to the parked
 * `SKILL.md`, and nothing about their relative positions changes.
 * @param options - workspace path and the wire path.
 * @param enabled - the requested state.
 * @returns the canonical entry path and whether the disk changed.
 */
function setSkillEnabled({ workspacePath, path: wirePath }, enabled) {
	const target = resolveTarget({ workspacePath, path: wirePath });
	/* A dangling link has no target to park. Refuse the toggle instead of
	 * moving the dead link into `.system/`, where it would only become harder
	 * to find; deleting the link is the one meaningful operation. */
	if (target.dangling === true) throw new Error('this skill is a dangling symbolic link; delete it instead');
	/* A symlinked skill is switched off by moving the LINK, never by renaming its
	 * `SKILL.md`: that rename resolves through the link and edits the other
	 * tool's directory, silently breaking it. */
	if (target.linkTarget !== null) {
		parkEntry(target, !enabled);
		return { changed: true, path: target.canonicalEntry, link: true };
	}
	const live = livePathOf(target.canonicalEntry, target.directory);
	const parked = parkedPathOf(target.canonicalEntry, target.directory);
	if (enabled) {
		if (!fs.existsSync(parked)) throw new Error('this skill is already enabled');
		if (fs.existsSync(live)) throw new Error(`cannot enable: ${path.relative(target.root.path, live)} already exists`);
		fs.renameSync(parked, live);
		return { changed: true, path: target.canonicalEntry };
	}
	if (!fs.existsSync(live)) throw new Error('this skill is already disabled');
	if (fs.existsSync(parked)) throw new Error(`cannot disable: ${path.relative(target.root.path, parked)} already exists`);
	fs.renameSync(live, parked);
	return { changed: true, path: target.canonicalEntry };
}

/**
 * Remove one skill from disk.
 *
 * Deletion is restricted to the two shapes discovery understands, which is what
 * keeps it from being a general `rm -rf` over a user-supplied path: a bundle
 * directory is removed recursively, a flat skill is unlinked. The root
 * directory itself can never be a target, and a directory that holds no
 * `SKILL.md` is refused rather than removed.
 * @param options - workspace path and the wire path.
 * @returns the removed path.
 */
function deleteSkill({ workspacePath, path: wirePath }) {
	const target = resolveTarget({ workspacePath, path: wirePath });
	/* A dangling link is still a link: unlink removes it without following the
	 * missing target, and there is no SKILL.md to inspect first. */
	if (target.dangling === true) {
		const wasParked = path.dirname(target.absolute) === systemDirOf(target.root.path);
		fs.unlinkSync(target.absolute);
		return { removed: target.absolute, directory: false, link: true, dangling: true, wasParked };
	}
	/* Deleting a linked skill removes the LINK. `rmSync` on a directory symlink
	 * removes the link alone (it does not follow it), and `unlinkSync` is the
	 * explicit form for the same intent; the real directory outside the root is
	 * left untouched either way. */
	if (target.linkTarget !== null) {
		const wasParked = path.dirname(target.absolute) === systemDirOf(target.root.path);
		fs.unlinkSync(target.absolute);
		return { removed: target.absolute, directory: target.directory, link: true, wasParked };
	}
	if (target.directory) {
		const live = path.join(target.absolute, 'SKILL.md');
		const parked = path.join(target.absolute, 'SKILL.md' + DISABLED_SUFFIX);
		if (!fs.existsSync(live) && !fs.existsSync(parked)) {
			throw new Error('this directory does not contain a SKILL.md; refusing to delete it');
		}
		fs.rmSync(target.absolute, { recursive: true, force: false });
		return { removed: target.absolute, directory: true };
	}
	if (!target.absolute.endsWith('.md') && !target.absolute.endsWith('.md' + DISABLED_SUFFIX)) {
		throw new Error('refusing to delete a file that is not a skill document');
	}
	fs.rmSync(target.absolute, { force: false });
	return { removed: target.absolute, directory: false };
}

/* ── import ──────────────────────────────────────────────────────────────── */

/** Recursively collect the files under one picked directory. */
function collectFiles(source) {
	const files = [];
	let bytes = 0;
	const walk = (directory, depth) => {
		if (depth > 12) throw new Error('the selected directory is nested too deeply');
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.DS_Store') continue;
			const absolute = path.join(directory, entry.name);
			const lstat = fs.lstatSync(absolute);
			if (lstat.isSymbolicLink()) continue;
			if (lstat.isDirectory()) {
				walk(absolute, depth + 1);
				continue;
			}
			if (!lstat.isFile()) continue;
			if (files.length >= IMPORT_FILE_LIMIT) throw new Error(`the selection holds more than ${IMPORT_FILE_LIMIT} files`);
			bytes += lstat.size;
			if (bytes > IMPORT_BYTE_LIMIT) throw new Error('the selection is larger than 64 MB');
			files.push({ absolute, relative: path.relative(source, absolute) });
		}
	};
	walk(source, 0);
	return files;
}

/**
 * The skill names one root currently resolves.
 *
 * Names, not file names: the provider catalogues a skill by its frontmatter
 * `name:`, so a bundle in `folder-a/` and a flat file `folder-b.md` collide when
 * they declare the same name. Comparing destinations would miss that, and the
 * provider would then resolve the pair by `localeCompare` on the entry name —
 * one skill silently invisible, with no error anywhere.
 * @param rootPath - the root to scan.
 * @param parseYaml - the `yaml` package's `parse`.
 * @returns the catalogued names present in that root.
 */
function namesInRoot(rootPath, parseYaml) {
	const names = new Set();
	let entries;
	try {
		entries = fs.readdirSync(rootPath, { withFileTypes: true });
	} catch {
		return names;
	}
	for (const entry of entries) {
		if (entry.name === '.system') continue;
		const entryPath = path.join(rootPath, entry.name);
		const file = entry.isDirectory()
			? fs.existsSync(path.join(entryPath, 'SKILL.md'))
				? path.join(entryPath, 'SKILL.md')
				: fs.existsSync(path.join(entryPath, 'SKILL.md' + DISABLED_SUFFIX))
					? path.join(entryPath, 'SKILL.md' + DISABLED_SUFFIX)
					: void 0
			: entry.name.endsWith('.md') || entry.name.endsWith('.md' + DISABLED_SUFFIX)
				? entryPath
				: void 0;
		if (file === void 0) continue;
		try {
			const parsed = parseFrontmatter(fs.readFileSync(file, 'utf8'), parseYaml);
			if (parsed === void 0) continue;
			names.add(validateFrontmatter(parsed.data).name);
		} catch {
			/* An unparsable neighbour is not this import's problem. */
		}
	}
	return names;
}

/**
 * Plan and perform one import into a skill root.
 *
 * The destination name is the skill's **frontmatter name**, not the folder name,
 * because that is the identity the provider catalogues. A picked folder may be
 * one skill (it holds `SKILL.md`) or a parent of several; a picked `.md` file is
 * one flat skill.
 *
 * Refusals are deliberate rather than lenient. A name that already resolves in
 * the destination root is refused, because the provider would resolve the pair
 * by entry name and hide one of them; a name that resolves in a higher-ranked
 * root is reported as shadowed, because the copy would land on disk and never
 * reach the model.
 * @param options - workspace path, scope, source path and the YAML parser.
 * @returns what was imported, including any shadowing warning.
 */
function importSkills({ workspacePath, scope, source, parseYaml }) {
	if (typeof source !== 'string' || source.length === 0) throw new Error('a source directory is required');
	const from = path.resolve(source);
	if (!fs.existsSync(from)) throw new Error('the selected path no longer exists');
	if (fs.lstatSync(from).isSymbolicLink()) throw new Error('the selected path is a symbolic link');
	const root = scope === 'global' ? globalRoot() : workspaceRoot(workspacePath);
	const candidates = planImport(from, fs.lstatSync(from), parseYaml);
	if (candidates.length === 0) {
		throw new Error('no skill was found: select a folder containing SKILL.md, a folder of skill folders, or a .md skill file');
	}
	const present = namesInRoot(root, parseYaml);
	const seen = new Set();
	for (const candidate of candidates) {
		if (seen.has(candidate.name)) throw new Error(`two selected skills both resolve to "${candidate.name}"; import them one at a time`);
		seen.add(candidate.name);
		if (present.has(candidate.name)) throw new Error(`a skill named "${candidate.name}" already exists in ${path.basename(root)}; delete or rename it first`);
		if (fs.existsSync(path.join(root, candidate.destination))) {
			throw new Error(`"${candidate.destination}" already exists in ${path.basename(root)}; delete or rename it first`);
		}
	}
	const shadowed = [];
	for (const other of roots({ workspacePath })) {
		if (other.path === root) continue;
		const names = namesInRoot(other.path, parseYaml);
		for (const candidate of candidates) {
			if (names.has(candidate.name)) shadowed.push({ name: candidate.name, by: other.source });
		}
	}
	fs.mkdirSync(root, { recursive: true });
	const written = [];
	for (const candidate of candidates) {
		const destination = path.join(root, candidate.destination);
		writeCopy(candidate, destination);
		written.push({ name: candidate.name, destination, description: candidate.description, entry: candidate.destination });
	}
	return { root, imported: written, shadowed };
}

/** Decide what one picked path contributes, validated before anything is written. */
function planImport(from, stat, parseYaml) {
	if (stat.isFile()) {
		if (!from.endsWith('.md')) throw new Error('select a folder, or a Markdown skill file');
		const parsed = parseFrontmatter(fs.readFileSync(from, 'utf8'), parseYaml);
		if (parsed === void 0) throw new Error(`${path.basename(from)} has no YAML frontmatter`);
		const valid = validateFrontmatter(parsed.data);
		return [{ name: valid.name, description: valid.description, destination: `${valid.name}.md`, files: [{ absolute: from, relative: path.basename(from) }], flat: true }];
	}
	const direct = path.join(from, 'SKILL.md');
	if (fs.existsSync(direct)) {
		const parsed = parseFrontmatter(fs.readFileSync(direct, 'utf8'), parseYaml);
		if (parsed === void 0) throw new Error(`${path.basename(from)}/SKILL.md has no YAML frontmatter`);
		const valid = validateFrontmatter(parsed.data);
		return [{ name: valid.name, description: valid.description, destination: valid.name, files: collectFiles(from), flat: false }];
	}
	const candidates = [];
	for (const entry of fs.readdirSync(from, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
		if (entry.name.startsWith('.')) continue;
		const child = path.join(from, entry.name);
		const lstat = fs.lstatSync(child);
		if (lstat.isSymbolicLink()) continue;
		if (lstat.isDirectory()) {
			const file = path.join(child, 'SKILL.md');
			if (!fs.existsSync(file)) continue;
			const parsed = parseFrontmatter(fs.readFileSync(file, 'utf8'), parseYaml);
			if (parsed === void 0) throw new Error(`${entry.name}/SKILL.md has no YAML frontmatter`);
			const valid = validateFrontmatter(parsed.data);
			candidates.push({ name: valid.name, description: valid.description, destination: valid.name, files: collectFiles(child), flat: false });
			continue;
		}
		if (!lstat.isFile() || !entry.name.endsWith('.md')) continue;
		const parsed = parseFrontmatter(fs.readFileSync(child, 'utf8'), parseYaml);
		if (parsed === void 0) continue;
		const valid = validateFrontmatter(parsed.data);
		candidates.push({ name: valid.name, description: valid.description, destination: `${valid.name}.md`, files: [{ absolute: child, relative: entry.name }], flat: true });
	}
	const seen = new Set();
	for (const candidate of candidates) {
		if (seen.has(candidate.destination)) throw new Error(`two selected skills both resolve to "${candidate.name}"; import them one at a time`);
		seen.add(candidate.destination);
	}
	return candidates;
}

/** Copy one planned candidate into its destination. */
function writeCopy(candidate, destination) {
	if (candidate.flat) {
		fs.copyFileSync(candidate.files[0].absolute, destination, fs.constants.COPYFILE_EXCL);
		return;
	}
	fs.mkdirSync(destination, { recursive: false });
	try {
		for (const file of candidate.files) {
			const target = path.join(destination, file.relative);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.copyFileSync(file.absolute, target, fs.constants.COPYFILE_EXCL);
		}
	} catch (error) {
		fs.rmSync(destination, { recursive: true, force: true });
		throw error;
	}
}

/* ── create ──────────────────────────────────────────────────────────────── */

/** YAML-safe single-quoted scalar: the one form that always round-trips. */
function quoteScalar(value) {
	return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * Scaffold one new skill in a root.
 *
 * Writing the frontmatter through the same validator the import path uses keeps
 * the two entry points honest: there is no way to create a skill here that the
 * provider would refuse to catalogue.
 * @param options - workspace path, scope, name, description and the YAML parser.
 * @returns the created skill.
 */
function createSkill({ workspacePath, scope, name, description, parseYaml }) {
	const trimmedName = typeof name === 'string' ? name.trim() : '';
	const trimmedDescription = typeof description === 'string' ? description.trim() : '';
	if (trimmedName.length === 0) throw new Error('a skill name is required');
	const text = ['---', `name: ${quoteScalar(trimmedName)}`, `description: ${quoteScalar(trimmedDescription)}`, '---', '', `# ${trimmedName}`, '', 'Describe what this skill does and when to use it.', ''].join('\n');
	/* Validate exactly what will be written, so the page can never scaffold a
	 * skill that the provider then silently drops. */
	const parsed = parseFrontmatter(text, parseYaml);
	if (parsed === void 0) throw new Error('internal error: the generated frontmatter did not parse');
	const valid = validateFrontmatter(parsed.data);
	const root = scope === 'global' ? globalRoot() : workspaceRoot(workspacePath);
	if (namesInRoot(root, parseYaml).has(valid.name)) {
		throw new Error(`a skill named "${valid.name}" already exists in ${path.basename(root)}`);
	}
	const destination = path.join(root, valid.name);
	if (fs.existsSync(destination)) throw new Error(`"${valid.name}" already exists in ${path.basename(root)}`);
	fs.mkdirSync(root, { recursive: true });
	fs.mkdirSync(destination, { recursive: false });
	try {
		fs.writeFileSync(path.join(destination, 'SKILL.md'), text, { flag: 'wx' });
	} catch (error) {
		fs.rmSync(destination, { recursive: true, force: true });
		throw error;
	}
	return { name: valid.name, destination, entry: valid.name, description: valid.description };
}

/* ── external agent skill sources ────────────────────────────────────────── */

/**
 * Other agent tools this machine may have skills from.
 *
 * Each entry is a *catalogue* of places that tool keeps user-level skills. Only
 * directories that exist are reported, so the page never offers an empty
 * source. Paths are relative to the home directory; `~` expansion is done once
 * here rather than at every call site.
 */
const EXTERNAL_SOURCES = [
	{ id: 'claude', label: 'Claude Code', dirs: ['.claude/skills'] },
	{ id: 'zcode', label: 'ZCode', dirs: ['.zcode/skills', '.zcode/cli/skills'] },
	{ id: 'workbuddy', label: 'WorkBuddy', dirs: ['.workbuddy/skills'] },
	{ id: 'codex', label: 'Codex', dirs: ['.codex/skills'] },
	{ id: 'cursor', label: 'Cursor', dirs: ['.cursor/skills'] },
	{ id: 'agents', label: 'Agent Skills', dirs: ['.agents/skills'] }
];

/**
 * The same tools' project-level directories, relative to a workspace.
 *
 * Several of these tools keep a per-project store as well as a user-level one —
 * ZCode's lives at `<project>/.zcode/skills` — so a scan that only looked at the
 * home directory would miss the skills a user actually has for the project they
 * are working in.
 */
const EXTERNAL_PROJECT_SOURCES = [
	{ id: 'zcode', label: 'ZCode', dirs: ['.zcode/skills'] },
	{ id: 'claude', label: 'Claude Code', dirs: ['.claude/skills'] },
	{ id: 'workbuddy', label: 'WorkBuddy', dirs: ['.workbuddy/skills'] },
	{ id: 'agents', label: 'Agent Skills', dirs: ['.agents/skills', '.dsh/skills'] }
];

/** Directories that hold an accompanying database rather than a skill. */
const SOURCE_NOISE = new Set(['.DS_Store', '.skills_store_lock.json', '_bm_skillid_migration.json']);

/**
 * Collect the skill folders under one external directory.
 *
 * Two layouts are in the wild and both are handled: skill folders sitting
 * directly under the directory (Claude Code, WorkBuddy), and one namespace level
 * in between (`zcode/skills/@user_x/<skill>`). Only bundles with a readable
 * `SKILL.md` count, so a source never advertises something that cannot be
 * imported.
 * @param directory - the external skill directory.
 * @param parseYaml - the `yaml` package's `parse`.
 * @returns the discovered skills, each with the layout depth it was found at.
 */
function readExternalSkills(directory, parseYaml) {
	const found = [];
	const readBundle = (bundlePath, depth) => {
		const file = path.join(bundlePath, 'SKILL.md');
		if (!fs.existsSync(file)) return;
		let name;
		let description = '';
		try {
			const parsed = parseFrontmatter(fs.readFileSync(file, 'utf8'), parseYaml);
			if (parsed === void 0) return;
			name = validateFrontmatter(parsed.data).name;
			description = validateFrontmatter(parsed.data).description;
		} catch {
			/* A skill the target tool also cannot read is not offered. */
			return;
		}
		found.push({ name, description, path: bundlePath, directory: bundlePath, depth, flat: false });
	};
	let entries;
	try {
		entries = fs.readdirSync(directory, { withFileTypes: true });
	} catch {
		return found;
	}
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		if (entry.name.startsWith('.') || SOURCE_NOISE.has(entry.name)) continue;
		const entryPath = path.join(directory, entry.name);
		const kind = entryKind(entryPath, entry);
		if (kind === 'file') {
			if (!entry.name.endsWith('.md')) continue;
			let name;
			let description = '';
			try {
				const parsed = parseFrontmatter(fs.readFileSync(entryPath, 'utf8'), parseYaml);
				if (parsed === void 0) continue;
				const valid = validateFrontmatter(parsed.data);
				name = valid.name;
				description = valid.description;
			} catch {
				continue;
			}
			found.push({ name, description, path: entryPath, directory: path.dirname(entryPath), depth: 0, flat: true });
			continue;
		}
		if (kind !== 'directory') continue;
		if (fs.existsSync(path.join(entryPath, 'SKILL.md'))) {
			readBundle(entryPath, 0);
			continue;
		}
		/* No SKILL.md here: treat it as a namespace and look one level in. */
		let children;
		try {
			children = fs.readdirSync(entryPath, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
			if (child.name.startsWith('.') || SOURCE_NOISE.has(child.name)) continue;
			const childPath = path.join(entryPath, child.name);
			if (entryKind(childPath, child) === 'directory') readBundle(childPath, 1);
		}
	}
	return found;
}

/**
 * Every external source present on this machine, with its skills.
 * @param options - the YAML parser.
 * @returns one entry per existing source directory.
 */
function listExternalSources({ parseYaml, workspacePath }) {
	const home = os.homedir();
	const sources = [];
	/** Add one source directory when it exists and holds at least one skill. */
	const consider = (group, directory, display, scope) => {
		let isDirectory = false;
		try {
			isDirectory = fs.statSync(directory).isDirectory();
		} catch {
			isDirectory = false;
		}
		if (!isDirectory) return;
		const skills = readExternalSkills(directory, parseYaml);
		/* An empty directory is not a source: offering it would only produce an
		 * "import" that imports nothing. `.dsh/skills` in particular is this
		 * plugin's own workspace root and is normally empty or already shown in
		 * the main list. */
		if (skills.length === 0) return;
		sources.push({
			id: group.id,
			label: group.label,
			scope,
			path: directory,
			display,
			skills: skills.map((skill) => ({
				name: skill.name,
				description: skill.description,
				path: skill.path,
				flat: skill.flat,
				/* A skill one namespace level down (`@user_x/<skill>`) cannot be
				 * discovered as-is: discovery scans exactly one level. The import
				 * flattens it, and the page says so. */
				nested: skill.depth > 0
			}))
		});
	};
	for (const group of EXTERNAL_SOURCES) {
		for (const relative of group.dirs) consider(group, path.join(home, relative), `~/${relative}`, 'user');
	}
	if (typeof workspacePath === 'string' && workspacePath.length > 0) {
		for (const group of EXTERNAL_PROJECT_SOURCES) {
			for (const relative of group.dirs) consider(group, path.join(workspacePath, relative), relative, 'project');
		}
	}
	return sources;
}

/**
 * Import selected skills from external agent tools.
 *
 * Two modes, because they trade off differently and the user knows which they
 * want:
 *
 * - `copy` duplicates the skill into the target root. The import is then
 *   self-contained and survives the source being moved or deleted, at the cost
 *   of a second copy that can drift out of date.
 * - `link` puts a single symlink in the target root instead. Edits to the source
 *   show up immediately and nothing is duplicated, and the shipped provider does
 *   discover a linked bundle (it resolves each entry with `stat`). The link is
 *   always to the skill's own directory, never to a namespace parent, so the
 *   one-level discovery rule still holds.
 *
 * Either way the destination name is the skill's frontmatter `name`, and a
 * collision is refused before anything is written.
 * @param options - workspace path, target scope, mode, the selected sources and
 *   the YAML parser.
 * @returns what was imported, skipped and shadowed.
 */
function importExternalSkills({ workspacePath, scope, mode, picks, parseYaml }) {
	if (!Array.isArray(picks) || picks.length === 0) throw new Error('select at least one skill to import');
	const sourceMode = mode === 'link' ? 'link' : 'copy';
	const root = scope === 'global' ? globalRoot() : workspaceRoot(workspacePath);
	const allowed = listExternalSources({ parseYaml, workspacePath });
	/* A pick is honoured only when it names a skill one of the scanners actually
	 * reported. Nothing else is imported, so a bad request cannot copy an
	 * arbitrary directory into a skill root. */
	const index = new Map();
	for (const source of allowed) {
		for (const skill of source.skills) index.set(skill.path, { ...skill, sourceLabel: source.label, sourceScope: source.scope });
	}
	const selected = [];
	for (const pick of picks) {
		if (typeof pick !== 'string' || pick.length === 0) continue;
		const resolved = path.resolve(pick);
		const known = index.get(resolved);
		if (known === void 0) throw new Error(`"${path.basename(resolved)}" is not a skill offered by any external source`);
		selected.push(known);
	}
	if (selected.length === 0) throw new Error('select at least one skill to import');

	const present = namesInRoot(root, parseYaml);
	const seen = new Set();
	for (const skill of selected) {
		if (seen.has(skill.name)) throw new Error(`"${skill.name}" was selected twice`);
		seen.add(skill.name);
		if (present.has(skill.name)) throw new Error(`a skill named "${skill.name}" already exists in ${path.basename(root)}; delete or rename it first`);
		const destination = path.join(root, skill.flat ? `${skill.name}.md` : skill.name);
		if (fs.existsSync(destination)) throw new Error(`"${skill.name}" already exists in ${path.basename(root)}`);
	}

	fs.mkdirSync(root, { recursive: true });
	const imported = [];
	for (const skill of selected) {
		const destination = path.join(root, skill.flat ? `${skill.name}.md` : skill.name);
		if (sourceMode === 'link') {
			fs.symlinkSync(skill.path, destination, skill.flat ? 'file' : 'dir');
			imported.push({ name: skill.name, destination, mode: 'link', source: skill.path });
			continue;
		}
		const candidate = skill.flat
			? { flat: true, files: [{ absolute: skill.path, relative: path.basename(skill.path) }] }
			: { flat: false, files: collectFiles(skill.path) };
		writeCopy(candidate, destination);
		imported.push({ name: skill.name, destination, mode: 'copy', source: skill.path });
	}
	const shadowed = [];
	for (const other of roots({ workspacePath })) {
		if (other.path === root) continue;
		const names = namesInRoot(other.path, parseYaml);
		for (const skill of selected) if (names.has(skill.name)) shadowed.push({ name: skill.name, by: other.source });
	}
	return { root, mode: sourceMode, imported, shadowed };
}

/* ── file picker fallback ────────────────────────────────────────────────── */

/**
 * Well-known directories a skill might be imported from.
 *
 * When the native directory picker is unavailable (a non-desktop composition),
 * the page falls back to this list, so it is built from directories that exist
 * and that commonly hold skills.
 * @returns labelled candidate directories.
 */
function importSuggestions() {
	const home = os.homedir();
	const candidates = [
		{ label: '~/.dsh/skills', path: globalRoot() },
		{ label: '~/.agents/skills', path: path.join(process.env.DSH_AGENTS_HOME || path.join(home, '.agents'), 'skills') },
		{ label: '~/.claude/skills', path: path.join(home, '.claude', 'skills') },
		{ label: '~/Downloads', path: path.join(home, 'Downloads') },
		{ label: '~/Documents', path: path.join(home, 'Documents') },
		{ label: '~/Desktop', path: path.join(home, 'Desktop') }
	];
	return candidates.filter((entry) => {
		try {
			return fs.statSync(entry.path).isDirectory();
		} catch {
			return false;
		}
	});
}

/* ── the HTTP surface ────────────────────────────────────────────────────── */

/** The route prefix the plugin owns. */
const ROUTE = '/skill-manager/api';
/** Cap on one request body. */
const BODY_LIMIT = 1024 * 1024;

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
 * Like the method table below, this lives in the re-required module rather than
 * in the ESM entry: Node caches an ES module by URL for the life of the process,
 * and the shipped HMR watcher does not watch a linked plugin whose files live
 * outside the profile, so a change written into the ESM entry would not take
 * effect until DSH restarted. Everything that can change therefore lives here,
 * and the entry stays a thin adapter.
 * @param deps - the YAML parser, the workspace resolver, and a reader for the
 *   deployment's trusted hosts.
 * @returns a `(request, response) => Promise<void>` handler.
 */
function createHandler({ parseYaml, resolveWorkspace, trustedHosts }) {
	const methods = createApi({ parseYaml, resolveWorkspace });
	return async (request, response) => {
		if (!isTrustedRequest(request, trustedHosts())) {
			writeJson(response, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } });
			return;
		}
		const method = new URL(request.url === void 0 ? '/' : request.url, 'http://dsh.internal').pathname.slice(ROUTE.length + 1);
		const handler = Object.hasOwn(methods, method) ? methods[method] : void 0;
		if (handler === void 0) {
			writeJson(response, 404, { ok: false, error: { code: 'not-found', message: `unknown skill-manager method "${method}"` } });
			return;
		}
		try {
			const payload = request.method === 'POST' ? await readJsonBody(request) : {};
			writeJson(response, 200, { ok: true, value: await handler(payload) });
		} catch (error) {
			writeJson(response, 200, {
				ok: false,
				error: { code: 'failed', message: error && error.message ? String(error.message) : String(error) }
			});
		}
	};
}

/* ── skill roots ─────────────────────────────────────────────────────────── */

/**
 * Build the method table this plugin's routes dispatch to.
 *
 * This lives here, in the module `index.js` re-requires on every apply, rather
 * than in the ESM entry: Node caches an ES module by URL, so a host-side edit
 * there is invisible until the process restarts. Keeping the table in CJS means
 * adding or changing a method takes effect on the next plugin toggle.
 * @param deps - the YAML parser and the workspace resolver supplied by the host
 *   half (the latter validates a path against the registered workspaces).
 * @returns the method table, keyed by wire method name.
 */
function createApi({ parseYaml, resolveWorkspace }) {
	/**
	 * Resolve the workspace a request addresses, or `undefined` for the user scope.
	 *
	 * The user scope is a first-class target — it is the global skill root, and
	 * the page sends no workspace for it. Requiring a path here would make the
	 * default view of the page fail, so absence is meaningful rather than
	 * malformed; a *present* path is still validated against the registry.
	 * @param payload - the request body.
	 * @returns the workspace path, or undefined.
	 */
	function scopeOf(payload) {
		const requested = payload === void 0 ? void 0 : payload.workspacePath;
		return requested === void 0 || requested === null || requested === '' ? void 0 : resolveWorkspace(requested);
	}

	/**
	 * The workspace a project-scoped mutation writes into.
	 *
	 * A project target has to name a workspace — there is nothing else to derive
	 * its skill root from — while the user scope needs no workspace at all.
	 * @param payload - the request body.
	 * @returns the workspace path.
	 */
	function requireProjectWorkspace(payload) {
		const workspacePath = scopeOf(payload);
		if (workspacePath === void 0) throw new Error('a project-scope import needs a workspace; switch the scope to user or open a workspace');
		return workspacePath;
	}
	return {
		/** The roots and the skill list. */
		async list(payload) {
			const workspacePath = scopeOf(payload);
			const result = listSkills({ workspacePath, parseYaml });
			return {
				roots: result.roots,
				home: dshHome(),
				workspacePath: workspacePath === void 0 ? null : workspacePath,
				skills: result.skills.map((skill) => ({
					name: skill.name,
					description: skill.description,
					heading: skill.heading,
					entry: skill.entry,
					entryPath: skill.entryPath,
					file: skill.file,
					directory: skill.directory,
					scope: skill.scope,
					source: skill.source,
					enabled: skill.enabled,
					parked: skill.parked,
					problem: skill.problem,
					bytes: skill.bytes,
					/* Non-null when this skill is a symlink: the page labels it, and
					 * the host switches it off by moving the link rather than by
					 * renaming a file through it. */
					linkTarget: skill.linkTarget === void 0 ? null : skill.linkTarget,
					/* A symlink whose target is gone: shown as broken, and the one
					 * broken shape the page can actually clean up. */
					dangling: skill.dangling === true,
					/* Whether a same-named skill in a higher-precedence root wins.
					 * Computed from the roots, not from a registry query: in the
					 * shipped Web composition discovery lives inside an agent preset,
					 * so the host-plane registry is empty and a query would mark every
					 * skill invisible. */
					shadowed: skill.shadowed === true
				}))
			};
		},
		/** Enable or disable one skill. */
		async toggle(payload) {
			const workspacePath = scopeOf(payload);
			const outcome = setSkillEnabled({ workspacePath, path: payload.path }, payload.enabled === true);
			return { changed: outcome.changed, entryPath: outcome.path, link: outcome.link === true };
		},
		/** Remove one skill from disk. */
		async remove(payload) {
			const workspacePath = scopeOf(payload);
			const outcome = deleteSkill({ workspacePath, path: payload.path });
			return { removed: outcome.removed, directory: outcome.directory, link: outcome.link === true, dangling: outcome.dangling === true };
		},
		/** Import a picked folder or file into a skill root. */
		async import(payload) {
			const scope = payload.scope === 'global' ? 'global' : 'project';
			const workspacePath = scope === 'global' ? void 0 : requireProjectWorkspace(payload);
			return importSkills({ workspacePath, scope, source: payload.source, parseYaml });
		},
		/** Scaffold a new empty skill. */
		async create(payload) {
			const scope = payload.scope === 'global' ? 'global' : 'project';
			const workspacePath = scope === 'global' ? void 0 : requireProjectWorkspace(payload);
			return createSkill({ workspacePath, scope, name: payload.name, description: payload.description, parseYaml });
		},
		/** Directories the page offers when no native picker exists. */
		async suggestions() {
			return { suggestions: importSuggestions() };
		},
		/** Other agent tools on this machine, with the skills they hold. */
		async externalSources(payload) {
			const workspacePath = payload.workspacePath === void 0 ? void 0 : resolveWorkspace(payload.workspacePath);
			return { sources: listExternalSources({ parseYaml, workspacePath }) };
		},
		/** Import selected external skills, by copy or by symlink. */
		async importExternal(payload) {
			const scope = payload.scope === 'global' ? 'global' : 'project';
			const workspacePath = scope === 'global' ? void 0 : requireProjectWorkspace(payload);
			return importExternalSkills({ workspacePath, scope, mode: payload.mode, picks: payload.picks, parseYaml });
		}
	};
}

module.exports = {
	DISABLED_SUFFIX,
	ROUTE,
	collectFiles,
	createApi,
	createHandler,
	createSkill,
	deleteSkill,
	dshHome,
	firstHeading,
	globalRoot,
	importExternalSkills,
	importSkills,
	importSuggestions,
	isInside,
	importExternalSkills,
	listExternalSources,
	listSkills,
	parseFrontmatter,
	projectRootOf,
	readSkill,
	resolveTarget,
	setSkillEnabled,
	validateFrontmatter,
	workspaceRoot
};
