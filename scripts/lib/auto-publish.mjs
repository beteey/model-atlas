import { fetchSourceText } from './collect.mjs';
import { articleText, candidateRevision, hash, normalize, policyHash, recordFingerprint, sourceFor, today } from './review.mjs';
import { AUTO_REVIEW_VERSION, extractOfficialRelease } from './official-release.mjs';

const KINDS = new Set(['正式发布', 'API 上线', '预览开放', '权重开放']);
const validDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d;
const modelKey = name => normalize(name).toLowerCase().replace(/[\s_\-\u2010-\u2015]/g, '');
const fail = message => { throw new Error(message); };

function matchesKind(existing, kind) {
  if (existing === kind) return true;
  if (kind === 'API 上线') return /API/.test(existing) && !/预览|私测|实验|Beta|限量/i.test(existing);
  if (kind === '权重开放') return /权重/.test(existing);
  if (kind === '预览开放') return /预览|实验版|Beta|限量开放|私测/i.test(existing);
  return /正式发布|首次发布|产品上线|模型上线|模型\s*\/\s*权重发布/.test(existing) && !/预览|私测|限量/.test(existing);
}

function officialSource(candidate, registry, vendors) {
  return registry.sources.find(source => {
    if (source.sourceType !== 'official' || source.autoPublish?.enabled !== true || !vendors.has(source.vendor)) return false;
    if (candidate.vendor && candidate.vendor !== source.vendor) return false;
    try { sourceFor(registry, source.id, candidate.canonicalUrl); return true; } catch { return false; }
  });
}

function assertExtraction(result, html, now) {
  if (!result?.eligible) fail(result?.reason || '原文不足以确认已发布');
  const { record: r, evidence: e } = result;
  if (!r || !e || !KINDS.has(r.kind) || !normalize(r.name) || !normalize(r.summary)) fail('模型名称、事件类型或摘要不完整');
  if (!validDate(r.date) || r.date > today(now)) fail('实际发布日期无效或仍在未来');
  if (!e.ruleVersion || !e.title || e.text !== articleText(html) || e.text.length < 80) fail('没有取得一致的官网正文');
  for (const key of ['modelName', 'eventType']) {
    const quote = normalize(e.quotes?.[key]);
    if (quote.length < 4 || quote.length > 1200 || !e.text.includes(quote)) fail('模型或发布状态摘录没有对应官网原文');
  }
  if (!normalize(e.quotes.modelName).toLowerCase().includes(normalize(r.name).toLowerCase())) fail('模型名称与原文不一致');
  const basis = e.dateBasis;
  if (!normalize(e.quotes?.eventDate) || !basis || !['explicit_release_date', 'article_date_today'].includes(basis.type) || basis.value !== r.date || !basis.quote || !basis.field) fail('缺少与实际发布行为对应的日期依据');
  if (normalize(e.quotes.eventDate) !== normalize(basis.quote)) fail('日期摘录与核验依据不一致');
  if (basis.type === 'explicit_release_date' && !e.text.includes(normalize(basis.quote))) fail('事件日期不在官网正文中');
}

function proofHash(result) {
  return hash({ record: result.record, evidence: result.evidence });
}

// Fetches and parses original documents twice; it never manufactures a human decision.
async function verify(candidate, source, registry, fetchText, extractRelease, now) {
  const options = { validateUrl: url => sourceFor(registry, source.id, url) };
  try {
    const first = await fetchText(candidate.canonicalUrl, options);
    sourceFor(registry, source.id, first.url);
    const result = extractRelease({ html: first.text, url: first.url, source, now });
    if (!result.eligible) return { status: 'needs_review', code: result.code, reason: result.reason || '官网正文尚不能确认实际发布' };
    try { assertExtraction(result, first.text, now); } catch (error) { return { status: 'needs_review', code: 'incomplete_evidence', reason: error.message }; }
    const second = await fetchText(first.url, options);
    sourceFor(registry, source.id, second.url);
    const confirmed = extractRelease({ html: second.text, url: second.url, source, now });
    try {
      assertExtraction(confirmed, second.text, now);
      if (second.url !== first.url || proofHash(result) !== proofHash(confirmed)) fail('官网正文或日期依据发生变化，需要人工核对');
    } catch (error) { return { status: 'needs_review', code: 'changed_evidence', reason: error.message }; }
    return { status: 'verified', result, source, url: second.url, documentHash: hash(second.text) };
  } catch (error) {
    return { status: 'failed', code: 'source_unavailable', reason: String(error.message || error).slice(0, 300), retryAfter: new Date(now.getTime() + 30 * 60 * 1000).toISOString() };
  }
}

