import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { autoReviewCandidates } from '../scripts/lib/auto-publish.mjs';
import { AUTO_REVIEW_VERSION } from '../scripts/lib/official-release.mjs';
import { articleText, hash, recordFingerprint } from '../scripts/lib/review.mjs';

const now = new Date('2026-10-22T03:00:00Z');
const ruleVersion = 'auto-publish-test-v1';
const officialUrl = 'https://openai.com/index/atlas-model';
const html = '<article><h1>Atlas Model</h1><time>2026-10-20</time><p>Atlas Model is available today through the API.</p><p>The model supports text generation, reasoning, and long-context analysis for developers.</p></article>';
const source = overrides => ({ id: 'official', name: 'Official news', vendor: 'openai', kind: 'rss', status: 'ready', sourceType: 'official', evidencePrefixes: ['https://openai.com/index/'], autoPublish: { enabled: true }, ...overrides });
const candidate = (overrides = {}) => ({ id: 'candidate-1', title: 'Atlas Model', canonicalUrl: officialUrl, vendor: 'openai', status: 'pending', sources: [{ registryId: 'official', url: officialUrl, sourceType: 'official' }], review: null, ...overrides });
function extracted({ html: body }) {
  const name = body.match(/<h1>([^<]+)<\/h1>/)?.[1] || 'Atlas Model';
  return {
    eligible: true,
    record: { name, kind: 'API 上线', date: '2026-10-20', summary: '模型已通过 API 提供访问。' },
    evidence: { text: articleText(body), title: name, quotes: { modelName: name, eventType: `${name} is available today through the API.`, eventDate: '2026-10-20' }, dateBasis: { type: 'article_date_today', value: '2026-10-20', quote: '2026-10-20', field: 'datePublished' }, ruleVersion },
  };
}
function fixture(overrides = {}) {
  return {
    queue: { schemaVersion: 1, candidates: [candidate()], runs: [{ id: 'earlier-collection' }] },
    atlas: { checkedAt: '2026-10-18', historyCheckedAt: '2026-10-18', radarCheckedAt: '2026-10-18', vendors: [{ id: 'openai' }, { id: 'anthropic' }], events: [], forecasts: [] },
    registry: { sources: [source()] },
    fetchText: async (url, options) => { await options.validateUrl(url); return { text: html, url, status: 200, contentType: 'text/html' }; },
    extractRelease: extracted,
    now,
    ...overrides,
  };
}
function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(deepFreeze); }
  return value;
}
function assertUnpublished(out, before) {
  assert.equal(out.report.published, 0);
  assert.deepEqual(out.atlas, before.atlas);
  assert.equal(out.queue.candidates[0].status, 'pending');
}
function linkedRecord(c) { return c.review?.recordId || c.autoReview?.recordId || c.recordId; }

function officialFixture() {
  const f = fixture();
  const url = 'https://www.anthropic.com/news/claude-sonnet-4-5';
  const markup = readFileSync(new URL('fixtures/official-anthropic-sonnet.html', import.meta.url), 'utf8');
  f.registry.sources[0] = source({ vendor: 'anthropic', evidencePrefixes: ['https://www.anthropic.com/news/'] });
  f.queue.candidates[0] = candidate({ vendor: 'anthropic', canonicalUrl: url, title: 'Claude Sonnet 4.5', sources: [{ registryId: 'official', url }] });
  delete f.extractRelease;
  return { f, markup };
}

test('the default extractor publishes a real official release excerpt through the complete pipeline', async () => {
  const { f, markup } = officialFixture();
  let reads = 0;
  f.fetchText = async (target, options) => { reads++; await options.validateUrl(target); return { text: markup, url: target }; };
  const out = await autoReviewCandidates(f);
  assert.equal(out.report.published, 1, JSON.stringify(out.queue.candidates[0].autoReview));
  assert.equal(reads, 2);
  const record = out.atlas.events[0];
  assert.equal(record.vendor, 'anthropic');
  assert.equal(record.name, 'Claude Sonnet 4.5');
  assert.equal(record.kind, '正式发布');
  assert.equal(record.date, '2025-09-29');
  assert.equal(record.pipelineReview.ruleVersion, AUTO_REVIEW_VERSION);
  assert.equal(record.pipelineReview.recordHash, recordFingerprint(record));
});

