import fs from 'node:fs';
import { collectCandidates } from './lib/collect.mjs';
const root = new URL('../', import.meta.url);
const read = path => JSON.parse(fs.readFileSync(new URL(path, root), 'utf8'));
const result = await collectCandidates({ registry: read('public/data/sources.json'), atlas: read('public/data/atlas.json'), queue: read('review/queue.json') });
const path = new URL('review/queue.json', root);
fs.writeFileSync(new URL('review/queue.json.tmp', root), JSON.stringify(result.queue, null, 2) + '\n');
fs.renameSync(new URL('review/queue.json.tmp', root), path);
console.log(JSON.stringify(result.report, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## 采集结果\n新增 ${result.report.added} 条候选，失败 ${result.report.failed} 个入口。全部保持待审核，正式数据未修改。\n\n|入口|状态|\n|---|---|\n` + result.report.sources.map(s => `|${String(s.id || s.sourceId || '').replaceAll('|', '')}|${s.status}|`).join('\n'));
}
// Persist failure details too; the workflow reports an outage after committing the queue.
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `outage=${result.report.sources.every(s => !['ok', 'empty'].includes(s.status))}\n`);
