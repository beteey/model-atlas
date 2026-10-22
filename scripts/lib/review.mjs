import { createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const candidateRevision = c => hash({ id: c.id, url: c.canonicalUrl, title: c.title, sources: c.sources });
export const policyHash = r => hash(r.sources.map(s => ({ id: s.id, vendor: s.vendor, sourceType: s.sourceType, evidencePrefixes: s.evidencePrefixes })));
export const confirmationHash = d => hash({ candidateId: d.candidateId, candidateRevision: d.candidateRevision, policyHash: d.policyHash, record: d.record, evidence: d.evidence, reason: d.reason });
export function recordFingerprint(record) {
  const { pipelineReview, archiveUrl, archivedAt, ...facts } = record;
  if (facts.sources) facts.sources = facts.sources.map(({ archiveUrl, archivedAt, ...source }) => source);
  return hash(facts);
}
const fail = message => { throw new Error(message); };
export const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
const validDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d;
export const normalize = s => String(s || '').replace(/\s+/g, ' ').trim();

export function articleText(html) {
  let body = html.replace(/<(script|style|nav|header|footer|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  body = body.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] || body.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] || body;
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return normalize(body.replace(/<[^>]*>/g, ' ').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, key) => {
    if (entities[key]) return entities[key];
    const n = key.startsWith('#x') ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
  }));
}
export function sourceFor(registry, id, url) {
  const s = registry.sources.find(x => x.id === id);
  let u;
  try { u = new URL(url); } catch { fail('来源 URL 无效'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port && u.port !== '443') fail('来源必须是无凭据的 HTTPS 原文');
  if (!s || !s.evidencePrefixes?.some(prefix => {
    const p = new URL(prefix);
    return u.origin === p.origin && u.pathname.startsWith(p.pathname);
  })) fail('来源不在可核验的原文范围内；转载入口只能发现线索，请补充官网或媒体原文');
  return s;
}

export function applyDecision({ queue, atlas, registry, decision, evidence, actor, now = new Date() }) {
  if (!actor || !/^[a-z\d][a-z\d-]{0,50}$/i.test(actor)) fail('缺少可信审核人');
  const q = structuredClone(queue), a = structuredClone(atlas), d = decision;
  const c = q.candidates.find(x => x.id === d.candidateId);
  if (!c) fail('候选不存在');
  if (['published', 'rejected'].includes(c.status)) fail('该候选已经处理，不可重复发布');
  if (d.candidateRevision !== candidateRevision(c)) fail('候选内容已变化，请重新审核');
  const at = now.toISOString(), date = today(now);
  if (['reject', 'defer'].includes(d.action)) {
    if (!normalize(d.reason)) fail('请填写处理原因');
    c.status = d.action === 'reject' ? 'rejected' : 'deferred';
    c.review = { by: actor, at, action: d.action, reason: normalize(d.reason) };
    return { queue: q, atlas: a, published: false };
  }
  if (d.action !== 'publish') fail('未知审核动作');
  if (d.confirmationHash !== confirmationHash(d)) fail('审核内容已变化，请重新确认当前记录与原文的对应关系');
  if (d.policyHash !== policyHash(registry)) fail('信源政策已变化，请重新审核');
  const r = d.record || {}, e = d.evidence || {};
  const source = sourceFor(registry, e.registryId, e.url);
  sourceFor(registry, e.registryId, evidence?.url);
  const body = normalize(evidence?.text);
  if (!body || body.length < 80 || /^(just a moment|access denied|sign in to continue)/i.test(body)) fail('未取得可核验原文');
  if (hash(body) !== e.contentHash) fail('原文正文已变化，请重新读取并审核');
  if (e.checks?.fullTextRead !== true) fail('请阅读原文后审核');
  if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(r.id || '')) fail('记录 ID 只能含小写字母、数字和连字符');
  if (!a.vendors.some(v => v.id === r.vendor)) fail('未知厂商');
  for (const field of ['name', 'kind', 'summary']) if (!normalize(r[field]) || r[field].length > 2000) fail(`缺少或过长的 ${field}`);
  if (!normalize(e.note)) fail('请说明证据支持的事实');
  if (!['event', 'forecast'].includes(r.type)) fail('必须选择历史事件或未来线索');
  for (const key of ['modelName', 'eventType', 'eventDate']) {
    // No date assertion is made when a forecast's window is explicitly unknown.
    if (key === 'eventDate' && r.type === 'forecast' && !r.windowStart && !r.windowEnd) continue;
    const quote = normalize(e.quotes?.[key]);
    if (e.checks?.[key] !== true || quote.length < 4 || quote.length > 1200) fail(`请核对并填写 ${key} 原文摘录`);
    if (!body.includes(quote)) fail(`${key} 摘录不在原文中`);
  }
  if (!normalize(e.quotes.modelName).toLowerCase().includes(normalize(r.name).toLowerCase())) fail('模型名称必须与原文摘录一致');
  if (source.sourceType === 'official' && source.vendor !== r.vendor) fail('官方原文所属厂商与模型不一致');
  const method = '审核人阅读原文并逐项摘录；发布前再次读取正文比对 SHA-256';
  const receipt = { candidateId: c.id, by: actor, at, decisionHash: hash(d), contentHash: e.contentHash, policyHash: d.policyHash, sourceId: source.id, quotes: e.quotes, sourceUrl: e.url };
  const events = ['首次宣布', '预览开放', 'API 上线', '正式发布', '权重开放', '论文公开'];
  let record;
  if (r.type === 'event') {
    if (!['official', 'paper'].includes(source.sourceType)) fail('历史发布必须有所属厂商官方原文或论文依据');
    if (source.sourceType === 'paper' && r.kind !== '论文公开') fail('论文只能支持论文公开，不能确认产品已经发布');
    if (!events.includes(r.kind)) fail('请选择明确的历史事件类型');
    if (!validDate(r.date)) fail('事件日期无效');
    if (r.date > date) fail('历史日期在未来，应放入未来线索');
    if (!['首次宣布', '论文公开'].includes(r.kind) && /\b(plan|planned|expect|expected|will|upcoming|soon|aim|hope|not|never)\b|计划|预计|即将|将于|将在|拟于|尚未|没有|未开放|未发布/i.test(e.quotes.eventType)) fail('该摘录描述计划或尚未可用，不能当成已经发布');
    record = { id: r.id, vendor: r.vendor, name: normalize(r.name), date: r.date, kind: r.kind, summary: normalize(r.summary), url: e.url, sourceType: source.sourceType, tags: [],
      audit: { status: 'verified', checkedAt: date, verifiedAt: date, supports: normalize(e.note), support: { modelName: true, eventDate: true, eventType: true }, method }, pipelineReview: receipt };
  } else {
    if (!['official', 'media'].includes(source.sourceType)) fail('目前仅发布核实后的官方计划或媒体线索，社区与转载留在待审核');
    if (!['计划发布', '正在训练', '发布暂缓'].includes(r.kind)) fail('请选择明确的未来状态');
    for (const field of ['windowStart', 'windowEnd']) if (r[field] && !validDate(r[field])) fail('预测日期无效');
    if (r.windowStart && r.windowEnd && r.windowStart > r.windowEnd) fail('预测窗口顺序错误');
    const confidence = source.sourceType;
    const dateLabel = r.windowStart || r.windowEnd ? [r.windowStart, r.windowEnd].filter(Boolean).join(' — ') : '发布时间待定';
    record = { id: r.id, vendor: r.vendor, name: normalize(r.name), kind: r.kind, confidence, evidenceLabel: confidence === 'official' ? '官方计划' : '媒体报道', status: r.kind, dateLabel,
      dateDetail: normalize(e.note), summary: normalize(r.summary), checkedAt: date,
      ...(r.windowStart ? { windowStart: r.windowStart } : {}), ...(r.windowEnd ? { windowEnd: r.windowEnd } : {}),
      sources: [{ title: source.name || source.id, url: e.url, sourceType: confidence, verification: 'verified', verifiedAt: date, method, supports: normalize(e.note), note: normalize(e.note), quote: normalize(e.quotes.eventType) }],
      changes: [{ date, text: normalize(d.reason) || '人工核对原文后首次收录。' }], pipelineReview: receipt };
  }
  const target = r.type === 'event' ? a.events : a.forecasts;
  const previous = [...a.events, ...a.forecasts].find(x => x.id === r.id);
  if (previous) {
    if (r.operation !== 'update' || !normalize(d.reason)) fail('ID 已存在；请明确选择更新并说明修改原因');
    if (!target.some(x => x.id === r.id)) fail('不能自动把预测转成历史，请另建已核验事件');
    if (r.baseHash !== hash(previous)) fail('原记录版本已变化，请重新审核');
    if (previous.vendor !== r.vendor) fail('更新不能改变厂商');
    const { revisions = [], ...snapshot } = previous;
    record.revisions = [...revisions, { at, by: actor, reason: normalize(d.reason), previous: snapshot }];
    if (r.type === 'forecast') record.changes = [...(previous.changes || []), ...record.changes];
    if (r.type === 'event') {
      record.tags = previous.tags || [];
      record.extraSources = previous.extraSources || [];
      if (previous.url === e.url && previous.pipelineReview?.contentHash === e.contentHash) for (const k of ['archiveUrl', 'archivedAt']) if (previous[k]) record[k] = previous[k];
    }
    target[target.findIndex(x => x.id === r.id)] = record;
  } else {
    if (r.operation === 'update') fail('要更新的记录不存在');
    if (target.some(x => x.vendor === r.vendor && normalize(x.name).toLowerCase() === normalize(r.name).toLowerCase() && x.kind === r.kind && (r.type === 'forecast' || x.date === r.date))) fail('已存在同模型同类型事件，请选择更新');
    target.push(record);
  }
  // Collection never advances the published data verification dates.
  receipt.recordHash = recordFingerprint(record);
  a[r.type === 'event' ? 'historyCheckedAt' : 'radarCheckedAt'] = date;
  c.status = 'published'; c.review = { ...receipt, action: 'publish', recordId: r.id, recordHash: hash(record), reason: normalize(d.reason) };
  return { queue: q, atlas: a, published: true };
}