function makeRecord(candidate, verified, policy, now) {
  const { result: { record: facts, evidence }, source, url } = verified;
  const at = now.toISOString();
  const receipt = {
    mode: 'automatic', by: 'model-atlas-auto', at, candidateId: candidate.id,
    candidateRevision: candidateRevision(candidate), policyHash: policy, ruleVersion: evidence.ruleVersion,
    sourceId: source.id, sourceUrl: url, contentHash: hash(evidence.text), documentHash: verified.documentHash,
    quotes: evidence.quotes, dateBasis: evidence.dateBasis, title: evidence.title,
  };
  const id = 'auto-' + hash([source.vendor, modelKey(facts.name), facts.kind, facts.date]).slice(0, 20);
  const record = {
    id, vendor: source.vendor, name: normalize(facts.name), date: facts.date, kind: facts.kind,
    summary: normalize(facts.summary), url, sourceType: 'official', tags: [],
    audit: { status: 'verified', checkedAt: today(now), verifiedAt: today(now), supports: `${evidence.quotes.eventType} 日期依据：${evidence.dateBasis.quote}`,
      support: { modelName: true, eventDate: true, eventType: true },
      method: `官网规则自动核验（${evidence.ruleVersion}）：核对模型、开放类型与实际日期；两次读取原文确认一致。` },
    pipelineReview: receipt,
  };
  return { ...record, pipelineReview: { ...receipt, recordHash: recordFingerprint(record) } };
}

export function validateAutomaticReceipt(record, registry) {
  const receipt = record.pipelineReview;
  if (receipt?.mode !== 'automatic') return;
  const source = sourceFor(registry, receipt.sourceId, receipt.sourceUrl);
  if (source.sourceType !== 'official' || source.vendor !== record.vendor || record.sourceType !== 'official' || !KINDS.has(record.kind)) fail('自动核验仅能确认所属厂商的已发生模型发布');
  if (record.url !== receipt.sourceUrl || !receipt.ruleVersion || receipt.by !== 'model-atlas-auto') fail('自动核验收据缺少规则或原文信息');
  for (const key of ['contentHash', 'documentHash', 'policyHash', 'candidateRevision']) if (!/^[a-f0-9]{64}$/.test(receipt[key] || '')) fail('自动核验收据缺少完整校验记录');
  if (!receipt.title || !receipt.at || !receipt.candidateId || !receipt.quotes?.modelName || !receipt.quotes?.eventType || !receipt.quotes?.eventDate) fail('自动核验收据缺少原文摘录');
  if (!normalize(receipt.quotes.modelName).toLowerCase().includes(normalize(record.name).toLowerCase())) fail('自动核验模型与摘录不符');
  if (!['explicit_release_date', 'article_date_today'].includes(receipt.dateBasis?.type) || receipt.dateBasis.value !== record.date || !receipt.dateBasis.quote || !receipt.dateBasis.field) fail('自动核验日期依据与记录不符');
  if (normalize(receipt.quotes.eventDate) !== normalize(receipt.dateBasis.quote)) fail('自动核验日期摘录不一致');
  if (!/自动|规则/.test(record.audit?.method || '') || /审核人阅读/.test(record.audit?.method || '')) fail('自动核验不能标为人工阅读');
}

