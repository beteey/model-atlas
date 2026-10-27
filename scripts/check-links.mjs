// 仅检查 HTTP 可访问性；访问受限或暂时失败不等于来源失效，脚本不改数据。
import fs from 'node:fs';
import { probeLink } from './lib/link-check.mjs';

const atlas = JSON.parse(fs.readFileSync(new URL('../public/data/atlas.json', import.meta.url), 'utf8'));
const watch = JSON.parse(fs.readFileSync(new URL('../public/data/watchlist.json', import.meta.url), 'utf8'));

const urls = new Map();
const add = (u, where) => { if (u) urls.set(u, [...(urls.get(u) || []), where]); };
atlas.events.forEach((e) => { add(e.url, e.id); (e.extraSources || []).forEach((x) => add(x.url, e.id)); });
atlas.forecasts.forEach((x) => x.sources.forEach((s) => add(s.url, x.id)));
watch.accounts.forEach((a) => (a.trackRecord || []).forEach((r) => { add(r.claimUrl, a.id); add(r.evidenceUrl, a.id); }));

const bad = [];
const counts = { checked: 0, available: 0, broken: 0, blocked: 0, unknown: 0 };
const labels = { available: 'HTTP 可访问', broken: '疑似失效', blocked: '访问受限', unknown: '暂无法判断' };
const list = [...urls.keys()];
for (let i = 0; i < list.length; i += 6) {
  const batch = list.slice(i, i + 6);
  const res = await Promise.all(batch.map(url => probeLink(url)));
  batch.forEach((u, j) => {
    const { status, category } = res[j];
    counts.checked++; counts[category]++;
    console.log(`${category === 'available' ? '✓' : category === 'broken' ? '✗' : '?'} ${status}  ${u}  [${labels[category]}]`);
    if (category === 'broken') bad.push({ url: u, status, used: urls.get(u) });
  });
}
console.log(`\n共 ${counts.checked} 个链接，${counts.available} 个 HTTP 可访问，${counts.broken} 个疑似失效，${counts.blocked} 个访问受限，${counts.unknown} 个暂无法判断。`);
bad.forEach((b) => console.log(`  ${b.status}  ${b.url}  ← ${b.used.join(', ')}`));
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(counts).map(([key, value]) => `${key}=${value}\n`).join(''));
process.exitCode = bad.length ? 1 : 0;
