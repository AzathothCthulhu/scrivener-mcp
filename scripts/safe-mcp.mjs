#!/usr/bin/env node
// Narrow, offline-first entry point; avoids upstream AI discovery and auto-setup.
import * as fs from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { SafeProjectBridge } from './safe-project-bridge.mjs';

if (!process.env.SCRIVENER_BRIDGE_CONFIG) throw new Error('SCRIVENER_BRIDGE_CONFIG must name a local configuration file');
const config = JSON.parse(await fs.readFile(process.env.SCRIVENER_BRIDGE_CONFIG, 'utf8'));
const bridge = await new SafeProjectBridge(config).initialize();
const string = description => ({ type: 'string', description });
const tools = [
  { name: 'scrivener_export_bundle', description: 'Read selected documents into a portable JSON bundle for a user-authorised transfer to Capacities or another connected system. Returns content and Scrivener UUID provenance; sends nothing externally.', properties: { documentIds: { type: 'array', description: 'Up to 20 Binder UUIDs to export', items: { type: 'string' }, minItems: 1, maxItems: 20 } }, required: ['documentIds'], run: async args => {
    if (!Array.isArray(args.documentIds) || args.documentIds.length < 1 || args.documentIds.length > 20) throw new Error('Select 1–20 documents');
    return { sourceSystem: 'Scrivener', exportedAt: new Date().toISOString(), documents: await Promise.all(args.documentIds.map(id => bridge.read(id))) };
  } },
  { name: 'scrivener_transactions', description: 'List backup transaction journals and recovery status.', properties: {}, run: () => bridge.transactions() },
  { name: 'scrivener_recover_transaction', description: 'Recover an incomplete transaction from its verified backup only if no external changes are detected. Requires Scrivener closed and no other bridge process. Does not override a stale bridge lock automatically.', properties: { transaction: string('Transaction ID from scrivener_transactions') }, required: ['transaction'], write: true, run: args => { if (config.enableWrites !== true) throw new Error('Writes disabled'); return bridge.recover(args.transaction); } },
  { name: 'scrivener_binder', description: 'Read the configured saved project Binder. Excludes Trash. No project writes.', properties: {}, run: () => bridge.list() },
  { name: 'scrivener_read', description: 'Read body, synopsis and notes by Binder UUID; distinguishes absent bodies from empty text.', properties: { documentId: string('Binder document UUID') }, required: ['documentId'], run: args => bridge.read(args.documentId) },
  { name: 'scrivener_search', description: 'Offline literal substring search across active text bodies, notes and synopses. No AI calls.', properties: { query: string('Literal phrase to find') }, required: ['query'], run: args => bridge.search(args.query) },
  { name: 'scrivener_prepare_change', description: 'Preview a Research/AI Notes artifact, append-only document note, or synopsis replacement. Does not write the project. Retrieve connected-system material in chat first, distinguish source claims from interpretation, and include provenance. Returns a short-lived token for the exact proposed change.', properties: {
    kind: { type: 'string', enum: ['research', 'append_note', 'synopsis'], description: 'Allowed operation; manuscript body edits are forbidden' },
    text: string('Finished brief/note/synopsis, including uncertainties'), title: string('Research artifact title'),
    artifactKey: string('Stable research identifier reused on updates'), documentId: string('UUID for notes or synopsis'),
    sources: { type: 'array', description: 'Provenance from Capacities or another connected system', items: { type: 'object', properties: { system: string('Source system'), objectId: string('Source object ID'), title: string('Source title'), url: string('Source URL when available'), updatedAt: string('Source modification timestamp when known') }, required: ['system', 'objectId', 'title'], additionalProperties: false } }
  }, required: ['kind', 'text'], run: args => bridge.prepare(args) },
  { name: 'scrivener_commit_change', description: 'Apply an exact prepared token to the configured project after verified external backup. Requires Scrivener closed, unchanged files and write opt-in. Automatically rolls back caught failures. Reopen Scrivener afterward. Never edits manuscript body text.', properties: { token: string('Token returned by prepare_change') }, required: ['token'], write: true,
    run: args => { if (config.enableWrites !== true) throw new Error('Writes disabled in local configuration'); return bridge.commit(args.token); } },
];
const server = new Server({ name: 'scrivener-safe-bridge', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(({ run, properties, required, write, ...tool }) => ({ ...tool,
  inputSchema: { type: 'object', properties, required: required ?? [], additionalProperties: false },
  annotations: { readOnlyHint: !write, destructiveHint: Boolean(write), openWorldHint: false }
})) }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  try {
    const tool = tools.find(tool => tool.name === request.params.name);
    if (!tool) throw new Error('Unknown/forbidden tool');
    const args = request.params.arguments ?? {};
    for (const key of tool.required ?? []) if (!(key in args)) throw new Error(`Missing ${key}`);
    for (const key of Object.keys(args)) if (!(key in tool.properties)) throw new Error(`Unknown parameter ${key}`);
    const result = await tool.run(args);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
});
await server.connect(new StdioServerTransport());