test('two matching official reads publish an automatic receipt without fabricating human confirmation', async () => {
  const f = fixture();
  const requests = [], extractions = [];
  const fetchText = f.fetchText;
  f.fetchText = async (url, options) => {
    requests.push(url);
    assert.equal(typeof options.validateUrl, 'function');
    await assert.rejects(async () => options.validateUrl('https://openai.com.evil.example/index/atlas-model'));
    await assert.rejects(async () => options.validateUrl('https://openai.com/account/atlas-model'));
    return fetchText(url, options);
  };
  f.extractRelease = args => { extractions.push(args); return extracted(args); };
  const before = structuredClone({ queue: f.queue, atlas: f.atlas, registry: f.registry });
  deepFreeze(f.queue); deepFreeze(f.atlas); deepFreeze(f.registry);
  const out = await autoReviewCandidates(f);
  assert.deepEqual(requests, [officialUrl, officialUrl]);
  assert.equal(extractions.length, 2);
  for (const args of extractions) {
    assert.equal(args.source.id, 'official');
    assert.equal(args.url, officialUrl);
    assert.equal(args.html, html);
    assert.equal(args.now.toISOString(), now.toISOString());
  }
  assert.deepEqual(out.report, { checked: 1, published: 1, needsReview: 0, failed: 0, duplicates: 0 });
  const record = out.atlas.events[0];
  assert.match(record.id, /^auto-[a-f0-9]{20}$/);
  assert.equal(record.vendor, 'openai');
  assert.equal(record.sourceType, 'official');
  assert.equal(record.kind, 'API 上线');
  assert.equal(record.audit.status, 'verified');
  assert.match(record.audit.method, /自动|规则/);
  assert.doesNotMatch(record.audit.method, /审核人阅读/);
  const receipt = record.pipelineReview;
  assert.equal(receipt.mode, 'automatic');
  assert.equal(receipt.sourceId, 'official');
  assert.equal(receipt.sourceUrl, officialUrl);
  assert.equal(receipt.contentHash, hash(articleText(html)));
  assert.match(receipt.policyHash, /^[a-f0-9]{64}$/);
  assert.equal(receipt.ruleVersion, ruleVersion);
  assert.deepEqual(receipt.quotes, extracted({ html }).evidence.quotes);
  assert.deepEqual(receipt.dateBasis, extracted({ html }).evidence.dateBasis);
  assert.equal(receipt.recordHash, recordFingerprint(record));
  assert.equal('confirmationHash' in receipt, false);
  assert.equal(JSON.stringify(receipt).includes('fullTextRead'), false);
  assert.equal(out.queue.candidates[0].status, 'published');
  assert.equal(linkedRecord(out.queue.candidates[0]), record.id);
  assert.equal(out.atlas.historyCheckedAt, '2026-10-22');
  assert.equal(out.atlas.radarCheckedAt, before.atlas.radarCheckedAt);
  assert.deepEqual({ queue: f.queue, atlas: f.atlas, registry: f.registry }, before);
  const repeated = await autoReviewCandidates({ ...f, ...out });
  assert.equal(repeated.report.published, 0);
  assert.equal(requests.length, 2);
  assert.deepEqual(repeated.atlas.events, out.atlas.events);
  const independent = await autoReviewCandidates(fixture());
  assert.equal(independent.atlas.events[0].id, record.id);
});

