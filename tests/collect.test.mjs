import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import https from 'node:https';
import http from 'node:http';
import tls from 'node:tls';
import os from 'node:os';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { Readable, PassThrough } from 'node:stream';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { collectCandidates, fetchSourceText } from '../scripts/lib/collect.mjs';

const now = new Date('2026-10-22T08:00:00Z');
const rss = (body) => `<rss version="2.0"><channel>${body}</channel></rss>`;
const item = (url, title = 'A model', date = '') => `<item><title>${title}</title><link>${url}</link>${date ? `<pubDate>${date}</pubDate>` : ''}</item>`;
const source = (extra = {}) => ({ id: 'feed', name: 'A feed', kind: 'rss', status: 'ready', url: 'https://example.com/feed', sourceType: 'official', vendor: 'openai', ...extra });
const run = (sources, fetchImpl, extra = {}) => collectCandidates({ registry: { sources }, atlas: { events: [], forecasts: [] }, queue: { schemaVersion: 1, candidates: [], runs: [] }, fetchImpl, now, ...extra });
const response = (text, init) => new Response(text, init);

test('RSS decodes CDATA/entities, normalizes URL and produces only pending excerpt candidates', async () => {
  const { queue, report } = await run([source()], async () => response(rss(item('https://EXAMPLE.com:443/news/a/?utm_source=x&amp;b=2&amp;a=1#top', '<![CDATA[<b>Model</b> &amp; &#x4E2D;&#25991; &quot;A&quot;]]>', 'Thu, 22 Oct 2026 02:00:00 GMT'))));
  assert.equal(queue.candidates.length, 1);
  const c = queue.candidates[0];
  assert.equal(c.canonicalUrl, 'https://example.com/news/a?a=1&b=2');
  assert.equal(c.title, 'Model & 中文 "A"');
  assert.equal(c.publishedAt, '2026-10-22');
  assert.equal(c.discoveredAt, now.toISOString());
  assert.equal(c.lastSeenAt, now.toISOString());
  assert.equal(c.status, 'pending');
  assert.equal(c.suggestedKind, 'unknown');
  assert.equal(c.review, null);
  assert.equal(c.sources[0].sourceType, 'official');
  assert.equal(c.sources[0].feedUrl, 'https://example.com/feed');
  assert.equal(c.sources[0].url, c.canonicalUrl);
  assert.equal('verifiedAt' in c, false);
  assert.equal(report.added, 1);
  assert.equal(queue.runs.length, 1);
});

test('Atom chooses alternate HTML link over self/enclosure and prefers published date', async () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title type="html">Model &lt;b&gt;two&lt;/b&gt;</title><link href="https://example.com/api/entry" rel="self"/><link rel="enclosure" href="https://example.com/audio.mp3"/><link type="text/html" href="/news/two?utm_medium=rss" rel="alternate"/><published>2026-10-19T21:00:00-07:00</published><updated>2026-10-22T00:00:00Z</updated></entry></feed>`;
  const { queue } = await run([source()], async () => response(xml));
  assert.equal(queue.candidates[0].canonicalUrl, 'https://example.com/news/two');
  assert.equal(queue.candidates[0].title, 'Model two');
  assert.equal(queue.candidates[0].publishedAt, '2026-10-19');
});

test('RSS guid fallback respects isPermaLink=false and accepts namespaces / invalid dates safely', async () => {
  const xml = `<rss><channel><item><title>Ignored model</title><guid isPermaLink="false">https://example.com/not-a-link</guid></item><item><title>Good model</title><guid>https://example.com/a</guid><dc:date>nonsense</dc:date></item></channel></rss>`;
  const { queue } = await run([source()], async () => response(xml));
  assert.equal(queue.candidates.length, 1);
  assert.equal(queue.candidates[0].publishedAt, null);
});

test('deduplicates repeat URLs and merges independent source attribution without guessing official', async () => {
  const sources = [source(), source({ id: 'mirror', name: 'Mirror', url: 'https://mirror.example.org/feed', sourceType: undefined, vendor: null })];
  const { queue } = await run(sources, async () => response(rss(item('https://example.com/a#one') + item('https://example.com/a?utm_source=mirror'))));
  assert.equal(queue.candidates.length, 1);
  assert.equal(queue.candidates[0].sources.length, 2);
  assert.equal(queue.candidates[0].sources[1].sourceType, 'aggregator');
});

