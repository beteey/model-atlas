// 把已核验来源提交到 Internet Archive，并回写 archiveUrl / archivedAt
// 用法：npm run archive            只处理尚无存档的来源
//       npm run archive -- --dry   只列出待存档链接，不发请求
import fs from 'node:fs';

const file = new URL('../public/data/atlas.json', import.meta.url);
const atlas = JSON.parse(fs.readFileSync(file, 'utf8'));
const dry = process.argv.includes('--dry');
const today = new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = [];
const collect = (obj, verified) => { if (verified && obj.url && !obj.archiveUrl) targets.push(obj); };
for (const e of atlas.events) {
  collect(e, e.audit?.status === 'verified');
  (e.extraSources || []).forEach((x) => collect(x, e.audit?.status === 'verified'));
}
for (const x of atlas.forecasts) x.sources.forEach((s) => collect(s, s.verification === 'verified'));

console.log(`待存档 ${targets.length} 条`);
if (dry) { targets.forEach((t) => console.log('  ' + t.url)); process.exit(0); }

async function save(url) {
  const r = await fetch('https://web.archive.org/save/' + url, { redirect: 'manual', headers: { 'User-Agent': 'model-atlas-archiver/1.0' } });
  const loc = r.headers.get('content-location') || r.headers.get('location');
  if (loc) return new URL(loc, 'https://web.archive.org').href;
  if (r.ok) return `https://web.archive.org/web/${today.replace(/-/g, '')}/${url}`;
  throw new Error(`HTTP ${r.status}`);
}

const result = structuredClone(atlas);
const byUrl = new Map();
let ok = 0;
for (const t of targets) {
  try {
    const archiveUrl = byUrl.get(t.url) || await save(t.url);
    byUrl.set(t.url, archiveUrl);
    ok++;
    console.log(`✓ ${t.url}\n  → ${archiveUrl}`);
  } catch (e) {
    console.warn(`✗ ${t.url}：${e.message}`);
  }
  await sleep(6000); // 免费接口限流，约每分钟 10 次
}

const patch = (obj) => { const a = byUrl.get(obj.url); return a && !obj.archiveUrl ? { ...obj, archiveUrl: a, archivedAt: today } : obj; };
result.events = result.events.map((e) => ({ ...patch(e), ...(e.extraSources ? { extraSources: e.extraSources.map(patch) } : {}) }));
result.forecasts = result.forecasts.map((x) => ({ ...x, sources: x.sources.map(patch) }));
fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
console.log(`\n完成：${ok}/${targets.length} 条已存档。`);
