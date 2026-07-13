/**
 * Content Translator Service
 *
 * 상품 설명 / SNS 리뷰 텍스트를 Claude AI로 아랍어(ar)·프랑스어(fr)로 번역해
 * 원본 객체에 캐싱한다. services/claudeReviewSummarizer.js와 동일한 초기화·호출 패턴을 따른다.
 */

const crypto = require('crypto');

const Anthropic = require('@anthropic-ai/sdk').default;

let anthropicClient = null;
const AI_MODEL = process.env.AI_MODEL || 'claude-haiku-4-5-20251001';
const AI_PROVIDER = process.env.AI_PROVIDER || 'keyword';

const SUPPORTED_LANGS = ['ar', 'fr'];
const LANG_NAMES = { ar: 'Arabic', fr: 'French' };

/**
 * 초기화 — server.js에서 호출 (claudeReviewSummarizer와 같은 ANTHROPIC_API_KEY 재사용)
 */
function initialize() {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (apiKey && apiKey.startsWith('sk-ant-')) {
    try {
      anthropicClient = new Anthropic({ apiKey });
      console.log('🌐 Content Translator initialized (model: ' + AI_MODEL + ')');
    } catch (e) {
      console.error('❌ Content Translator 초기화 실패:', e.message);
      anthropicClient = null;
    }
  } else {
    console.log('⚠️  ANTHROPIC_API_KEY not configured — content translation disabled');
  }
}

function isAvailable() {
  return AI_PROVIDER === 'claude' && anthropicClient !== null;
}

function isSupportedLang(lang) {
  return SUPPORTED_LANGS.includes(lang);
}

/**
 * 필드 값들의 해시 — 원본이 안 바뀌었으면 재번역을 건너뛰기 위함
 */
function hashFields(fields) {
  const str = Object.values(fields).map((v) => v || '').join('␟');
  return crypto.createHash('sha1').update(str).digest('hex');
}

/**
 * 필드 묶음을 한 번의 Claude 호출로 번역
 * fields: { key: string } 형태. HTML 태그가 섞여있어도 태그 구조는 보존하고 텍스트만 번역하도록 지시.
 */
async function translateFields(fields, targetLang) {
  if (!anthropicClient) {
    throw new Error('Claude AI client not initialized');
  }
  if (!isSupportedLang(targetLang)) {
    throw new Error(`Unsupported target language: ${targetLang}`);
  }

  const entries = Object.entries(fields).filter(([, v]) => v);
  if (entries.length === 0) return {};

  const langName = LANG_NAMES[targetLang];
  const systemPrompt = `You are a professional e-commerce translator for Datepalm Bay, a K-Beauty platform.
Translate the given JSON fields from English into ${langName}.
Rules:
- Preserve the original tone and marketing intent.
- If a field's value contains HTML tags, keep the tag structure and attributes exactly as-is and only translate the human-readable text nodes — never translate tag names or attribute values.
- Do not translate brand names, product codes, or numbers/units.
- Return ONLY a raw JSON object (no markdown, no code fences) with exactly the same keys as the input, each value replaced by its ${langName} translation.`;

  const userPrompt = `Translate these fields to ${langName}:\n\n${JSON.stringify(Object.fromEntries(entries), null, 2)}`;

  const response = await anthropicClient.messages.create({
    model: AI_MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const responseText = response.content[0]?.text || '';
  let jsonStr = responseText.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  return JSON.parse(jsonStr);
}

/**
 * 상품 텍스트 필드 번역 (productName/introduction/detailInfo/정책 3종)
 * product.translations = { ar: {...fields, sourceHash, translatedAt}, fr: {...} }
 * 이미 최신 상태인 언어는 건너뛰고, 변경분만 재번역한다. 변경이 있으면 true를 반환.
 */
async function translateProductFields(product) {
  if (!isAvailable()) return false;

  const sourceFields = {
    productName: product.productName || '',
    introduction: product.introduction || '',
    detailInfo: product.detailInfo || '',
    deliveryPolicy: product.policy?.deliveryPolicy || '',
    exchangePolicy: product.policy?.exchangePolicy || '',
    refundPolicy: product.policy?.refundPolicy || '',
  };
  const sourceHash = hashFields(sourceFields);

  if (!product.translations) product.translations = {};
  let changed = false;

  for (const lang of SUPPORTED_LANGS) {
    if (product.translations[lang]?.sourceHash === sourceHash) continue;
    try {
      const translated = await translateFields(sourceFields, lang);
      product.translations[lang] = { ...translated, sourceHash, translatedAt: new Date().toISOString() };
      changed = true;
      console.log(`🌐 상품 번역 완료: ${product.productCode} → ${lang}`);
    } catch (error) {
      console.error(`❌ 상품 번역 실패 (${product.productCode} → ${lang}):`, error.message);
    }
  }

  return changed;
}

/**
 * SNS 리뷰 텍스트 필드 번역 (title/description)
 * review.translations = { ar: {...}, fr: {...} }
 */
async function translateSnsReviewFields(review) {
  if (!isAvailable()) return false;

  const sourceFields = {
    title: review.title || '',
    description: review.description || '',
  };
  const sourceHash = hashFields(sourceFields);

  if (!review.translations) review.translations = {};
  let changed = false;

  for (const lang of SUPPORTED_LANGS) {
    if (review.translations[lang]?.sourceHash === sourceHash) continue;
    try {
      const translated = await translateFields(sourceFields, lang);
      review.translations[lang] = { ...translated, sourceHash, translatedAt: new Date().toISOString() };
      changed = true;
    } catch (error) {
      console.error(`❌ SNS 리뷰 번역 실패 (${review.id} → ${lang}):`, error.message);
    }
  }

  return changed;
}

/**
 * 임의의 짧은 텍스트(예: AI 요약 결과)를 번역 — 결과 캐싱은 호출부 책임
 */
async function translateText(text, targetLang) {
  if (!text) return text;
  const result = await translateFields({ text }, targetLang);
  return result.text || text;
}

module.exports = {
  initialize,
  isAvailable,
  isSupportedLang,
  SUPPORTED_LANGS,
  hashFields,
  translateFields,
  translateProductFields,
  translateSnsReviewFields,
  translateText,
};