test('does not mutate inputs or reset reviewed/rejected candidates on rediscovery', async () => {
  const queue = { schemaVersion: 1, candidates: [{ id: 'old', canonicalUrl: 'https://example.com/a', title: 'Reviewed title', discoveredAt: '2026-10-01T00:00:00Z', lastSeenAt: '2026-10-01T00:00:00Z', publishedAt: null, vendor: null, status: 'rejected', sources: [], suggestedKind: 'history', review: { reason: 'Not a release' } }], runs: [] };
  const before = structuredClone(queue);
  const atlas = { events: [], forecasts: [] };
  Object.freeze(atlas);
  const result = await run([source()], async () => response(rss(item('https://example.com/a/'))), { queue, atlas });
  assert.deepEqual(queue, before);
  assert.deepEqual(atlas, { events: [], forecasts: [] });
  const c = result.queue.candidates[0];
  assert.equal(c.id, 'old');
  assert.equal(c.title, 'Reviewed title');
  assert.equal(c.status, 'rejected');
  assert.equal(c.suggestedKind, 'history');
  assert.deepEqual(c.review, { reason: 'Not a release' });
  assert.equal(c.lastSeenAt, now.toISOString());
  assert.equal(c.discoveredAt, before.candidates[0].discoveredAt);
});

test('skips all atlas primary/extra/forecast source URLs after normalization', async () => {
  const atlas = { events: [{ url: 'https://example.com/a', extraSources: [{ url: 'https://example.com/b?utm_campaign=x' }] }], forecasts: [{ sources: [{ url: 'https://example.com/c#x' }] }] };
  const { queue, report } = await run([source()], async () => response(rss(['a/', 'b', 'c', 'd'].map((p) => item(`https://example.com/${p}`)).join(''))), { atlas });
  assert.deepEqual(queue.candidates.map((c) => c.canonicalUrl), ['https://example.com/d']);
  assert.equal(report.skippedExisting, 3);
});

test('web lists require same origin + explicit path prefix, ignore assets/navigation/list page', async () => {
  const s = source({ kind: 'web_list', url: 'https://example.com/news', webList: { allowUrlPrefixes: ['https://example.com/news/'] } });
  const html = `<a href="/news/a">A <b>model</b></a><a href="//evil.org/news/b">bad</a><a href="https://example.com.evil.org/news/c">bad</a><a href="/newsroom/d">bad</a><a href="/news/image.jpg">image</a><a href="/news/tag/ai">tag</a><a href="/news/">list</a><a href="/news/a?utm_source=x">dupe</a>`;
  const { queue } = await run([s], async () => response(html));
  assert.deepEqual(queue.candidates.map((c) => c.canonicalUrl), ['https://example.com/news/a']);
  assert.equal(queue.candidates[0].title, 'A model');
});

test('extracts quoted Qwen/GLM script paths as data without executing scripts', async () => {
  const sources = [source({ id: 'qwen', vendor: 'qwen', kind: 'web_list', url: 'https://qwenlm.github.io/blog/', webList: { allowUrlPrefixes: ['https://qwenlm.github.io/blog/'] } }), source({ id: 'glm', vendor: 'glm', kind: 'web_list', url: 'https://docs.z.ai/release-notes/new-released', webList: { allowUrlPrefixes: ['https://docs.z.ai/release-notes/'] } })];
  globalThis.__collectorExecuted = false;
  const { queue } = await run(sources, async (url) => response(url.includes('qwen') ? `<script>globalThis.__collectorExecuted = true; const pages=["blog/qwen3guard", "\\/blog\\/qwen3-max", "https://evil.org/blog/bad"];</script>` : `<script>self.__next_f.push([1,"{\\"href\\":\\"release-notes/2026-10-20\\"}"]);</script>`));
  assert.equal(globalThis.__collectorExecuted, false);
  delete globalThis.__collectorExecuted;
  assert.deepEqual(queue.candidates.map((c) => c.canonicalUrl).sort(), ['https://docs.z.ai/release-notes/2026-10-20', 'https://qwenlm.github.io/blog/qwen3-max', 'https://qwenlm.github.io/blog/qwen3guard']);
});