for (const [name, change] of [
  ['candidate sourceType cannot upgrade media registry evidence', f => { f.registry.sources[0].sourceType = 'media'; }],
  ['aggregators cannot authorize publication', f => { f.registry.sources[0].sourceType = 'aggregator'; }],
  ['a source needs explicit automatic publication opt-in', f => { delete f.registry.sources[0].autoPublish; }],
  ['disabled automation stays disabled', f => { f.registry.sources[0].autoPublish.enabled = false; }],
  ['an unregistered source cannot authorize an unrelated URL', f => { f.queue.candidates[0].sources[0].registryId = 'forged-official'; f.queue.candidates[0].sources[0].url = f.queue.candidates[0].canonicalUrl = 'https://unrelated.example/model'; }],
  ['official evidence needs a known vendor', f => { f.registry.sources[0].vendor = 'unregistered-vendor'; f.queue.candidates[0].vendor = null; }],
  ['official evidence needs vendor attribution', f => { f.registry.sources[0].vendor = null; f.queue.candidates[0].vendor = null; }],
  ['candidate and official source vendors must match', f => { f.queue.candidates[0].vendor = 'anthropic'; }],
  ['official domain lookalikes are outside the source policy', f => { f.queue.candidates[0].sources[0].url = f.queue.candidates[0].canonicalUrl = 'https://openai.com.evil.example/index/model'; }],
  ['unregistered official paths are outside the source policy', f => { f.queue.candidates[0].sources[0].url = f.queue.candidates[0].canonicalUrl = 'https://openai.com/account/model'; }],
  ['prefix matching respects path boundaries even without a trailing slash', f => { f.registry.sources[0].evidencePrefixes = ['https://openai.com/index']; f.queue.candidates[0].sources[0].url = f.queue.candidates[0].canonicalUrl = 'https://openai.com/index-other/model'; }],
]) test(name, async () => {
  const f = fixture(); change(f); let calls = 0;
  f.fetchText = async () => { calls++; return { text: html, url: officialUrl }; };
  const out = await autoReviewCandidates(f);
  assertUnpublished(out, f);
  assert.equal(calls, 0);
});

test('unknown candidate attribution can be established by the actual registered official source', async () => {
  const f = fixture(); f.queue.candidates[0].vendor = null;
  f.queue.candidates[0].sources[0].sourceType = 'aggregator';
  const out = await autoReviewCandidates(f);
  assert.equal(out.report.published, 1);
  assert.equal(out.atlas.events[0].vendor, 'openai');
});

test('a mirror can discover a URL, while only its matched official registry source authorizes publication', async () => {
  const f = fixture();
  f.registry.sources.push(source({ id: 'mirror', sourceType: 'aggregator', vendor: null, evidencePrefixes: ['https://mirror.example/posts/'] }));
  f.queue.candidates[0].vendor = null;
  f.queue.candidates[0].sources = [{ registryId: 'mirror', sourceType: 'official', url: officialUrl }];
  const out = await autoReviewCandidates(f);
  assert.equal(out.report.published, 1);
  assert.equal(out.atlas.events[0].pipelineReview.sourceId, 'official');
  assert.equal(out.atlas.events[0].sourceType, 'official');
  assert.equal(out.atlas.events[0].vendor, 'openai');
});

test('every fetch passes an origin and path validator that rejects cross-vendor redirects', async () => {
  for (const badUrl of ['https://www.anthropic.com/news/model', 'https://openai.com/account/model']) {
    const f = fixture(); let calls = 0;
    f.registry.sources.push(source({ id: 'anthropic', vendor: 'anthropic', evidencePrefixes: ['https://www.anthropic.com/news/'] }));
    f.fetchText = async (_url, options) => {
      calls++;
      if (calls === 2) await options.validateUrl(badUrl);
      return { text: html, url: officialUrl };
    };
    const out = await autoReviewCandidates(f);
    assertUnpublished(out, f);
    assert.equal(calls, 2);
    assert.ok(out.queue.candidates[0].autoReview?.reason);
  }
});

test('the returned evidence URL is also checked when an injected transport ignores redirect validation', async () => {
  const f = fixture(); f.fetchText = async () => ({ text: html, url: 'https://unrelated.example/reprint' });
  assertUnpublished(await autoReviewCandidates(f), f);
});

test('only pending candidates are considered; existing records, forecasts, decisions and manual candidates survive', async () => {
  const f = fixture();
  const manual = candidate({ id: 'manual', sources: [{ registryId: 'manual', url: officialUrl }] });
  const preserved = ['deferred', 'rejected', 'published', 'approved', 'duplicate'].map(status => candidate({ id: status, status, review: { reason: 'Maintainer decision', recordId: 'existing' } }));
  f.queue.candidates = [...preserved, manual, candidate()];
  f.registry.sources.push(source({ id: 'manual', kind: 'manual', autoPublish: { enabled: false } }));
  f.atlas.events.push({ id: 'existing', vendor: 'openai', name: 'Old Model', date: '2026-09-01', kind: 'API 上线', tags: ['keep'], archiveUrl: 'https://archive.example/old' });
  f.atlas.forecasts.push({ id: 'forecast', vendor: 'openai', name: 'Future Model', status: '计划发布', changes: [{ text: 'Keep history' }] });
  const out = await autoReviewCandidates(f);
  assert.equal(out.report.published, 1);
  assert.deepEqual(out.queue.candidates.slice(0, preserved.length), preserved);
  assert.deepEqual(out.queue.candidates[preserved.length], manual);
  assert.deepEqual(out.atlas.events[0], f.atlas.events[0]);
  assert.deepEqual(out.atlas.forecasts, f.atlas.forecasts);
  assert.deepEqual(out.queue.runs, f.queue.runs);
});

