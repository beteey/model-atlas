// 数据校验：任何一条不通过都会让 CI 失败，阻止部署
import fs from 'node:fs';

const read = (p) => JSON.parse(fs.readFileSync(new URL(`../public/data/${p}`, import.meta.url), 'utf8'));
const atlas = read('atlas.json');
const watch = read('watchlist.json');
const site = read('site.json');

const errors = [];
const warnings = [];
const err = (where, msg) => errors.push(`${where}: ${msg}`);
const warn = (where, msg) => warnings.push(`${where}: ${msg}`);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (d) => DATE.test(d) && !Number.isNaN(new Date(d + 'T00:00:00Z').getTime());
const isHttps = (u) => { try { return new URL(u).protocol === 'https:'; } catch { return false; } };
const today = new Date().toISOString().slice(0, 10);

const VERIFICATION = new Set(['verified', 'unverified', 'blocked', 'unavailable']);
const SOURCE_TYPES = new Set(['official', 'paper', 'press_release', 'media', 'vendor_community', 'community', 'aggregator']);
const CONFIDENCE = new Set(['official', 'media', 'estimated', 'community']);
const OUTCOMES = new Set(['hit', 'partial', 'miss', 'pending']);
const SNIPPET_ONLY = /检索摘录|未直接打开原页/;

const vendorIds = new Set();
for (const v of atlas.vendors) {
  if (vendorIds.has(v.id)) err(`vendor ${v.id}`, '重复的厂商 ID');
  vendorIds.add(v.id);
}

const ids = new Set();
const checkId = (kind, id) => {
  if (!id || !/^[a-z0-9-]+$/.test(id)) err(`${kind} ${id}`, 'ID 只能包含小写字母、数字和连字符');
  if (ids.has(id)) err(`${kind} ${id}`, '重复 ID');
  ids.add(id);
};

const checkSource = (where, s, { requireType = true } = {}) => {
  if (!isHttps(s.url)) err(where, `来源链接必须是 https：${s.url}`);
  if (requireType && !SOURCE_TYPES.has(s.sourceType)) err(where, `sourceType 无效：${s.sourceType}`);
  if (s.archiveUrl && !isHttps(s.archiveUrl)) err(where, 'archiveUrl 必须是 https');
  if (s.archivedAt && !isDate(s.archivedAt)) err(where, 'archivedAt 日期格式错误');
};

const watchIds = new Set(watch.accounts.map((a) => a.id));

// 历史事件
for (const e of atlas.events) {
  const w = `event ${e.id}`;
  checkId('event', e.id);
  if (!vendorIds.has(e.vendor)) err(w, `未知厂商 ${e.vendor}`);
  if (!isDate(e.date)) err(w, `日期格式错误：${e.date}`);
  if (e.date > today) err(w, `历史事件日期在未来：${e.date}，应放入 forecasts`);
  if (!e.name || !e.kind || !e.summary) err(w, '缺少 name / kind / summary');
  checkSource(w, e);
  (e.extraSources || []).forEach((x, i) => checkSource(`${w} extraSources[${i}]`, x));

  const a = e.audit || {};
  if (!VERIFICATION.has(a.status)) err(w, `audit.status 无效：${a.status}`);
  if (!isDate(a.checkedAt)) err(w, 'audit.checkedAt 缺失或格式错误');
  if (!a.supports) err(w, 'audit.supports 必须说明来源支持了什么');
  const sup = a.support || {};
  for (const k of ['modelName', 'eventDate', 'eventType']) if (!(k in sup)) err(w, `audit.support.${k} 缺失`);
  if (a.status === 'verified') {
    if (!isDate(a.verifiedAt)) err(w, '已核验记录必须有 verifiedAt');
    if (sup.eventDate !== true || sup.eventType !== true) err(w, '已核验记录的日期与事件类型必须都被来源支持');
    if (sup.modelName === false) err(w, '已核验记录的模型名称不能为“不支持”');
    if (SNIPPET_ONLY.test(a.method || '')) err(w, '只读到检索摘录的来源不能标为已核验');
    if (['community', 'aggregator'].includes(e.sourceType)) err(w, '社区或第三方整理来源不能单独确认历史事件');
    if (!e.archiveUrl) warn(w, '已核验但尚无存档链接（运行 npm run archive）');
  } else if (a.verifiedAt) {
    err(w, '未核验的记录不应有 verifiedAt');
  }
}

