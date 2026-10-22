import { articleText, normalize, today } from './review.mjs';

export const AUTO_REVIEW_VERSION = 'official-release-v1';
const HOSTS = {
  openai: ['openai.com'], anthropic: ['anthropic.com', 'www.anthropic.com'],
  google: ['deepmind.google', 'blog.google', 'research.google'], mistral: ['mistral.ai'],
  meta: ['ai.meta.com'], xai: ['x.ai'], deepseek: ['www.deepseek.com', 'deepseek.com', 'api-docs.deepseek.com'],
  qwen: ['qwenlm.github.io', 'qwen.ai'], kimi: ['www.kimi.com', 'kimi.com'],
  glm: ['docs.z.ai', 'z.ai'], minimax: ['www.minimax.io', 'minimax.io'],
};
const MODEL_PATTERNS = {
  openai: /\b(?:GPT[ -]?\d+(?:\.\d+)*(?:o)?(?:[ -](?:mini|nano|pro|thinking|instant|turbo))?|o[1-9](?:[ -](?:mini|pro))?)/gi,
  anthropic: /\bClaude[ -](?:(?:Opus|Sonnet|Haiku|Fable)[ -]\d+(?:\.\d+)*|\d+(?:\.\d+)*(?:[ -](?:Opus|Sonnet|Haiku))?)/gi,
  google: /\b(?:Gemini[ -]\d+(?:\.\d+)*(?:[ -](?:Flash(?:[ -]Lite)?|Pro|Ultra|Nano|Argon|Live(?:[ -]Extended[ -]Thinking)?|Deep[ -]Think))?|Gemma[ -]\d+(?:\.\d+)*(?:[ -]\d+B)?)/gi,
  mistral: /\b(?:Mistral[ -](?:Large|Medium|Small)[ -]\d+(?:\.\d+)*|Mixtral[ -]\d+x\d+B)/gi,
  meta: /\bLlama[ -]\d+(?:\.\d+)*(?:[ -](?:Scout|Maverick|Behemoth))?/gi,
  xai: /\bGrok[ -]\d+(?:\.\d+)*(?:[ -](?:Fast|Heavy|mini))?/gi,
  deepseek: /\bDeepSeek[ -](?:V\d+(?:\.\d+)*(?:-(?:Terminus|Exp|Pro|Flash))?|R\d+(?:-\d{4})?)/gi,
  qwen: /\bQwen[ -]?\d+(?:\.\d+)*(?:-(?:Max|Plus|Turbo|Omni|VL|\d+B(?:-A\d+B)?))?/gi,
  kimi: /\bKimi[ -]K\d+(?:\.\d+)*(?:[ -]Thinking)?/gi,
  glm: /\bGLM[ -]\d+(?:\.\d+)*(?:[ -](?:Air|Flash|Plus))?/gi,
  minimax: /\bMiniMax[ -]M\d+(?:\.\d+)*(?:[ -](?:Flash|Lightning))?/gi,
};
const UNCERTAIN = /\b(?:will|would|could|may|might|plan(?:s|ned)?|expect(?:ed)?|upcoming|soon|tomorrow|not|never|if|rumou?r|reportedly|previously|yesterday|last (?:week|month|year))\b|计划|预计|即将|将于|将在|拟于|尚未|没有|未开放|未发布|传闻|如果|去年|昨日/i;
const AUXILIARY = /\b(?:benchmark|pricing|partnership|tutorial|guide|paper|report|system card|evaluation|integration|hardware|robotics|text.to.speech|embedding|classifier|moderation|music|video generation|image generation)\b|教程|定价|合作|论文|评测|基准|语音合成|嵌入模型|图像生成|视频生成/i;
const EXPANSION = /\b(?:expand\w*|additional|more users|more countries|new (?:partner|platform|region)|(?:now|available) (?:also|again)|existing users|access (?:update|upgrade)|to (?:all |our )?(?:free|paid|enterprise|pro|max|team) (?:users|customers|subscribers))\b|扩大|扩展|更多用户|更多国家|新增地区|访问范围/i;
const PREVIEW = /\b(?:preview|experimental|beta|early access)\b|预览|实验性|测试版/i;
const RESTRICTED = /\b(?:private|invitation[- ]only|invite[- ]only|waitlist|select(?:ed)? (?:customers|users|testers|partners)|requires? (?:an? )?(?:invitation|approval)|closed (?:beta|preview)|internal (?:test|preview))\b|私有预览|内测|邀请制|受邀|白名单|排队|部分客户|审核通过后|访问申请/i;
const RELEASE_VERB = '(?:releas(?:e|ed|ing)|launch(?:ed|ing)?|roll(?:ing)?\\s+out|rolled\\s+out|open[- ]sourc(?:e|ed|ing))';
const denied = (code, reason) => ({ eligible: false, code, reason });
const identity = name => name.toLowerCase().replace(/[\s-]+/g, '');
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const plain = markup => articleText(markup);