test('a normalized duplicate links the existing record without refreshing verification dates', async () => {
  const f = fixture();
  f.atlas.events.push({ id: 'existing-release', vendor: 'openai', name: '  ATLAS   MODEL  ', date: '2026-10-20', kind: 'API 上线', summary: 'Existing evidence' });
  const out = await autoReviewCandidates(f);
  assert.equal(out.report.duplicates, 1);
  assert.equal(out.report.published, 0);
  assert.deepEqual(out.atlas, f.atlas);
  assert.equal(out.queue.candidates[0].status, 'duplicate');
  assert.equal(linkedRecord(out.queue.candidates[0]), 'existing-release');
});

for (const [oldKind, newKind] of [['API / 产品上线', 'API 上线'], ['权重发布', '权重开放']]) {
  test(`legacy event label ${oldKind} represents the same release as ${newKind}`, async () => {
    const f = fixture();
    f.atlas.events.push({ id: 'legacy-release', vendor: 'openai', name: 'Atlas Model', date: '2026-10-20', kind: oldKind });
    f.extractRelease = args => { const result = extracted(args); result.record.kind = newKind; return result; };
    const out = await autoReviewCandidates(f);
    assert.equal(out.report.duplicates, 1);
    assert.equal(out.report.published, 0);
    assert.deepEqual(out.atlas, f.atlas);
    assert.equal(linkedRecord(out.queue.candidates[0]), 'legacy-release');
  });
}

test('concurrent candidates for the same release cannot create two records', async () => {
  const f = fixture();
  f.queue.candidates.push(candidate({ id: 'candidate-2', canonicalUrl: `${officialUrl}-second`, sources: [{ registryId: 'official', url: `${officialUrl}-second` }] }));
  const out = await autoReviewCandidates(f);
  assert.equal(out.atlas.events.length, 1);
  assert.equal(out.report.published, 1);
  assert.equal(out.report.duplicates, 1);
  assert.deepEqual(out.queue.candidates.map(c => c.status).sort(), ['duplicate', 'published']);
  for (const c of out.queue.candidates) assert.equal(linkedRecord(c), out.atlas.events[0].id);
});

test('same model and event type with a conflicting date remains pending for review', async () => {
  const f = fixture(); f.atlas.events.push({ id: 'old-date', vendor: 'openai', name: 'Atlas Model', date: '2026-10-19', kind: 'API 上线' });
  const out = await autoReviewCandidates(f);
  assertUnpublished(out, f);
  assert.equal(out.report.needsReview, 1);
  assert.ok(out.queue.candidates[0].autoReview.reason);
});

test('conflicting dates discovered in the same batch cannot publish whichever response happens to be first', async () => {
  const f = fixture();
  f.queue.candidates.push(candidate({ id: 'different-date', canonicalUrl: `${officialUrl}-different-date`, sources: [{ registryId: 'official', url: `${officialUrl}-different-date` }] }));
  f.fetchText = async url => ({ text: url.endsWith('different-date') ? html.replaceAll('2026-10-20', '2026-10-19') : html, url });
  f.extractRelease = args => {
    const result = extracted(args);
    const date = args.html.match(/<time>([^<]+)<\/time>/)[1];
    result.record.date = date;
    result.evidence.quotes.eventDate = date;
    result.evidence.dateBasis = { ...result.evidence.dateBasis, value: date, quote: date };
    return result;
  };
  const out = await autoReviewCandidates(f);
  assert.equal(out.report.published, 0);
  assert.equal(out.report.needsReview, 2);
  assert.deepEqual(out.atlas, f.atlas);
  for (const c of out.queue.candidates) {
    assert.equal(c.status, 'pending');
    assert.ok(c.autoReview.reason);
  }
});