test('skips deferred/unsupported/nonselected sources and fails closed without list prefixes', async () => {
  const sources = [source({ id: 'selected' }), source({ id: 'deferred', kind: 'deferred' }), source({ id: 'blocked', status: 'blocked' }), source({ id: 'x', kind: 'x' }), source({ id: 'other' }), source({ id: 'noprefix', kind: 'web_list' })];
  let count = 0;
  const { report } = await run(sources, async () => { count++; return response(rss('')); }, { sourceIds: ['selected', 'deferred', 'blocked', 'x', 'noprefix'] });
  assert.equal(count, 1);
  assert.equal(report.sources.find((s) => s.id === 'noprefix').status, 'skipped');
});

test('weak RSS is supported, source limit applies to unique valid candidates', async () => {
  const { queue } = await run([source({ status: 'weak' })], async () => response(rss(item('https://example.com/a') + item('https://example.com/a#x') + item('javascript:alert(1)') + item('https://example.com/b') + item('https://example.com/c'))), { limitPerSource: 2 });
  assert.deepEqual(queue.candidates.map((c) => c.canonicalUrl), ['https://example.com/a', 'https://example.com/b']);
});

test('preserves old queue on HTTP 403/429 or network failure with no retry', async () => {
  const old = { schemaVersion: 1, candidates: [{ id: 'old', canonicalUrl: 'https://example.com/old', status: 'approved', sources: [], review: { accepted: true } }], runs: [{ id: 'previous' }] };
  const sources = [source({ id: '403' }), source({ id: '429' }), source({ id: 'network' })];
  let count = 0;
  const { queue, report } = await run(sources, async () => { const i = count++; if (i === 2) throw new Error('network unavailable'); return response('', { status: i === 0 ? 403 : 429 }); }, { queue: old });
  assert.equal(count, 3);
  assert.equal(report.failed, 3);
  assert.deepEqual(queue.candidates, old.candidates);
  assert.deepEqual(queue.runs[0], old.runs[0]);
});

test('rejects non-HTTPS, credentials, localhost, private/link-local/mapped addresses before fetch', async () => {
  const urls = ['http://example.com/feed', 'https://u:p@example.com/feed', 'https://localhost/feed', 'https://a.localhost/feed', 'https://127.0.0.1/feed', 'https://2130706433/feed', 'https://10.0.0.1/feed', 'https://172.16.1.1/feed', 'https://192.168.1.1/feed', 'https://169.254.169.254/feed', 'https://[::1]/feed', 'https://[::ffff:127.0.0.1]/feed', 'https://[fc00::1]/feed', 'https://[fe80::1]/feed'];
  let count = 0;
  const { report } = await run(urls.map((url, i) => source({ id: `private-${i}`, url })), async () => { count++; return response(''); });
  assert.equal(count, 0);
  assert.equal(report.failed, urls.length);
});

test('manually validates redirects; private redirects never get requested', async () => {
  const calls = [];
  const { report } = await run([source()], async (url, options) => { calls.push(url); assert.equal(options.redirect, 'manual'); return response('', { status: 302, headers: { location: 'https://127.0.0.1/secret' } }); });
  assert.equal(calls.length, 1);
  assert.equal(report.failed, 1);
});

test('follows bounded safe redirects, and handles missing location / redirect loops as failures', async () => {
  const { queue } = await run([source()], async (url) => url.endsWith('/feed') ? response('', { status: 301, headers: { location: '/real-feed' } }) : response(rss(item('https://example.com/a'))));
  assert.equal(queue.candidates.length, 1);
  let calls = 0;
  const { report } = await run([source()], async () => { calls++; return response('', { status: 302, headers: { location: '/feed' } }); });
  assert.ok(calls <= 6);
  assert.equal(report.failed, 1);
});

test('rejects oversized bodies by content-length and streaming byte count', async () => {
  const sources = [source({ id: 'length' }), source({ id: 'stream' })];
  let i = 0;
  const { report, queue } = await run(sources, async () => i++ === 0 ? response('', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }) : response('x'.repeat(2 * 1024 * 1024 + 1)));
  assert.equal(report.failed, 2);
  assert.equal(queue.candidates.length, 0);
});

