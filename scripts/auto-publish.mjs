import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { autoReviewCandidates } from './lib/auto-publish.mjs';

const root = new URL('../', import.meta.url);
const read = path => JSON.parse(fs.readFileSync(new URL(path, root), 'utf8'));
const dryRun = process.argv.includes('--dry-run');
const atlas = read('public/data/atlas.json');
const result = await autoReviewCandidates({ queue: read('review/queue.json'), atlas, registry: read('public/data/sources.json'), maxCandidates: Number(process.env.AUTO_REVIEW_LIMIT || 24) });
const draft = new URL('review/atlas-auto-draft.json', root);
try {
  fs.writeFileSync(draft, JSON.stringify(result.atlas, null, 2) + '\n');
  const checked = spawnSync(process.execPath, ['scripts/validate.mjs'], { cwd: root, env: { ...process.env, ATLAS_FILE: draft.pathname }, stdio: 'inherit' });
  if (checked.status !== 0) throw new Error('自动核验结果未通过数据校验，正式数据没有修改');
  if (!dryRun) {
    if (result.report.published) fs.renameSync(draft, new URL('public/data/atlas.json', root));
    fs.writeFileSync(new URL('review/queue.json.tmp', root), JSON.stringify(result.queue, null, 2) + '\n');
    fs.renameSync(new URL('review/queue.json.tmp', root), new URL('review/queue.json', root));
  }
} finally { fs.rmSync(draft, { force: true }); }
const published = !dryRun && result.report.published > 0;
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `published=${published}\n`);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n## 官网自动核验\n读取 ${result.report.checked} 条官网线索，通过 ${result.report.published} 条，已收录 ${result.report.duplicates} 条，需人工核对 ${result.report.needsReview} 条，抓取失败 ${result.report.failed} 条。未来预测和不确定信息不会自动发布。\n`);
const added = result.atlas.events.filter(e => !atlas.events.some(old => old.id === e.id));
console.log(JSON.stringify({ dryRun, ...result.report, releases: added.map(e => ({ name: e.name, date: e.date, kind: e.kind, url: e.url, evidence: e.pipelineReview.quotes, dateBasis: e.pipelineReview.dateBasis })) }, null, 2));
