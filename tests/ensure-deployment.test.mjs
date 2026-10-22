import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDeployment } from '../scripts/ensure-deployment.mjs';

const root = '/test/model-atlas';
const repo = 'beteey/model-atlas';
const local = 'a'.repeat(40), older = 'b'.repeat(40);
const head = '1'.repeat(40), previousHead = '2'.repeat(40);
const run = (status = 'completed', conclusion = 'success', headSha = head) => ({ status, conclusion, headSha, url: `https://github.com/${repo}/actions/runs/123`, event: 'workflow_dispatch' });

function fixture({ runs = [], blobs = {}, gitHash = local, fail } = {}) {
  const calls = [];
  const execute = async (command, args, options) => {
    calls.push({ command, args, options });
    assert.equal(options.cwd, root);
    if (fail?.(command, args)) throw new Error('GitHub unavailable');
    if (command === 'git') {
      assert.deepEqual(args, ['hash-object', 'public/data/atlas.json']);
      return { stdout: `${gitHash}\n` };
    }
    assert.equal(command, 'gh');
    if (args[0] === 'run') {
      assert.ok(args.includes('deploy.yml'));
      assert.equal(args[args.indexOf('--repo') + 1], repo);
      assert.equal(args[args.indexOf('--branch') + 1], 'main');
      return { stdout: JSON.stringify(runs) };
    }
    if (args[0] === 'api') {
      assert.deepEqual(args.slice(2), ['--jq', '.sha']);
      const sha = args[1].split('?ref=')[1];
      assert.equal(args[1], `repos/${repo}/contents/public/data/atlas.json?ref=${sha}`);
      if (!(sha in blobs)) throw new Error('Missing test blob');
      return { stdout: `${blobs[sha]}\n` };
    }
    assert.deepEqual(args, ['workflow', 'run', 'deploy.yml', '--repo', repo, '--ref', 'main']);
    return { stdout: '' };
  };
  const invoke = extra => ensureDeployment({ root, repo, execute, ...extra });
  const dispatched = () => calls.filter(c => c.args[0] === 'workflow').length;
  return { calls, invoke, dispatched };
}

test('already deployed atlas content skips dispatch even when commit history differs', async () => {
  const f = fixture({ runs: [run()], blobs: { [head]: local } });
  assert.equal((await f.invoke()).status, 'current');
  assert.equal(f.dispatched(), 0);
});

test('changed atlas content dispatches deployment', async () => {
  const f = fixture({ runs: [run()], blobs: { [head]: older } });
  assert.equal((await f.invoke()).status, 'dispatched');
  assert.equal(f.dispatched(), 1);
});

for (const status of ['queued', 'in_progress', 'waiting']) {
  test(`${status} deployment of matching content skips a duplicate dispatch`, async () => {
    const f = fixture({ runs: [run(status, null), run('completed', 'success', previousHead)], blobs: { [head]: local, [previousHead]: older } });
    assert.equal((await f.invoke()).status, 'pending');
    assert.equal(f.dispatched(), 0);
  });
}

test('a pending deployment of different content does not suppress the required deployment', async () => {
  const f = fixture({ runs: [run('queued', null)], blobs: { [head]: older } });
  assert.equal((await f.invoke()).status, 'dispatched');
  assert.equal(f.dispatched(), 1);
});

test('a failed previous attempt is retried even without another model publication', async () => {
  const f = fixture({ runs: [run('completed', 'failure'), run('completed', 'success', previousHead)], blobs: { [previousHead]: older } });
  assert.equal((await f.invoke()).status, 'dispatched');
  assert.equal(f.dispatched(), 1);
});

test('a cancelled pending deployment is retried on the next invocation', async () => {
  const f = fixture({ runs: [run('completed', 'cancelled')] });
  assert.equal((await f.invoke()).status, 'dispatched');
  assert.equal(f.dispatched(), 1);
});

test('only the latest successful deployment determines current content', async () => {
  const f = fixture({ runs: [run(), run('completed', 'success', previousHead)], blobs: { [head]: older, [previousHead]: local } });
  assert.equal((await f.invoke()).status, 'dispatched');
  assert.equal(f.dispatched(), 1);
});

test('an empty workflow history requires deployment', async () => {
  const f = fixture();
  assert.equal((await f.invoke()).status, 'dispatched');
  assert.equal(f.dispatched(), 1);
});

test('successful pull request validation does not count as production deployment', async () => {
  const f = fixture({ runs: [{ ...run(), event: 'pull_request' }] });
  assert.equal((await f.invoke()).status, 'dispatched');
  assert.equal(f.dispatched(), 1);
});

for (const operation of ['run', 'api']) {
  test(`a failed GitHub ${operation} read cannot dispatch or claim success`, async () => {
    const f = fixture({ runs: [run()], fail: (command, args) => command === 'gh' && args[0] === operation });
    await assert.rejects(f.invoke(), /GitHub unavailable/);
    assert.equal(f.dispatched(), 0);
  });
}

test('a failed pending-run content lookup also prevents dispatch', async () => {
  const f = fixture({ runs: [run('waiting', null)], fail: (command, args) => command === 'gh' && args[0] === 'api' });
  await assert.rejects(f.invoke(), /GitHub unavailable/);
  assert.equal(f.dispatched(), 0);
});

test('malformed GitHub run data fails closed', async () => {
  for (const runs of [{}, [{ ...run(), headSha: '../main' }], [{ ...run(), status: 'unknown' }]]) {
    const f = fixture({ runs });
    await assert.rejects(f.invoke(), /运行|SHA|状态/);
    assert.equal(f.dispatched(), 0);
  }
});

test('invalid local and remote object hashes fail closed', async () => {
  for (const settings of [{ gitHash: '--bad' }, { runs: [run()], blobs: { [head]: 'not-found' } }]) {
    const f = fixture(settings);
    await assert.rejects(f.invoke(), /SHA/);
    assert.equal(f.dispatched(), 0);
  }
});

test('invalid repository input is rejected before any command runs', async () => {
  for (const value of ['-option/repo', 'owner/../repo', 'owner/repo?ref=evil', 'https://github.com.evil.test/owner/repo', 'https://user@github.com/owner/repo', 'owner/repo;touch x']) {
    const f = fixture();
    await assert.rejects(f.invoke({ repo: value }), /仓库/);
    assert.equal(f.calls.length, 0);
  }
});

test('the GitHub repository URL is read from site.json when repo is omitted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-deployment-test-'));
  try {
    await mkdir(join(directory, 'public', 'data'), { recursive: true });
    await writeFile(join(directory, 'public', 'data', 'site.json'), JSON.stringify({ repo: `https://github.com/${repo}` }));
    const commands = [];
    const result = await ensureDeployment({ root: directory, execute: async (command, args, options) => {
      assert.equal(options.cwd, directory);
      commands.push([command, args]);
      return { stdout: command === 'git' ? local : args[0] === 'run' ? '[]' : '' };
    } });
    assert.equal(result.status, 'dispatched');
    assert.ok(commands.filter(([command]) => command === 'gh').every(([, args]) => args[args.indexOf('--repo') + 1] === repo));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
