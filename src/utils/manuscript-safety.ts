import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// Deliberate opt-in for upstream development, never an AI Notes write mode.
export function manuscriptSafetyEnabled(): boolean {
	return process.env.SCRIVENER_MCP_UNSAFE_UPSTREAM_WRITES !== '1';
}

const READ_TOOLS = new Set([
	'list_skills', 'use_skill', 'open_project', 'close_project', 'refresh_project',
	'discover_projects', 'detect_open_project', 'get_structure', 'get_document_info',
	'read_document', 'search', 'find_mentions', 'read_annotations', 'list_trash',
	'get_statistics', 'get_compile_settings', 'list_snapshots', 'read_snapshot',
	'compare_snapshot',
]);

export function isToolAllowed(name: string): boolean {
	return !manuscriptSafetyEnabled() || READ_TOOLS.has(name);
}

/** Copy before upstream can initialize databases or flush cached project state.
 * Retain the copy; do not recursively delete manuscript-bearing files.
 */
export async function isolateProject(projectPath: string, scrivxPath: string) {
	const source = await fs.realpath(projectPath);
	const relativeXml = path.relative(source, await fs.realpath(scrivxPath));
	if (relativeXml.startsWith('..') || path.isAbsolute(relativeXml)) {
		throw new Error('Project XML must be inside the project directory');
	}
	async function rejectLinks(entry: string): Promise<void> {
		const stat = await fs.lstat(entry);
		if (stat.isSymbolicLink()) throw new Error('Linked project files are not supported in safe mode');
		if (stat.isDirectory()) {
			for (const child of await fs.readdir(entry)) await rejectLinks(path.join(entry, child));
		}
	}
	await rejectLinks(source);
	const session = await fs.mkdtemp(path.join(os.tmpdir(), 'scrivener-mcp-read-'));
	const copy = path.join(session, path.basename(source));
	await fs.cp(source, copy, {
		recursive: true,
		dereference: false,
		filter: async (entry) => {
			if ((await fs.lstat(entry)).isSymbolicLink()) {
				throw new Error('Project changed to include a link during copying');
			}
			return true;
		},
	});
	return { projectPath: copy, scrivxPath: path.join(copy, relativeXml) };
}
