// 检查所有来源链接是否还能打开；失效链接需要人工复核，脚本不改数据
import fs from 'node:fs';

const atlas = JSON.parse(fs.readFileSync(new URL('../public/data/atlas.json', import.meta.url), 'utf8'));
const watch = JSON.parse(fs.readFileSync(new URL('../public/data/watchlist.json', import.meta.url), 'utf8'));

const urls = new Map();
const add = (u, where) => { if (u) urls.set(u, [...(urls.get(u) || []), where]); };
atlas.events.forEach((e) => { add(e.url, e.id); (e.extraSources || []).forEach((x) => add(x.url, e.id)); });
atlas.forecasts.forEach((x) => x.sources.forEach((s) => add(s.url, x.id)));
watch.accounts.forEach((a) => (a.trackRecord || []).forEach((r) => { add(r.claimUrl, a.id); add(r.evidenceUrl, a.id); }));

async function probe(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0 model-atlas-linkcheck' } });
    return r.status;
  } catch (e) {
    return e.name === 'AbortError' ? 'timeout' : e.message;
  } finally {
    clearTimeout(timer);
  }
}

const bad = [];
const list = [...urls.keys()];
for (let i = 0; i < list.length; i += 6) {
  const batch = list.slice(i, i + 6);
  const res = await Promise.all(batch.map(probe));
  batch.forEach((u, j) => {
    const s = res[j];
    const fine = typeof s === 'number' && s < 400;
    // x.com 等站点对脚本访问常返回 403，只提示不判失效
    const blocked = s === 403 || s === 429;
    console.log(`${fine ? '✓' : blocked ? '?' : '✗'} ${s}  ${u}`);
    if (!fine && !blocked) bad.push({ url: u, status: s, used: urls.get(u) });
  });
}
console.log(`\n共 ${list.length} 个链接，${bad.length} 个疑似失效。`);
bad.forEach((b) => console.log(`  ${b.status}  ${b.url}  ← ${b.used.join(', ')}`));
process.exit(bad.length ? 1 : 0);
