import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { applyDecision, articleText, sourceFor } from './lib/review.mjs';
import { fetchSourceText } from './lib/collect.mjs';

const root = new URL('../', import.meta.url);
const read = path => JSON.parse(fs.readFileSync(new URL(path, root), 'utf8'));
const raw = process.env.REVIEW_DECISION || '';
if (!raw || Buffer.byteLength(raw) > 60_000) throw new Error('审核请求缺失或过大；请使用 npm run review 的审核入口');
if (process.env.GITHUB_REF !== 'refs/heads/main' || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch') throw new Error('发布仅接受 main 上由仓库维护者手动触发的审核工作流');
const decision = JSON.parse(raw);
const registry = read('public/data/sources.json');
let evidence;
if (decision.action === 'publish') {
  sourceFor(registry, decision.evidence.registryId, decision.evidence.url);
  const response = await fetchSourceText(decision.evidence.url, { validateUrl: url => sourceFor(registry, decision.evidence.registryId, url) });
  evidence = { url: response.url, text: articleText(response.text) };
}
const result = applyDecision({ queue: read('review/queue.json'), atlas: read('public/data/atlas.json'), registry, decision, evidence, actor: process.env.GITHUB_ACTOR });
// Validate the proposed atlas before changing either durable file.
const draft = new URL('review/atlas-draft.json', root);
try {
  fs.writeFileSync(draft, JSON.stringify(result.atlas, null, 2) + '\n');
  const checked = spawnSync(process.execPath, ['scripts/validate.mjs'], { cwd: root, env: { ...process.env, ATLAS_FILE: draft.pathname }, stdio: 'inherit' });
  if (checked.status !== 0) throw new Error('拟发布数据校验失败，没有写入正式数据');
  if (result.published) fs.renameSync(draft, new URL('public/data/atlas.json', root));
  fs.writeFileSync(new URL('review/queue.json.tmp', root), JSON.stringify(result.queue, null, 2) + '\n');
  fs.renameSync(new URL('review/queue.json.tmp', root), new URL('review/queue.json', root));
} finally { fs.rmSync(draft, { force: true }); }
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `published=${result.published}\n`);
console.log(result.published ? '核验通过；等待提交和部署。' : '审核状态已更新；正式数据没有变化。');
