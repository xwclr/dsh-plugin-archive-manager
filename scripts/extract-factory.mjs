/**
 * Cut the factory body out of an original client bundle.
 *
 * The skill manager and workspace colors halves were written and tested as
 * standalone browser bundles: each is one `__ModuleLoader__.load({ id, factory })`
 * call whose factory body is the whole feature. This plugin ships a single
 * client module, so the bodies are lifted out verbatim and re-embedded by
 * `build-client.mjs` — no behaviour is retyped, and the originals stay under
 * `src/original/` as the reference the fragments were cut from.
 *
 * Run with `node scripts/extract-factory.mjs` (also step one of `pnpm build`).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = 'factory: (require) => {';
const TAIL = '\n\t}\n});';

const sources = [
	{
		source: 'src/original/skills.client.js',
		target: 'src/features/skills.factory.js',
		doc: `/**
 * 技能管理 / Skill Manager — browser feature factory.
 *
 * Lifted verbatim from the standalone \`dsh-plugin-skill-manager\` client bundle
 * by \`scripts/extract-factory.mjs\`; only the loader wrapper was removed. The
 * feature registers the sidebar「技能」row and the full-page manager it opens.
 *
 * @param require - the module table this plugin's factory received.
 * @returns the feature module: \`{ apply, inject, SkillManagerPage, SkillManagerIcon }\`.
 */`
	},
	{
		source: 'src/original/colors.client.js',
		target: 'src/features/colors.factory.js',
		doc: `/**
 * 工作区配色 / Workspace Colors — browser feature factory.
 *
 * Lifted verbatim from the standalone \`dsh-plugin-workspace-colors\` client bundle
 * by \`scripts/extract-factory.mjs\`; only the loader wrapper was removed. The
 * feature paints workspace rows, hangs their sessions off a coloured rail, and
 * owns the "更改颜色" palette overlay.
 *
 * @param require - the module table this plugin's factory received.
 * @returns the feature module: \`{ apply, inject, WorkspaceColorPalette }\`.
 */`
	}
];

for (const entry of sources) {
	const source = readFileSync(join(root, entry.source), 'utf8');
	const start = source.indexOf(MARKER);
	const end = source.lastIndexOf(TAIL);
	if (start < 0 || end < 0 || end <= start) {
		throw new Error(`${entry.source}: cannot locate the factory body (marker ${start}, tail ${end})`);
	}
	const body = source.slice(start + MARKER.length, end);
	const fragment = `${entry.doc}\n(require) => {${body}\n}\n`;
	writeFileSync(join(root, entry.target), fragment);
	process.stdout.write(`extracted ${entry.source} -> ${entry.target} (${body.length} body bytes)\n`);
}
