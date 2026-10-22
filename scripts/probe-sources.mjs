#!/usr/bin/env node
/**
 * 礼貌探测信源：只读公开 RSS / 列表页，带身份 UA，限并发，不绕过 403。
 * 用法：node scripts/probe-sources.mjs
 */
import fs from 'node:fs';

const UA = 'model-atlas-probe/1.0 (+https://github.com/beteey/model-atlas; polite source discovery)';
const TIMEOUT = 20_000;
const CONCURRENCY = 3;

const registry = JSON.parse(fs.readFileSync(new URL('../public/data/sources.json', import.meta.url), 'utf8'));

/** 社区常见额外公开订阅（仅官方/公开 feed，不爬登录墙） */
const EXTRA = [
  { id: 'extra-openai-news', vendor: 'openai', name: 'OpenAI News (confirm)', kind: 'rss', url: 'https://openai.com/news/rss.xml' },
  { id: 'extra-mistral', vendor: 'mistral', name: 'Mistral RSS', kind: 'rss', url: 'https://mistral.ai/news/rss' },
  { id: 'extra-deepmind', vendor: 'google', name: 'DeepMind RSS', kind: 'rss', url: 'https://deepmind.google/blog/rss.xml' },
  { id: 'extra-google-ai', vendor: 'google', name: 'Google AI Keyword RSS', kind: 'rss', url: 'https://blog.google/innovation-and-ai/technology/ai/rss/' },
  { id: 'extra-hf', vendor: null, name: 'Hugging Face Blog', kind: 'rss', url: 'https://huggingface.co/blog/feed.xml' },
  { id: 'extra-arxiv-ai', vendor: null, name: 'arXiv cs.AI', kind: 'rss', url: 'https://rss.arxiv.org/rss/cs.AI' },
  { id: 'extra-arxiv-cl', vendor: null, name: 'arXiv cs.CL', kind: 'rss', url: 'https://rss.arxiv.org/rss/cs.CL' },
  { id: 'extra-ms-research', vendor: null, name: 'Microsoft Research', kind: 'rss', url: 'https://www.microsoft.com/en-us/research/feed/' },
  { id: 'extra-nvidia', vendor: null, name: 'NVIDIA Blog', kind: 'rss', url: 'https://blogs.nvidia.com/feed/' },
  { id: 'extra-aws-ml', vendor: null, name: 'AWS ML Blog', kind: 'rss', url: 'https://aws.amazon.com/blogs/machine-learning/feed/' },
  { id: 'extra-google-research', vendor: 'google', name: 'Google Research', kind: 'rss', url: 'https://research.google/blog/rss/' },
  { id: 'extra-anthropic-rss-guess', vendor: 'anthropic', name: 'Anthropic RSS guess', kind: 'rss', url: 'https://www.anthropic.com/news/rss.xml' },
  { id: 'extra-meta-rss-guess', vendor: 'meta', name: 'Meta AI RSS guess', kind: 'rss', url: 'https://ai.meta.com/blog/rss/' },
  { id: 'extra-xai-rss-guess', vendor: 'xai', name: 'xAI RSS guess', kind: 'rss', url: 'https://x.ai/news/rss.xml' },
  { id: 'extra-qwen-blog', vendor: 'qwen', name: 'Qwen Blog list', kind: 'web_list', url: 'https://qwenlm.github.io/blog/' },
  { id: 'extra-kimi-news', vendor: 'kimi', name: 'Kimi News list', kind: 'web_list', url: 'https://www.kimi.com/news' },
  { id: 'extra-glm-notes', vendor: 'glm', name: 'Z.ai release notes', kind: 'web_list', url: 'https://docs.z.ai/release-notes/new-released' },
  { id: 'extra-minimax', vendor: 'minimax', name: 'MiniMax blog', kind: 'web_list', url: 'https://www.minimax.io/blog' },
  { id: 'extra-deepseek-docs', vendor: 'deepseek', name: 'DeepSeek API docs news', kind: 'web_list', url: 'https://api-docs.deepseek.com/news/' },
  { id: 'extra-alibaba-press', vendor: 'qwen', name: 'Alibaba Cloud press', kind: 'web_list', url: 'https://www.alibabacloud.com/en/press-room' },
];

const seen = new Set();
const jobs = [];
for (const s of [...registry.sources, ...EXTRA]) {
  if (!s.url || seen.has(s.url)) continue;
  seen.add(s.url);
  jobs.push(s);
}

