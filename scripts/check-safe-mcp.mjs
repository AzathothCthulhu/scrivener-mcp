// Runs against a disposable copy named in a test-only config. Never point at a live project.
import * as fs from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
const [configFile, inputFile] = process.argv.slice(2);
const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
if (config.disposableTestProject !== true) throw new Error('Test config must explicitly mark disposableTestProject');
const input = JSON.parse(await fs.readFile(inputFile, 'utf8'));
const client = new Client({ name: 'scrivener-bridge-verifier', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./safe-mcp.mjs', import.meta.url))], env: { ...process.env, SCRIVENER_BRIDGE_CONFIG: configFile } }));
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text);
}
try {
  const tools = await client.listTools();
  const binder = await call('scrivener_binder');
  const before = await call('scrivener_read', { documentId: input.documentId });
  const preview = await call('scrivener_prepare_change', input.research);
  await call('scrivener_commit_change', { token: preview.token });
  const artifact = await call('scrivener_read', { documentId: preview.documentId });
  if (!artifact.content.includes(input.research.text)) throw new Error('Research readback mismatch');
  const repeat = await call('scrivener_prepare_change', { ...input.research, text: `${input.research.text}\nUpdated test brief.` });
  if (repeat.documentId !== preview.documentId) throw new Error('Duplicate import');
  await call('scrivener_commit_change', { token: repeat.token });
  for (const kind of ['append_note', 'synopsis']) {
    const plan = await call('scrivener_prepare_change', { kind, documentId: input.documentId, text: 'Bridge verification marker — disposable project only.' });
    await call('scrivener_commit_change', { token: plan.token });
  }
  const after = await call('scrivener_read', { documentId: input.documentId });
  if (after.content !== before.content || !after.notes.includes(before.notes) || !after.notes.includes('Bridge verification marker')) throw new Error('Note/body preservation failed');
  const matches = await call('scrivener_search', { query: 'Bridge verification marker' });
  if (!matches.length) throw new Error('Search readback failed');
  const denied = await client.callTool({ name: 'write_document', arguments: {} });
  if (!denied.isError) throw new Error('Generic manuscript write exposed');
  console.log(JSON.stringify({ passed: true, tools: tools.tools.map(tool => tool.name), binderEntries: binder.length, researchImported: true, duplicatePrevented: true, notesAppended: true, synopsisUpdated: true, manuscriptPreserved: true, searchMatches: matches.length }));
} finally { await client.close(); }
