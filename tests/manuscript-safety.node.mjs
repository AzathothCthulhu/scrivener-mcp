import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { isolateProject, isToolAllowed } from '../dist/utils/manuscript-safety.js';
import { initializeSkillRegistry, activateSkills, getRegisteredTools,
	executeRegisteredHandler } from '../dist/handlers/skill-registry.js';

test('every skill hides mutations and direct dispatch rejects before touching context', async () => {
	initializeSkillRegistry();
	activateSkills('project', 'documents', 'search', 'analysis', 'compilation', 'memory', 'relationships', 'advanced');
	const names = getRegisteredTools().map((tool) => tool.name);
	assert.ok(names.includes('read_document'));
	assert.ok(names.includes('get_document_info'));
	assert.ok(names.includes('search'));
	assert.ok(names.every(isToolAllowed));
	for (const name of ['write_document', 'update_document', 'create_document', 'enhance_content', 'future_tool']) {
		await assert.rejects(executeRegisteredHandler(name, {}, null), /disabled by manuscript safety policy/);
		assert.ok(!names.includes(name));
	}
});

test('default policy denies mutations and newly introduced tools', () => {
	delete process.env.SCRIVENER_MCP_UNSAFE_UPSTREAM_WRITES;
	for (const name of ['write_document', 'create_document', 'delete_document', 'move_document',
		'update_document', 'restore_document', 'create_snapshot', 'enhance_content',
		'queue_project_analysis', 'export_project', 'future_tool']) assert.equal(isToolAllowed(name), false);
	for (const name of ['open_project', 'get_structure', 'search', 'read_document',
		'get_document_info', 'find_mentions']) assert.equal(isToolAllowed(name), true);
	process.env.SCRIVENER_MCP_UNSAFE_UPSTREAM_WRITES = 'true';
	assert.equal(isToolAllowed('write_document'), false);
	process.env.SCRIVENER_MCP_UNSAFE_UPSTREAM_WRITES = '1';
	assert.equal(isToolAllowed('write_document'), true);
	delete process.env.SCRIVENER_MCP_UNSAFE_UPSTREAM_WRITES;
});

test('upstream support/content writes to the isolated copy cannot change source', async () => {
	const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'scrivener-safety-fixture-'));
	const source = path.join(fixture, 'Synthetic.scriv');
	await fs.mkdir(path.join(source, 'Files', 'Data', 'scene'), { recursive: true });
	const xml = path.join(source, 'Synthetic.scrivx');
	const rtf = path.join(source, 'Files', 'Data', 'scene', 'content.rtf');
	await fs.writeFile(xml, '<ScrivenerProject/>');
	await fs.writeFile(rtf, '{\\rtf1 Original}');
	const copy = await isolateProject(source, xml);
	await fs.writeFile(copy.scrivxPath, 'changed');
	await fs.writeFile(path.join(copy.projectPath, 'Files', 'Data', 'scene', 'content.rtf'), 'changed');
	await fs.mkdir(path.join(copy.projectPath, '.scrivener-mcp'));
	assert.equal(await fs.readFile(xml, 'utf8'), '<ScrivenerProject/>');
	assert.equal(await fs.readFile(rtf, 'utf8'), '{\\rtf1 Original}');
	await assert.rejects(fs.stat(path.join(source, '.scrivener-mcp')));
	await assert.rejects(isolateProject(source, path.join(copy.projectPath, 'Synthetic.scrivx')));
	// Junction creation works on Windows without symlink elevation.
	await fs.symlink(copy.projectPath, path.join(source, 'linked'), 'junction');
	await assert.rejects(isolateProject(source, xml), /Linked project files/);
});