test('invalid feed response is a reported failure and preserves existing candidates', async () => {
  const { report } = await run([source()], async () => response('<html>Please sign in</html>'));
  assert.equal(report.failed, 1);
});

test('all requests have a 20-second abort budget including body consumption', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = run([source()], async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })));
  await Promise.resolve();
  t.mock.timers.tick(20_000);
  const { report } = await pending;
  assert.equal(report.failed, 1);
  assert.match(report.sources[0].error, /timeout/i);
});

test('runs no more than three requests concurrently with stable source order', async () => {
  let active = 0;
  let max = 0;
  const sources = Array.from({ length: 7 }, (_, i) => source({ id: `s-${i}`, url: `https://example.com/feed-${i}` }));
  const { report } = await run(sources, async () => { active++; max = Math.max(max, active); await new Promise((resolve) => setImmediate(resolve)); active--; return response(rss('')); });
  assert.equal(max, 3);
  assert.deepEqual(report.sources.map((s) => s.id), sources.map((s) => s.id));
});

test('filters unrelated broad-feed headlines and reports filtered count', async () => {
  const { queue, report } = await run([source({ vendor: null })], async () => response(rss(item('https://example.com/company-picnic', 'Our annual picnic') + item('https://example.com/new-llm', 'A new reasoning model'))));
  assert.equal(queue.candidates.length, 1);
  assert.equal(report.filtered, 1);
});

test('shared transport refuses private/mixed DNS before opening a socket', async (t) => {
  t.mock.method(os, 'platform', () => 'linux');
  t.mock.method(dns, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }]);
  const socket = t.mock.method(https, 'request', () => { throw new Error('must not connect'); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(fetchSourceText('https://public.example.org/feed'), /unsafe_dns/);
  assert.equal(socket.mock.callCount(), 0);
});

test('native HTTPS transport pins audited DNS and preserves hostname TLS verification', async (t) => {
  t.mock.method(os, 'platform', () => 'linux');
  let lookupCalls = 0;
  t.mock.method(dns, 'lookup', async () => { lookupCalls++; return [{ address: '93.184.216.34', family: 4 }]; });
  t.mock.method(https, 'request', (url, options, callback) => {
    assert.equal(url.hostname, 'public.example.org');
    assert.notEqual(options.rejectUnauthorized, false);
    options.lookup('public.example.org', { all: true }, (err, addresses) => {
      assert.equal(err, null);
      assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]);
    });
    const request = new EventEmitter();
    request.end = () => {
      const stream = Readable.from([Buffer.from('public response')]);
      stream.headers = { 'content-type': 'text/plain' };
      stream.statusCode = 200;
      callback(stream);
    };
    return request;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.deepEqual(await fetchSourceText('https://public.example.org/feed'), { text: 'public response', url: 'https://public.example.org/feed', status: 200, contentType: 'text/plain' });
  assert.equal(lookupCalls, 1);
});

test('body streaming also observes the 20-second deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = false;
  const pending = fetchSourceText('https://example.com/feed', { fetchImpl: async () => response(new ReadableStream({ pull: () => new Promise(() => {}), cancel: () => { cancelled = true; } })) });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(20_000);
  await assert.rejects(pending, /timeout/);
  assert.equal(cancelled, true);
});

test('a malformed percent-encoded script slug does not discard valid list candidates', async () => {
  const s = source({ kind: 'web_list', url: 'https://example.com/news', webList: { allowUrlPrefixes: ['https://example.com/news/'] } });
  const { queue, report } = await run([s], async () => response('<a href="/news/gpt">GPT release</a><script>var links=["/news/%FF"]</script>'));
  assert.equal(report.failed, 0);
  assert.equal(queue.candidates[0].canonicalUrl, 'https://example.com/news/gpt');
});

test('publication dates preserve source calendar day consistently and reject impossible RFC dates', async () => {
  const dates = ['2026-10-19T23:00:00-07:00', 'Mon, 19 Oct 2026 23:00:00 -0700', '31 Feb 2026 00:00:00 GMT'];
  const { queue } = await run([source()], async () => response(rss(dates.map((date, i) => item(`https://example.com/model-${i}`, 'Model release', date)).join(''))));
  assert.deepEqual(queue.candidates.map((c) => c.publishedAt), ['2026-10-19', '2026-10-19', null]);
});