async function fetchText(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctl.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html, application/xhtml+xml;q=0.9,*/*;q=0.8',
      },
    });
    const text = await res.text();
    return { status: res.status, finalUrl: res.url, text, ok: res.ok };
  } catch (e) {
    return { status: 0, finalUrl: url, text: '', ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(t);
  }
}

function parseRss(text) {
  const items = [];
  // RSS item / Atom entry — 轻量抽取，不依赖 XML 库
  const blocks = text.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks.slice(0, 8)) {
    const title = (b.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i) || [])[1]?.replace(/<[^>]+>/g, '').trim();
    const link =
      (b.match(/<link[^>]*href=["']([^"']+)["']/i) || [])[1] ||
      (b.match(/<link[^>]*>\s*([^<\s]+)\s*<\/link>/i) || [])[1] ||
      (b.match(/<guid[^>]*>([^<]+)<\/guid>/i) || [])[1];
    const date =
      (b.match(/<pubDate[^>]*>([^<]+)<\/pubDate>/i) || [])[1] ||
      (b.match(/<updated[^>]*>([^<]+)<\/updated>/i) || [])[1] ||
      (b.match(/<published[^>]*>([^<]+)<\/published>/i) || [])[1];
    if (title || link) items.push({ title: title || '(无标题)', link: link?.trim() || null, date: date?.trim() || null });
  }
  return items;
}

function parseWebList(text, baseUrl) {
  const hrefs = [...text.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1]);
  const abs = [];
  for (const h of hrefs) {
    try {
      const u = new URL(h, baseUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      abs.push(u.toString().split('#')[0]);
    } catch { /* ignore */ }
  }
  // 启发式：路径像文章的链接
  const articleLike = abs.filter((u) => {
    const p = new URL(u).pathname;
    if (p.length < 8) return false;
    if (/\/(tag|tags|category|categories|author|page|label|labels|login|signin|search)(\/|$)/i.test(p)) return false;
    return /\/(news|blog|posts?|announc|introduc|release|changelog|article)s?\//i.test(p) || /\/20\d{2}\/\d{2}\//.test(p);
  });
  const uniq = [...new Set(articleLike)];
  // 去掉列表页自身
  const baseNorm = baseUrl.replace(/\/$/, '');
  return uniq.filter((u) => u.replace(/\/$/, '') !== baseNorm).slice(0, 12);
}

async function probe(job) {
  const r = await fetchText(job.url);
  const out = {
    id: job.id,
    name: job.name,
    vendor: job.vendor,
    kind: job.kind,
    url: job.url,
    http: r.status,
    error: r.error || null,
    items: 0,
    samples: [],
    verdict: 'fail',
    reason: '',
  };
  if (r.error) {
    out.reason = r.error;
    return out;
  }
  if (r.status === 403 || r.status === 401) {
    out.verdict = 'blocked';
    out.reason = `HTTP ${r.status}（礼貌探测停止，不绕过）`;
    return out;
  }
  if (r.status === 404) {
    out.verdict = 'missing';
    out.reason = 'HTTP 404';
    return out;
  }
  if (!r.ok) {
    out.verdict = 'fail';
    out.reason = `HTTP ${r.status}`;
    return out;
  }

  if (job.kind === 'rss') {
    const items = parseRss(r.text);
    out.items = items.length;
    out.samples = items.slice(0, 3);
    if (items.length > 0) {
      out.verdict = 'ok';
      out.reason = `RSS/Atom 解析到条目（抽样显示 ${items.length}）`;
    } else if (/<rss|<feed|xmlns:atom/i.test(r.text)) {
      out.verdict = 'empty';
      out.reason = '像 feed 但未解析出 item/entry';
    } else {
      out.verdict = 'fail';
      out.reason = '响应不像 RSS/Atom';
    }
    return out;
  }

  // web_list
  const links = parseWebList(r.text, r.finalUrl || job.url);
  out.items = links.length;
  out.samples = links.slice(0, 5).map((link) => ({ title: link.replace(/^https?:\/\//, '').slice(0, 80), link, date: null }));
  const looksSpa = r.text.length < 8000 && /__NEXT_DATA__|id="root"|id="app"/i.test(r.text) && links.length === 0;
  if (links.length >= 2) {
    out.verdict = 'ok';
    out.reason = `列表页启发式找到 ${links.length} 条疑似文章链接`;
  } else if (links.length === 1) {
    out.verdict = 'weak';
    out.reason = '只找到 1 条疑似链接，选择器需人工确认';
  } else if (looksSpa) {
    out.verdict = 'needs_render';
    out.reason = '像前端渲染壳，原始 HTML 无文章链接（不自动用付费渲染）';
  } else {
    out.verdict = 'fail';
    out.reason = 'HTML 里未识别到文章链接（可能选择器不同或结构特殊）';
  }
  return out;
}

async function pool(list, n, fn) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < list.length) {
      const idx = i++;
      results[idx] = await fn(list[idx]);
      await new Promise((r) => setTimeout(r, 400)); // 礼貌间隔
    }
  }
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

const results = await pool(jobs, CONCURRENCY, probe);
const order = { ok: 0, weak: 1, empty: 2, needs_render: 3, missing: 4, blocked: 5, fail: 6 };
results.sort((a, b) => (order[a.verdict] ?? 9) - (order[b.verdict] ?? 9) || a.id.localeCompare(b.id));

const summary = {
  probedAt: new Date().toISOString(),
  total: results.length,
  byVerdict: Object.fromEntries(
    ['ok', 'weak', 'empty', 'needs_render', 'missing', 'blocked', 'fail'].map((k) => [k, results.filter((r) => r.verdict === k).length]),
  ),
  results,
};

const outPath = new URL('../tmp/source-probe-report.json', import.meta.url);
fs.mkdirSync(new URL('../tmp', import.meta.url), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n');

// 可读摘要
console.log(`探测完成 ${summary.total} 条 @ ${summary.probedAt}`);
console.log('统计:', summary.byVerdict);
console.log('');
for (const r of results) {
  const flag = { ok: '✓', weak: '~', empty: '○', needs_render: '◐', missing: '?', blocked: '✗', fail: '✗' }[r.verdict] || '?';
  console.log(`${flag} [${r.verdict}] ${r.id}  HTTP ${r.http}  items=${r.items}  ${r.reason}`);
  if (r.samples?.[0]) console.log(`    例: ${r.samples[0].title?.slice(0, 70) || r.samples[0].link}`);
}
console.log(`\n完整报告: ${outPath.pathname}`);
