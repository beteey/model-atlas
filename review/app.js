const $ = id => document.getElementById(id);
let state, selected, evidence, confirmedHash;
const notice = message => { $('notice').textContent = message; };
async function request(path, body) {
  const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Review-Token': state.csrf }, body: JSON.stringify(body) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error); return data;
}
function option(select, value, text) { const o = document.createElement('option'); o.value = value; o.textContent = text; select.append(o); }
function kinds() {
  const event = $('type').value === 'event'; $('kind').replaceChildren();
  (event ? ['首次宣布', '预览开放', 'API 上线', '正式发布', '权重开放', '论文公开'] : ['计划发布', '正在训练', '发布暂缓']).forEach(k => option($('kind'), k, k));
  $('date-label').classList.toggle('hidden', !event); $('date').required = event;
  $('window').classList.toggle('hidden', event);
}
function list() {
  $('list').replaceChildren();
  const text = $('search').value.toLowerCase();
  const candidates = state.candidates.filter(c => c.status === $('status').value && `${c.title} ${c.sources.map(s => s.name).join(' ')}`.toLowerCase().includes(text));
  $('count').textContent = `${candidates.length} 条`;
  for (const c of candidates) {
    const button = document.createElement('button'); button.className = 'item'; button.setAttribute('aria-current', c.id === selected?.id);
    const title = document.createElement('span'); title.textContent = c.title;
    const small = document.createElement('small'); small.textContent = c.sources.map(s => s.name).join(' · ') + (c.submitted ? ' · 等待处理' : '');
    button.append(title, small); button.onclick = () => choose(c); $('list').append(button);
  }
}
function choose(c) {
  selected = c; evidence = null; $('form').reset(); kinds();
  $('body').textContent = '请选择对应发布方，再读取可公开访问的原文。';
  $('empty').classList.add('hidden'); $('detail').classList.remove('hidden');
  $('title').textContent = c.title; $('original').href = c.canonicalUrl;
  $('discovery').textContent = `${c.sources.map(s => s.name).join(' · ')} · 发现于 ${c.discoveredAt?.slice(0, 10) || '未知'}`;
  $('processed').textContent = c.review ? `${c.review.mode === 'automatic' ? '自动核验' : c.review.by} · ${c.review.at} · ${c.review.reason || c.review.action}` : c.autoReview?.reason || '';
  $('form').classList.toggle('hidden', ['published', 'rejected', 'duplicate'].includes(c.status));
  $('url').value = c.canonicalUrl;
  const source = state.registry.sources.find(s => c.sources.some(x => x.registryId === s.id) && s.evidencePrefixes?.length);
  $('source').value = source?.id || '';
  $('vendor').value = c.vendor || '';
  $('target-label').classList.add('hidden'); $('id').readOnly = false;
  $('publish').disabled = !!c.submitted;
  list();
}
async function refresh() {
  const id = selected?.id; state = await request('/api/state');
  $('actor').textContent = state.actor;
  $('source').replaceChildren(); option($('source'), '', '选择原文发布方');
  state.registry.sources.filter(s => s.evidencePrefixes?.length).forEach(s => option($('source'), s.id, s.name));
  $('vendor').replaceChildren(); option($('vendor'), '', '选择厂商'); state.atlas.vendors.forEach(v => option($('vendor'), v.id, v.name));
  $('target').replaceChildren(); option($('target'), '', '选择已有记录'); state.records.forEach(r => option($('target'), r.id, `${r.name} · ${r.kind}`));
  list(); if (id) { const c = state.candidates.find(x => x.id === id); if (c) choose(c); }
}
async function act(fn) { try { await fn(); } catch (error) { notice(error.message); } }
$('sync').onclick = () => act(async () => { notice('正在同步…'); await request('/api/sync', {}); await refresh(); notice('待审核队列已同步。'); });
$('status').onchange = list; $('search').oninput = list; $('type').onchange = kinds;
for (const id of ['source', 'url']) $(id).oninput = () => { evidence = null; $('body').textContent = '来源已改变，请重新读取原文。'; };
$('form').addEventListener('input', e => { if (e.target !== $('checked')) { $('checked').checked = false; confirmedHash = null; } });
$('read').onclick = () => act(async () => {
  evidence = null; notice('正在读取原文…');
  evidence = await request('/api/evidence', { registryId: $('source').value, url: $('url').value });
  $('body').textContent = evidence.text; $('checked').checked = false; notice('原文已读取，请选择能够支持记录的摘录。');
});
$('operation').onchange = () => { $('target-label').classList.toggle('hidden', $('operation').value !== 'update'); $('id').readOnly = $('operation').value === 'update'; };
$('target').onchange = () => {
  const r = state.records.find(r => r.id === $('target').value); if (!r) return;
  $('id').value = r.id; $('name').value = r.name; $('vendor').value = r.vendor;
  $('type').value = r.date ? 'event' : 'forecast'; kinds();
  if ([...$('kind').options].some(o => o.value === r.kind)) $('kind').value = r.kind;
  $('date').value = r.date || ''; $('start').value = r.windowStart || ''; $('end').value = r.windowEnd || ''; $('summary').value = r.summary;
};
function decision(action) {
  const d = { candidateId: selected.id, candidateRevision: selected.revision, policyHash: state.policyHash, action, reason: $('reason').value };
  if (action === 'publish') {
    if (!evidence) throw new Error('请先读取原文');
    const existing = state.records.find(r => r.id === $('target').value);
    d.record = { id: $('id').value, vendor: $('vendor').value, name: $('name').value, type: $('type').value, kind: $('kind').value, date: $('date').value, windowStart: $('start').value, windowEnd: $('end').value, summary: $('summary').value, operation: $('operation').value, baseHash: existing?.baseHash };
    d.evidence = { registryId: $('source').value, url: $('url').value, contentHash: evidence.contentHash, fetchedAt: evidence.fetchedAt, quotes: { modelName: $('quote-name').value, eventType: $('quote-type').value, eventDate: $('quote-date').value }, note: $('note').value, checks: Object.fromEntries(['fullTextRead', 'modelName', 'eventType', 'eventDate'].map(k => [k, $('checked').checked])) };
  }
  return d;
}
$('checked').onchange = () => act(async () => {
  confirmedHash = null;
  if (!$('checked').checked) return;
  const d = decision('publish');
  const value = { candidateId: d.candidateId, candidateRevision: d.candidateRevision, policyHash: d.policyHash, record: d.record, evidence: d.evidence, reason: d.reason };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  confirmedHash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
});
async function submit(action) {
  if (!selected) return;
  const d = decision(action);
  if (action === 'publish') d.confirmationHash = confirmedHash;
  notice('正在校验并提交审核…'); const result = await request('/api/decision', d);
  selected.submitted = true; $('publish').disabled = true; list();
  notice('已提交。工作流通过后才会发布；完成后点击“同步待审核”。');
  const a = document.createElement('a'); a.textContent = ' 查看处理结果 ↗'; a.href = result.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; $('notice').append(a);
}
$('form').onsubmit = event => { event.preventDefault(); act(() => submit('publish')); };
$('defer').onclick = () => act(() => submit('defer')); $('reject').onclick = () => act(() => submit('reject'));
act(async () => { await refresh(); notice('正在同步待审核…'); await request('/api/sync', {}); await refresh(); notice('待审核队列已同步。'); });
