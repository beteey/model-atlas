import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request, Agent } from 'node:https';
import { request as httpRequest } from 'node:http';
import { connect as tlsConnect } from 'node:tls';
import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createBrotliDecompress, createInflate } from 'node:zlib';

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const CONCURRENCY = 3;
const MAX_REDIRECTS = 5;
const MAX_RUN_SUMMARIES = 100;
const CONTENT_DECODERS = new Map([['gzip', createGunzip], ['br', createBrotliDecompress], ['deflate', createInflate]]);
const UA = 'model-atlas-collector/1.0 (+https://github.com/beteey/model-atlas; candidate discovery only)';
const SOURCE_TYPES = new Set(['official', 'paper', 'press_release', 'media', 'vendor_community', 'community', 'aggregator']);
const MODEL_WORDS = /model|llm\b|gpt|chatgpt|openai|claude|anthropic|gemini|deepmind|deepseek|qwen|kimi|moonshot|glm|z[.\s-]?ai\b|grok|xai|llama|mistral|minimax|muse\s?spark|模型|发布|预览|release|launch|preview|introduc|announc/i;
const ASSET = /\.(?:png|jpe?g|gif|svg|webp|ico|css|js|mjs|woff2?|ttf|map|mp[34]|zip|xml|json|pdf)$/i;
const NAVIGATION = /\/(?:tags?|categor(?:y|ies)|authors?|page|search|login|signin|feeds?)(?:\/|$)/i;

function publicAddress(address) {
  const ip = address.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  // Accept global-unicast IPv6 only; mapped/translated/tunnel/documentation ranges fail closed.
  return isIP(ip) === 6 && /^[23][0-9a-f]{3}:/.test(ip) &&
    !/^(?:2001:(?:0:|db8:|10:|20:)|2002:)/.test(ip);
}

function safeUrl(raw, base) {
  const url = new URL(raw, base);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('unsafe_url: HTTPS without credentials on port 443 required');
  }
  if (isIP(host) ? !publicAddress(host) : (!host.includes('.') || /(?:^|\.)(?:localhost|local|internal|lan|home)$/.test(host))) {
    throw new Error('unsafe_url: localhost or non-public address');
  }
  url.hash = '';
  return url;
}

function canonicalize(raw, base) {
  try {
    const url = safeUrl(decodeEntities(raw).trim(), base);
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key) || /^(?:fbclid|gclid|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.href;
  } catch { return null; }
}

function requestResponse(url, options, connection) {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'GET', headers: options.headers, signal: options.signal, ...connection,
    }, (res) => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      resolve({ status: res.statusCode, headers, nativeBody: res, url: url.href });
    });
    req.on('error', reject);
    req.end();
  });
}

async function nativeResponse(url, options) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true });
  options.signal.throwIfAborted();
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw new Error('unsafe_dns: non-public DNS address');
  const pinned = addresses[0];
  return requestResponse(url, options, {
    // Pin the validated address, preserving the URL hostname for Host, SNI and certificate checks.
    lookup: (_hostname, opts, callback) => opts?.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family),
  });
}

async function systemHttpsProxy(signal) {
  if (platform() !== 'darwin') return null;
  const settings = await new Promise((resolve, reject) => {
    execFile('/usr/sbin/scutil', ['--proxy'], { timeout: 2000, maxBuffer: 16_384, signal }, (error, stdout) => {
      if (error) reject(new Error('system_proxy_unavailable: cannot read macOS proxy settings'));
      else resolve(stdout);
    });
  });
  signal.throwIfAborted();
  const value = key => settings.match(new RegExp(`^\\s*${key}\\s*:\\s*(.*?)\\s*$`, 'm'))?.[1];
  if (value('HTTPSEnable') !== '1') return null;
  const hostname = value('HTTPSProxy');
  const port = Number(value('HTTPSPort'));
  if (!['127.0.0.1', '::1', 'localhost'].includes(hostname) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('unsupported_system_proxy: only an explicitly enabled loopback HTTPS proxy is trusted');
  }
  return { hostname: hostname === 'localhost' ? '127.0.0.1' : hostname, port };
}

