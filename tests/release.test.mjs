import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { prepareReleaseArtifacts } from '../scripts/release.mjs';

const repository = 'robertmanzanillag-jpg/software-factory-pilot';
const baseSha = 'a'.repeat(40), headSha = 'b'.repeat(40), jobId = '12345678-1234-1234-1234-123456789012';
const objectHash = (type, bytes) => createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');
function fixture() {
  const source = { 'site/index.html': '<h1>Baseline</h1>\n', 'site/style.css': 'h1{color:black}\n', 'scripts/untrusted.mjs': 'throw Error("MUST NEVER EXECUTE");\n' };
  const candidate = { ...source, 'site/index.html': '<h1>Candidate</h1>\n' };
  const calls = [];
  let badParent = false, wrongBlob = false;
  function tree(files) {
    const entries = Object.entries(files).map(([name, text]) => ({ path: name, type: 'blob', mode: '100644', sha: objectHash('blob', Buffer.from(text)), size: Buffer.byteLength(text) }));
    const hashEntries = items => objectHash('tree', Buffer.concat(items.sort((a, b) => a.name.localeCompare(b.name)).map(item => Buffer.concat([Buffer.from(`${item.mode} ${item.name}\0`), Buffer.from(item.sha, 'hex')]))));
    const folders = ['scripts', 'site'].map(name => ({ path: name, name, type: 'tree', mode: '040000', sha: hashEntries(entries.filter(e => e.path.startsWith(name + '/')).map(e => ({ ...e, name: e.path.split('/')[1] }))) }));
    return { sha: hashEntries(folders.map(f => ({ ...f, mode: '40000' }))), truncated: false, tree: [...folders, ...entries] };
  }
  const request = async (url, init) => {
    calls.push(url); assert.equal(init.redirect, 'error'); assert.ok(init.signal); assert.equal(new Headers(init.headers).has('Authorization'), false);
    const baseline = tree(source), changed = tree(candidate);
    if (url === `https://api.github.com/repos/${repository}`) return Response.json({ full_name: repository, private: false, archived: false, disabled: false });
    if (url.endsWith(`/git/commits/${baseSha}`)) return Response.json({ sha: baseSha, tree: { sha: baseline.sha }, parents: [] });
    if (url.endsWith(`/git/commits/${headSha}`)) return Response.json({ sha: headSha, tree: { sha: changed.sha }, parents: badParent ? [] : [{ sha: baseSha }] });
    if (url.includes('/git/trees/')) return Response.json(url.includes(baseline.sha) ? baseline : changed);
    const value = [...Object.values(source), ...Object.values(candidate)].find(text => url.endsWith(objectHash('blob', Buffer.from(text))));
    assert.notEqual(value, undefined); assert.ok(!value.includes('MUST NEVER EXECUTE'));
    const bytes = Buffer.from(value), sha = objectHash('blob', bytes);
    return Response.json({ sha, size: bytes.length, encoding: 'base64', content: Buffer.from(wrongBlob ? 'tampered' : value).toString('base64') });
  };
  return { request, calls, source, candidate, badParent: () => { badParent = true; }, corrupt: () => { wrongBlob = true; },
    prepare: (target = 'staging', operation = 'deploy', extra = {}) => prepareReleaseArtifacts({ baseSha, headSha, target, operation, jobId, request, ...extra }) };
}

test('staging preserves baseline root and publishes only immutable candidate static files below staging', async () => {
  const f = fixture(), artifact = await f.prepare();
  try {
    assert.equal(await readFile(path.join(artifact.directory, 'index.html'), 'utf8'), f.source['site/index.html']);
    assert.equal(await readFile(path.join(artifact.directory, 'staging/index.html'), 'utf8'), f.candidate['site/index.html']);
    assert.equal(artifact.rootManifest.revision, baseSha); assert.equal(artifact.stagingManifest.revision, headSha);
    assert.deepEqual((await readdir(artifact.directory)).sort(), ['.nojekyll', 'health.json', 'index.html', 'release.json', 'staging', 'style.css']);
    assert.deepEqual(JSON.parse(await readFile(path.join(artifact.directory, 'release.json'), 'utf8')), artifact.plan);
    assert.equal(f.calls.filter(url => url.includes('/git/blobs/')).length, 3);
  } finally { await artifact.cleanup(); }
  await assert.rejects(access(artifact.directory));
});

test('production deploy and both rollback targets use the specified immutable revisions', async () => {
  for (const [target, operation] of [['production', 'deploy'], ['staging', 'rollback'], ['production', 'rollback']]) {
    const f = fixture(), artifact = await f.prepare(target, operation);
    try {
      const expected = operation === 'deploy' ? headSha : baseSha;
      assert.equal(artifact.rootManifest.revision, expected); assert.equal(artifact.stagingManifest.revision, expected);
      assert.equal(artifact.plan.target, target); assert.equal(artifact.plan.operation, operation); assert.equal(artifact.plan.jobId, jobId);
    } finally { await artifact.cleanup(); }
  }
});

test('wrong parent, other modified files and corrupted blobs cannot produce an artifact', async () => {
  for (const mutate of [f => f.badParent(), f => { f.candidate['site/style.css'] = 'changed'; }, f => { f.candidate['scripts/untrusted.mjs'] = 'changed'; }, f => f.corrupt(), f => { delete f.candidate['site/style.css']; }]) {
    const f = fixture(); mutate(f); await assert.rejects(f.prepare(), /UNVERIFIED/);
  }
});

test('invalid revisions, mode, job id and pre-aborted work make no requests', async () => {
  for (const extra of [{ baseSha: 'main' }, { headSha: baseSha }, { target: 'other' }, { operation: 'delete' }, { jobId: '../escape' }]) {
    const f = fixture(); await assert.rejects(f.prepare('staging', 'deploy', extra), /UNVERIFIED/); assert.equal(f.calls.length, 0);
  }
  const f = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(f.prepare('staging', 'deploy', { signal: controller.signal })); assert.equal(f.calls.length, 0);
});
