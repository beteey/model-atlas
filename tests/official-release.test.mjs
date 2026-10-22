import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractOfficialRelease, AUTO_REVIEW_VERSION } from '../scripts/lib/official-release.mjs';
import { articleText } from '../scripts/lib/review.mjs';

const now = new Date('2026-10-22T04:00:00Z');
const sources = {
  anthropic: { sourceType: 'official', vendor: 'anthropic', evidencePrefixes: ['https://www.anthropic.com/news/'] },
  openai: { sourceType: 'official', vendor: 'openai', evidencePrefixes: ['https://openai.com/index/'] },
  minimax: { sourceType: 'official', vendor: 'minimax', evidencePrefixes: ['https://www.minimax.io/blog/'] },
  deepseek: { sourceType: 'official', vendor: 'deepseek', evidencePrefixes: ['https://www.deepseek.com/en/news/'] },
  google: { sourceType: 'official', vendor: 'google', evidencePrefixes: ['https://deepmind.google/blog/'] },
};
const html = (body, { title = 'Introducing Claude Sonnet 4.5', date = '2025-09-29', extra = '' } = {}) => `${date ? `<meta property="article:published_time" content="${date}">` : ''}${extra}<article><h1>${title}</h1>${body}</article>`;
const extract = (markup, options = {}) => extractOfficialRelease({ html: markup, source: sources.anthropic, url: 'https://www.anthropic.com/news/claude-sonnet-4-5', now, ...options });
const released = '<p>Today we are releasing Claude Sonnet 4.5, our latest general-purpose reasoning model.</p>';
const reject = (markup, options) => { const result = extract(markup, options); assert.equal(result.eligible, false, JSON.stringify(result)); assert.ok(result.code); assert.ok(result.reason); };

for (const sentence of ['Today we release Claude Sonnet 4.5?', 'Today we are releasing Claude Sonnet 4.5？', '今日我们正式发布 Claude Sonnet 4.5？']) {
  test(`a question is not a release assertion: ${sentence}`, () => reject(html(`<p>${sentence}</p><p>The article discusses the model and how people might use its capabilities.</p>`)));
}

for (const [file, vendor, name, date, url] of [
  ['official-anthropic-sonnet.html', 'anthropic', 'Claude Sonnet 4.5', '2025-09-29', 'https://www.anthropic.com/news/claude-sonnet-4-5'],
  ['official-anthropic-opus.html', 'anthropic', 'Claude Opus 4.1', '2025-08-05', 'https://www.anthropic.com/news/claude-opus-4-1'],
  ['official-minimax-m31f.html', 'minimax', 'MiniMax M3.1 Flash', '2026-10-19', 'https://www.minimax.io/blog/minimax-m31f'],
]) {
  test(`extracts confirmed release from real official excerpt: ${file}`, () => {
    const markup = readFileSync(new URL(`fixtures/${file}`, import.meta.url), 'utf8');
    const result = extract(markup, { source: sources[vendor], url });
    assert.equal(result.eligible, true, JSON.stringify(result));
    assert.deepEqual({ name: result.record.name, date: result.record.date, kind: result.record.kind }, { name, date, kind: '正式发布' });
    assert.equal(result.evidence.text, articleText(markup));
    assert.ok(result.record.summary.length > 0);
    assert.equal(result.evidence.ruleVersion, AUTO_REVIEW_VERSION);
    assert.ok(result.evidence.text.includes(result.evidence.quotes.modelName));
    assert.ok(result.evidence.text.includes(result.evidence.quotes.eventType));
    assert.equal(result.evidence.dateBasis.type, 'article_date_today');
    assert.equal(result.evidence.dateBasis.value, date);
    assert.match(result.evidence.dateBasis.field, /datePublished|published_time/);
  });
}

test('date is tied to the target release sentence, never another model released today', () => {
  reject(html('<p>Today we released Claude Opus 4.1. Claude Sonnet 4.5 will launch next month.</p>'));
  reject(html('<p>Today we released Claude Opus 4.1.</p><p>Claude Sonnet 4.5 is available.</p>'));
  reject(html('<p>Today we released Claude Opus 4.1, unlike Claude Sonnet 4.5 which is coming next month.</p>'));
});