function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)]
    .map(m => [m[1].toLowerCase(), plain(m[2] ?? m[3] ?? m[4])]));
}

function approvedSource(source, url) {
  if (source?.sourceType !== 'official' || !HOSTS[source.vendor]) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || !HOSTS[source.vendor].includes(u.hostname)) return false;
    if (/%(?:2f|5c|2e)/i.test(u.pathname)) return false;
    return source.evidencePrefixes?.some(raw => {
      const prefix = new URL(raw), path = prefix.pathname.replace(/\/+$/, '');
      return prefix.protocol === 'https:' && u.origin === prefix.origin && (u.pathname === path || u.pathname.startsWith(`${path}/`));
    }) === true;
  } catch { return false; }
}

// Do not combine paragraphs or read assertions from related cards, hidden nodes, or quotations.
// A small balanced tag walk removes entire excluded subtrees, including nested divs.
function cleanMarkup(html) {
  const source = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const stack = [], output = [];
  for (const token of source.match(/<[^>]*>|[^<]+/g) || []) {
    if (!token.startsWith('<')) { if (!stack.some(x => x.skip)) output.push(token); continue; }
    const closing = token.match(/^<\/([\w-]+)/), opening = token.match(/^<([\w-]+)/);
    if (closing) {
      const index = stack.map(x => x.tag).lastIndexOf(closing[1].toLowerCase());
      const skip = stack.some(x => x.skip);
      if (index >= 0) stack.splice(index);
      if (!skip) output.push(token);
    } else if (opening) {
      const tag = opening[1].toLowerCase(), attrs = attributes(token);
      const skip = stack.some(x => x.skip) || /^(?:aside|nav|footer|blockquote|button|form)$/.test(tag) ||
        /related|recommend|sidebar|breadcrumb|share[-_ ]|comment|cookie/i.test(`${attrs.class || ''} ${attrs.id || ''}`) ||
        attrs['aria-hidden'] === 'true' || /\shidden(?:\s|=|>)/i.test(token) || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(attrs.style || '');
      if (!skip) output.push(token);
      if (!/^(?:meta|link|img|br|hr|input|source|area|base|embed|wbr)$/.test(tag) && !/\/\s*>$/.test(token)) stack.push({ tag, skip });
    }
  }
  return output.join('');
}

