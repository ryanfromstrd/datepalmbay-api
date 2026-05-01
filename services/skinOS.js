/**
 * SKIN OS — Ingredient Analysis Service
 *
 * K-Beauty 제품의 INCI 성분표를 Claude AI로 분석하여 피부 타입별 적합도 점수,
 * 핵심 성분, 주의 성분, 루틴 배치 정보를 구조화된 JSON으로 반환한다.
 *
 * 핵심 기능:
 * 1. INCI 성분 분석 & 피부 적합도 점수 생성 (Claude API)
 * 2. 분석 결과를 product.ingredientAnalysis에 embedded 저장
 * 3. 60분 TTL 캐시 (productCode 기반)
 * 4. Admin 수동 편집 지원 (isManualOverride)
 * 5. Claude 미설정 시 명확한 에러 반환 (keyword fallback 없음)
 */

const Anthropic = require('@anthropic-ai/sdk').default;

// Anthropic 클라이언트
let anthropicClient = null;
const AI_MODEL = process.env.AI_MODEL || 'claude-sonnet-4-6';

// 외부 참조 (server.js에서 주입)
let productsRef = null;
let saveCallback = null;

// 분석 캐시 (productCode → { result, inciText, timestamp })
const analysisCache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 60분

// ───────────────────────────────────────────
// 초기화
// ───────────────────────────────────────────

/**
 * 초기화 — server.js loadData() 완료 후 호출
 * @param {{ productsRef: Array, onSave: Function }} refs
 */
function initialize(refs) {
  productsRef = refs.productsRef;
  saveCallback = refs.onSave || null;

  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (apiKey && apiKey.startsWith('sk-ant-')) {
    try {
      anthropicClient = new Anthropic({ apiKey });
      console.log('🧴 SKIN OS Ingredient Analyzer initialized (model: ' + AI_MODEL + ')');
    } catch (e) {
      console.error('❌ SKIN OS Claude 초기화 실패:', e.message);
      anthropicClient = null;
    }
  } else {
    console.log('⚠️  SKIN OS: ANTHROPIC_API_KEY 미설정 — 성분 분석 비활성화');
  }
}

/**
 * Claude AI 사용 가능 여부
 */
function isClaudeAvailable() {
  return anthropicClient !== null;
}

// ───────────────────────────────────────────
// 제품 조회
// ───────────────────────────────────────────

function findProduct(productCode) {
  if (!productsRef) return null;
  return productsRef.find(p => p.productCode === productCode) || null;
}

const DEFAULT_ANALYSIS = {
  inciText: '',
  adminDirection: '',
  analyzedAt: null,
  analysisVersion: 0,
  isManualOverride: false,
  overriddenAt: null,
  result: null,
};

/**
 * product.ingredientAnalysis 초기화 (없을 때만).
 * 주의: 이 함수는 product를 직접 변경하며, 호출 후 saveCallback()을 반드시 호출해야 한다.
 */
function ensureIngredientAnalysis(product) {
  if (!product.ingredientAnalysis) {
    product.ingredientAnalysis = { ...DEFAULT_ANALYSIS };
  }
  return product.ingredientAnalysis;
}

// ───────────────────────────────────────────
// 캐시
// ───────────────────────────────────────────

function getCached(productCode) {
  const entry = analysisCache.get(productCode);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    analysisCache.delete(productCode);
    return null;
  }
  return entry;
}

function setCached(productCode, result, inciText) {
  analysisCache.set(productCode, { result, inciText, timestamp: Date.now() });
}

function invalidateCache(productCode) {
  analysisCache.delete(productCode);
}

// ───────────────────────────────────────────
// Claude 분석
// ───────────────────────────────────────────

const SYSTEM_PROMPT = `You are SKIN OS, an expert cosmetic ingredient analyst specializing in K-Beauty formulations sold to Middle East & Africa (MENA) markets via datepalmbay.com.

Your task: analyze INCI (International Nomenclature of Cosmetic Ingredients) lists and return a structured JSON analysis.

Rules:
- skin_scores (0–100): suitability of THIS product for each skin concern. 100 = perfect fit, 0 = terrible fit or potentially harmful.
  Example: a heavy occlusive cream = high dry score (90), low oily score (20).
- Concentration estimation from INCI list position: ingredients 1–5 = "high", 6–15 = "medium", 16+ = "low".
- Include 8–12 key_ingredients that best represent the formula.
- caution_ingredients: ONLY evidence-based concerns (known irritants, allergens, comedogenic for acne-prone). Leave empty [] if none.
- All user-facing text in Korean: function labels, routine_placement fields, missing_coverage items, summary.
- Ingredient names in English (INCI standard).
- Consider MENA climate context: hot, humid, and arid environments. Factor this into routine recommendations.
- Return ONLY a raw JSON object. No markdown, no code blocks, no explanation text.`;