for (const body of [
  'Claude Sonnet 4.5 will be released today.', 'Today we plan to release Claude Sonnet 4.5.',
  'Claude Sonnet 4.5 is not yet available today.', 'We have not released Claude Sonnet 4.5 today.',
  'If Claude Sonnet 4.5 is released today, benchmarks may improve.', 'Claude Sonnet 4.5 may be available today.',
  'Today we announce that Claude Sonnet 4.5 is coming soon.', 'Today we introduce Claude Sonnet 4.5 research results.',
  'Today we are releasing a benchmark for Claude Sonnet 4.5.', 'Today we are releasing pricing for Claude Sonnet 4.5.',
  'Today we are releasing a tutorial about Claude Sonnet 4.5.', 'Today we are releasing a paper about Claude Sonnet 4.5.',
  'Today we are releasing a partnership with Claude Sonnet 4.5.',
  'Claude Sonnet 4.5 is now available to more users today.',
  'Claude Sonnet 4.5 is now available in 40 additional countries today.',
  'Claude Sonnet 4.5 is available today through our new partner platform.',
]) test(`does not promote uncertainty or non-model launch: ${body}`, () => reject(html(`<p>${body}</p>`)));

for (const title of ['Claude Sonnet 4.5 pricing update', 'How to use Claude Sonnet 4.5', 'Claude Sonnet 4.5 benchmark', 'Claude Sonnet 4.5 partnership', 'Expanding access to Claude Sonnet 4.5', 'Claude Sonnet 4.5 research paper']) {
  test(`does not treat an ancillary page as a model release: ${title}`, () => reject(html(released, { title })));
}

test('does not infer a release date from modified, arbitrary dates, or feed metadata', () => {
  reject(html(released, { date: null, extra: '<meta property="article:modified_time" content="2025-09-29"><p>2025-09-29</p>' }));
  reject(html(released, { date: null }), { source: { ...sources.anthropic, publishedAt: '2025-09-29' } });
  reject(html('<p>Claude Sonnet 4.5 is now available.</p>'));
});

test('rejects conflicting, invalid, and future publication days', () => {
  reject(html(released, { extra: '<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2025-09-30"}</script>' }));
  reject(html(released, { date: '2025-02-30' }));
  reject(html(released, { date: '2027-01-01' }));
  reject(html('<time datetime="2025-09-30">September 30, 2025</time>' + released));
});

test('explicit event-date sentence needs no article publication date', () => {
  const result = extract(html('<p>On September 29, 2025, we released Claude Sonnet 4.5, our latest general-purpose model.</p>', { date: null }));
  assert.equal(result.eligible, true, JSON.stringify(result));
  assert.equal(result.record.date, '2025-09-29');
  assert.match(result.evidence.quotes.eventDate, /September 29, 2025/);
});

test('conflicting event dates cannot be resolved by selecting the first sentence', () => {
  reject(html('<p>On September 29, 2025, we released Claude Sonnet 4.5.</p><p>On September 30, 2025, we released Claude Sonnet 4.5.</p>'));
});

test('distinguishes preview, API, weights, and general release without promoting preview', () => {
  const cases = [
    ['Today we are releasing Claude Sonnet 4.5 as a research preview.', '预览开放'],
    ['Claude Sonnet 4.5 is available in preview today through our API.', '预览开放'],
    ['Today we are launching Claude Sonnet 4.5 in the API.', 'API 上线'],
    ['Today we release the open weights of Claude Sonnet 4.5.', '权重开放'],
    ['Today we are releasing Claude Sonnet 4.5.', '正式发布'],
  ];
  for (const [sentence, kind] of cases) {
    const result = extract(html(`<p>${sentence}</p>`));
    assert.equal(result.eligible, true, JSON.stringify(result));
    assert.equal(result.record.kind, kind);
  }
});

test('a preview title cannot be promoted by generic release language', () => {
  const result = extract(html(released, { title: 'Claude Sonnet 4.5 Preview' }));
  assert.equal(result.eligible, true, JSON.stringify(result));
  assert.equal(result.record.kind, '预览开放');
});

test('requires an explicit unambiguous primary model name in title and prose', () => {
  reject(html(released, { title: 'Our newest model is here' }));
  reject(html('<p>Today we release our newest general-purpose reasoning model.</p>'));
  reject(html(released, { title: 'Introducing Claude Sonnet 4.5 and Claude Opus 4.1' }));
  reject(html(released + '<p>Today we release Claude Opus 4.1.</p>'));
  reject(html('<p>Today we are releasing Claude Sonnet 4.5 and Opus 4.1.</p>'));
});

test('keeps model variant names intact and rejects unsupported suffix truncation', () => {
  reject(html('<p>Today we release Claude Sonnet 4.5-Speciale.</p>', { title: 'Claude Sonnet 4.5-Speciale' }));
  const result = extract(html('<p>Today we are releasing DeepSeek-V3.1-Terminus, our latest general-purpose model.</p>', { title: 'DeepSeek-V3.1-Terminus', date: '2025-09-22' }), { source: sources.deepseek, url: 'https://www.deepseek.com/en/news/v3-1-terminus' });
  assert.equal(result.eligible, true, JSON.stringify(result));
  assert.equal(result.record.name, 'DeepSeek-V3.1-Terminus');
});

