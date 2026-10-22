import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createReviewServer } from '../scripts/review-server.mjs';
import { confirmationHash, hash } from '../scripts/lib/review.mjs';

test('review API: CSRF, invalid source, readable evidence, explicit review dispatch; no local publication', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-review-test-'));
  const text = 'Atlas Test Model is available today. Released October 20, 2026. API access is now available.';
  const candidate = { id: 'c-1', canonicalUrl: 'https://openai.com/index/test', title: 'Atlas Test Model', status: 'pending', sources: [{ registryId: 'official' }] };
  const files = {
    'review/queue.json': { candidates: [candidate], runs: [] },
    'public/data/atlas.json': { vendors: [{ id: 'openai' }], events: [], forecasts: [] },
    'public/data/sources.json': { sources: [{ id: 'official', name: 'Official', vendor: 'openai', sourceType: 'official', evidencePrefixes: ['https://openai.com/index/'] }] },
    'public/data/site.json': { repo: 'https://github.com/example/atlas' },
  };
  for (const [p, data] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true }); await fs.writeFile(path.join(root, p), JSON.stringify(data)); }
  const calls = []; let fetchCalls = 0;
  const server = createReviewServer({ root, execute: async (bin, args) => {
    calls.push([bin, args]);
    if (bin === 'git' && args[0] === 'fetch') await new Promise(r => setTimeout(r, 40));
    const stdout = args[0] === 'api' ? 'maintainer\n' : args[0] === 'rev-parse' ? 'a'.repeat(40) : args[0] === 'show' ? JSON.stringify(files[args[1].split(':')[1]]) : '';
    return { stdout };
  }, fetchText: async url => { fetchCalls++; return { url, text }; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(url + '/api/state', { headers: { Origin: 'https://attacker.example' } })).status, 403);
  const state = await (await fetch(url + '/api/state')).json();
  const post = (route, data, overrides = {}) => fetch(url + route, { method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json', 'X-Review-Token': state.csrf, ...overrides }, body: JSON.stringify(data) });
  assert.equal((await post('/api/decision', {}, { 'X-Review-Token': 'wrong' })).status, 403);
  assert.equal((await post('/api/evidence', { registryId: 'official', url: 'http://127.0.0.1/secret' })).status, 400);
  assert.equal(fetchCalls, 0);
  const evidence = await (await post('/api/evidence', { registryId: 'official', url: candidate.canonicalUrl })).json();
  assert.equal(evidence.contentHash, hash(text));
  const decision = { candidateId: candidate.id, candidateRevision: state.candidates[0].revision, policyHash: state.policyHash, action: 'publish', reason: '',
    record: { id: 'atlas-test', type: 'event', vendor: 'openai', name: 'Atlas Test Model', kind: 'API 上线', date: '2026-10-20', summary: 'API 可用' },
    evidence: { registryId: 'official', url: candidate.canonicalUrl, contentHash: evidence.contentHash, quotes: { modelName: 'Atlas Test Model', eventType: 'API access is now available.', eventDate: 'Released October 20, 2026.' }, note: '人工核对原文', checks: { fullTextRead: true, modelName: true, eventType: true, eventDate: true } } };
  assert.equal((await post('/api/decision', decision)).status, 400);
  assert.equal(calls.filter(c => c[1][0] === 'workflow').length, 0);
  decision.confirmationHash = confirmationHash(decision);
  const submitted = await post('/api/decision', decision); assert.equal(submitted.status, 200, await submitted.text());
  assert.equal(calls.filter(c => c[1][0] === 'workflow').length, 1);
  assert.equal((await post('/api/decision', decision)).status, 400);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'public/data/atlas.json'))), files['public/data/atlas.json']);
  const results = await Promise.all([post('/api/sync', {}), post('/api/sync', {})]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal((await post('/api/sync', { huge: 'x'.repeat(61_000) })).status, 413);
  assert.equal((await post('/api/sync', {})).status, 200); // Lock released after oversized body.
  assert.equal((await post('/unknown', {})).status, 404);
});