function proxyTunnel(url, proxy, signal) {
  return new Promise((resolve, reject) => {
    const authority = `${url.hostname}:443`;
    const req = httpRequest({ hostname: proxy.hostname, port: proxy.port, method: 'CONNECT', path: authority, headers: { Host: authority }, signal });
    req.on('error', reject);
    req.on('response', res => { res.resume(); reject(new Error(`proxy_connect_failed: HTTP ${res.statusCode}`)); });
    req.on('connect', (res, socket, head) => {
      if (res.statusCode !== 200) { socket.destroy(); reject(new Error(`proxy_connect_failed: HTTP ${res.statusCode}`)); return; }
      if (signal.aborted) { socket.destroy(); reject(signal.reason); return; }
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    req.end();
  });
}

async function proxyResponse(url, options, proxy) {
  const socket = await proxyTunnel(url, proxy, options.signal);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let secure;
  try {
    secure = await new Promise((resolve, reject) => {
      const connected = tlsConnect({ socket, host, servername: isIP(host) ? undefined : host, rejectUnauthorized: true, signal: options.signal });
      connected.once('error', reject);
      connected.once('secureConnect', () => {
        if (!connected.authorized) { connected.destroy(); reject(new Error('proxy_tls_certificate_rejected')); return; }
        resolve(connected);
      });
    });
    const agent = new Agent({ keepAlive: false });
    // The tunnel is already authenticated against the target hostname, never against the proxy.
    agent.createConnection = () => secure;
    return await requestResponse(url, options, { agent });
  } catch (error) {
    secure?.destroy();
    socket.destroy();
    throw error;
  }
}

async function cancelBody(response) {
  if (response.nativeBody) { response.nativeBody.destroy(); return; }
  try { await response.body?.cancel(); } catch { /* Stream may already be locked/closed. */ }
}

async function boundedText(response, signal) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    await cancelBody(response);
    throw new Error('response_too_large: exceeds 2 MB');
  }
  if (!response.body?.getReader) throw new Error('response_body_unreadable');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw new Error('response_too_large: exceeds 2 MB');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function boundedNativeText(stream, headers, signal) {
  if (Number(headers.get('content-length')) > MAX_BYTES) {
    stream.destroy();
    throw new Error('response_too_large: exceeds 2 MB');
  }
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  const abort = () => stream.destroy(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    for await (const chunk of stream) {
      signal.throwIfAborted();
      bytes += chunk.byteLength;
      if (bytes > MAX_BYTES) throw new Error('response_too_large: exceeds 2 MB');
      text += decoder.decode(chunk, { stream: true });
    }
    signal.throwIfAborted();
    return text + decoder.decode();
  } finally {
    signal.removeEventListener('abort', abort);
    stream.destroy();
  }
}

async function nativeText(response, signal) {
  const encoding = (response.headers.get('content-encoding') || 'identity').trim().toLowerCase();
  if (encoding === 'identity') return boundedNativeText(response.nativeBody, response.headers, signal);
  const createDecoder = CONTENT_DECODERS.get(encoding);
  if (!createDecoder) { await cancelBody(response); throw new Error('unsupported_content_encoding'); }
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    await cancelBody(response);
    throw new Error('response_too_large: compressed body exceeds 2 MB');
  }
  let received = 0;
  const compressedLimit = new Transform({ transform(chunk, _encoding, callback) {
    received += chunk.byteLength;
    callback(received > MAX_BYTES ? new Error('response_too_large: compressed body exceeds 2 MB') : null, chunk);
  } });
  const input = response.nativeBody;
  const decoder = createDecoder({ chunkSize: 16_384 });
  // Observe all pipeline errors immediately; never return a partially decoded response.
  const completed = pipeline(input, compressedLimit, decoder, { signal }).then(() => null, error => error);
  try {
    const text = await boundedNativeText(decoder, response.headers, signal);
    const error = await completed;
    if (error) throw error;
    return text;
  } catch (error) {
    throw new Error(`decompression_failed: ${error.cause?.message || error.message || encoding}`, { cause: error });
  } finally {
    input.destroy(); compressedLimit.destroy(); decoder.destroy();
    await completed;
  }
}

/**
 * Shared transport for registry-approved URLs; callers enforce their source allowlist.
 * macOS may use its configured loopback HTTPS proxy, trusting that proxy's DNS/routing policy.
 * URL literals still reject private addresses; proxy redirects stay at the original origin unless
 * the caller supplies validateUrl, which must approve every target against its source registry.
 * Direct connections pin public DNS. Environment proxies and PAC scripts are never executed.
 * Injected fetch is for controlled tests, not an alternative production transport.
 */