// 未来线索
for (const x of atlas.forecasts) {
  const w = `forecast ${x.id}`;
  checkId('forecast', x.id);
  if (!vendorIds.has(x.vendor)) err(w, `未知厂商 ${x.vendor}`);
  if (!CONFIDENCE.has(x.confidence)) err(w, `confidence 无效：${x.confidence}`);
  if (!isDate(x.checkedAt)) err(w, 'checkedAt 缺失或格式错误');
  for (const k of ['windowStart', 'windowEnd']) if (x[k] && !isDate(x[k])) err(w, `${k} 格式错误`);
  if (x.windowStart && x.windowEnd && x.windowStart > x.windowEnd) err(w, '时间窗起点晚于终点');
  if (!x.sources?.length) err(w, '未来线索至少需要一条来源');
  if (!x.changes?.length) err(w, '未来线索必须有变更记录');
  (x.changes || []).forEach((c, i) => { if (!isDate(c.date)) err(`${w} changes[${i}]`, '日期格式错误'); });

  const verifiedTypes = new Set();
  (x.sources || []).forEach((s, i) => {
    const sw = `${w} sources[${i}]`;
    checkSource(sw, s);
    if (!VERIFICATION.has(s.verification)) err(sw, `verification 无效：${s.verification}`);
    if (s.verification === 'verified') {
      if (!isDate(s.verifiedAt)) err(sw, '已核验来源必须有 verifiedAt');
      if (SNIPPET_ONLY.test(s.method || '')) err(sw, '只读到检索摘录的来源不能标为已核验');
      verifiedTypes.add(s.sourceType);
    }
    if (s.sourceType === 'community') {
      if (!s.watchlistId) err(sw, '社区账号来源必须通过 watchlistId 关联观察名单');
      else if (!watchIds.has(s.watchlistId)) err(sw, `watchlistId 不存在：${s.watchlistId}`);
    }
  });
  // 分级不能高于已核验证据所能支撑的级别
  if (x.confidence === 'official' && !verifiedTypes.has('official')) err(w, '标为“官方”但没有已核验的官方来源');
  if (x.confidence === 'media' && !verifiedTypes.has('media') && !verifiedTypes.has('official')) err(w, '标为“媒体报道”但没有已核验的媒体或官方来源');
}

// 观察名单
const accIds = new Set();
for (const a of watch.accounts) {
  const w = `account ${a.id}`;
  if (accIds.has(a.id)) err(w, '重复账号 ID');
  accIds.add(a.id);
  if (!isHttps(a.url)) err(w, '账号主页必须是 https');
  (a.focus || []).forEach((v) => { if (!vendorIds.has(v)) err(w, `focus 中的未知厂商 ${v}`); });
  if (a.profileCheckedAt && !isDate(a.profileCheckedAt)) err(w, 'profileCheckedAt 格式错误');
  if (!a.profileCheckedAt) warn(w, '账号信息尚未核对（profileCheckedAt 为空）');
  (a.trackRecord || []).forEach((r, i) => {
    const rw = `${w} trackRecord[${i}]`;
    if (!r.claim) err(rw, '缺少说法内容 claim');
    if (!isHttps(r.claimUrl)) err(rw, '每条说法必须附 https 原帖链接 claimUrl');
    if (!isDate(r.claimedAt)) err(rw, 'claimedAt 缺失或格式错误');
    if (!OUTCOMES.has(r.outcome)) err(rw, `outcome 无效：${r.outcome}`);
    if (r.outcome !== 'pending') {
      if (!isDate(r.resolvedAt)) err(rw, '已比对的说法必须有 resolvedAt');
      if (r.outcome !== 'miss' && !isHttps(r.evidenceUrl)) err(rw, '命中 / 部分命中必须附官方依据 evidenceUrl');
      if (r.eventId && !atlas.events.some((e) => e.id === r.eventId)) err(rw, `eventId 不存在：${r.eventId}`);
    }
  });
}

if (site.url && !isHttps(site.url)) err('site.json', 'url 必须是 https');
if (/YOUR_GITHUB_USERNAME|example\.com/.test(JSON.stringify(site))) warn('site.json', '仍是占位值，部署前请填写 url / repo / issues');

for (const m of warnings) console.warn('⚠ ' + m);
for (const m of errors) console.error('✗ ' + m);
console.log(`\n${atlas.events.length} 条事件，${atlas.forecasts.length} 条线索，${watch.accounts.length} 个账号；${errors.length} 个错误，${warnings.length} 个提醒。`);
process.exit(errors.length ? 1 : 0);