export async function autoReviewCandidates({ queue, atlas, registry, fetchText = fetchSourceText, extractRelease = extractOfficialRelease, now = new Date(), maxCandidates = 24, concurrency = 3 }) {
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 120 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6) fail('自动核验批次或并发参数无效');
  const policy = policyHash(registry), at = now.toISOString(), vendors = new Set(atlas.vendors.map(v => v.id));
  const updates = new Map(), groups = new Map();
  const report = { checked: 0, published: 0, needsReview: 0, failed: 0, duplicates: 0 };
  const stamp = (review, candidate) => ({ ...review, ...(review.status === 'needs_review' ? { retryAfter: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString() } : {}), checkedAt: at, ruleVersion: AUTO_REVIEW_VERSION, policyHash: policy, candidateRevision: candidateRevision(candidate) });
  for (const candidate of queue.candidates) {
    if (candidate.status !== 'pending' || candidate.sources?.some(s => registry.sources.find(r => r.id === s.registryId)?.kind === 'manual')) continue;
    const previous = candidate.autoReview;
    if (previous?.ruleVersion === AUTO_REVIEW_VERSION && previous.policyHash === policy && previous.candidateRevision === candidateRevision(candidate) && previous.retryAfter > at) continue;
    const source = officialSource(candidate, registry, vendors);
    if (!source) {
      updates.set(candidate.id, { ...candidate, autoReview: stamp({ status: 'needs_review', code: 'manual_source', reason: '非可自动核验的所属厂商官网来源，需人工核对' }, candidate) });
      report.needsReview++;
      continue;
    }
    groups.set(source.vendor, [...(groups.get(source.vendor) || []), { candidate, source }]);
  }
  for (const [vendor, group] of groups) groups.set(vendor, group.toSorted((a, b) => (a.candidate.autoReview?.checkedAt || '').localeCompare(b.candidate.autoReview?.checkedAt || '')));
  // Round-robin prevents an unavailable vendor from occupying the entire batch.
  const selected = [];
  for (let round = 0; selected.length < maxCandidates; round++) {
    const items = [...groups.values()].flatMap(group => group[round] ? [group[round]] : []);
    if (!items.length) break;
    selected.push(...items.slice(0, maxCandidates - selected.length));
  }
  const results = new Array(selected.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, async () => {
    while (cursor < selected.length) {
      const index = cursor++;
      const { candidate, source } = selected[index];
      results[index] = await verify(candidate, source, registry, fetchText, extractRelease, now);
    }
  }));
  let resultAtlas = structuredClone(atlas);
  const batchDates = new Map();
  for (const verified of results.filter(v => v.status === 'verified')) {
    const facts = verified.result.record;
    const identity = JSON.stringify([verified.source.vendor, modelKey(facts.name), facts.kind]);
    batchDates.set(identity, new Set([...(batchDates.get(identity) || []), facts.date]));
  }
  // Apply sequentially after parallel reads, so two announcements cannot duplicate one event.
  for (const [index, verified] of results.entries()) {
    const { candidate } = selected[index];
    report.checked++;
    if (verified.status !== 'verified') {
      report[verified.status === 'failed' ? 'failed' : 'needsReview']++;
      updates.set(candidate.id, { ...candidate, autoReview: stamp(verified, candidate) });
      continue;
    }
    const record = makeRecord(candidate, verified, policy, now);
    if (batchDates.get(JSON.stringify([record.vendor, modelKey(record.name), record.kind])).size > 1) {
      updates.set(candidate.id, { ...candidate, autoReview: stamp({ status: 'needs_review', code: 'batch_date_conflict', reason: '本轮官网资料对同一模型发布时间存在冲突，需人工核对' }, candidate) });
      report.needsReview++;
      continue;
    }
    const matches = resultAtlas.events.filter(e => e.vendor === record.vendor && modelKey(e.name) === modelKey(record.name) && matchesKind(e.kind, record.kind));
    const same = matches.find(e => e.date === record.date);
    if (same) {
      updates.set(candidate.id, { ...candidate, status: 'duplicate', autoReview: stamp({ status: 'duplicate', recordId: same.id, reason: '同一模型发布已收录，无需重复审核' }, candidate) });
      report.duplicates++;
    } else if (matches.length || [...resultAtlas.events, ...resultAtlas.forecasts].some(e => e.id === record.id)) {
      updates.set(candidate.id, { ...candidate, autoReview: stamp({ status: 'needs_review', code: 'existing_conflict', reason: '与已收录事件日期冲突，保留现有记录并等待人工核对' }, candidate) });
      report.needsReview++;
    } else {
      validateAutomaticReceipt(record, registry);
      resultAtlas = { ...resultAtlas, events: [...resultAtlas.events, record], historyCheckedAt: today(now) };
      updates.set(candidate.id, { ...candidate, status: 'published', review: { ...record.pipelineReview, action: 'publish', recordId: record.id, reason: '官网原文通过自动核验' }, autoReview: stamp({ status: 'published', recordId: record.id, reason: '官网原文通过自动核验' }, candidate) });
      report.published++;
    }
  }
  return { queue: { ...queue, candidates: queue.candidates.map(c => updates.get(c.id) || structuredClone(c)) }, atlas: resultAtlas, report };
}
