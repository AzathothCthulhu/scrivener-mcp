import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
const client = new Client({ name: 'scrivener-read-verifier', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./safe-mcp.mjs', import.meta.url))], env: { ...process.env, SCRIVENER_BRIDGE_CONFIG: process.argv[2] } }));
try {
  const tools = await client.listTools();
  const binderResult = await client.callTool({ name: 'scrivener_binder', arguments: {} });
  if (binderResult.isError) throw new Error(binderResult.content[0].text);
  const binder = JSON.parse(binderResult.content[0].text);
  const chapter = binder.find(row => row.type === 'Text' && /^Ch1\b/.test(row.title));
  if (!chapter) throw new Error('First chapter not found');
  const result = await client.callTool({ name: 'scrivener_read', arguments: { documentId: chapter.id } });
  if (result.isError) throw new Error(result.content[0].text);
  const text = JSON.parse(result.content[0].text);
  console.log(JSON.stringify({ connected: true, toolCount: tools.tools.length, binderEntries: binder.length, chapterBodyPresent: text.bodyPresent, chapterCharacters: text.content.length }));
} finally { await client.close(); }