test('Atom relative links inherit xml:base from feed, entry and link', async () => {
  const xml = '<feed xml:base="https://example.com/news/"><entry><title>GPT one</title><link href="one" rel="alternate"/></entry><entry xml:base="models/"><title>GPT two</title><link href="two" rel="alternate"/></entry><entry xml:base="models/"><title>GPT three</title><link xml:base="../preview/" href="three" rel="alternate"/></entry></feed>';
  const { queue } = await run([source()], async () => response(xml));
  assert.deepEqual(queue.candidates.map((c) => c.canonicalUrl), ['https://example.com/news/one', 'https://example.com/news/models/two', 'https://example.com/news/preview/three']);
});

function systemProxyMocks(t, { proxy = '127.0.0.1', status = 200, tlsError = false, redirectTo } = {}) {
  const calls = { dns: 0, connect: 0, https: 0, tls: 0 };
  t.mock.method(os, 'platform', () => 'darwin');
  t.mock.method(childProcess, 'execFile', (file, args, options, callback) => {
    assert.equal(file, '/usr/sbin/scutil');
    assert.deepEqual(args, ['--proxy']);
    callback(null, `<dictionary> {\n HTTPSEnable : 1\n HTTPSProxy : ${proxy}\n HTTPSPort : 7890\n}`, '');
  });
  t.mock.method(dns, 'lookup', async () => { calls.dns++; return [{ address: '198.18.0.23', family: 4 }]; });
  t.mock.method(http, 'request', (options, callback) => {
    calls.connect++;
    assert.equal(options.hostname, '127.0.0.1');
    assert.equal(options.port, 7890);
    assert.equal(options.method, 'CONNECT');
    assert.equal(options.path, 'public.example.org:443');
    assert.equal(callback, undefined);
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => req.emit('connect', { statusCode: status }, new PassThrough(), Buffer.alloc(0)));
    return req;
  });
  let tunnel;
  t.mock.method(tls, 'connect', (options) => {
    calls.tls++;
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.servername, 'public.example.org');
    assert.equal(options.host, 'public.example.org');
    assert.ok(options.socket);
    tunnel = new PassThrough();
    tunnel.authorized = !tlsError;
    queueMicrotask(() => tunnel.emit(tlsError ? 'error' : 'secureConnect', ...(tlsError ? [new Error('certificate rejected')] : [])));
    return tunnel;
  });
  t.mock.method(https, 'request', (url, options, callback) => {
    calls.https++;
    assert.equal(url.hostname, 'public.example.org');
    assert.equal(options.agent.createConnection(), tunnel);
    const req = new EventEmitter();
    req.end = () => {
      const res = Readable.from([Buffer.from('secure proxy response')]);
      res.headers = { 'content-type': 'text/plain', ...(redirectTo ? { location: redirectTo } : {}) }; res.statusCode = redirectTo ? 302 : 200; callback(res);
    };
    return req;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return calls;
}

test('macOS enabled loopback HTTPS proxy resolves target through CONNECT without accepting fake DNS', async (t) => {
  const calls = systemProxyMocks(t);
  const result = await fetchSourceText('https://public.example.org/article');
  assert.equal(result.text, 'secure proxy response');
  assert.deepEqual(calls, { dns: 0, connect: 1, https: 1, tls: 1 });
});

test('system proxy never enables private target URLs or untrusted remote proxy endpoints', async (t) => {
  const calls = systemProxyMocks(t, { proxy: '10.0.0.2' });
  await assert.rejects(fetchSourceText('https://127.0.0.1/secret'), /unsafe_url/);
  await assert.rejects(fetchSourceText('https://public.example.org/article'), /system_proxy/);
  assert.equal(calls.connect, 0);
  assert.equal(calls.dns, 0);
});

test('failed proxy CONNECT is reported once without direct-network fallback', async (t) => {
  const calls = systemProxyMocks(t, { status: 403 });
  await assert.rejects(fetchSourceText('https://public.example.org/article'), /proxy.*403/i);
  assert.deepEqual(calls, { dns: 0, connect: 1, https: 0, tls: 0 });
});

test('proxy tunnel still requires a valid target TLS certificate', async (t) => {
  const calls = systemProxyMocks(t, { tlsError: true });
  await assert.rejects(fetchSourceText('https://public.example.org/article'), /certificate/);
  assert.deepEqual(calls, { dns: 0, connect: 1, https: 0, tls: 1 });
});

test('proxy redirects cannot switch to an unapproved public hostname', async (t) => {
  const calls = systemProxyMocks(t, { redirectTo: 'https://private-dns.example.org/secret' });
  await assert.rejects(fetchSourceText('https://public.example.org/article'), /proxy_redirect/);
  assert.equal(calls.connect, 1);
});

test('caller URL policy is applied to every hop before requesting the redirect target', async () => {
  const checked = [];
  let requested = 0;
  await assert.rejects(fetchSourceText('https://example.com/approved/article', {
    validateUrl(url) { checked.push(url); if (!url.startsWith('https://example.com/approved/')) throw Error('outside_source_policy'); },
    fetchImpl: async () => { requested++; return response('', { status: 302, headers: { location: '/unapproved/secret' } }); },
  }), /outside_source_policy/);
  assert.equal(requested, 1);
  assert.deepEqual(checked, ['https://example.com/approved/article', 'https://example.com/unapproved/secret']);
});

test('GLM embedded table of contents is diagnosed as a single-page changelog without invented article paths', async () => {
  // Reduced from the real 2026-10-22 page: dates are JSON section slugs, not article URLs.
  const html = '<main><h1>New Released</h1><h2 id="models">Models</h2></main><a href="/release-notes/new-released">New Released</a><script type="application/json">{"page":{"pagePath":"release-notes/new-released","slug":"/release-notes/new-released"},"mdxExtracts":{"tableOfContents":[{"title":"Models","slug":"models","depth":2},{"title":"2026-08-26","slug":"2026-08-26","depth":1},{"title":"2025-09-30","slug":"2025-09-30","depth":1}]}}</script>';
  const s = source({ id: 'glm-release-notes', vendor: 'glm', kind: 'web_list', url: 'https://docs.z.ai/release-notes/new-released', webList: { allowUrlPrefixes: ['https://docs.z.ai/release-notes/'] } });
  const { queue, report } = await run([s], async () => response(html));
  assert.equal(queue.candidates.length, 0);
  assert.equal(report.sources[0].status, 'empty');
  assert.equal(report.sources[0].reason, 'single_page_changelog');
  assert.equal(report.sources[0].embeddedEntries, 2);
  assert.equal(report.empty, 1);
  assert.equal(report.failed, 0);
  const nonScriptData = html.replace('<script type="application/json">', '<template data-page-json>').replace('</script>', '</template>');
  const second = await run([s], async () => response(nonScriptData));
  assert.equal(second.report.sources[0].reason, 'single_page_changelog');
  assert.equal(second.report.sources[0].embeddedEntries, 2);
});

test('distinguishes reachable empty feeds and filtered lists from HTTP failure', async () => {
  const sources = [source({ id: 'empty', url: 'https://example.com/empty' }), source({ id: 'unrelated', url: 'https://example.com/unrelated' }), source({ id: 'failure', url: 'https://example.com/failure' })];
  const { report } = await run(sources, async (url) => url.endsWith('/empty') ? response(rss('')) : url.endsWith('/unrelated') ? response(rss(item('https://example.com/picnic', 'Annual picnic'))) : response('', { status: 403 }));
  assert.deepEqual(report.sources.map(s => s.status), ['empty', 'empty', 'failed']);
  assert.deepEqual(report.sources.map(s => s.reason || null), ['no_article_entries', 'no_relevant_candidates', null]);
  assert.equal(report.empty, 2);
  assert.equal(report.failed, 1);
});

test('retains only the latest 100 run summaries without mutating the original history', async () => {
  const queue = { schemaVersion: 1, candidates: [], runs: Array.from({ length: 105 }, (_, id) => ({ id })) };
  const result = await run([], async () => { throw Error('no requests expected'); }, { queue });
  assert.equal(queue.runs.length, 105);
  assert.equal(result.queue.runs.length, 100);
  assert.equal(result.queue.runs[0].id, 6);
  assert.deepEqual(result.queue.runs.at(-1), result.report);
});

function compressedNativeMock(t, encoding, data, headers = {}) {
  t.mock.method(os, 'platform', () => 'linux');
  t.mock.method(dns, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]);
  const wire = data instanceof Readable ? data : Readable.from(Array.isArray(data) ? data : [data]);
  t.mock.method(https, 'request', (_url, _options, callback) => {
    const req = new EventEmitter();
    req.end = () => { wire.statusCode = 200; wire.headers = { 'content-type': 'text/xml', 'content-encoding': encoding, ...headers }; callback(wire); };
    return req;
  });
  syncBuiltinESMExports();
  t.after(() => { wire.destroy(); t.mock.restoreAll(); syncBuiltinESMExports(); });
  return wire;
}