test('same name under a different vendor or event type is not an existing release', async () => {
  const f = fixture();
  f.atlas.events.push({ id: 'other-vendor', vendor: 'anthropic', name: 'Atlas Model', date: '2026-10-20', kind: 'API 上线' });
  f.atlas.events.push({ id: 'other-stage', vendor: 'openai', name: 'Atlas Model', date: '2026-10-19', kind: '首次宣布' });
  const out = await autoReviewCandidates(f);
  assert.equal(out.report.published, 1);
  assert.equal(out.atlas.events.length, 3);
});

for (const oldKind of ['API 预览上线', '产品上线 / API 私测']) {
  test(`an earlier ${oldKind} does not prevent a later full API release`, async () => {
    const f = fixture();
    f.atlas.events.push({ id: 'preview', vendor: 'openai', name: 'Atlas Model', date: '2026-10-19', kind: oldKind });
    const out = await autoReviewCandidates(f);
    assert.equal(out.report.published, 1);
    assert.equal(out.atlas.events.length, 2);
    assert.deepEqual(out.atlas.events[0], f.atlas.events[0]);
    assert.equal(out.atlas.events[1].kind, 'API 上线');
  });
}

for (const [name, change] of [
  ['unknown event type', r => { r.record.kind = 'unknown'; }],
  ['future historical date', r => { r.record.date = '2027-01-01'; }],
  ['impossible calendar date', r => { r.record.date = '2026-02-30'; }],
  ['missing model name', r => { r.record.name = ''; }],
  ['missing summary', r => { r.record.summary = ''; }],
  ['missing model quote', r => { delete r.evidence.quotes.modelName; }],
  ['missing event quote', r => { delete r.evidence.quotes.eventType; }],
  ['missing date quote', r => { delete r.evidence.quotes.eventDate; }],
  ['date quote inconsistent with its recorded basis', r => { r.evidence.quotes.eventDate = '2099-01-01'; }],
  ['invented quote', r => { r.evidence.quotes.eventType = 'The new model was released yesterday.'; }],
  ['extractor-supplied text absent from the fetched article', r => { r.evidence.text += ' The new model was released yesterday.'; r.evidence.quotes.eventType = 'The new model was released yesterday.'; }],
  ['model name unsupported by its quote', r => { r.record.name = 'Unmentioned Model'; }],
  ['missing date basis', r => { delete r.evidence.dateBasis; }],
  ['unsupported date basis type', r => { r.evidence.dateBasis.type = 'feed_published_at'; }],
  ['date basis inconsistent with the record', r => { r.evidence.dateBasis.value = '2026-10-19'; }],
  ['missing extraction rule version', r => { delete r.evidence.ruleVersion; }],
]) test(`eligible extraction still fails closed for ${name}`, async () => {
  const f = fixture(); f.extractRelease = args => { const result = extracted(args); change(result); return result; };
  const out = await autoReviewCandidates(f);
  assertUnpublished(out, f);
  assert.equal(out.report.needsReview, 1);
  assert.ok(out.queue.candidates[0].autoReview?.reason);
});

test('insufficient evidence stays pending and is not fetched again under the same policy and rule version', async () => {
  const f = fixture(); let calls = 0;
  f.fetchText = async (url, options) => { calls++; await options.validateUrl(url); return { text: html, url }; };
  f.extractRelease = () => ({ eligible: false, reason: 'Only a future plan is present', code: 'not_release' });
  const first = await autoReviewCandidates(f);
  assertUnpublished(first, f);
  assert.equal(first.report.needsReview, 1);
  assert.ok(first.queue.candidates[0].autoReview.reason.includes('future plan'));
  const afterFirst = calls;
  const second = await autoReviewCandidates({ ...f, queue: first.queue, atlas: first.atlas });
  assert.equal(calls, afterFirst);
  assert.equal(second.report.checked, 0);
  assert.deepEqual(second.atlas, f.atlas);
  const updatedRegistry = structuredClone(f.registry);
  updatedRegistry.sources[0].evidencePrefixes.push('https://openai.com/news/');
  await autoReviewCandidates({ ...f, registry: updatedRegistry, queue: first.queue, atlas: first.atlas });
  assert.ok(calls > afterFirst, 'a changed source policy must allow a fresh evidence decision');
});

test('enabling automatic publication invalidates a previous disabled-source decision', async () => {
  const f = fixture(); f.registry.sources[0].autoPublish.enabled = false;
  const first = await autoReviewCandidates(f);
  assertUnpublished(first, f);
  const registry = structuredClone(f.registry); registry.sources[0].autoPublish.enabled = true;
  const second = await autoReviewCandidates({ ...f, queue: first.queue, registry });
  assert.equal(second.report.published, 1);
});

