import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { parseStringPromise, Builder } from 'xml2js';
import { RTFHandler } from '../dist/services/parsers/rtf-handler.js';

const digest = data => createHash('sha256').update(data).digest('hex');
const array = value => value ? (Array.isArray(value) ? value : [value]) : [];
const uuid = value => typeof value === 'string' && /^[A-Fa-f0-9-]{36}$/.test(value);
export async function inventory(root) {
  const result = {};
  async function walk(dir) {
    for (const name of (await fs.readdir(dir)).sort()) {
      const file = path.join(dir, name), stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) throw new Error('Linked files/junctions are unsupported');
      if (stat.isDirectory()) await walk(file);
      else if (stat.isFile()) result[path.relative(root, file)] = digest(await fs.readFile(file));
      else throw new Error('Unsupported project file');
    }
  }
  await walk(root); return result;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function optional(file) {
  try { return await fs.readFile(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function flatten(container, ancestors = []) {
  return array(container?.BinderItem).flatMap(item => [{ item, ancestors }, ...flatten(item.Children?.[0], [...ancestors, item])]);
}
function rtf(text) {
  let escaped = '';
  for (let i = 0; i < text.length; i++) {
    const n = text.charCodeAt(i), c = text[i];
    escaped += c === '\n' ? '\\par\n' : c === '\r' ? '' : /[\\{}]/.test(c) ? `\\${c}` : n > 127 ? `\\u${n > 32767 ? n - 65536 : n}?` : c;
  }
  return `{\\rtf1\\ansi\\uc1 ${escaped}}`;
}

export class SafeProjectBridge {
  constructor(config) { this.config = config; this.plans = new Map(); this.busy = false; }
  async initialize() {
    this.root = await fs.realpath(this.config.projectPath);
    await fs.mkdir(this.config.backupRoot, { recursive: true });
    this.backups = await fs.realpath(this.config.backupRoot);
    const relative = path.relative(this.root, this.backups);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) throw new Error('Backups must be outside project');
    this.xmlName = (await fs.readdir(this.root)).find(name => name.endsWith('.scrivx'));
    if (!this.xmlName) throw new Error('Project XML missing');
    await inventory(this.root);
    return this;
  }
  async closed() {
    if (await optional(path.join(this.root, 'Files', 'user.lock'))) throw new Error('Close Scrivener first; user.lock exists');
  }
  async transactions() {
    const results = [];
    for (const name of await fs.readdir(this.backups)) {
      if (!/^transaction-[A-Za-z0-9]+$/.test(name)) continue;
      const journal = await optional(path.join(this.backups, name, 'journal.json'));
      if (journal) results.push({ transaction: name, ...JSON.parse(journal.toString()) });
    }
    return results;
  }
  async recover(name) {
    if (!/^transaction-[A-Za-z0-9]+$/.test(name)) throw new Error('Invalid transaction ID');
    if (this.busy) throw new Error('Transaction running');
    this.busy = true;
    let lock;
    try {
      // A crash may leave bridge.lock. Recovery is intentionally not automatic:
      // the user must establish that no bridge process remains before removing it.
      lock = await fs.open(path.join(this.backups, 'bridge.lock'), 'wx');
      await this.closed();
      const session = path.join(this.backups, name);
      const journal = JSON.parse((await fs.readFile(path.join(session, 'journal.json'))).toString());
      if (journal.state !== 'prepared' || journal.project !== this.root) throw new Error('Not an incomplete transaction for this project');
      const before = JSON.parse(await fs.readFile(path.join(session, 'before.json'), 'utf8'));
      if (!same(before, await inventory(path.join(session, 'project.scriv')))) throw new Error('Recovery backup is damaged');
      const current = await inventory(this.root);
      for (const [file, hash] of Object.entries(current)) {
        if (hash !== before[file] && hash !== journal.nextHashes[file]) throw new Error('External changes detected; manual recovery required');
      }
      for (const file of Object.keys(before)) if (!(file in current)) throw new Error('Files were removed externally; manual recovery required');
      for (const file of journal.files) {
        const old = await optional(path.join(session, 'project.scriv', file));
        if (old) await fs.writeFile(path.join(this.root, file), old);
        else if (file in current) await fs.unlink(path.join(this.root, file));
      }
      if (!same(before, await inventory(this.root))) throw new Error('Recovery verification failed');
      await fs.writeFile(path.join(session, 'journal.json'), JSON.stringify({ state: 'rolled_back', project: this.root }));
      return { recovered: true, transaction: name };
    } finally {
      if (lock) { await lock.close(); await fs.unlink(path.join(this.backups, 'bridge.lock')); }
      this.busy = false;
    }
  }
  async binder() {
    const xml = await fs.readFile(path.join(this.root, this.xmlName));
    const tree = await parseStringPromise(xml);
    const rows = flatten(tree.ScrivenerProject?.Binder?.[0]);
    if (!rows.length) throw new Error('Unsupported/empty Binder');
    return { xml, tree, rows };
  }
  async list() {
    const { rows } = await this.binder();
    return rows.filter(row => !row.ancestors.some(a => a.$.Type === 'TrashFolder') && row.item.$.Type !== 'TrashFolder')
      .map(({ item, ancestors }) => ({ id: item.$.UUID, title: item.Title?.[0], type: item.$.Type, parentId: ancestors.at(-1)?.$.UUID, depth: ancestors.length }));
  }
  async read(id) {
    if (!uuid(id)) throw new Error('Invalid document UUID');
    const { rows } = await this.binder();
    if (!rows.some(row => row.item.$.UUID === id)) throw new Error('Unknown document');
    const dir = path.join(this.root, 'Files', 'Data', id), parser = new RTFHandler();
    const body = await optional(path.join(dir, 'content.rtf')), notes = await optional(path.join(dir, 'notes.rtf'));
    return { documentId: id, bodyPresent: body !== null,
      content: body ? (await parser.parseRTF(body.toString())).plainText : '',
      notes: notes ? (await parser.parseRTF(notes.toString())).plainText : '',
      synopsis: (await optional(path.join(dir, 'synopsis.txt')))?.toString() ?? '' };
  }
  async search(query) {
    if (typeof query !== 'string' || !query.trim()) throw new Error('Nonempty search query required');
    const matches = [];
    for (const row of await this.list()) {
      if (row.type !== 'Text') continue;
      const doc = await this.read(row.id);
      for (const field of ['content', 'notes', 'synopsis']) {
        const offset = doc[field].toLowerCase().indexOf(query.toLowerCase());
        if (offset >= 0) matches.push({ documentId: row.id, title: row.title, field, snippet: doc[field].slice(Math.max(0, offset - 100), offset + 250) });
      }
    }
    return matches;
  }
  async prepare(input) {
    await this.closed();
    if (!['research', 'append_note', 'synopsis'].includes(input.kind)) throw new Error('Unsupported change kind');
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 1000000) throw new Error('Text required, maximum 1M characters');
    const before = await inventory(this.root), { tree, rows } = await this.binder();
    const changes = new Map();
    let documentId = input.documentId;
    const target = rows.find(row => row.item.$.UUID === documentId);
    if (input.kind !== 'research') {
      if (!uuid(documentId) || !target || target.item.$.Type !== 'Text' || target.ancestors.some(a => a.$.Type === 'TrashFolder')) throw new Error('Active text document required');
      if (!this.config.allowDocumentNotes) throw new Error('Document notes/synopsis permission is disabled');
    }
    if (input.kind === 'append_note') {
      const file = path.join('Files', 'Data', documentId, 'notes.rtf'), old = await optional(path.join(this.root, file));
      const addition = `\n\n[AI Note — ${new Date().toISOString()}]\n${input.text}`;
      if (old) {
        const raw = old.toString('latin1'), end = raw.lastIndexOf('}');
        if (!raw.startsWith('{\\rtf') || end < 0 || raw.slice(end + 1).trim()) throw new Error('Unsupported notes RTF; refusing to regenerate existing notes');
        // Existing bytes remain intact; insert a self-contained scoped group.
        const fragment = rtf(addition).replace(/^\{\\rtf1/, '{\\plain');
        changes.set(file, Buffer.concat([old.subarray(0, end), Buffer.from(fragment), old.subarray(end)]));
      } else changes.set(file, Buffer.from(rtf(addition)));
    } else if (input.kind === 'synopsis') {
      changes.set(path.join('Files', 'Data', documentId, 'synopsis.txt'), Buffer.from(input.text));
    } else {
      if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 255) throw new Error('Research title required, maximum 255 characters');
      if (typeof input.artifactKey !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(input.artifactKey)) throw new Error('Stable artifactKey required');
      const research = rows.find(row => row.item.$.UUID === this.config.researchRootId);
      if (!research || research.item.$.Type !== 'ResearchFolder' || research.ancestors.some(a => ['DraftFolder', 'TrashFolder'].includes(a.$.Type))) throw new Error('Configured Research UUID is not a safe Research root');
      const children = research.item.Children ??= [{ BinderItem: [] }];
      children[0].BinderItem ??= [];
      let ai = children[0].BinderItem.find(item => item.Title?.[0] === 'AI Notes');
      if (ai && ai.$.Type !== 'Folder') throw new Error('AI Notes exists but is not a folder');
      if (!ai) { ai = { $: { UUID: randomUUID().toUpperCase(), Type: 'Folder' }, Title: ['AI Notes'], Children: [{ BinderItem: [] }] }; children[0].BinderItem.push(ai); }
      const aiChildren = ai.Children ??= [{ BinderItem: [] }]; aiChildren[0].BinderItem ??= [];
      const keysFile = path.join(this.backups, 'artifact-keys.json');
      const keys = JSON.parse((await optional(keysFile))?.toString() ?? '{}');
      const savedId = keys[input.artifactKey];
      let artifact = aiChildren[0].BinderItem.find(item => item.$.UUID === savedId || item.MetaData?.[0]?.AIArtifactKey?.[0] === input.artifactKey);
      if (savedId && !artifact) throw new Error('Previously imported artifact was moved or removed; resolve explicitly');
      if (!artifact) {
        artifact = { $: { UUID: randomUUID().toUpperCase(), Type: 'Text' }, Title: [input.title], MetaData: [{ IncludeInCompile: ['No'], AIArtifactKey: [input.artifactKey] }] };
        aiChildren[0].BinderItem.push(artifact);
      }
      documentId = artifact.$.UUID; artifact.Title = [input.title];
      if (!uuid(documentId) || artifact.$.Type !== 'Text') throw new Error('Research artifact must be a text document with a valid UUID');
      if (input.sources !== undefined && (!Array.isArray(input.sources) || input.sources.length > 100 || JSON.stringify(input.sources).length > 100000)) throw new Error('Invalid or oversized provenance');
      const provenance = JSON.stringify(input.sources ?? [], null, 2);
      const text = `${input.title}\n\n${input.text}\n\nSources and provenance\nRetrieved: ${new Date().toISOString()}\n${provenance}\n\nSource claims, interpretations and uncertainties should be distinguished in the brief.`;
      changes.set(path.join('Files', 'Data', documentId, 'content.rtf'), Buffer.from(rtf(text)));
      const checksumFile = path.join('Files', 'Data', 'docs.checksum');
      const checksum = await optional(path.join(this.root, checksumFile));
      if (checksum) {
        const key = `${documentId}/content.rtf`;
        const hash = createHash('sha1').update(changes.get(path.join('Files', 'Data', documentId, 'content.rtf'))).digest('hex');
        const lines = checksum.toString().split('\n').filter(line => line && !line.startsWith(`${key}=`));
        lines.push(`${key}=${hash}`);
        changes.set(checksumFile, Buffer.from(`${lines.join('\n')}\n`));
      }
      changes.set(this.xmlName, Buffer.from(new Builder().buildObject(tree)));
      // Stable keys also persist externally: unknown XML metadata may be stripped by Scrivener.
      if (savedId && savedId !== documentId) throw new Error('Artifact key mapping changed; resolve explicitly rather than duplicate');
    }
    const preview = [];
    for (const [file, data] of changes) preview.push({ file, previousHash: before[file] ?? null, nextHash: digest(data), bytes: data.length });
    const token = randomUUID();
    this.plans.set(token, { before, changes, input, documentId, expires: Date.now() + 15 * 60 * 1000 });
    return { token, documentId, kind: input.kind, previous: target ? await this.read(documentId) : null,
      text: input.text, sources: input.sources ?? [], changes: preview, expiresInMinutes: 15 };
  }
  async commit(token, faultAfter = Infinity) {
    if (this.busy) throw new Error('Another transaction is running');
    const plan = this.plans.get(token);
    if (!plan || plan.expires < Date.now()) throw new Error('Unknown/expired preview token');
    this.busy = true;
    let lock, session, changed = [];
    try {
      lock = await fs.open(path.join(this.backups, 'bridge.lock'), 'wx');
      if ((await this.transactions()).some(j => j.state === 'prepared')) throw new Error('Incomplete transaction requires recovery before another write');
      await this.closed();
      if (!same(plan.before, await inventory(this.root))) throw new Error('Project changed since preview; prepare again');
      session = await fs.mkdtemp(path.join(this.backups, 'transaction-'));
      const backup = path.join(session, 'project.scriv');
      await fs.cp(this.root, backup, { recursive: true });
      if (!same(plan.before, await inventory(backup)) || !same(plan.before, await inventory(this.root))) throw new Error('Backup/source changed during snapshot');
      await fs.writeFile(path.join(session, 'before.json'), JSON.stringify(plan.before, null, 2));
      await fs.writeFile(path.join(session, 'journal.json'), JSON.stringify({ state: 'prepared', project: this.root, token, files: [...plan.changes.keys()], nextHashes: Object.fromEntries([...plan.changes].map(([file, data]) => [file, digest(data)])) }));
      for (const [file, data] of plan.changes) {
        await this.closed();
        const destination = path.join(this.root, file);
        const current = await optional(destination);
        if ((current ? digest(current) : undefined) !== plan.before[file]) throw new Error('Target changed during transaction');
        await fs.mkdir(path.dirname(destination), { recursive: true });
        changed.push(file);
        await fs.writeFile(destination, data);
        if (digest(await fs.readFile(destination)) !== digest(data)) throw new Error('Readback mismatch');
        if (changed.length >= faultAfter) throw new Error('Injected write failure');
      }
      const expected = { ...plan.before };
      for (const [file, data] of plan.changes) expected[file] = digest(data);
      const after = await inventory(this.root);
      if (Object.keys(after).length !== Object.keys(expected).length || Object.entries(expected).some(([file, hash]) => after[file] !== hash)) throw new Error('Unexpected concurrent change');
      if (plan.input.kind === 'research') {
        const keysFile = path.join(this.backups, 'artifact-keys.json');
        const keys = JSON.parse((await optional(keysFile))?.toString() ?? '{}');
        keys[plan.input.artifactKey] = plan.documentId;
        await fs.writeFile(keysFile, JSON.stringify(keys, null, 2));
      }
      await fs.writeFile(path.join(session, 'journal.json'), JSON.stringify({ state: 'committed', token, files: changed, after }));
      this.plans.delete(token);
      return { committed: true, documentId: plan.documentId, backup, changedFiles: changed, reopenProject: true };
    } catch (error) {
      if (session && changed.length) {
        try {
          for (const file of changed.reverse()) {
            await this.closed();
            const present = await optional(path.join(this.root, file));
            if (present && digest(present) !== digest(plan.changes.get(file)) && digest(present) !== plan.before[file]) throw new Error('External change detected during rollback; manual recovery required');
            const old = await optional(path.join(session, 'project.scriv', file));
            const destination = path.join(this.root, file);
            if (old) await fs.writeFile(destination, old); else await fs.unlink(destination);
          }
          await fs.writeFile(path.join(session, 'journal.json'), JSON.stringify({ state: 'rolled_back', project: this.root, reason: error.message }));
        } catch (rollbackError) { throw new Error(`ROLLBACK FAILED: ${rollbackError.message}; retain backup at ${session}`); }
      }
      throw error;
    } finally {
      if (lock) { await lock.close(); await fs.unlink(path.join(this.backups, 'bridge.lock')); }
      this.busy = false;
    }
  }
}