for (const [encoding, compress] of [['gzip', gzipSync], ['br', brotliCompressSync], ['deflate', deflateSync]]) {
  test(`native ${encoding} responses decode streamed UTF-8 safely`, async (t) => {
    const expected = rss(item('https://example.com/model', '中文模型发布'));
    const packed = compress(Buffer.from(expected));
    compressedNativeMock(t, encoding, [packed.subarray(0, 3), packed.subarray(3)], { 'content-length': String(packed.length) });
    assert.equal((await fetchSourceText('https://example.com/feed')).text, expected);
  });
}

test('compressed wire bytes exceeding 2 MB fail before entering the decompressor', async (t) => {
  compressedNativeMock(t, 'gzip', Buffer.concat([gzipSync(Buffer.from('small model')), Buffer.alloc(2 * 1024 * 1024)]));
  await assert.rejects(fetchSourceText('https://example.com/feed'), /compressed.*2 MB/);
});

test('a small gzip payload expanding beyond 2 MB is stopped while decoding', async (t) => {
  const packed = gzipSync(Buffer.alloc(2 * 1024 * 1024 + 1, 65));
  assert.ok(packed.length < 10_000);
  compressedNativeMock(t, 'gzip', packed);
  await assert.rejects(fetchSourceText('https://example.com/feed'), /response_too_large/);
});