test('rejects unversioned and specialist model families', () => {
  reject(html('<p>Today we are releasing Claude Sonnet, our new model.</p>', { title: 'Claude Sonnet' }));
  reject(html('<p>Today we release Gemini 3.8 text-to-speech.</p>', { title: 'Gemini 3.8 text-to-speech' }), { source: sources.google, url: 'https://deepmind.google/blog/speech' });
  reject(html('<p>Today we release Qwen3Guard, a safety classifier.</p>', { title: 'Qwen3Guard' }));
});

test('never takes release claims from related links, comments, scripts, or page furniture', () => {
  for (const wrapper of [s => `<aside>${s}</aside>`, s => `<footer>${s}</footer>`, s => `<nav>${s}</nav>`, s => `<section class="related-articles">${s}</section>`, s => `<div aria-hidden="true">${s}</div>`, s => `<!-- ${s} -->`, s => `<script>${s}</script>`, s => `<blockquote>${s}</blockquote>`]) {
    reject(html('<p>We discuss the capabilities of Claude Sonnet 4.5 and ongoing model evaluation.</p>' + wrapper(released)));
  }
  reject(html('<p>We discuss Claude Sonnet 4.5 capabilities.</p><h2>Related articles</h2>' + released));
  reject('<h1>Introducing Claude Sonnet 4.5</h1>' + released);
});

test('checks official source, vendor ownership, HTTPS, and exact prefix boundaries', () => {
  const markup = html(released);
  for (const url of ['http://www.anthropic.com/news/model', 'https://evil.test/news/model', 'https://www.anthropic.com.evil.test/news/model', 'https://a@www.anthropic.com/news/model', 'https://www.anthropic.com:8443/news/model', 'https://www.anthropic.com/newspaper/model']) reject(markup, { url });
  reject(markup, { source: { ...sources.anthropic, sourceType: 'aggregator' } });
  reject(markup, { source: { ...sources.anthropic, vendor: null } });
  reject(markup, { source: sources.openai, url: 'https://openai.com/index/competitor' });
  reject(markup, { source: { ...sources.anthropic, evidencePrefixes: ['https://mirror.example.com/news/'] }, url: 'https://mirror.example.com/news/model' });
  reject(markup, { source: { ...sources.anthropic, evidencePrefixes: ['https://www.anthropic.com/news'] }, url: 'https://www.anthropic.com/newspaper/model' });
});

test('Chinese release and date are bound within the target statement', () => {
  const result = extract(html('<p>2025年9月22日，DeepSeek-V3.1-Terminus 正式发布，支持通用推理与工具调用。</p>', { title: 'DeepSeek-V3.1-Terminus 正式发布', date: null }), { source: sources.deepseek, url: 'https://www.deepseek.com/en/news/v3-1-terminus' });
  assert.equal(result.eligible, true, JSON.stringify(result));
  assert.equal(result.record.date, '2025-09-22');
  reject(html('<p>今日计划正式发布 Claude Sonnet 4.5。</p>'));
});

test('malformed or missing input fails closed without exceptions', () => {
  for (const input of [{}, { html: null }, { html: '<article>broken', url: 'not a URL', source: sources.anthropic }]) assert.doesNotThrow(() => assert.equal(extractOfficialRelease(input).eligible, false));
});

test('uses the official metadata title when a real publication hides its animated hero before hydration', () => {
  const markup = '<meta property="og:title" content="Introducing Claude Sonnet 4.5"><meta property="article:published_time" content="2025-09-29"><article><header style="visibility:hidden"><h1>Introducing Claude Sonnet 4.5</h1></header><p>Claude Sonnet 4.5 is available everywhere today.</p></article>';
  const result = extract(markup);
  assert.equal(result.eligible, true, JSON.stringify(result));
  assert.equal(result.record.name, 'Claude Sonnet 4.5');
});

test('rejects an audience-only rollout even when the title contains the existing model', () => {
  reject(html('<p>Today we are releasing Claude Sonnet 4.5 to free users.</p>'));
  reject(html('<p>Claude Sonnet 4.5 is available to enterprise customers today.</p>'));
});

test('does not reinterpret a model feature or possessive release as the model itself', () => {
  reject(html("<p>Today we are releasing Claude Sonnet 4.5's new context window.</p>"));
});

test('contradictory target availability elsewhere keeps the article in manual review', () => {
  reject(html(released + '<p>Claude Sonnet 4.5 will only become available next month.</p>'));
});

