// Offline validation: deliberately bypass server startup, AI and database setup.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { isolateProject } from '../dist/utils/manuscript-safety.js';
import { ProjectLoader } from '../dist/services/project-loader.js';
import { DocumentManager } from '../dist/services/document-manager.js';

const [source, backupRoot] = process.argv.slice(2);
if (!source || !backupRoot) throw new Error('Supply project directory and external backup directory');
const realSource = await fs.realpath(source);
const backupAbsolute = path.resolve(backupRoot);
const relativeBackup = path.relative(realSource, backupAbsolute);
if (!relativeBackup.startsWith('..') && !path.isAbsolute(relativeBackup)) throw new Error('Backup must be outside project');
async function inventory(root) {
	const entries = {};
	async function walk(dir) {
		for (const name of (await fs.readdir(dir)).sort()) {
			const file = path.join(dir, name);
			const stat = await fs.lstat(file);
			if (stat.isSymbolicLink()) throw new Error('Linked files are unsupported');
			if (stat.isDirectory()) await walk(file);
			else entries[path.relative(root, file)] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
		}
	}
	await walk(root);
	return entries;
}
const before = await inventory(realSource);
const xmlName = Object.keys(before).find(name => !name.includes(path.sep) && name.endsWith('.scrivx'));
if (!xmlName) throw new Error('No root project XML');
const isolated = await isolateProject(realSource, path.join(realSource, xmlName));
const copied = await inventory(isolated.projectPath);
if (JSON.stringify(before) !== JSON.stringify(copied) || JSON.stringify(before) !== JSON.stringify(await inventory(realSource))) {
	throw new Error('Project changed during copy; save and close Scrivener before retrying');
}
await fs.mkdir(backupAbsolute, { recursive: true });
const backupSession = await fs.mkdtemp(path.join(backupAbsolute, 'verified-'));
const backup = path.join(backupSession, path.basename(realSource));
await fs.cp(isolated.projectPath, backup, { recursive: true, errorOnExist: true, force: false });
if (JSON.stringify(before) !== JSON.stringify(await inventory(backup))) throw new Error('Backup verification failed');
await fs.writeFile(path.join(backupSession, 'sha256-manifest.json'), JSON.stringify(before, null, 2), { flag: 'wx' });
const loader = new ProjectLoader(isolated.projectPath, { scrivxPath: isolated.scrivxPath });
const structure = await loader.loadProject();
const manager = new DocumentManager(isolated.projectPath);
manager.setProjectStructure(structure);
const documents = await manager.getAllDocuments();
let readable = 0;
let characters = 0;
let morriganDocuments = 0;
const errors = [];
for (const doc of documents) {
	if (doc.type !== 'Text') continue;
	try {
		const text = await manager.readDocument(doc.id);
		readable++;
		characters += text.length;
		if (/morr[ií]gan/i.test(text)) morriganDocuments++;
	} catch (error) { errors.push({ id: doc.id, error: error.message }); }
}
if (JSON.stringify(before) !== JSON.stringify(await inventory(realSource))) throw new Error('Source changed during validation');
const report = { sourceUnchanged: true, backupVerified: true, backup, isolatedCopy: isolated.projectPath,
	fileCount: Object.keys(before).length, binderDocuments: documents.length, readableTextDocuments: readable,
	synopsisDocuments: documents.filter(doc => doc.synopsis || doc.metadata?.synopsis).length,
	notesDocuments: documents.filter(doc => doc.notes || doc.metadata?.notes).length,
	textCharacters: characters, morriganDocuments, errors,
	limits: 'Service-level offline validation only; no MCP startup, Scrivener round-trip or write rollback tested.' };
await fs.writeFile(path.join(backupSession, 'validation.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ ...report, errors: `${errors.length} body-read failures; details in validation.json` }, null, 2));
process.exit(errors.length ? 1 : 0);
