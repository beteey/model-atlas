import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDecision, candidateRevision, policyHash, hash, articleText, confirmationHash, recordFingerprint } from '../scripts/lib/review.mjs';

const registry = { sources: [
  { id: 'official', vendor: 'openai', sourceType: 'official', evidencePrefixes: ['https://openai.com/index/'] },
  { id: 'media', vendor: null, sourceType: 'media', evidencePrefixes: ['https://news.example/articles/'] },
  { id: 'mirror', vendor: 'openai', sourceType: 'aggregator', evidencePrefixes: [] },
] };
const text = 'Atlas Test Model is available today. Released October 20, 2026. API access is now available.';
function fixture() {
  const c = { id: 'candidate-1', canonicalUrl: 'https://openai.com/index/test', title: 'Atlas Test Model', status: 'pending', sources: [{ registryId: 'official', url: 'https://openai.com/index/test' }] };
  const atlas = { vendors: [{ id: 'openai' }, { id: 'anthropic' }], events: [], forecasts: [] };
  const decision = {
    candidateId: c.id, candidateRevision: candidateRevision(c), policyHash: policyHash(registry), action: 'publish',
    record: { id: 'atlas-test', type: 'event', vendor: 'openai', name: 'Atlas Test Model', kind: 'API 上线', date: '2026-10-20', summary: '提供 API 访问。' },
    evidence: { registryId: 'official', url: c.canonicalUrl, contentHash: hash(text), quotes: { modelName: 'Atlas Test Model', eventType: 'API access is now available.', eventDate: 'Released October 20, 2026.' }, checks: { fullTextRead: true, modelName: true, eventDate: true, eventType: true }, note: '核对名称、API 可用性与实际日期。' },
  };
  decision.confirmationHash = confirmationHash(decision);
  return { registry, atlas, queue: { candidates: [c], runs: [] }, decision, evidence: { text, url: c.canonicalUrl }, actor: 'maintainer', now: new Date('2026-10-22T03:00:00Z') };
}
test('verified official evidence publishes once with audit receipt, preserving inputs', () => {
  const f = fixture(); const out = applyDecision(f);
  assert.equal(out.atlas.events[0].audit.status, 'verified');
  assert.equal(out.queue.candidates[0].status, 'published');
  assert.equal(out.atlas.events[0].pipelineReview.by, 'maintainer');
  assert.equal(f.atlas.events.length, 0);
  assert.throws(() => applyDecision({ ...f, ...out }), /处理|published/);
});
for (const [name, mutate, pattern] of [
  ['unread article', f => { f.decision.evidence.checks.fullTextRead = false; }, /原文/],
  ['missing quote', f => { f.decision.evidence.quotes.eventDate = ''; }, /摘录/],
  ['invented quote', f => { f.decision.evidence.quotes.modelName = 'Fabricated Model'; }, /原文|名称/],
  ['changed body', f => { f.evidence.text += ' Corrected.'; }, /正文.*变化/],
  ['changed source policy', f => { f.decision.policyHash = 'old'; }, /信源政策/],
  ['changed candidate', f => { f.queue.candidates[0].title = 'Corrected'; }, /候选.*变化/],
  ['cross vendor official', f => { f.decision.record.vendor = 'anthropic'; }, /厂商/],
  ['off domain redirect', f => { f.evidence.url = 'https://other.example/test'; }, /来源|原文/],
  ['source-prefix lookalike', f => { f.decision.evidence.url = 'https://openai.com.evil.example/index/test'; }, /来源/],
  ['future historical date', f => { f.decision.record.date = '2026-11-01'; }, /未来/],
  ['invalid calendar date', f => { f.decision.record.date = '2026-02-30'; }, /日期/],
  ['mirror cannot verify', f => { f.decision.evidence.registryId = 'mirror'; }, /来源|转载/],
  ['media cannot create history', f => { f.decision.evidence.registryId = 'media'; f.decision.evidence.url = f.evidence.url = 'https://news.example/articles/test'; }, /官方/],
]) test(name, () => { const f = fixture(); mutate(f); f.decision.confirmationHash = confirmationHash(f.decision); assert.throws(() => applyDecision(f), pattern); });
test('official plan cannot become release event even when reviewer ticks boxes', () => {
  const f = fixture(); f.evidence.text += ' We plan to release it soon.';
  f.decision.evidence.contentHash = hash(f.evidence.text);
  f.decision.evidence.quotes.eventType = 'We plan to release it soon.';
  f.decision.confirmationHash = confirmationHash(f.decision);
  assert.throws(() => applyDecision(f), /计划/);
});
test('media plans remain media forecasts; unspecified time stays unknown', () => {
  const f = fixture(); f.decision.evidence.registryId = 'media'; f.decision.evidence.url = f.evidence.url = 'https://news.example/articles/test';
  f.decision.record = { ...f.decision.record, type: 'forecast', kind: '计划发布', date: undefined, confidence: 'official' };
  f.decision.confirmationHash = confirmationHash(f.decision);
  const out = applyDecision(f); assert.equal(out.atlas.forecasts[0].confidence, 'media');
  assert.equal(out.atlas.forecasts[0].dateLabel, '发布时间待定');
  assert.equal(out.atlas.events.length, 0);
});
test('reject/defer require a reason; reject survives without touching published atlas', () => {
  const f = fixture(); f.decision.action = 'reject'; f.decision.reason = '与基础模型发布无关';
  const out = applyDecision(f); assert.equal(out.queue.candidates[0].status, 'rejected');
  assert.deepEqual(out.atlas, f.atlas);
  assert.equal(out.queue.candidates[0].review.reason, '与基础模型发布无关');
  f.decision.reason = ''; assert.throws(() => applyDecision(f), /原因/);
});
test('existing records need explicit update + matching version and retain old revision', () => {
  const f = fixture(); const old = { id: 'atlas-test', vendor: 'openai', name: 'Old', date: '2026-10-19', kind: 'API 上线', summary: 'Old', url: 'https://openai.com/index/old', archiveUrl: 'https://archive.example/old' };
  f.atlas.events.push(old);
  assert.throws(() => applyDecision(f), /更新/);
  f.decision.record.operation = 'update'; f.decision.record.baseHash = hash(old); f.decision.reason = '原公告修正了日期';
  f.decision.confirmationHash = confirmationHash(f.decision);
  const out = applyDecision(f); assert.equal(out.atlas.events.length, 1);
  assert.equal(out.atlas.events[0].revisions[0].previous.date, '2026-10-19');
  assert.equal(out.atlas.events[0].archiveUrl, undefined);
  f.decision.record.baseHash = 'stale'; f.decision.confirmationHash = confirmationHash(f.decision); assert.throws(() => applyDecision(f), /版本/);
});
test('changing date or kind invalidates the already confirmed review', () => {
  for (const [key, value] of [['date', '2026-01-01'], ['kind', '权重开放']]) {
    const f = fixture(); f.decision.record[key] = value;
    assert.throws(() => applyDecision(f), /审核内容已变化/);
  }
});
test('negative availability is not a release', () => {
  const f = fixture(); f.evidence.text += ' API access is not available.';
  f.decision.evidence.contentHash = hash(f.evidence.text); f.decision.evidence.quotes.eventType = 'API access is not available.';
  f.decision.confirmationHash = confirmationHash(f.decision);
  assert.throws(() => applyDecision(f), /尚未/);
});
test('same URL after correction does not inherit old archive', () => {
  const f = fixture(); const old = { id: 'atlas-test', vendor: 'openai', name: 'Atlas Test Model', date: '2026-10-19', kind: 'API 上线', summary: 'Old', url: f.evidence.url, archiveUrl: 'https://archive.example/old', pipelineReview: { contentHash: 'previous-body' } };
  f.atlas.events.push(old); Object.assign(f.decision.record, { operation: 'update', baseHash: hash(old) }); f.decision.reason = '更正';
  f.decision.confirmationHash = confirmationHash(f.decision);
  const out = applyDecision(f); assert.equal(out.atlas.events[0].archiveUrl, undefined);
  assert.equal(out.atlas.events[0].revisions[0].previous.archiveUrl, old.archiveUrl);
});
test('normalized names cannot duplicate the same event', () => {
  const f = fixture(); f.atlas.events.push({ ...f.decision.record, id: 'other-id' }); f.decision.record.name = ' Atlas Test Model ';
  f.decision.confirmationHash = confirmationHash(f.decision);
  assert.throws(() => applyDecision(f), /已存在同模型/);
});
test('article text strips scripts and navigation instead of trusting markup', () => {
  assert.equal(articleText('<nav>Menu</nav><article><h1>A &amp; B</h1><script>alert(1)</script><p>Model</p></article>'), 'A & B Model');
});
test('archive metadata may be added later, but reviewed facts cannot change', () => {
  const out = applyDecision(fixture()); const record = out.atlas.events[0];
  assert.equal(record.pipelineReview.recordHash, recordFingerprint(record));
  record.archiveUrl = 'https://web.archive.org/web/20261022/example'; record.archivedAt = '2026-10-22';
  assert.equal(record.pipelineReview.recordHash, recordFingerprint(record));
  record.date = '2026-10-01';
  assert.notEqual(record.pipelineReview.recordHash, recordFingerprint(record));
});
