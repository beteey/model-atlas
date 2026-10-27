// 模型纪元 · 前端逻辑（无构建步骤，纯静态）
const $ = (s) => document.querySelector(s);
const h = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const f = (d) => String(d).replace(/-/g, '.');
const T = (d) => new Date(d + 'T00:00:00Z').getTime();
const DAY = 864e5;

const ST = { verified: ['已核验', 't-v'], unverified: ['未核验', 't-b'], blocked: ['待复核', 't-b'], unavailable: ['无法读取', 't-u'] };
const chip = (s) => { const a = ST[s] || ['未知', 't-b']; return `<span class="tag ${a[1]}">${a[0]}</span>`; };

const SOURCE_TYPE = {
  official: '官方一手', paper: '论文', press_release: '厂商新闻稿', media: '媒体报道',
  vendor_community: '厂商社区文章', community: '社区账号', aggregator: '第三方整理',
};
const tier = (e) => SOURCE_TYPE[e.sourceType] || '来源待核实';

const ACCOUNT_TYPE = { leaker: '爆料', 'reverse-engineer': '逆向分析', analyst: '行业分析', aggregator: '资讯聚合', commentator: '评论解读', reporter: '记者' };
const OUTCOME = { hit: ['命中', 't-v'], partial: ['部分命中', 't-b'], miss: ['未命中', 't-u'], pending: ['待比对', 't-m'] };

const link = (u, t) => `<a href="${h(u)}" target="_blank" rel="noopener noreferrer">${h(t)}</a>`;
const archiveLink = (s) => s.archiveUrl ? `<a class="arc" href="${h(s.archiveUrl)}" target="_blank" rel="noopener noreferrer" title="存档于 ${h(s.archivedAt || '')}">存档</a>` : '';
const ck = (s) => ['modelName', 'eventDate', 'eventType'].map((k) => { const v = s[k]; return v === true ? '<span class="y">✓</span>' : v === false ? '<span class="n">✗</span>' : '<span class="p">≈</span>'; }).join('');