export async function fetchSourceText(rawUrl, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS, validateUrl } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > TIMEOUT_MS) throw new Error('invalid_timeout: maximum 20000 ms');
  if (validateUrl !== undefined && typeof validateUrl !== 'function') throw new Error('invalid_url_policy');
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('timeout: source request exceeded budget');
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  const work = async () => {
    let url = safeUrl(rawUrl);
    const initialOrigin = url.origin;
    const proxy = fetchImpl === globalThis.fetch ? await systemHttpsProxy(controller.signal) : null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      controller.signal.throwIfAborted();
      if (validateUrl) await validateUrl(url.href);
      else if (proxy && url.origin !== initialOrigin) throw new Error('unsafe_proxy_redirect: target origin is not explicitly approved');
      const options = { redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9', 'Accept-Encoding': 'identity' } };
      const res = fetchImpl === globalThis.fetch ? await (proxy ? proxyResponse(url, options, proxy) : nativeResponse(url, options)) : await fetchImpl(url.href, options);
      if (res.url) safeUrl(res.url);
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get('location');
        await cancelBody(res);
        if (!location || hop === MAX_REDIRECTS) throw new Error('redirect_error: missing location or too many redirects');
        url = safeUrl(location, url);
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        await cancelBody(res);
        const error = new Error(`HTTP ${res.status}`);
        error.status = res.status;
        throw error;
      }
      const text = await (fetchImpl === globalThis.fetch ? nativeText(res, controller.signal) : boundedText(res, controller.signal));
      return { text, url: url.href, status: res.status, contentType: res.headers.get('content-type') || '' };
    }
  };
  try { return await Promise.race([work(), deadline]); }
  finally { clearTimeout(timer); }
}

function decodeEntities(text = '') {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…' };
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, entity) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? all;
    const value = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : '�';
  });
}

function plainText(value = '') {
  return decodeEntities(decodeEntities(String(value).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)]
    .map((m) => [m[1].toLowerCase(), decodeEntities(m[2] ?? m[3] ?? m[4])]));
}

function tagValue(xml, name) {
  const match = xml.match(new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${name}\\s*>`, 'i'));
  return match ? plainText(match[1]) : '';
}

function publicationDate(value) {
  if (!value || Number.isNaN(Date.parse(value))) return null;
  let day = value.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (!day) {
    const rfc = value.match(/\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{2,4})\b/i);
    if (!rfc) return null;
    const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(rfc[2].toLowerCase()) + 1;
    const year = rfc[3].length === 2 ? (Number(rfc[3]) < 50 ? 2000 : 1900) + Number(rfc[3]) : Number(rfc[3]);
    day = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${rfc[1].padStart(2, '0')}`;
  }
  const date = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().startsWith(day) ? day : null;
}

function xmlBase(tag, parent) {
  const value = attributes(tag)['xml:base'];
  if (!value) return parent;
  try { return new URL(value, parent).href; } catch { return null; }
}

function parseFeed(text, baseUrl) {
  if (!/<(?:[\w.-]+:)?(?:rss|feed|RDF)\b/i.test(text)) throw new Error('invalid_feed: response is not RSS/Atom');
  const rootBase = xmlBase(text.match(/<(?:[\w.-]+:)?(?:rss|feed|RDF)\b[^>]*>/i)?.[0] || '', baseUrl);
  const blocks = text.match(/<(?:[\w.-]+:)?(?:item|entry)\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?(?:item|entry)\s*>/gi) || [];
  return blocks.map((block) => {
    const entryBase = xmlBase(block.match(/^<[^>]*>/)?.[0] || '', rootBase);
    const links = [...block.matchAll(/<(?:[\w.-]+:)?link\b[^>]*>/gi)].map((m) => ({ ...attributes(m[0]), base: xmlBase(m[0], entryBase) }));
    const alternate = links.find((a) => a.href && (!a.rel || a.rel === 'alternate') && (!a.type || /html/i.test(a.type))) || links.find((a) => a.href && a.rel === 'alternate');
    const guidTag = block.match(/<(?:[\w.-]+:)?guid\b([^>]*)>/i);
    const guid = guidTag && attributes(guidTag[1]).ispermalink !== 'false' ? tagValue(block, 'guid') : '';
    const link = alternate?.href || tagValue(block, 'link') || guid;
    return { url: link ? canonicalize(link, alternate ? alternate.base : entryBase) : null, title: tagValue(block, 'title'), publishedAt: publicationDate(tagValue(block, 'published') || tagValue(block, 'pubDate') || tagValue(block, 'date') || tagValue(block, 'updated')) };
  }).filter((entry) => entry.url && entry.title);
}