for (const field of ['url', 'vendor']) {
  test(`correcting a candidate ${field} invalidates the previous evidence decision`, async () => {
    const f = fixture();
    if (field === 'url') f.queue.candidates[0].canonicalUrl = 'https://openai.com/account/atlas-model';
    else f.queue.candidates[0].vendor = 'anthropic';
    const first = await autoReviewCandidates(f);
    assertUnpublished(first, f);
    const queue = structuredClone(first.queue);
    queue.candidates[0].canonicalUrl = officialUrl;
    queue.candidates[0].vendor = 'openai';
    const second = await autoReviewCandidates({ ...f, queue });
    assert.equal(second.report.published, 1);
  });
}

test('a changed extraction rule version invalidates a cached needs-review decision', async () => {
  const f = fixture();
  const first = await autoReviewCandidates({ ...f, extractRelease: () => ({ eligible: false, code: 'unsupported', reason: 'Not understood by the old rules' }) });
  const queue = structuredClone(first.queue);
  queue.candidates[0].autoReview.ruleVersion = 'previous-version';
  const second = await autoReviewCandidates({ ...f, queue });
  assert.equal(second.report.published, 1);
});

test('an unchanged future candidate is reconsidered after the evidence cache expires', async () => {
  const { f, markup } = officialFixture();
  let available = false, reads = 0;
  f.fetchText = async url => {
    reads++;
    return { text: available ? markup : markup.replace('is available everywhere today', 'will be available next week'), url };
  };
  const pending = await autoReviewCandidates(f);
  assertUnpublished(pending, f);
  assert.equal(pending.report.needsReview, 1);
  const firstReads = reads;
  available = true;
  const sameTime = await autoReviewCandidates({ ...f, queue: pending.queue });
  assertUnpublished(sameTime, f);
  assert.equal(reads, firstReads, 'unchanged evidence decisions should respect their short-lived cache');
  const later = await autoReviewCandidates({ ...f, queue: sameTime.queue, now: new Date(now.getTime() + 25 * 60 * 60 * 1000) });
  assert.equal(later.report.published, 1);
  assert.equal(later.queue.candidates[0].status, 'published');
  assert.equal(reads, firstReads + 2, 'expired evidence is fetched and independently confirmed again');
  assert.equal(later.atlas.events[0].name, 'Claude Sonnet 4.5');
});

test('changed article text at the second read cannot publish even if extracted facts match', async () => {
  const f = fixture(); let calls = 0;
  f.fetchText = async url => ({ text: ++calls === 1 ? html : html.replace('</article>', '<p>Correction: access conditions changed.</p></article>'), url });
  const out = await autoReviewCandidates(f);
  assertUnpublished(out, f);
  assert.equal(calls, 2);
  assert.ok(out.queue.candidates[0].autoReview?.reason);
});

for (const [name, change] of [
  ['publication metadata', markup => markup.replace('2025-09-29T00:00:00.000Z', '2025-09-30T00:00:00.000Z')],
  ['primary title', markup => markup.replace('<h1>Introducing Claude Sonnet 4.5</h1>', '<h1>Introducing Claude Opus 4.1</h1>')],
]) {
  test(`real extraction rejects a change to ${name} during verification`, async () => {
    const { f, markup } = officialFixture(); let reads = 0;
    f.fetchText = async url => ({ text: ++reads === 1 ? markup : change(markup), url });
    assertUnpublished(await autoReviewCandidates(f), f);
    assert.equal(reads, 2);
  });
}

test('unrelated script nonce changes preserve the same release evidence', async () => {
  const { f, markup } = officialFixture(); let reads = 0, lastDocument;
  f.fetchText = async url => {
    lastDocument = `${markup}<script nonce="nonce-${++reads}">window.tracker = ${reads};</script>`;
    return { text: lastDocument, url };
  };
  const out = await autoReviewCandidates(f);
  assert.equal(out.report.published, 1);
  assert.equal(reads, 2);
  assert.equal(out.atlas.events[0].pipelineReview.documentHash, hash(lastDocument));
});