function content(html) {
  const clean = cleanMarkup(html);
  let body = clean.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] || clean.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
  if (!body) return null;
  const headings = [...clean.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map(m => plain(m[1]));
  if (!headings.length) {
    const titles = [...clean.matchAll(/<meta\b[^>]*>/gi)].map(m => attributes(m[0])).filter(a => a.property === 'og:title').map(a => a.content);
    headings.push(...titles.filter(Boolean));
  }
  if (new Set(headings).size !== 1) return null;
  const related = body.search(/<h[2-6]\b[^>]*>\s*(?:Related|Read more|Recommended|相关文章|相关推荐)/i);
  if (related >= 0) body = body.slice(0, related);
  const blocks = [...body.matchAll(/<(p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
    .filter(m => !/<(?:p|li)\b/i.test(m[2])).map(m => ({ text: plain(m[2]), offset: m.index }));
  return { title: headings[0], body, blocks };
}

function models(text) {
  return Object.entries(MODEL_PATTERNS).flatMap(([vendor, pattern]) => [...text.matchAll(new RegExp(pattern))]
    .filter(m => !/[\w-]/.test(text[m.index + m[0].length] || ''))
    .map(m => ({ vendor, name: m[0], key: identity(m[0]), index: m.index })));
}

function primaryModel(title, vendor) {
  const found = models(title);
  if (found.length !== 1 || found[0].vendor !== vendor) return null;
  const rest = title.slice(found[0].index + found[0].name.length).trim();
  // Unknown suffixes must not silently turn a specialist/variant into its parent model.
  if (rest && !/^(?:[:：,.!—–]|$|(?:release|preview|released|launch)(?:\b|[：:！!。])|(?:正式发布|发布|预览)(?:$|[：:！!。]))/i.test(rest)) return null;
  return found[0];
}

function sentences(block) {
  return block.split(/(?<=[。！？])|(?<=[.!?])\s+(?=[A-Z\u4e00-\u9fff])/u).map(normalize).filter(Boolean);
}

function releaseClause(sentence) {
  const trimmed = sentence.replace(/^(?:today|今日|今天)[,，]?\s*/i, '');
  const date = dates(trimmed)[0];
  if (!date) return trimmed;
  // Only remove a leading temporal adjunct; words expressing intent stay in the clause.
  return trimmed.replace(new RegExp(`^(?:On\\s+)?${escape(date.quote)}[,，]?\\s*`, 'i'), '');
}

function affirmative(sentence, model) {
  if (sentence.length > 1200 || /[?？]/.test(sentence) || UNCERTAIN.test(sentence) || AUXILIARY.test(sentence) || EXPANSION.test(sentence) || RESTRICTED.test(sentence)) return false;
  const name = escape(model.name), prefix = '(?:officially\\s+)?';
  if (new RegExp(`${name}(?:['’]s|的)`, 'i').test(sentence)) return false;
  const issuer = `we(?:\\s+${prefix}(?:release|released|launch|launched|roll\\s+out|rolled\\s+out|open[- ]source|open[- ]sourced)|(?:\\s+are|['’]re)\\s+${prefix}(?:releasing|launching|rolling\\s+out|open[- ]sourcing)|\\s+have\\s+${prefix}(?:released|launched))`;
  const boundary = `(?=\\s*(?:$|[.,!?;:，。！；：])|\\s+(?:as|on|in|via|through|today|for|at|with|and)\\b)`;
  const object = new RegExp(`^${issuer}\\s+(?:the\\s+)?(?:open\\s+(?:model\\s+)?weights\\s+(?:of|for)\\s+)?${name}${boundary}`, 'i');
  const subject = new RegExp(`^${name}\\s+(?:(?:is|are|was|has been|have been)\\s+)?(?:now\\s+)?${prefix}(?:available(?:\\s+everywhere)?|live|released|launched|open[- ]sourced)\\b`, 'i');
  const chinese = new RegExp(`^(?:${name}\\s*(?:今日|今天)?\\s*(?:已正式发布|正式发布|已发布|已上线|正式上线|已开放|开放预览|已开源)|(?:我们)?(?:正式发布|已发布|发布了|已上线|已开放|已开源)\\s*${name})(?=\\s*(?:$|[，。！？；：,.!?;:]))`, 'i');
  const clause = releaseClause(sentence);
  return object.test(clause) || subject.test(clause) || chinese.test(clause);
}

function releaseStatements(blocks) {
  return blocks.flatMap(block => sentences(block.text).flatMap(sentence => {
    // Comparison targets do not become co-releases (e.g. "an upgrade to Claude Opus 4").
    const assertion = sentence.split(/\b(?:an upgrade to|compared (?:to|with)|versus|vs\.)\b|相较于|相比于/i)[0];
    const found = models(assertion);
    const aliases = assertion.match(/\b(?:Opus|Sonnet|Haiku|Fable)\s+\d+(?:\.\d+)*/gi) || [];
    const sharedFamily = aliases.some(alias => !found.some(model => model.name.includes(alias))) ||
      /(?:\band\b|[、/])\s*(?:\d|[A-Z]{1,3}\d)/i.test(assertion);
    const valid = found.filter(model => affirmative(sentence, model));
    return valid.map(model => ({ model, sentence, ambiguous: found.length > 1 || sharedFamily }));
  }));
}

function restrictedAnnouncement(blocks, primary) {
  return blocks.flatMap(b => sentences(b.text)).some(sentence => {
    if (!RESTRICTED.test(sentence)) return false;
    if (models(sentence).some(model => model.key === primary.key)) return true;
    // An explicitly named non-model product (e.g. a browser extension) is a separate
    // subject. Anonymous "access", "the model", or unclear restrictions stay manual.
    const separateProduct = /^(?:And\s+)?we(?:['’]ve| have)\s+made\s+(?:the\s+)?[^.!?]{1,70}\b(?:extension|plugin|SDK)\s+available\b/i.test(sentence);
    const modelAccess = /\b(?:model|model access)\b|模型|访问权限/i.test(sentence);
    return !separateProduct || modelAccess;
  });
}

function validDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value ? value : null;
}

function dates(text) {
  const english = /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/gi;
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const found = [...text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})(?:T[\d:.+-]+Z?)?/g)].map(m => ({ value: validDay(`${m[1]}-${m[2]}-${m[3]}`), quote: m[0] }));
  for (const m of text.matchAll(english)) found.push({ value: validDay(`${m[3]}-${String(months.indexOf(m[1].slice(0, 3).toLowerCase()) + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`), quote: m[0] });
  for (const m of text.matchAll(/(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日/g)) found.push({ value: validDay(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`), quote: m[0] });
  return found;
}

function publicationDay(raw) {
  if (typeof raw !== 'string' || !Number.isFinite(Date.parse(raw))) return null;
  const found = dates(raw);
  return found.length === 1 && found[0].quote === raw ? found[0].value : null;
}

function publicationDates(html, article) {
  const found = [];
  const document = html.replace(/<!--[\s\S]*?-->/g, '');
  const firstArticle = document.search(/<article\b/i), firstMain = document.search(/<main\b/i);
  const metadata = document.slice(0, firstArticle >= 0 ? firstArticle : firstMain);
  const head = document.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1] || metadata;
  for (const m of head.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').matchAll(/<meta\b[^>]*>/gi)) {
    const a = attributes(m[0]), key = a.property || a.name || a.itemprop;
    if (['article:published_time', 'datePublished'].includes(key)) found.push({ value: publicationDay(a.content), quote: a.content, field: `meta ${key}` });
  }
  for (const m of metadata.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (attributes(m[1]).type !== 'application/ld+json') continue;
    try {
      const data = JSON.parse(m[2]);
      const nodes = Array.isArray(data) ? data : [data, ...(Array.isArray(data?.['@graph']) ? data['@graph'] : [])];
      for (const node of nodes) {
        const type = [node?.['@type']].flat();
        if (!type.some(t => ['Article', 'NewsArticle', 'BlogPosting'].includes(t)) || !node.datePublished) continue;
        if (node.headline && normalize(node.headline) !== article.title) continue;
        found.push({ value: node.headline ? publicationDay(String(node.datePublished)) : null, quote: String(node.datePublished), field: 'JSON-LD Article datePublished matched by headline' });
      }
    } catch { /* Invalid structured data is not publication evidence. */ }
  }
  const firstProse = article.blocks.find(b => b.text.length >= 50)?.offset ?? 0;
  const beforeProse = article.body.slice(0, firstProse);
  for (const m of beforeProse.matchAll(/<time\b([^>]*)>([\s\S]*?)<\/time>/gi)) {
    const previous = plain(beforeProse.slice(Math.max(0, m.index - 100), m.index));
    if (/updated|modified|更新|修订/i.test(previous)) continue;
    const a = attributes(m[1]), raw = a.datetime || plain(m[2]);
    found.push({ value: publicationDay(raw), quote: raw, field: 'article header time before release prose' });
  }
  return found;
}

function explicitReleaseDates(statement) {
  const { sentence, model } = statement;
  return dates(sentence).filter(date => {
    const index = sentence.indexOf(date.quote), before = sentence.slice(0, index), after = sentence.slice(index + date.quote.length);
    const beginning = /^(?:Today[,，]?\s*)?(?:On\s+)?$/i.test(before) &&
      new RegExp(`^[,，]?\\s*(?:we\\b|${escape(model.name)}|正式发布|已发布)`, 'i').test(after);
    const postposed = new RegExp(`(?:${RELEASE_VERB}\\s+${escape(model.name)}|${escape(model.name)}\\s+(?:is\\s+|was\\s+)?(?:released|launched|available))\\s+on\\s+$`, 'i').test(before);
    const chinese = new RegExp(`${escape(model.name)}\\s*(?:于|在)\\s*$`, 'i').test(before) && /^\s*(?:正式发布|已发布|发布|上线|开放)/.test(after);
    return beginning || postposed || chinese;
  });
}

function determineDate(statements, published) {
  if (published.some(d => !d.value) || new Set(published.map(d => d.value)).size > 1) return null;
  const candidates = statements.flatMap(statement => {
    const explicit = explicitReleaseDates(statement);
    if (explicit.length) return explicit.map(d => ({ ...d, value: /\btoday\b|今日|今天/i.test(statement.sentence) && published.length && d.value !== published[0].value ? null : d.value, type: 'explicit_release_date', field: 'release statement in article body', statement }));
    if (/\btoday\b|今日|今天/i.test(statement.sentence) && published.length) return [{ ...published[0], type: 'article_date_today', statement }];
    return [];
  });
  if (!candidates.length || candidates.some(d => !d.value) || new Set(candidates.map(d => d.value)).size !== 1) return null;
  return candidates[0];
}

function eventKind(statement, title) {
  if (PREVIEW.test(title) || PREVIEW.test(statement)) return '预览开放';
  if (/\b(?:open[- ]?(?:model[- ]?)?weights|weights|open[- ]sourc\w*)\b|权重|开源/i.test(statement)) return '权重开放';
  if (/\bAPI\b/i.test(statement)) return 'API 上线';
  return '正式发布';
}

/** Pure, fail-closed extraction: it never fetches, calls a model, or changes public data. */
export function extractOfficialRelease({ html, url, source, now = new Date() } = {}) {
  if (!approvedSource(source, url)) return denied('unapproved_source', '仅核实已登记的本厂商 HTTPS 官网原文');
  if (typeof html !== 'string' || html.length < 80 || html.length > 2 * 1024 * 1024 || !Number.isFinite(now?.valueOf())) return denied('unreadable_article', '未取得完整可解析的官网文章');
  const article = content(html);
  if (!article || !article.blocks.length) return denied('unreadable_article', '未找到唯一文章标题与独立正文段落');
  if (AUXILIARY.test(article.title) || EXPANSION.test(article.title) || /\bhow to\b|教程|安全报告/i.test(article.title)) return denied('not_model_release', '本文主题不是新模型发布');
  const primary = primaryModel(article.title, source.vendor);
  if (!primary) return denied('ambiguous_model', '官网标题未明确唯一、完整且带版本的本厂商通用模型');
  if (restrictedAnnouncement(article.blocks, primary)) return denied('restricted_access', '公告正文存在内测、邀请或申请访问限制，需人工确认开放范围');
  const releases = releaseStatements(article.blocks);
  const matching = releases.filter(s => s.model.key === primary.key);
  if (!matching.length) return denied('unconfirmed_release', '正文没有直接确认该模型已开放的明确语句');
  const contradictory = article.blocks.flatMap(b => sentences(b.text)).some(sentence =>
    models(sentence).some(m => m.key === primary.key) && UNCERTAIN.test(sentence) &&
    /(?:will|would|not|never|尚未|未发布|未开放)[^.!?。！？]{0,45}(?:releas|launch|available|发布|开放)/i.test(sentence) &&
    !/weights|权重|technical report|技术报告/i.test(sentence));
  if (contradictory) return denied('conflicting_status', '正文还含目标模型尚未发布或未来开放的冲突语句');
  if (matching.some(s => s.ambiguous) || releases.some(s => s.model.key !== primary.key)) return denied('multiple_releases', '文章存在多个发布模型，需人工确认主模型与变体');
  const kinds = matching.map(s => eventKind(s.sentence, article.title));
  if (new Set(kinds).size !== 1) return denied('multiple_release_phases', '正文包含不同开放阶段，不能跨语句拼接事件类型与日期');
  const date = determineDate(matching, publicationDates(html, article));
  if (!date) return denied('unconfirmed_date', '缺少与该模型发布语句绑定的唯一有效日期，或官方日期冲突');
  if (date.value > today(now)) return denied('future_release', '官方日期仍在未来，保留人工审核');
  const kind = eventKind(date.statement.sentence, article.title);
  const statement = date.statement;
  const text = articleText(html);
  if (!text.includes(statement.sentence) || !text.includes(statement.model.name)) return denied('unverifiable_quote', '发布摘录与标准正文不一致');
  return {
    eligible: true,
    record: { name: statement.model.name, kind, date: date.value, summary: `${statement.model.name} ${kind}；官网原文明确确认，日期为 ${date.value}。` },
    evidence: {
      text, title: article.title,
      quotes: { modelName: statement.model.name, eventType: statement.sentence, eventDate: date.quote },
      dateBasis: { type: date.type, value: date.value, quote: date.quote, field: date.field },
      ruleVersion: AUTO_REVIEW_VERSION,
    },
  };
}
