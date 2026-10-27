import { sourceFor } from './review.mjs';

// These are discovery cues for display order, never evidence for publication.
const MODEL = /\b(?:gpt[ -](?:oss[ -])?\d|gpt[ -]rosalind|o[134](?:\b|[ -])|claude[ -](?:(?:opus|sonnet|haiku|fable)[ -])?\d|gemini[ -]?\d|gemma[ -]?\d|deepseek[ -]?[vr]\d|qwen[ -]?\d|kimi[ -]?k\d|glm[ -]?\d|grok[ -]?\d|llama[ -]?\d|mistral[ -](?:large|medium|small|\d)|mixtral[ -]?\d|minimax[ -]?m\d|muse[ -](?:spark|wonder))|通义千问\s*\d|智谱\s*\d/i;
const FAMILY = /\b(?:gpt|claude|gemini|gemma|deepseek|qwen|kimi|glm|grok|llama|mistral|mixtral|minimax|muse)\b|通义千问|大模型|语言模型|基础模型|推理模型|多模态模型/i;
const RELEASE = /\b(?:introducing|welcome|announc\w*|releas\w*|launch\w*|unveil\w*|debut\w*|preview|now available|open[ -]sourc\w*|open[ -]weights?|api (?:access|release|launch)|new model)\b|发布|推出|上线|预览|开源|开放权重/i;
const FOUNDATION = /\b(?:(?:large )?language|foundation|reasoning|coding|multimodal) models?\b|\bnew (?:open )?models?\b|\b\d+(?:\.\d+)?[bm]\s+(?:open(?:[ -]weight)?\s+)?models?\b|大模型|语言模型|基础模型|推理模型|多模态模型/i;
const FUTURE = /\b(?:upcoming|next[ -]gen\w*|roadmap|rumou?r\w*|leak\w*|delay\w*|expected|coming|training)\b|即将|预计|传闻|爆料|路线图|下一代|暂缓|延期|训练中/i;
const SECONDARY = /\b(?:how\b|guide|tutorial|benchmark\w*|comparison|versus|vs\.?|fine[ -]tun\w*|system card|safely|responsibly|helps?|case stud\w*|customer stor\w*|matches?|powered by|using)\b|closing in on|指南|教程|测评|评测|对比|微调|应用案例|帮助|赋能/i;
const NON_MODEL = /\b(?:acquir\w*|funding|raises?|invests?|hires?|hiring|joins?|office|partnership|advertis\w*|ad stack|ads|signups|conference|summit|webinar|mission|program|plugin|mini app|robot(?:ics)?|music|speech|ocr|embedding|classifier|image generation|video generation)\b|qwen[ -]?\d+(?:\.\d+)*[ -]?guard|融资|收购|招聘|任命|合作|广告|峰会|会议|办公室|插件|小程序|机器人|图像生成|视频生成|语音合成/i;

function originalOfficial(candidate, registry) {
  return (candidate.sources || []).some(entry => {
    try { return sourceFor(registry, entry.registryId, candidate.canonicalUrl).sourceType === 'official'; }
    catch { return false; }
  });
}

function articleSlug(candidate) {
  try { return decodeURIComponent(new URL(candidate.canonicalUrl).pathname.split('/').filter(Boolean).at(-1) || '').replace(/[-_]+/g, ' '); }
  catch { return ''; }
}

function relevance(candidate, official) {
  const title = String(candidate.title || '').trim();
  const slug = articleSlug(candidate);
  const text = `${title} ${slug}`;
  if (NON_MODEL.test(title)) return 0;
  if (SECONDARY.test(title)) return FAMILY.test(text) || MODEL.test(text) ? 1 : 0;
  const named = MODEL.test(text);
  // Official blog cards sometimes contain only the model name, without a release verb.
  const plainName = official && MODEL.test(title) && title.length < 65 &&
    /^(?:GPT|o[134]\b|Claude|Gemini|Gemma|DeepSeek|Qwen|Kimi|GLM|Grok|Llama|Mistral|Mixtral|MiniMax|Muse)/i.test(title) &&
    !/[:：,，!?？]|\b(?:for|with|and|is|our|the|to)\b/i.test(title);
  if (named && !FUTURE.test(title) && (RELEASE.test(text) || plainName)) return 3;
  if (named || (FAMILY.test(text) || FOUNDATION.test(text)) && (RELEASE.test(text) || FUTURE.test(text))) return 2;
  return FAMILY.test(text) ? 1 : 0;
}

function dateKey(candidate) {
  for (const value of [candidate.publishedAt, candidate.discoveredAt]) {
    const day = typeof value === 'string' ? value.slice(0, 10) : '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(day)) && new Date(day).toISOString().startsWith(day)) return day;
  }
  return '';
}

export function sortReviewCandidates(candidates, registry) {
  return candidates.map((candidate, index) => {
    const official = originalOfficial(candidate, registry);
    return { candidate, index, official, relevance: relevance(candidate, official), date: dateKey(candidate) };
  }).sort((a, b) => b.relevance - a.relevance || b.date.localeCompare(a.date) || Number(b.official) - Number(a.official) || a.index - b.index)
    .map(entry => entry.candidate);
}