test('dates mentioned for training data do not become the release date', () => {
  const result = extract(html('<p>Today we release Claude Sonnet 4.5, trained on information through January 1, 2025.</p>'));
  assert.equal(result.eligible, true, JSON.stringify(result));
  assert.equal(result.record.date, '2025-09-29');
  reject(html('<p>We release Claude Sonnet 4.5, trained on information through January 1, 2025.</p>', { date: null }));
});

test('an explicit postposed release date is accepted', () => {
  const result = extract(html('<p>We released Claude Sonnet 4.5 on September 29, 2025.</p>', { date: null }));
  assert.equal(result.eligible, true, JSON.stringify(result));
  assert.equal(result.record.date, '2025-09-29');
});

test('invalid metadata timestamps and contradictions between today and explicit dates fail closed', () => {
  reject(html(released, { date: '2025-09-29T99:99:99Z' }));
  reject(html('<p>Today, on September 30, 2025, we release Claude Sonnet 4.5.</p>'));
});

for (const sentence of [
  'We hope to release Claude Sonnet 4.5 today.',
  'Today we are preparing to release Claude Sonnet 4.5.',
  'Today we want to release Claude Sonnet 4.5.',
  'Today we are releasing Claude Sonnet 4.5 documentation, including new examples and reference pages.',
  'Today we are releasing Claude Sonnet 4.5 in private preview to selected testers.',
  'Today we are releasing Claude Sonnet 4.5 on an invitation-only basis.',
  'Today we are releasing Claude Sonnet 4.5 to select customers.',
  'Claude Sonnet 4.5 is available today through a waitlist.',
  'We hope Claude Sonnet 4.5 is available today.',
  '今日我们希望正式发布 Claude Sonnet 4.5。',
]) test(`requires a completed public model event with exact grammatical object: ${sentence}`, () => reject(html(`<p>${sentence}</p>`)));

test('does not take publication dates from unrelated cards or unbound structured Article objects', () => {
  reject(html(released, { date: null, extra: '<script type="application/ld+json">{"@type":"Article","datePublished":"2025-09-29"}</script>' }));
  reject(html(released + '<section class="related-articles"><meta property="article:published_time" content="2025-09-29"></section>', { date: null }));
  reject(html(released + '<section class="related-articles"><script type="application/ld+json">{"@type":"Article","headline":"Introducing Claude Sonnet 4.5","datePublished":"2025-09-29"}</script></section>', { date: null }));
  reject(html(released, { date: null, extra: '<script type="application/ld+json">{"@type":"Article","headline":"An unrelated article","datePublished":"2025-09-29"}</script>' }));
});

test('a preview statement cannot borrow a different release stage date', () => {
  reject(html('<p>Claude Sonnet 4.5 is available in research preview.</p>' + released));
  reject(html('<p>On September 1, 2025, we released Claude Sonnet 4.5 as a preview.</p>' + released));
});

test('abbreviated sibling versions in a release sentence remain ambiguous', () => {
  reject(html('<p>Today we release Claude Sonnet 4.5 and 4.6.</p>'));
  reject(html('<p>Today we release MiniMax M2.5 and M2.5-Lightning.</p>', { title: 'MiniMax M2.5' }), { source: sources.minimax, url: 'https://www.minimax.io/blog/minimax-m25' });
});

test('restricted access anywhere in the announcement cannot be discarded as a non-release sentence', () => {
  reject(html(released + '<p>Claude Sonnet 4.5 is available only to selected testers.</p>'));
  reject(html(released + '<p>Access is available only to selected testers.</p>'));
  reject(html(released + '<p>The model requires an invitation to try.</p>'));
});

for (const sentence of [
  '今日我们正式发布 Claude Sonnet 4.5 文档，包含接口用法和示例。',
  'Claude Sonnet 4.5 今日正式发布说明文档，介绍未来模型的使用方法。',
  '今日我们正式发布 Claude Sonnet 4.5 的说明。',
  'Claude Sonnet 4.5 今日已开放访问申请，审核通过后才能使用。',
]) test(`Chinese release grammar does not permit product-document or application suffixes: ${sentence}`, () => reject(html(`<p>${sentence}</p>`)));

test('mentioning a plugin does not make an anonymous access restriction unrelated', () => {
  reject(html(released + '<p>Access is available only to selected testers who install our plugin.</p>'));
});

test('an explicit separate extension rollout does not restrict the released model', () => {
  // This separate product sentence occurs in the real Sonnet 4.5 announcement.
  const result = extract(html(released + "<p>And we've made the Claude for Chrome extension available to Max users who joined the waitlist last month.</p>"));
  assert.equal(result.eligible, true, JSON.stringify(result));
});
