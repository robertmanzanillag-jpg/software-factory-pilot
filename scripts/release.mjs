import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from './site.mjs';

const repository = 'robertmanzanillag-jpg/software-factory-pilot';
const api = `https://api.github.com/repos/${repository}`;
const sha = /^[a-f0-9]{40}$/;
const objectHash = (type, bytes) => createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');
const reject = () => { throw Error('PILOT_RELEASE_SOURCE_UNVERIFIED'); };

function treeIdentity(entries) {
  const root = new Map();
  const seen = new Set();
  for (const entry of entries) {
    if (typeof entry.path !== 'string' || entry.path.length > 1000 || !sha.test(entry.sha) ||
        entry.path.split('/').some(segment => !segment || segment === '.' || segment === '..' || /[\\\x00-\x1f]/.test(segment)) || seen.has(entry.path)) reject();
    seen.add(entry.path);
    if (entry.type === 'tree' && entry.mode === '040000') continue;
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) reject();
    const parts = entry.path.split('/');
    let node = root;
    for (const name of parts.slice(0, -1)) {
      if (!node.has(name)) node.set(name, new Map());
      node = node.get(name);
      if (!(node instanceof Map)) reject();
    }
    const name = parts.at(-1);
    if (node.has(name)) reject();
    node.set(name, entry);
  }
  const hashTree = node => objectHash('tree', Buffer.concat([...node].sort(([an, av], [bn, bv]) =>
    Buffer.compare(Buffer.from(an + (av instanceof Map ? '/' : '')), Buffer.from(bn + (bv instanceof Map ? '/' : ''))))
    .map(([name, item]) => Buffer.concat([Buffer.from(`${item instanceof Map ? '40000' : item.mode} ${name}\0`),
      Buffer.from(item instanceof Map ? hashTree(item) : item.sha, 'hex')]))));
  return hashTree(root);
}

/** Artifact construction only: this does not authorize or deploy a release.
 * Caller must separately validate the live financial ledger, exact release gate,
 * lease/fence and operation immediately before publication. No candidate script
 * is imported or executed; only two immutable public source blobs are copied. */
export async function prepareReleaseArtifacts({ baseSha, headSha, target, operation, jobId, request = fetch, signal }) {
  if (!sha.test(baseSha) || !sha.test(headSha) || baseSha === headSha || !['staging', 'production'].includes(target) ||
      !['deploy', 'rollback'].includes(operation) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(jobId ?? '') || typeof request !== 'function') reject();
  const stopped = () => signal?.throwIfAborted();
  async function get(route, maximum = 2097152) {
    stopped();
    const timeout = AbortSignal.timeout(5000);
    const response = await request(api + route, { redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' } });
    if (response.status !== 200) { await response.body?.cancel(); reject(); }
    const reader = response.body?.getReader();
    if (!reader) reject();
    let size = 0;
    const chunks = [];
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maximum) reject();
        chunks.push(chunk.value);
      }
      stopped();
      return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks)));
    } finally { await reader.cancel(); }
  }
  const info = await get('', 65536);
  if (info.full_name !== repository || info.private !== false || info.archived !== false || info.disabled !== false) reject();
  async function commit(revision) {
    const value = await get(`/git/commits/${revision}`, 65536);
    if (value.sha !== revision || !sha.test(value.tree?.sha) || !Array.isArray(value.parents)) reject();
    return value;
  }
  const base = await commit(baseSha), head = await commit(headSha);
  if (head.parents.length !== 1 || head.parents[0].sha !== baseSha) reject();
  async function snapshot(commit) {
    const result = await get(`/git/trees/${commit.tree.sha}?recursive=1`);
    if (result.sha !== commit.tree.sha || result.truncated !== false || !Array.isArray(result.tree) || result.tree.length > 2000 || treeIdentity(result.tree) !== result.sha) reject();
    return result.tree.filter(entry => entry.type === 'blob');
  }
  const baseFiles = await snapshot(base), headFiles = await snapshot(head);
  const changed = [];
  if (baseFiles.length !== headFiles.length) reject();
  for (const previous of baseFiles) {
    const next = headFiles.find(entry => entry.path === previous.path);
    if (!next || next.mode !== previous.mode) reject();
    if (next.sha !== previous.sha) changed.push(previous.path);
  }
  if (changed.length !== 1 || changed[0] !== 'site/index.html') reject();
  for (const files of [baseFiles, headFiles]) for (const name of ['site/index.html', 'site/style.css']) {
    const entry = files.find(file => file.path === name);
    if (!entry || entry.mode !== '100644') reject();
  }
  const loaded = new Map();
  async function load(entry) {
    if (loaded.has(entry.sha)) return loaded.get(entry.sha);
    const result = await get(`/git/blobs/${entry.sha}`, 150000);
    if (result.sha !== entry.sha || result.encoding !== 'base64' || !Number.isSafeInteger(result.size) || result.size < 0 || result.size > 100000 || typeof result.content !== 'string') reject();
    const encoded = result.content.replace(/\n/g, ''), bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded || bytes.length !== result.size || objectHash('blob', bytes) !== entry.sha) reject();
    loaded.set(entry.sha, bytes);
    return bytes;
  }
  // Download and validate all source before creating any artifact directory.
  const sources = [];
  for (const files of [baseFiles, headFiles]) {
    const source = {};
    for (const name of ['index.html', 'style.css']) source[name] = await load(files.find(file => file.path === `site/${name}`));
    sources.push(source);
  }
  stopped();
  const workspace = await mkdtemp(path.join(tmpdir(), 'factory-release-'));
  try {
    const baseSource = path.join(workspace, 'source-base'), headSource = path.join(workspace, 'source-head'), directory = path.join(workspace, 'artifact');
    await mkdir(baseSource); await mkdir(headSource);
    for (const [index, source] of [baseSource, headSource].entries()) for (const name of ['index.html', 'style.css']) await writeFile(path.join(source, name), sources[index][name], { flag: 'wx' });
    const rootUsesHead = operation === 'deploy' && target === 'production', stageUsesHead = operation === 'deploy';
    const rootManifest = await build({ source: rootUsesHead ? headSource : baseSource, output: directory, revision: rootUsesHead ? headSha : baseSha });
    const stagingManifest = await build({ source: stageUsesHead ? headSource : baseSource, output: path.join(directory, 'staging'), revision: stageUsesHead ? headSha : baseSha });
    const plan = { version: 1, repository, baseSha, headSha, target, operation, jobId, rootIdentity: rootManifest.identity, stagingIdentity: stagingManifest.identity };
    await writeFile(path.join(directory, 'release.json'), JSON.stringify(plan), { flag: 'wx' });
    stopped();
    return { directory, plan, rootManifest, stagingManifest, cleanup: () => rm(workspace, { recursive: true, force: true }) };
  } catch (error) { await rm(workspace, { recursive: true, force: true }); throw error; }
}