test('compressed content-length exceeding the limit fails even if the actual body is small', async (t) => {
  compressedNativeMock(t, 'gzip', gzipSync(Buffer.from('small')), { 'content-length': String(2 * 1024 * 1024 + 1) });
  await assert.rejects(fetchSourceText('https://example.com/feed'), /response_too_large/);
});

test('native identity bodies retain the header and streamed byte limits', async (t) => {
  compressedNativeMock(t, 'identity', Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(fetchSourceText('https://example.com/feed'), /response_too_large/);
});

test('buffered oversized native identity headers close the wire response safely', async (t) => {
  const wire = new PassThrough();
  wire.write('already buffered bytes');
  compressedNativeMock(t, 'identity', wire, { 'content-length': String(2 * 1024 * 1024 + 1) });
  await assert.rejects(fetchSourceText('https://example.com/feed'), /response_too_large/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wire.destroyed, true);
});

for (const encoding of ['zstd', '__proto__', 'constructor']) {
  test(`unsupported encoding ${encoding} remains a failure without fallback or alternate request`, async (t) => {
    compressedNativeMock(t, encoding, Buffer.from('not supported'));
    await assert.rejects(fetchSourceText('https://example.com/feed'), /unsupported_content_encoding/);
  });
}

test('buffered unsupported native responses close without a later uncaught stream error', async (t) => {
  const wire = new PassThrough();
  wire.write('already buffered bytes');
  compressedNativeMock(t, 'zstd', wire);
  await assert.rejects(fetchSourceText('https://example.com/feed'), /unsupported_content_encoding/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wire.destroyed, true);
});

test('truncated gzip is rejected instead of returning partially decoded evidence', async (t) => {
  const packed = gzipSync(Buffer.from('Evidence must be complete.'));
  compressedNativeMock(t, 'gzip', packed.subarray(0, packed.length - 4));
  await assert.rejects(fetchSourceText('https://example.com/feed'), /unexpected end|decompress/i);
});

test('20-second deadline cancels an unfinished compressed stream and destroys its wire source', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const wire = new PassThrough();
  compressedNativeMock(t, 'gzip', wire);
  wire.write(gzipSync(Buffer.from('partial model')).subarray(0, 12));
  const pending = fetchSourceText('https://example.com/feed');
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(20_000);
  await assert.rejects(pending, /timeout/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wire.destroyed, true);
});