async function loadJSON(path) {
  const r = await fetch(path, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.json();
}

function showLoadError(err) {
  const isFile = location.protocol === 'file:';
  $('main').insertAdjacentHTML('afterbegin', `<p class="err" role="alert">数据加载失败：${h(err.message)}。${isFile ? '本页需要通过 HTTP 访问，不能直接双击打开。请在项目目录运行 <code>npm run dev</code> 或 <code>python3 -m http.server -d public 8080</code>，然后访问 <code>http://localhost:8080</code>。' : '请稍后刷新，或到勘误页反馈。'}</p>`);
}

function init({ D, W, SITE }) {
  const V = Object.fromEntries(D.vendors.map((v) => [v.id, v]));
  const A = Object.fromEntries((W.accounts || []).map((a) => [a.id, a]));
  const TZ = SITE.timezone || 'Asia/Taipei';
  document.querySelectorAll('[data-tz]').forEach((el) => { el.textContent = SITE.timezoneLabel || TZ; });
  if (SITE.repo) $('#repo-link').href = SITE.repo;
  if (SITE.issues) $('#issues-link').href = SITE.issues;

  const E = D.events.slice().sort((a, b) => b.date.localeCompare(a.date));
  const todayKey = () => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const part = (t) => parts.find((p) => p.type === t).value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  };
  let TODAY = todayKey();

  function shiftMonths(date, months) {
    const d = new Date(T(date)), day = d.getUTCDate();
    d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + months);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
    return d.toISOString().slice(0, 10);
  }
  function forecastState(x, today = TODAY) {
    const closed = ['已发布', '已取消', '取消', '发布暂缓', '已暂停'].includes(x.status);
    const overdue = Boolean(x.windowEnd && x.windowEnd < today && !closed);
    return {
      status: overdue ? '窗口已过 · 待核实' : x.status,
      dateLabel: overdue ? '原计划：' + x.dateLabel : x.dateLabel,
      notice: overdue ? `原预计窗口已于 ${f(x.windowEnd)} 结束，本页尚未记录发布确认，请查看来源核实最新进展。` : '',
    };
  }

  // ---------- 观察名单统计 ----------
  const minN = W.rules?.minResolvedForRate ?? 5;
  function accountStats(a) {
    const rec = a.trackRecord || [];
    const n = (k) => rec.filter((r) => r.outcome === k).length;
    const hit = n('hit'), partial = n('partial'), miss = n('miss'), pending = n('pending');
    const resolved = hit + partial + miss;
    const rate = resolved ? (hit + partial * 0.5) / resolved : null;
    return { hit, partial, miss, pending, resolved, rate, enough: resolved >= minN };
  }
  const rateText = (st) => st.resolved === 0 ? '尚无建档记录' : st.enough ? `${Math.round(st.rate * 100)}%` : `样本不足（${st.resolved}/${minN}）`;
  const accountBadge = (id) => {
    const a = A[id]; if (!a) return '';
    const st = accountStats(a);
    return `<span class="badge" title="${h(a.name)} 历史记录：命中 ${st.hit} · 部分 ${st.partial} · 未命中 ${st.miss} · 待比对 ${st.pending}">${h(a.handle || a.name)} · ${h(st.enough ? '命中率 ' + rateText(st) : rateText(st))}</span>`;
  };

  $('#snap').textContent = f([D.checkedAt, D.historyCheckedAt, D.radarCheckedAt, W.checkedAt].filter(Boolean).sort().at(-1));

  // ---------- 雷达 ----------
  let rf = 'all';
  const CL = { official: 3, media: 2, estimated: 1, community: 1 };
  const RL = [['all', '全部线索'], ['official', '官方'], ['media', '媒体报道'], ['estimated', '周期推测'], ['community', '社区线索']];
  const srcLine = (s) => `<div>${chip(s.verification || 'unverified')}${link(s.url, s.title)}${archiveLink(s)}${s.watchlistId ? accountBadge(s.watchlistId) : ''}</div>`;
  function radar() {
    $('#rf').innerHTML = RL.map(([k, t]) => `<button class="chip" data-k="${k}" aria-pressed="${rf === k}">${t}</button>`).join('');
    const L = D.forecasts.filter((x) => rf === 'all' || x.confidence === rf);
    $('#rg').innerHTML = L.length ? L.map((x) => {
      const state = forecastState(x);
      return `<article class="rc"><div class="meta"><span style="color:${V[x.vendor].color};font-weight:600">${h(V[x.vendor].name)}</span><span>${h(state.status)}</span></div><h3>${h(x.name)} · ${h(x.kind)}</h3><div class="date">${h(state.dateLabel)}</div><div class="meter" title="可信等级">${[1, 2, 3].map((i) => `<i class="${i <= CL[x.confidence] ? 'on' : ''}"></i>`).join('')}&nbsp;${h(x.evidenceLabel)}</div><p style="margin:0">${h(x.summary)}</p>${state.notice ? `<p class="notice">${h(state.notice)}</p>` : ''}<div class="src">${x.sources.map(srcLine).join('')}</div><button class="btn" data-f="${x.id}">查看证据与变更记录</button></article>`;
    }).join('') : '<p class="sub">这一类别暂无线索。</p>';
  }
  $('#rf').onclick = (e) => { const k = e.target.dataset.k; if (k) { rf = k; radar(); } };
  $('#rg').onclick = (e) => { const k = e.target.dataset.f; if (k) openF(k); };
  radar();

  // ---------- 观察名单 ----------
  let wf = 'all';
  function watch() {
    const vendorsInUse = D.vendors.filter((v) => (W.accounts || []).some((a) => (a.focus || []).includes(v.id)));
    $('#wf').innerHTML = [['all', '全部账号'], ...vendorsInUse.map((v) => [v.id, v.name])].map(([k, t]) => `<button class="chip" data-w="${k}" aria-pressed="${wf === k}">${h(t)}</button>`).join('');
    const L = (W.accounts || []).filter((a) => wf === 'all' || (a.focus || []).includes(wf));
    $('#wg').innerHTML = L.length ? L.map((a) => {
      const st = accountStats(a);
      return `<article class="wc"><div class="meta"><span>${h(ACCOUNT_TYPE[a.type] || a.type)} · ${h(a.platform)}</span><span>${a.profileCheckedAt ? '账号核对于 ' + f(a.profileCheckedAt) : '<span class="t-b">账号待核对</span>'}</span></div><h3>${h(a.name)}<small>${link(a.url, a.handle || a.url)}</small></h3><div class="rate"><b>${h(rateText(st))}</b><small>${st.resolved ? `命中 ${st.hit} · 部分 ${st.partial} · 未命中 ${st.miss}${st.pending ? ` · 待比对 ${st.pending}` : ''}` : '尚未录入可比对的说法'}</small></div><div class="focus">${(a.focus || []).map((v) => `<span style="color:${V[v]?.color || 'inherit'}">${h(V[v]?.name || v)}</span>`).join('')}</div><p>${h(a.note || '')}</p><button class="btn" data-a="${a.id}">查看历史说法</button></article>`;
    }).join('') : '<p class="sub">这一厂商暂无跟踪账号。</p>';
  }
  $('#wf').onclick = (e) => { const k = e.target.dataset.w; if (k) { wf = k; watch(); } };
  $('#wg').onclick = (e) => { const k = e.target.dataset.a; if (k) openA(k); };
  watch();

  // ---------- 时间地图 ----------
  const S = { range: '3y', view: 'map', vendor: 'all', q: '' };
  const shown = (v) => S.vendor === 'all' || S.vendor === v;
  const rangeStart = () => S.range === '3y' ? shiftMonths(TODAY, -36) : '2017-04-01';
  const rangeEnd = () => [shiftMonths(TODAY, 3), ...E.map((e) => e.date), ...D.forecasts.map((x) => x.windowEnd)].filter(Boolean).sort().at(-1);
  function chips() {
    $('#rng').innerHTML = [['3y', '近三年'], ['all', '全部历史']].map(([k, t]) => `<button class="chip" data-r="${k}" aria-pressed="${S.range === k}">${t}</button>`).join('');
    $('#vw').innerHTML = [['map', '地图'], ['list', '列表']].map(([k, t]) => `<button class="chip" data-v="${k}" aria-pressed="${S.view === k}">${t}</button>`).join('');
    $('#vf').innerHTML = [['all', '全部厂商'], ...D.vendors.map((v) => [v.id, v.name])].map(([k, t]) => `<button class="chip" data-c="${k}" aria-pressed="${S.vendor === k}">${h(t)}</button>`).join('');
  }
  function items() {
    const q = S.q.trim().toLowerCase(), start = rangeStart();
    const a = E.filter((e) => e.date >= start && shown(e.vendor) && (!q || (e.name + V[e.vendor].name + V[e.vendor].zh + e.tags.join('') + e.summary).toLowerCase().includes(q)));
    const b = D.forecasts.filter((x) => x.windowEnd && x.windowEnd >= start && shown(x.vendor) && (!q || (x.name + V[x.vendor].name).toLowerCase().includes(q)));
    return [a, b];
  }
  function draw() {
    chips();
    const [a, b] = items();
    $('#sc').hidden = S.view !== 'map'; $('#ls').hidden = S.view !== 'list';
    if (S.view === 'list') {
      const y = {}; a.forEach((e) => (y[e.date.slice(0, 4)] ??= []).push(e));
      $('#ls').innerHTML = Object.keys(y).sort().reverse().map((k) => `<h4>${k}</h4>` + y[k].map((e) => `<button class="row" data-e="${e.id}"><small>${f(e.date)}</small><span><b>${h(e.name)}</b> <small>${h(V[e.vendor].name)} · ${h(e.kind)}</small></span>${chip(e.audit.status)}</button>`).join('')).join('') || '<p class="sub">没有匹配的记录。</p>';
      return;
    }
    const s0 = rangeStart(), end = rangeEnd(), ppd = S.range === 'all' ? .42 : 1.05, x0 = T(s0);
    const W_ = Math.round((T(end) - x0) / DAY * ppd), X = (d) => Math.round((T(d) - x0) / DAY * ppd);
    let ticks = '';
    for (let yy = +s0.slice(0, 4); yy <= +end.slice(0, 4); yy++) for (const m of S.range === 'all' ? [1] : [1, 4, 7, 10]) {
      const d = `${yy}-${String(m).padStart(2, '0')}-01`;
      if (d >= s0 && d <= end) ticks += `<div class="tick" style="left:${X(d)}px">${m === 1 ? yy : yy + '.' + m}</div>`;
    }
    const lanes = D.vendors.filter((v) => a.some((e) => e.vendor === v.id && T(e.date) >= x0) || b.some((x) => x.vendor === v.id)).map((v) => {
      let last = -999, lv = 0;
      const mk = (o, cls, id, d, nm) => {
        const x = X(d), label = id[0] === 'f' ? `${o.name} · ${o.dateDetail} · ${forecastState(o).status}（节点按窗口截止位置显示）` : `${nm} ${f(d)}`;
        lv = x - last < 120 ? (lv + 1) % 3 : 0; last = x;
        return `<button class="ev ${cls}" style="left:${x}px;--c:${v.color};--y:${20 + lv * 20}px" data-${id[0]}="${id[1]}" aria-label="${h(label)}" title="${h(label)}"><i></i><span>${h(nm)}</span></button>`;
      };
      const evs = [...a.filter((e) => e.vendor === v.id && T(e.date) >= x0).map((e) => [e.date, e, 0]), ...b.filter((x) => x.vendor === v.id).map((x) => [x.windowEnd, x, 1])].sort((p, q) => p[0].localeCompare(q[0]));
      return `<div class="lane"><div class="ln" style="color:${v.color}">${h(v.name)}<small>${h(v.zh)}</small></div><div class="track" style="width:${W_}px">${ticks}<div class="today" style="left:${X(TODAY)}px" aria-label="今天 ${f(TODAY)}"></div>${evs.map(([d, o, fc]) => fc ? mk(o, 'fc', ['f', o.id], d, o.name + (forecastState(o).notice ? '（待核实）' : '（预期）')) : mk(o, o.audit.status === 'verified' ? '' : 'bk', ['e', o.id], d, o.name)).join('')}</div></div>`;
    }).join('');
    $('#sc').innerHTML = lanes || '<p class="sub" style="padding:20px">没有匹配的记录。</p>';
    const sc = $('#sc'); sc.scrollLeft = S.range === 'all' ? W_ : X(TODAY) - sc.clientWidth * .6 + 112;
  }
  $('#rng').onclick = (e) => { if (e.target.dataset.r) { S.range = e.target.dataset.r; draw(); } };
  $('#vw').onclick = (e) => { if (e.target.dataset.v) { S.view = e.target.dataset.v; draw(); } };
  $('#vf').onclick = (e) => { if (e.target.dataset.c) { S.vendor = e.target.dataset.c; draw(); } };
  $('#q').oninput = (e) => { S.q = e.target.value; draw(); };
  const open = (e) => { const t = e.target.closest('[data-e],[data-f]'); if (!t) return; t.dataset.e ? openE(t.dataset.e) : openF(t.dataset.f); };
  $('#sc').onclick = open; $('#ls').onclick = open; draw();

  // ---------- 账本 ----------
  let lf = 'all';
  function ledger() {
    $('#lf').innerHTML = [['all', '全部'], ['verified', '已核验'], ['blocked', '待复核']].map(([k, t]) => `<button class="chip" data-s="${k}" aria-pressed="${lf === k}">${t}</button>`).join('');
    $('#lb').innerHTML = E.filter((e) => lf === 'all' || e.audit.status === lf).map((e) => `<tr data-e="${e.id}"><td>${f(e.date)}</td><td>${h(V[e.vendor].name)}</td><td><b>${h(e.name)}</b> <span style="color:var(--mute)">${h(e.kind)}</span></td><td>${h(tier(e))}</td><td>${h(e.audit.method)}</td><td class="ck">${ck(e.audit.support)}</td><td>${e.archiveUrl ? archiveLink(e) : '<span style="color:var(--mute)">—</span>'}</td><td>${chip(e.audit.status)}</td></tr>`).join('');
  }
  $('#lf').onclick = (e) => { if (e.target.dataset.s) { lf = e.target.dataset.s; ledger(); } };
  $('#lb').onclick = open; ledger();

  // ---------- 详情弹窗 ----------
  const dlg = $('#dlg');
  const show = (html, forecastId = '') => {
    dlg.dataset.forecast = forecastId;
    dlg.innerHTML = `<div class="dc"><button class="x" aria-label="关闭" data-close>×</button>${html}</div>`;
    if (!dlg.open) dlg.showModal();
  };
  dlg.onclick = (e) => { if (e.target === dlg || e.target.closest('[data-close]')) dlg.close(); };

  function openE(id) {
    const e = E.find((x) => x.id === id), a = e.audit, s = a.support, L = ['名称', '日期', '类型'], K = ['modelName', 'eventDate', 'eventType'];
    show(`<span style="color:${V[e.vendor].color};font-weight:600">${h(V[e.vendor].name)}</span> · ${f(e.date)} · ${h(e.kind)}<h3>${h(e.name)}</h3><p>${h(e.summary)}</p><p>${e.tags.map((t) => `<span class="tag">${h(t)}</span>`).join(' ')}</p>
<h5>证据检查 ${chip(a.status)}</h5><div class="chk">${K.map((k, i) => `<span>${s[k] === true ? '<span style="color:var(--ok)">✓</span>' : s[k] === false ? '<span style="color:var(--bad)">✗</span>' : '<span style="color:var(--warn)">≈</span>'} ${L[i]}${typeof s[k] === 'string' ? '（回溯命名）' : ''}</span>`).join('')}</div>
<h5>来源说明</h5><p>${h(a.supports)}</p>${a.note ? `<p style="color:var(--warn)">${h(a.note)}</p>` : ''}
<h5>来源（${h(tier(e))} · ${h(a.method)}）</h5><p>${link(e.url, e.url)} ${archiveLink(e)}</p>${(e.extraSources || []).map((x) => `<p>${link(x.url, x.title)} ${archiveLink(x)}<br><small>${h(x.note)}</small></p>`).join('')}
<h5>核验时间</h5><p>${a.verifiedAt ? '核验于 ' + f(a.verifiedAt) : '尚未核验'} · 最近检查 ${f(a.checkedAt)}</p>
<p style="margin-top:16px"><small><a href="${h(SITE.issues || 'about.html#corrections')}" target="_blank" rel="noopener noreferrer">对这条记录提交勘误</a></small></p>`);
  }
  function openF(id) {
    const x = D.forecasts.find((y) => y.id === id), state = forecastState(x);
    show(`<span style="color:${V[x.vendor].color};font-weight:600">${h(V[x.vendor].name)}</span> · ${h(x.evidenceLabel)} · ${h(state.status)}<h3>${h(x.name)} · ${h(x.kind)}</h3><p><b>${state.notice ? '原预计：' : ''}${h(x.dateDetail)}</b></p><p>${h(x.summary)}</p>${state.notice ? `<p class="notice">${h(state.notice)}</p>` : ''}
<h5>来源</h5>${x.sources.map((s) => `<p>${chip(s.verification || 'unverified')} ${link(s.url, s.title)} ${archiveLink(s)}<br><small>${h(SOURCE_TYPE[s.sourceType] || s.sourceType || '')}${s.method ? ' · ' + h(s.method) : ''}${s.publishedAt ? ' · 发布于 ' + f(s.publishedAt) : ''}</small>${s.watchlistId ? '<br>' + accountBadge(s.watchlistId) : ''}<br>${h(s.supports)}</p>${s.quote ? `<div class="q">“${h(s.quote)}”</div>` : ''}`).join('')}
<h5>变更记录</h5><div class="log">${x.changes.slice().reverse().map((c) => `<div><b>${f(c.date)}</b>${h(c.text)}</div>`).join('')}</div>
<p style="margin-top:16px"><small><a href="${h(SITE.issues || 'about.html#corrections')}" target="_blank" rel="noopener noreferrer">对这条线索提交勘误</a></small></p>`, id);
  }
  function openA(id) {
    const a = A[id], st = accountStats(a);
    const rec = (a.trackRecord || []).slice().sort((p, q) => (q.claimedAt || '').localeCompare(p.claimedAt || ''));
    show(`<span>${h(ACCOUNT_TYPE[a.type] || a.type)} · ${h(a.platform)} · ${a.profileCheckedAt ? '账号核对于 ' + f(a.profileCheckedAt) : '账号待核对'}</span><h3>${h(a.name)}</h3><p>${link(a.url, a.handle || a.url)}</p><p>${h(a.note || '')}</p>
<h5>命中统计</h5><p><b>${h(rateText(st))}</b> · 命中 ${st.hit} · 部分命中 ${st.partial} · 未命中 ${st.miss} · 待比对 ${st.pending}</p><p><small>命中率 = (命中 + 0.5 × 部分命中) ÷ 已比对数；已比对不足 ${minN} 条时不显示百分比。判定规则见 <a href="about.html#watchlist">关于页</a>。</small></p>
<h5>历史说法（${rec.length}）</h5>${rec.length ? `<div class="log">${rec.map((r) => { const o = OUTCOME[r.outcome] || OUTCOME.pending; return `<div><b>${f(r.claimedAt || '—')}</b><span class="tag ${o[1]}">${o[0]}</span> ${h(r.claim)}${r.claimUrl ? ' ' + link(r.claimUrl, '原帖') : ''}${r.resolvedAt ? `<br><small>比对于 ${f(r.resolvedAt)}${r.evidenceUrl ? ' · ' + link(r.evidenceUrl, '官方依据') : ''}${r.note ? ' · ' + h(r.note) : ''}</small>` : ''}</div>`; }).join('')}</div>` : '<p class="sub">尚未录入。建档方法见 <a href="about.html#watchlist">关于页</a>，欢迎通过仓库提交带原帖链接的说法记录。</p>'}`);
  }

  function refreshCurrentDay() {
    const next = todayKey(); if (next === TODAY) return;
    TODAY = next; radar(); draw();
    if (dlg.open && dlg.dataset.forecast) openF(dlg.dataset.forecast);
  }
  setInterval(refreshCurrentDay, 60000);
  window.addEventListener('focus', refreshCurrentDay);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshCurrentDay(); });
}

Promise.all([loadJSON('data/atlas.json'), loadJSON('data/watchlist.json'), loadJSON('data/site.json')])
  .then(([D, W, SITE]) => init({ D, W, SITE }))
  .catch((err) => { console.error(err); showLoadError(err); });