test('unchanged article with changed extracted facts cannot publish', async () => {
  const f = fixture(); let calls = 0;
  f.extractRelease = args => { const result = extracted(args); if (++calls === 2) result.record.summary = 'The interpretation changed.'; return result; };
  assertUnpublished(await autoReviewCandidates(f), f);
  assert.equal(calls, 2);
});

test('reverification cannot silently switch extraction rule versions', async () => {
  const f = fixture(); let calls = 0;
  f.extractRelease = args => { const result = extracted(args); if (++calls === 2) result.evidence.ruleVersion = 'different-rule'; return result; };
  assertUnpublished(await autoReviewCandidates(f), f);
  assert.equal(calls, 2);
});

test('a second-pass extraction that no longer supports a release leaves the candidate pending', async () => {
  const f = fixture(); let calls = 0;
  f.extractRelease = args => ++calls === 1 ? extracted(args) : { eligible: false, code: 'ambiguous', reason: 'Ambiguous event date' };
  assertUnpublished(await autoReviewCandidates(f), f);
  assert.equal(calls, 2);
});

test('network failures are isolated, remain pending, and carry a future retry time', async () => {
  const f = fixture();
  f.queue.candidates.unshift(candidate({ id: 'failed', canonicalUrl: 'https://openai.com/index/failure', sources: [{ registryId: 'official', url: 'https://openai.com/index/failure' }] }));
  const baseFetch = f.fetchText;
  f.fetchText = async (url, options) => { if (url.endsWith('/failure')) throw new Error('HTTP 429'); return baseFetch(url, options); };
  const out = await autoReviewCandidates(f);
  assert.equal(out.report.failed, 1);
  assert.equal(out.report.published, 1);
  const failed = out.queue.candidates.find(c => c.id === 'failed');
  assert.equal(failed.status, 'pending');
  assert.ok(failed.autoReview.reason);
  assert.ok(Date.parse(failed.autoReview.retryAfter) > now.getTime());
  let retries = 0;
  const retry = await autoReviewCandidates({ ...f, queue: out.queue, atlas: out.atlas, fetchText: async () => { retries++; throw new Error('should wait'); } });
  assert.equal(retries, 0);
  assert.equal(retry.report.failed, 0);
});

test('a broken source policy does not prevent an independent official source from publishing', async () => {
  const f = fixture();
  f.registry.sources.unshift(source({ id: 'broken', vendor: 'anthropic', evidencePrefixes: ['not a URL'] }));
  f.queue.candidates.unshift(candidate({ id: 'broken', vendor: 'anthropic', canonicalUrl: 'https://www.anthropic.com/news/model', sources: [{ registryId: 'broken', url: 'https://www.anthropic.com/news/model' }] }));
  const out = await autoReviewCandidates(f);
  assert.equal(out.report.published, 1);
  assert.equal(out.queue.candidates.find(c => c.id === 'broken').status, 'pending');
  assert.equal(out.queue.candidates.find(c => c.id === 'candidate-1').status, 'published');
});

test('all-network-failure and empty runs cannot advance published verification dates', async () => {
  const f = fixture({ fetchText: async () => { throw new Error('network unavailable'); } });
  assertUnpublished(await autoReviewCandidates(f), f);
  f.queue.candidates = [];
  const empty = await autoReviewCandidates(f);
  assert.deepEqual(empty.atlas, f.atlas);
  assert.equal(empty.report.checked, 0);
});

test('the single-run candidate limit and request concurrency limit bound independent work', async () => {
  const f = fixture();
  f.queue.candidates = Array.from({ length: 7 }, (_, i) => candidate({ id: `candidate-${i}`, canonicalUrl: `${officialUrl}-${i}`, sources: [{ registryId: 'official', url: `${officialUrl}-${i}` }] }));
  let active = 0, maxActive = 0;
  const calls = [];
  f.fetchText = async (url, options) => {
    await options.validateUrl(url);
    active++; maxActive = Math.max(maxActive, active); calls.push(url);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return { text: html.replaceAll('Atlas Model', `Atlas Model ${url.split('-').at(-1)}`), url };
  };
  const out = await autoReviewCandidates({ ...f, maxCandidates: 4, concurrency: 2 });
  assert.equal(out.report.checked, 4);
  assert.equal(out.report.published, 4);
  assert.equal(calls.length, 8);
  assert.equal(maxActive, 2);
  assert.deepEqual(out.queue.candidates.slice(4), f.queue.candidates.slice(4));
});
