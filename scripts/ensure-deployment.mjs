import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const pending = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);

function repository(value) {
  if (typeof value !== 'string') throw new Error('缺少有效 GitHub 仓库');
  let slug = value;
  if (value.startsWith('https://')) {
    const url = new URL(value);
    if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash) throw new Error('仓库必须是 github.com 上的无凭据地址');
    slug = url.pathname.slice(1).replace(/\/$/, '');
  }
  if (!/^[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]+$/i.test(slug) || ['.', '..'].includes(slug.split('/')[1])) throw new Error('仓库必须是合法的 owner/repo');
  return slug;
}

function objectHash(value) {
  if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value)) throw new Error('Git 或 GitHub 返回了无效 SHA');
  return value.toLowerCase();
}

/** Retry unpublished atlas content after a failed dispatch or deployment. */
export async function ensureDeployment({ execute = executeFile, root = projectRoot, repo } = {}) {
  const directory = root instanceof URL && root.protocol === 'file:' ? fileURLToPath(root) : root;
  if (typeof directory !== 'string' || !isAbsolute(directory) || typeof execute !== 'function') throw new Error('部署检查需要绝对项目路径和命令执行器');
  const target = repository(repo === undefined ? JSON.parse(await readFile(join(directory, 'public/data/site.json'), 'utf8')).repo : repo);
  const command = async (file, args) => {
    const result = await execute(file, args, { cwd: directory, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    const stdout = typeof result === 'string' ? result : result?.stdout;
    if (typeof stdout !== 'string') throw new Error(`${file} 未返回可读取的命令结果`);
    return stdout.trim();
  };
  const atlasHash = objectHash(await command('git', ['hash-object', 'public/data/atlas.json']));
  const raw = await command('gh', ['run', 'list', '--repo', target, '--workflow', 'deploy.yml', '--branch', 'main', '--limit', '20', '--json', 'status,conclusion,headSha,url,event']);
  let runs;
  try { runs = JSON.parse(raw); } catch { throw new Error('GitHub 部署运行列表不是有效 JSON'); }
  if (!Array.isArray(runs)) throw new Error('GitHub 部署运行列表无效');
  for (const run of runs) {
    if (!run || typeof run !== 'object' || (!pending.has(run.status) && run.status !== 'completed')) throw new Error('GitHub 部署运行状态无效');
    run.headSha = objectHash(run.headSha);
    if (run.conclusion !== null && typeof run.conclusion !== 'string') throw new Error('GitHub 部署运行结论无效');
  }
  // A successful pull_request run only validates; deploy.yml skips its deploy job.
  const deployments = runs.filter(run => !run.event || ['push', 'workflow_dispatch'].includes(run.event));
  const blobs = new Map();
  const contentAt = async sha => {
    if (!blobs.has(sha)) blobs.set(sha, objectHash(await command('gh', ['api', `repos/${target}/contents/public/data/atlas.json?ref=${sha}`, '--jq', '.sha'])));
    return blobs.get(sha);
  };
  // gh lists newest first. An older matching success cannot override a newer deployment.
  const successful = deployments.find(run => run.status === 'completed' && run.conclusion === 'success');
  if (successful && await contentAt(successful.headSha) === atlasHash) return { status: 'current', atlasHash };
  for (const run of deployments.filter(run => pending.has(run.status))) {
    if (await contentAt(run.headSha) === atlasHash) return { status: 'pending', atlasHash };
  }
  await command('gh', ['workflow', 'run', 'deploy.yml', '--repo', target, '--ref', 'main']);
  return { status: 'dispatched', atlasHash };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 2) throw new Error('部署检查不接受命令行参数；仓库从 site.json 读取');
    console.log(JSON.stringify(await ensureDeployment(), null, 2));
  } catch (error) {
    console.error(`部署检查失败，将在下轮重试：${error.message}`);
    process.exitCode = 1;
  }
}
