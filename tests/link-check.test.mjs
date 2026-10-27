import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyStatus, probeLink } from '../scripts/lib/link-check.mjs';

const root = new URL('../', import.meta.url);
function runCheck(fetchSource, env = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `globalThis.fetch = ${fetchSource}; await import('./scripts/check-links.mjs');`], {
    cwd: root, env: { ...process.env, GITHUB_OUTPUT: '', ...env }, encoding: 'utf8', timeout: 10_000,
  });
}

test('a paywall must not fail the link check or claim the source has vanished', () => {
  const result = runCheck('async () => new Response("Payment required", { status: 402 })');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /0 个疑似失效/);
  assert.match(result.stdout, /访问受限/);
});

test('known network failures remain indeterminate instead of becoming dead links', () => {
  const result = runCheck('async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("connection reset"), { code: "ECONNRESET" }) }); }');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /0 个疑似失效/);
  assert.match(result.stdout, /暂无法判断/);
});

test('404 remains a suspected dead link even when its body mentions a subscription', () => {
  const result = runCheck('async () => new Response("Subscribe for more news", { status: 404 })');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /✗ 404/);
});

test('unexpected implementation errors fail without describing them as broken sources', () => {
  const result = runCheck('async () => { throw new Error("implementation regression"); }');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /implementation regression/);
  assert.doesNotMatch(result.stdout, /疑似失效/);
});

test('machine-readable counts distinguish access restrictions from confirmed HTTP failures', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-link-output-'));
  const output = path.join(dir, 'output');
  try {
    const result = runCheck('async () => new Response(null, { status: 402 })', { GITHUB_OUTPUT: output });
    assert.equal(result.status, 0);
    const counts = Object.fromEntries(fs.readFileSync(output, 'utf8').trim().split('\n').map(line => line.split('=')));
    assert.ok(Number(counts.checked) > 0);
    assert.equal(counts.broken, '0');
    assert.equal(counts.blocked, counts.checked);
    assert.equal(counts.unknown, '0');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('HTTP classes use explicit response semantics instead of a blanket error threshold', () => {
  for (const status of [200, 204, 206, 299]) assert.equal(classifyStatus(status), 'available');
  for (const status of [404, 410]) assert.equal(classifyStatus(status), 'broken');
  for (const status of [401, 402, 403, 407, 423, 429, 451]) assert.equal(classifyStatus(status), 'blocked');
  for (const status of [100, 301, 302, 304, 400, 408, 418, 425, 500, 502, 503, 504, 599]) assert.equal(classifyStatus(status), 'unknown');
  for (const status of [0, 99, 600, NaN, '404', null, undefined]) assert.throws(() => classifyStatus(status), /Invalid HTTP status/);
});

test('status-only probes cancel bodies and never interpret subscription wording as proof', async () => {
  let canceled = false;
  const result = await probeLink('https://example.com/article', { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://example.com/article');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'follow');
    return { status: 410, body: { cancel: async () => { canceled = true; } } };
  } });
  assert.deepEqual(result, { status: 410, category: 'broken' });
  assert.equal(canceled, true);
  assert.deepEqual(await probeLink('https://example.com/article', { fetchImpl: async () => new Response(null, { status: 204 }) }), { status: 204, category: 'available' });
});

test('an aborted probe is indeterminate and releases its deadline', async () => {
  const result = await probeLink('https://example.com/article', { timeoutMs: 5, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  assert.deepEqual(result, { status: 'timeout', category: 'unknown' });
  for (const name of ['AbortError', 'TimeoutError']) {
    assert.deepEqual(await probeLink('https://example.com/article', { fetchImpl: async () => { throw new DOMException('Timeout', name); } }), { status: 'timeout', category: 'unknown' });
  }
});

test('invalid inputs and implementation faults are not hidden as source outages', async () => {
  for (const url of ['not-a-url', 'file:///tmp/private', 'https://user:password@example.com/article']) await assert.rejects(probeLink(url), TypeError);
  for (const timeoutMs of [0, -1, NaN, Infinity, 60_001]) await assert.rejects(probeLink('https://example.com/article', { timeoutMs }), /Invalid link probe options/);
  await assert.rejects(probeLink('https://example.com/article', { fetchImpl: null }), /Invalid link probe options/);
  await assert.rejects(probeLink('https://example.com/article', { fetchImpl: async () => ({ status: '404' }) }), /Invalid HTTP status/);
  await assert.rejects(probeLink('https://example.com/article', { fetchImpl: async () => { throw new TypeError('Cannot read properties of undefined'); } }), /Cannot read properties/);
});

test('ordinary fetch transport failures remain unknown and do not lose unrelated exceptions', async () => {
  assert.deepEqual(await probeLink('https://example.com/article', { fetchImpl: async () => { throw new TypeError('fetch failed'); } }), { status: 'network-error', category: 'unknown' });
  await assert.rejects(probeLink('https://example.com/article', { fetchImpl: async () => { throw new Error('program bug'); } }), /program bug/);
});