/**
 * INCI 성분 분석 실행
 * @param {string} productCode
 * @param {string} inciText - INCI 성분 목록 (쉼표 또는 줄바꿈 구분)
 * @param {string} adminDirection - 분석 방향 힌트 (선택)
 * @returns {Promise<{ ok: boolean, data?: object, message?: string }>}
 */
async function analyzeIngredients(productCode, inciText, adminDirection = '') {
  if (!anthropicClient) {
    return { ok: false, message: 'ANTHROPIC_API_KEY가 설정되지 않았습니다. Railway 환경변수를 확인하세요.' };
  }

  if (!inciText || !inciText.trim()) {
    return { ok: false, message: 'INCI 성분 목록이 비어있습니다.' };
  }

  const trimmedINCT = inciText.trim();

  // 60분 캐시 확인 — 동일 INCI 텍스트면 재분석 생략
  const cached = getCached(productCode);
  if (cached && cached.inciText === trimmedINCT) {
    console.log(`✅ [SKIN OS] Cache hit: ${productCode}`);
    const product = findProduct(productCode);
    return {
      ok: true,
      data: {
        productCode,
        inciText: trimmedINCT,
        adminDirection: adminDirection?.trim() || '',
        analyzedAt: product?.ingredientAnalysis?.analyzedAt,
        analysisVersion: product?.ingredientAnalysis?.analysisVersion,
        isManualOverride: false,
        result: cached.result,
        aiStatus: { claudeAvailable: true, model: AI_MODEL },
      },
    };
  }
  const directionLine = adminDirection?.trim()
    ? `[Admin Direction]: ${adminDirection.trim()}`
    : '[Admin Direction]: 없음';

  const userPrompt = `${directionLine}

INCI Ingredient List:
${trimmedINCT}

Return ONLY raw JSON (no markdown, no code blocks):
{
  "skin_scores": {"dry": 0, "oily": 0, "sensitive": 0, "combination": 0, "aging": 0, "acne": 0},
  "key_ingredients": [{"name": "", "function": "", "concentration": "high|medium|low"}],
  "caution_ingredients": [],
  "routine_placement": {"recommended_time": "morning|evening|both", "step": "", "ph_note": ""},
  "missing_coverage": [],
  "summary": ""
}

Include 8–12 key_ingredients. Leave caution_ingredients as [] if no evidence-based concerns.`;

  console.log(`\n🧴 [SKIN OS] 성분 분석 시작: ${productCode}`);
  console.log(`  모델: ${AI_MODEL}`);
  console.log(`  성분 수 (추정): ${trimmedINCT.split(',').length}개`);
  if (adminDirection?.trim()) {
    console.log(`  Admin Direction: ${adminDirection.trim().substring(0, 80)}...`);
  }

  try {
    const response = await anthropicClient.messages.create({
      model: AI_MODEL,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const responseText = response.content[0]?.text || '';

    // JSON 파싱 (코드 블록 래핑 제거)
    let jsonStr = responseText.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    let result;
    try {
      result = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.error('[SKIN OS] JSON 파싱 실패:', parseErr.message);
      console.error('[SKIN OS] Raw response:', responseText.substring(0, 500));
      return {
        ok: false,
        message: 'Claude 응답을 JSON으로 파싱할 수 없습니다.',
        rawResponse: responseText,
      };
    }

    // 결과 검증
    if (!result.skin_scores || !result.key_ingredients) {
      return {
        ok: false,
        message: 'Claude 응답 형식이 올바르지 않습니다.',
        rawResponse: responseText,
      };
    }

    // product.ingredientAnalysis 업데이트
    const product = findProduct(productCode);
    if (product) {
      const analysis = ensureIngredientAnalysis(product);
      analysis.inciText = trimmedINCT;
      analysis.adminDirection = adminDirection?.trim() || '';
      analysis.analyzedAt = new Date().toISOString();
      analysis.analysisVersion = (analysis.analysisVersion || 0) + 1;
      analysis.isManualOverride = false;
      analysis.result = result;

      if (saveCallback) saveCallback();
    }

    // 캐시 저장
    setCached(productCode, result, trimmedINCT);

    console.log(`✅ [SKIN OS] 분석 완료: ${productCode}`);
    console.log(`  dry:${result.skin_scores.dry} oily:${result.skin_scores.oily} sensitive:${result.skin_scores.sensitive} aging:${result.skin_scores.aging}`);
    console.log(`  핵심 성분: ${result.key_ingredients.length}개, 주의 성분: ${result.caution_ingredients?.length || 0}개`);

    return {
      ok: true,
      data: {
        productCode,
        inciText: trimmedINCT,
        adminDirection: adminDirection?.trim() || '',
        analyzedAt: product?.ingredientAnalysis?.analyzedAt,
        analysisVersion: product?.ingredientAnalysis?.analysisVersion,
        isManualOverride: false,
        result,
        aiStatus: { claudeAvailable: true, model: AI_MODEL },
      },
    };
  } catch (err) {
    console.error('[SKIN OS] Claude API 호출 실패:', err.message);
    return {
      ok: false,
      message: err.message || 'Claude API 호출 중 오류가 발생했습니다.',
    };
  }
}

// ───────────────────────────────────────────
// 분석 결과 조회
// ───────────────────────────────────────────

/**
 * 현재 성분 분석 결과 조회
 * @param {string} productCode
 * @returns {{ ok: boolean, data?: object }}
 */
function getAnalysis(productCode) {
  const product = findProduct(productCode);
  if (!product) {
    return { ok: false, message: '상품을 찾을 수 없습니다.' };
  }

  const analysis = product.ingredientAnalysis || { ...DEFAULT_ANALYSIS };

  return {
    ok: true,
    data: {
      productCode,
      inciText: analysis.inciText || '',
      adminDirection: analysis.adminDirection || '',
      analyzedAt: analysis.analyzedAt,
      overriddenAt: analysis.overriddenAt || null,
      analysisVersion: analysis.analysisVersion || 0,
      isManualOverride: analysis.isManualOverride || false,
      result: analysis.result,
      aiStatus: {
        claudeAvailable: isClaudeAvailable(),
        model: AI_MODEL,
      },
    },
  };
}

// ───────────────────────────────────────────
// 수동 편집 (Override)
// ───────────────────────────────────────────

/**
 * Admin 수동 편집 결과 저장
 * @param {string} productCode
 * @param {object} result - 수정된 IngredientAnalysisResult
 * @param {string} adminDirection
 * @returns {{ ok: boolean, data?: object, message?: string }}
 */
function saveOverride(productCode, result, adminDirection = '') {
  const product = findProduct(productCode);
  if (!product) {
    return { ok: false, message: '상품을 찾을 수 없습니다.' };
  }

  const analysis = ensureIngredientAnalysis(product);
  analysis.result = result;
  analysis.adminDirection = adminDirection?.trim() || analysis.adminDirection || '';
  analysis.isManualOverride = true;
  analysis.overriddenAt = new Date().toISOString();
  // analyzedAt은 Claude 분석 시점을 보존 — 수동 편집 시 갱신하지 않음

  invalidateCache(productCode);
  if (saveCallback) saveCallback();

  console.log(`✏️  [SKIN OS] 수동 편집 저장: ${productCode}`);

  return {
    ok: true,
    data: {
      productCode,
      inciText: analysis.inciText || '',
      adminDirection: analysis.adminDirection,
      analyzedAt: analysis.analyzedAt,
      overriddenAt: analysis.overriddenAt,
      analysisVersion: analysis.analysisVersion || 0,
      isManualOverride: true,
      result,
    },
  };
}

/**
 * 수동 편집 취소 — Claude 분석 결과 유지, isManualOverride 해제
 * (result는 변경하지 않음 — Claude 결과가 이미 result에 있음)
 * @param {string} productCode
 * @returns {{ ok: boolean, data?: object, message?: string }}
 */
function resetOverride(productCode) {
  const product = findProduct(productCode);
  if (!product) {
    return { ok: false, message: '상품을 찾을 수 없습니다.' };
  }

  if (!product.ingredientAnalysis) {
    return { ok: false, message: '성분 분석 데이터가 없습니다.' };
  }

  product.ingredientAnalysis.isManualOverride = false;
  if (saveCallback) saveCallback();

  console.log(`🔄 [SKIN OS] 수동 편집 해제: ${productCode}`);

  return {
    ok: true,
    data: {
      productCode,
      ...product.ingredientAnalysis,
    },
  };
}

// ───────────────────────────────────────────
// 공개 API용 — 고객 FE (Phase 2)
// ───────────────────────────────────────────

/**
 * 고객용 성분 분석 결과 조회 (내부 메타 제거)
 * @param {string} productCode
 * @returns {{ ok: boolean, data?: object, message?: string }}
 */
function getPublicAnalysis(productCode) {
  const product = findProduct(productCode);
  if (!product) {
    return { ok: false, message: '상품을 찾을 수 없습니다.' };
  }

  // 판매 중인 상품만 공개
  if (!product.productSaleStatus) {
    return { ok: false, message: '상품 정보를 조회할 수 없습니다.' };
  }

  const analysis = product.ingredientAnalysis;
  if (!analysis || !analysis.result) {
    return { ok: true, data: null }; // 미분석 상품은 null 반환 (에러 아님)
  }

  return {
    ok: true,
    data: {
      productCode,
      result: analysis.result,
      analyzedAt: analysis.analyzedAt,
    },
  };
}

// ───────────────────────────────────────────
// 헬스체크
// ───────────────────────────────────────────

function getStatus() {
  return {
    claudeAvailable: isClaudeAvailable(),
    model: AI_MODEL,
    cacheSize: analysisCache.size,
  };
}

module.exports = {
  initialize,
  isClaudeAvailable,
  analyzeIngredients,
  getAnalysis,
  saveOverride,
  resetOverride,
  getPublicAnalysis,
  getStatus,
};
