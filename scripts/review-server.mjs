import http from 'node:http';
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { applyDecision, articleText, candidateRevision, hash, policyHash, sourceFor } from './lib/review.mjs';
import { fetchSourceText } from './lib/collect.mjs';
import { sortReviewCandidates } from './lib/review-order.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
export function createReviewServer({ root = project, execute = run, fetchText = fetchSourceText } = {}) {
  const token = randomBytes(32).toString('hex');
  let state, actor, busy = false;
  const submitted = new Set();
  const command = (bin, args) => execute(bin, args, { cwd: root, timeout: 30_000, maxBuffer: 20 * 1024 * 1024 });
  const read = async path => JSON.parse(await fs.readFile(`${root}/${path}`, 'utf8'));
  const load = async () => {
    const [queue, atlas, registry, site] = await Promise.all(['review/queue.json', 'public/data/atlas.json', 'public/data/sources.json', 'public/data/site.json'].map(read));
    if (!/^https:\/\/github\.com\/[\w-]+\/[\w.-]+$/.test(site.repo)) throw new Error('仓库地址无效');
    return { queue, atlas, registry, repo: site.repo.slice('https://github.com/'.length) };
  };
  const getActor = async () => actor ||= (await command('gh', ['api', 'user', '--jq', '.login'])).stdout.trim();
  const sync = async () => {
    state ||= await load();
    // Read one remote commit consistently without touching the user's working tree.
    await command('git', ['fetch', 'origin', 'main']);
    const revision = (await command('git', ['rev-parse', 'origin/main'])).stdout.trim();
    const paths = [['queue', 'review/queue.json'], ['atlas', 'public/data/atlas.json'], ['registry', 'public/data/sources.json']];
    const entries = await Promise.all(paths.map(async ([key, path]) => [key, JSON.parse((await command('git', ['show', `${revision}:${path}`])).stdout)]));
    state = { ...state, ...Object.fromEntries(entries) };
    submitted.clear();
  };
  const server = http.createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    try {
      if (req.headers.host !== origin.slice(7) || req.headers.origin && req.headers.origin !== origin) return json(403, { error: '只允许本机审核页面访问' });
      if (req.method === 'GET') {
        if (req.url === '/api/state') {
          state ||= await load();
          return json(200, { ...state, csrf: token, actor: await getActor(), policyHash: policyHash(state.registry), candidates: sortReviewCandidates(state.queue.candidates, state.registry).map(c => ({ ...c, revision: candidateRevision(c), submitted: submitted.has(c.id) })), records: [...state.atlas.events, ...state.atlas.forecasts].map(r => ({ ...r, baseHash: hash(r) })) });
        }
        const file = { '/': ['review/index.html', 'text/html'], '/app.js': ['review/app.js', 'text/javascript'] }[req.url];
        if (!file) return json(404, { error: 'Not found' });
        res.writeHead(200, { 'Content-Type': file[1] + '; charset=utf-8' });
        return res.end(await fs.readFile(`${root}/${file[0]}`));
      }
      if (req.method !== 'POST' || req.headers.origin !== origin || req.headers['x-review-token'] !== token || !req.headers['content-type']?.startsWith('application/json')) return json(403, { error: '审核请求未授权' });
      if (busy) return json(409, { error: '正在处理上一项操作' });
      busy = true;
      try {
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 60_000) return json(413, { error: '请求过大' }); }
        const body = JSON.parse(raw);
        state ||= await load();
        if (req.url === '/api/sync') { await sync(); return json(200, { ok: true }); }
        if (req.url === '/api/evidence') {
          sourceFor(state.registry, body.registryId, body.url);
          const fetched = await fetchText(body.url, { validateUrl: url => sourceFor(state.registry, body.registryId, url) });
          sourceFor(state.registry, body.registryId, fetched.url);
          const text = articleText(fetched.text);
          if (text.length < 80) throw new Error('原文正文不足，保留待审核');
          return json(200, { url: fetched.url, text, contentHash: hash(text), fetchedAt: new Date().toISOString() });
        }
        if (req.url === '/api/decision') {
          if (submitted.has(body.candidateId)) throw new Error('已提交，请等待工作流完成后同步');
          let evidence;
          if (body.action === 'publish') {
            sourceFor(state.registry, body.evidence.registryId, body.evidence.url);
            const fetched = await fetchText(body.evidence.url, { validateUrl: url => sourceFor(state.registry, body.evidence.registryId, url) });
            evidence = { url: fetched.url, text: articleText(fetched.text) };
          }
          applyDecision({ ...state, decision: body, evidence, actor: await getActor() });
          // execFile passes arguments directly; untrusted titles and excerpts never enter a shell.
          await command('gh', ['workflow', 'run', 'review.yml', '--repo', state.repo, '--ref', 'main', '-f', `decision=${JSON.stringify(body)}`]);
          submitted.add(body.candidateId);
          return json(200, { submitted: true, url: `https://github.com/${state.repo}/actions/workflows/review.yml` });
        }
        return json(404, { error: 'Not found' });
      } finally { busy = false; }
    } catch (error) { return json(400, { error: error.message.slice(0, 1000) }); }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.REVIEW_PORT || 8787);
  const server = createReviewServer();
  server.listen(port, '127.0.0.1', () => console.log(`审核入口：http://127.0.0.1:${server.address().port}\n点击“同步待审核”，核对原文后提交。GitHub Actions 校验通过才会更新网站。`));
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
}