function allowedListUrl(raw, source, baseUrl, scriptPath = false) {
  let value = decodeEntities(raw).replace(/\\u002f/gi, '/').replace(/\\\//g, '/');
  if (scriptPath && /^(?:blog|news|release-notes)\//.test(value)) value = `/${value}`;
  const candidate = canonicalize(value, baseUrl);
  if (!candidate) return null;
  const url = new URL(candidate);
  if (url.origin !== new URL(source.url).origin || candidate === canonicalize(source.url) || ASSET.test(url.pathname) || NAVIGATION.test(url.pathname)) return null;
  const allowed = source.webList.allowUrlPrefixes.some((prefix) => {
    const parsed = safeUrl(prefix);
    const root = parsed.pathname.replace(/\/+$/, '');
    return url.origin === parsed.origin && url.pathname.startsWith(`${root}/`) && url.pathname !== `${root}/`;
  });
  return allowed ? candidate : null;
}

function parseWebList(text, source, baseUrl) {
  const anchors = [...text.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)].map((m) => ({ url: allowedListUrl(attributes(m[1]).href || '', source, baseUrl), title: plainText(m[2]) }));
  // Extract string data only. Never evaluate JavaScript, JSONP or embedded instructions.
  const scriptText = [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n')
    .replace(/\\u002f/gi, '/').replace(/\\\//g, '/').replace(/\\["']/g, '"');
  const paths = [...scriptText.matchAll(/["']((?:https:\/\/|\/|blog\/|news\/|release-notes\/)[^"'<>\s\\]{1,2000})["']/g)]
    .map((m) => ({ url: allowedListUrl(m[1], source, baseUrl, true), title: '' }));
  return [...anchors, ...paths].filter((entry) => entry.url).map((entry) => {
    const slug = new URL(entry.url).pathname.split('/').pop();
    let fallback = slug;
    try { fallback = decodeURIComponent(slug); } catch { /* Preserve other valid links when this slug has malformed encoding. */ }
    return { ...entry, title: entry.title || fallback, publishedAt: null };
  });
}

function relevant(entry, source) {
  return MODEL_WORDS.test(`${entry.title} ${new URL(entry.url).pathname}`) ||
    (source.vendor === 'glm' && /\/release-notes\/\d{4}-\d{2}-\d{2}(?:\/|$)/.test(new URL(entry.url).pathname));
}

function sourceSkip(source, selection) {
  if (selection && !selection.has(source.id)) return 'not_selected';
  if (!['ready', 'weak'].includes(source.status) || !['rss', 'web_list'].includes(source.kind)) return 'not_collectable';
  if (source.kind === 'web_list' && !source.webList?.allowUrlPrefixes?.length) return 'missing_allowed_prefixes';
  return null;
}

function emptyListDiagnostic(text, source, discovered, candidates) {
  if (candidates) return { reason: 'collection_limit_zero' };
  if (discovered) return { reason: 'no_relevant_candidates' };
  // Mintlify's current GLM page has date section slugs, not independent article routes.
  // These are diagnostic data only: do not turn them into URLs or bypass atlas deduplication.
  if (source.vendor === 'glm' && source.kind === 'web_list' && text.includes('tableOfContents')) {
    const pageData = text.replace(/\\["']/g, '"');
    const dates = new Set([...pageData.matchAll(/"slug"\s*:\s*"(\d{4}-\d{2}-\d{2})"/g)].map(m => m[1]));
    if (dates.size) return { reason: 'single_page_changelog', embeddedEntries: dates.size, note: '日期仅为同页章节；没有独立文章 URL，需另行设计条目级版本跟踪。' };
  }
  return { reason: 'no_article_entries' };
}

async function collectSource(source, selection, fetchImpl, limit) {
  const skip = sourceSkip(source, selection);
  if (skip) return { id: source.id, status: 'skipped', reason: skip, entries: [], filtered: 0 };
  try {
    const response = await fetchSourceText(source.url, { fetchImpl, validateUrl: url => {
      if (new URL(url).origin !== new URL(source.url).origin) throw new Error('source_redirect_rejected: outside registered origin');
    } });
    const parsed = source.kind === 'rss' ? parseFeed(response.text, response.url) : parseWebList(response.text, source, response.url);
    const firstByUrl = new Map();
    for (const entry of parsed) if (!firstByUrl.has(entry.url)) firstByUrl.set(entry.url, entry);
    const unique = [...firstByUrl.values()];
    const candidates = unique.filter((entry) => relevant(entry, source));
    const entries = candidates.slice(0, limit);
    return { id: source.id, status: entries.length ? 'ok' : 'empty', httpStatus: response.status, entries, discovered: unique.length, filtered: unique.length - candidates.length,
      ...(!entries.length ? emptyListDiagnostic(response.text, source, unique.length, candidates.length) : {}) };
  } catch (error) {
    return { id: source.id, status: 'failed', httpStatus: error.status || null, error: String(error.message || error).slice(0, 300), entries: [], filtered: 0 };
  }
}

async function pooled(sources, fn) {
  const results = new Array(sources.length);
  let next = 0;
  async function worker() {
    while (next < sources.length) {
      const index = next++;
      results[index] = await fn(sources[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sources.length) }, worker));
  return results;
}

function atlasUrls(atlas) {
  const sources = [
    ...(atlas?.events || []).flatMap((event) => [event, ...(event.extraSources || []), ...(event.sources || [])]),
    ...(atlas?.forecasts || []).flatMap((forecast) => forecast.sources || []),
  ];
  return new Set(sources.map((source) => canonicalize(source.url)).filter(Boolean));
}

function attribution(source, url) {
  return { registryId: source.id, name: source.name || source.id, url, sourceType: SOURCE_TYPES.has(source.sourceType) ? source.sourceType : 'aggregator', feedUrl: source.url };
}

/** Collect list excerpts for review. Does not fetch articles, mutate atlas, or assert verification. */
export async function collectCandidates({ registry, atlas, queue, fetchImpl = fetch, now = new Date(), sourceIds, limitPerSource = 12 }) {
  if (!registry || !Array.isArray(registry.sources)) throw new Error('registry.sources must be an array');
  if (!Number.isInteger(limitPerSource) || limitPerSource < 0 || limitPerSource > 100) throw new Error('limitPerSource must be an integer from 0 to 100');
  if (sourceIds !== undefined && !Array.isArray(sourceIds)) throw new Error('sourceIds must be an array');
  const timestamp = new Date(now).toISOString();
  const selection = sourceIds === undefined ? null : new Set(sourceIds);
  const original = structuredClone(queue || { schemaVersion: 1, candidates: [], runs: [] });
  if (original.schemaVersion !== 1 || !Array.isArray(original.candidates) || !Array.isArray(original.runs)) throw new Error('invalid_queue_schema');
  const candidates = [...original.candidates];
  const index = new Map(candidates.map((c, i) => [canonicalize(c.canonicalUrl), i]).filter(([url]) => url));
  const existing = atlasUrls(atlas);
  const collected = await pooled(registry.sources, (s) => collectSource(s, selection, fetchImpl, limitPerSource));
  const report = { startedAt: timestamp, added: 0, merged: 0, skippedExisting: 0, filtered: 0, failed: 0, empty: 0, sources: [] };
  for (let i = 0; i < collected.length; i++) {
    const { entries, ...sourceReport } = collected[i];
    const source = registry.sources[i];
    report.filtered += sourceReport.filtered;
    report.failed += Number(sourceReport.status === 'failed');
    report.empty += Number(sourceReport.status === 'empty');
    for (const entry of entries) {
      if (existing.has(entry.url)) { report.skippedExisting++; continue; }
      const meta = attribution(source, entry.url);
      if (index.has(entry.url)) {
        const position = index.get(entry.url);
        const previous = candidates[position];
        const sources = previous.sources || [];
        const duplicate = sources.some((s) => s.registryId === source.id && canonicalize(s.url) === entry.url);
        candidates[position] = { ...previous, canonicalUrl: entry.url, lastSeenAt: timestamp, sources: duplicate ? sources : [...sources, meta] };
        report.merged++;
      } else {
        const id = `candidate-${createHash('sha256').update(entry.url).digest('hex').slice(0, 20)}`;
        index.set(entry.url, candidates.length);
        candidates.push({ id, canonicalUrl: entry.url, title: entry.title.slice(0, 500), discoveredAt: timestamp, lastSeenAt: timestamp, publishedAt: entry.publishedAt, vendor: source.vendor || null, status: 'pending', sources: [meta], suggestedKind: 'unknown', review: null });
        report.added++;
      }
    }
    report.sources.push({ ...sourceReport, collected: entries.length });
  }
  return { queue: { ...original, candidates, runs: [...original.runs, structuredClone(report)].slice(-MAX_RUN_SUMMARIES) }, report };
}
