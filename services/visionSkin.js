/**
 * SKIN OS Vision — Claude Vision API 피부 분석 서비스
 *
 * 사용자 셀카를 Claude Vision으로 분석하여 6개 피부 타입 적합도 점수 +
 * 6개 바이오마커를 반환. 분석 결과를 skinProfiles[]에 저장하고
 * Phase 1 성분 분석 결과와 매칭하여 개인화 제품 추천을 생성한다.
 *
 * 핵심 기능:
 * 1. 사진 → Claude Vision → 구조화 JSON (skin_scores + biomarkers)
 * 2. skinProfiles[] 저장 (분석 이력 + 추적 히스토리)
 * 3. 동의 기반 학습 데이터 수집 (anonymized, Phase 3 자체 모델용)
 * 4. 제품 적합도 스코어링 (Phase 1 ingredientAnalysis.result와 매칭)
 * 5. 사진 즉시 삭제 — finally 블록 보장 (PRIVACY)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk').default;

// Anthropic 클라이언트
let anthropicClient = null;
const VISION_MODEL = 'claude-opus-4-6'; // Vision 정확도 최우선

// 외부 참조 (server.js에서 주입)
let productsRef = null;
let skinProfilesRef = null;
let saveCallback = null;

// Privacy: 학습 데이터 익명화 솔트
const ANON_SALT = process.env.SKIN_OS_ANON_SALT || 'datepalmbay-skin-os-salt-2025';

// ───────────────────────────────────────────
// 초기화
// ───────────────────────────────────────────

/**
 * 초기화 — server.js loadData() 완료 후 호출
 * @param {{ productsRef: Array, skinProfilesRef: Array, onSave: Function }} refs
 */
function initialize(refs) {
  productsRef = refs.productsRef;
  skinProfilesRef = refs.skinProfilesRef;
  saveCallback = refs.onSave || null;

  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (apiKey && apiKey.startsWith('sk-ant-')) {
    try {
      anthropicClient = new Anthropic({ apiKey });
      console.log('👁️  SKIN OS Vision initialized (model: ' + VISION_MODEL + ')');
    } catch (e) {
      console.error('❌ SKIN OS Vision Claude 초기화 실패:', e.message);
      anthropicClient = null;
    }
  } else {
    console.log('⚠️  SKIN OS Vision: ANTHROPIC_API_KEY 미설정 — 피부 분석 비활성화');
  }
}

function isClaudeAvailable() {
  return anthropicClient !== null;
}

// ───────────────────────────────────────────
// 프로필 조회/생성
// ───────────────────────────────────────────

function findProfile(userId) {
  if (!skinProfilesRef) return null;
  return skinProfilesRef.find(p => p.userId === userId) || null;
}

function getOrCreateProfile(userId) {
  let profile = findProfile(userId);
  if (!profile) {
    profile = {
      userId,
      analyzedAt: null,
      source: 'CLAUDE_VISION',
      skinScores: null,
      biomarkers: null,
      confidence: null,
      trackingHistory: [],
      trainingData: [],
    };
    skinProfilesRef.push(profile);
  }
  return profile;
}

// ───────────────────────────────────────────
// Claude Vision 프롬프트
// ───────────────────────────────────────────

const VISION_SYSTEM_PROMPT = `You are SKIN OS Vision, an expert dermatological image analyst specializing in K-Beauty products for the Middle East & Africa (MENA) markets via datepalmbay.com.

Analyze the provided facial photo and return structured JSON skin assessment scores only.

Rules:
- All scores 0–100 (100 = best/healthiest condition)
- skin_scores: how much this person's skin NEEDS each product type (100 = strong need/concern, 0 = no concern)
  Example: very dry skin → dry:90, oily:10
- biomarkers: objective skin condition measurements (100 = optimal/healthy)
  moisture: hydration level, sebum: oil balance (100=perfect balance), pores: pore clarity,
  wrinkles: skin smoothness (100=no wrinkles), elasticity: firmness, evenness: tone uniformity
- confidence: your confidence in this analysis (0–100), lower if photo quality is poor
- analysis_notes: one sentence about photo quality or notable observations (English)
- Consider MENA climate context: hot, humid, arid — factor into recommendations
- Return ONLY raw JSON. No markdown, no code blocks, no explanation.`;

// ───────────────────────────────────────────
// 피부 분석 실행
// ───────────────────────────────────────────

/**
 * 피부 사진 분석
 * @param {string} userId
 * @param {object} file - multer file object (path, mimetype, size)
 * @param {boolean} consentToStore - 학습 데이터 익명 저장 동의
 * @returns {Promise<{ ok: boolean, data?: object, message?: string }>}
 */
async function analyzePhoto(userId, file, consentToStore = false) {
  if (!anthropicClient) {
    // 파일이 있으면 삭제
    if (file && file.path && fs.existsSync(file.path)) {
      try { fs.unlinkSync(file.path); } catch (e) { /* ignore */ }
    }
    return { ok: false, message: 'ANTHROPIC_API_KEY가 설정되지 않았습니다. Railway 환경변수를 확인하세요.' };
  }

  if (!file || !file.path) {
    return { ok: false, message: '업로드된 사진 파일이 없습니다.' };
  }

  // 지원 미디어 타입 검증
  const supportedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
  const mediaType = file.mimetype || 'image/jpeg';
  if (!supportedTypes.includes(mediaType)) {
    try { fs.unlinkSync(file.path); } catch (e) { /* ignore */ }
    return { ok: false, message: '지원하지 않는 이미지 형식입니다. JPEG, PNG, WebP만 가능합니다.' };
  }

  let base64Data = null;

  try {
    // 파일 읽기 → base64 변환
    const buffer = fs.readFileSync(file.path);
    base64Data = buffer.toString('base64');
  } finally {
    // 파일 즉시 삭제 (PRIVACY — 분석 전/후 무조건)
    try {
      if (fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
        console.log(`🗑️  [SKIN OS Vision] 업로드 파일 삭제 완료: ${path.basename(file.path)}`);
      }
    } catch (deleteErr) {
      console.error('⚠️  [SKIN OS Vision] 파일 삭제 실패 (계속 진행):', deleteErr.message);
    }
  }

  if (!base64Data) {
    return { ok: false, message: '이미지 파일을 읽을 수 없습니다.' };
  }

  console.log(`\n👁️  [SKIN OS Vision] 피부 분석 시작: userId=${userId}`);
  console.log(`  모델: ${VISION_MODEL}`);
  console.log(`  파일 크기: ${(file.size / 1024).toFixed(1)}KB`);
  console.log(`  동의 여부: ${consentToStore ? '학습 데이터 저장 동의' : '즉시 삭제'}`);

  try {
    const response = await anthropicClient.messages.create({
      model: VISION_MODEL,
      max_tokens: 600,
      system: VISION_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: base64Data,
            },
          },
          {
            type: 'text',
            text: `Analyze this face photo. Return ONLY raw JSON (no markdown, no code blocks):
{
  "skin_scores": {"dry":0,"oily":0,"sensitive":0,"combination":0,"aging":0,"acne":0},
  "biomarkers": {"moisture":0,"sebum":0,"pores":0,"wrinkles":0,"elasticity":0,"evenness":0},
  "confidence": 0,
  "analysis_notes": ""
}`,
          },
        ],
      }],
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
      console.error('[SKIN OS Vision] JSON 파싱 실패:', parseErr.message);
      return { ok: false, message: 'Claude Vision 응답을 JSON으로 파싱할 수 없습니다.', rawResponse: responseText };
    }

    // 결과 검증
    if (!result.skin_scores || !result.biomarkers) {
      return { ok: false, message: 'Claude Vision 응답 형식이 올바르지 않습니다.', rawResponse: responseText };
    }

    const now = new Date().toISOString();

    // 프로필 업데이트
    const profile = getOrCreateProfile(userId);

    // 이전 분석이 있으면 trackingHistory에 추가
    if (profile.skinScores && profile.analyzedAt) {
      profile.trackingHistory.push({
        date: profile.analyzedAt,
        skinScores: { ...profile.skinScores },
      });
      // 최근 90일 히스토리만 보관
      if (profile.trackingHistory.length > 90) {
        profile.trackingHistory = profile.trackingHistory.slice(-90);
      }
    }

    profile.analyzedAt = now;
    profile.source = 'CLAUDE_VISION';
    profile.skinScores = result.skin_scores;
    profile.biomarkers = result.biomarkers;
    profile.confidence = result.confidence ?? null;

    // 학습 데이터 저장 (동의한 경우)
    if (consentToStore && base64Data) {
      const anonymizedId = crypto
        .createHash('sha256')
        .update(userId + ANON_SALT)
        .digest('hex');

      profile.trainingData.push({
        anonymizedId,
        imageBase64: base64Data,
        labels: {
          skinScores: { ...result.skin_scores },
          biomarkers: { ...result.biomarkers },
        },
        storedAt: now,
      });

      // 최대 10개 학습 데이터 보관 (오래된 것 제거)
      if (profile.trainingData.length > 10) {
        profile.trainingData = profile.trainingData.slice(-10);
      }

      console.log(`📚 [SKIN OS Vision] 학습 데이터 저장 (anonymized): ${anonymizedId.substring(0, 8)}...`);
    }

    if (saveCallback) saveCallback();

    console.log(`✅ [SKIN OS Vision] 분석 완료: userId=${userId}`);
    console.log(`  dry:${result.skin_scores.dry} oily:${result.skin_scores.oily} sensitive:${result.skin_scores.sensitive} aging:${result.skin_scores.aging}`);
    console.log(`  moisture:${result.biomarkers.moisture} elasticity:${result.biomarkers.elasticity} confidence:${result.confidence}`);

    return {
      ok: true,
      data: {
        skinScores: result.skin_scores,
        biomarkers: result.biomarkers,
        confidence: result.confidence ?? null,
        analyzedAt: now,
        source: 'CLAUDE_VISION',
      },
    };
  } catch (err) {
    console.error('[SKIN OS Vision] Claude API 호출 실패:', err.message);
    return { ok: false, message: err.message || 'Claude Vision API 호출 중 오류가 발생했습니다.' };
  }
}

// ───────────────────────────────────────────
// 프로필 조회
// ───────────────────────────────────────────

/**
 * 사용자 피부 프로필 조회
 * @param {string} userId
 * @returns {{ ok: boolean, data?: object|null }}
 */
function getProfile(userId) {
  const profile = findProfile(userId);

  if (!profile || !profile.skinScores) {
    return { ok: true, data: null }; // 미분석 사용자는 null (에러 아님)
  }

  return {
    ok: true,
    data: {
      skinScores: profile.skinScores,
      biomarkers: profile.biomarkers,
      confidence: profile.confidence,
      analyzedAt: profile.analyzedAt,
      source: profile.source,
      trackingHistory: profile.trackingHistory || [],
    },
  };
}

// ───────────────────────────────────────────
// 프로필 삭제 (GDPR)
// ───────────────────────────────────────────

/**
 * 사용자 피부 프로필 삭제
 * @param {string} userId
 * @returns {{ ok: boolean, message?: string }}
 */
function deleteProfile(userId) {
  if (!skinProfilesRef) {
    return { ok: false, message: '데이터를 찾을 수 없습니다.' };
  }

  const idx = skinProfilesRef.findIndex(p => p.userId === userId);
  if (idx === -1) {
    return { ok: false, message: '피부 프로필이 없습니다.' };
  }

  skinProfilesRef.splice(idx, 1);
  if (saveCallback) saveCallback();

  console.log(`🗑️  [SKIN OS Vision] 프로필 삭제: userId=${userId}`);
  return { ok: true };
}

// ───────────────────────────────────────────
// 추천 스코어링
// ───────────────────────────────────────────

/**
 * 사용자 피부 점수와 제품 성분 분석 점수를 매칭해 적합도 계산
 * @param {object} product
 * @param {object} userSkinScores - { dry, oily, sensitive, combination, aging, acne }
 * @returns {number} 0–100
 */
function scoreProductForUser(product, userSkinScores) {
  const productScores = product.ingredientAnalysis?.result?.skin_scores;
  if (!productScores) return 0;

  // 피부 타입별 가중치 (민감성/여드름성/노화 더 중요)
  const weights = {
    dry: 1.0,
    oily: 1.0,
    sensitive: 1.2,
    combination: 0.8,
    aging: 1.1,
    acne: 1.1,
  };

  let score = 0;
  let totalWeight = 0;

  for (const [type, w] of Object.entries(weights)) {
    const userNeed = (userSkinScores[type] || 0) / 100;
    const productFit = (productScores[type] || 0) / 100;
    score += userNeed * productFit * w;
    totalWeight += userNeed * w;
  }

  return totalWeight > 0 ? Math.round((score / totalWeight) * 100) : 0;
}

/**
 * 사용자 맞춤 제품 추천 목록
 * @param {string} userId
 * @returns {{ ok: boolean, data?: Array, message?: string }}
 */
function getRecommendations(userId) {
  const profile = findProfile(userId);

  if (!profile || !profile.skinScores) {
    return { ok: false, message: '피부 분석 결과가 없습니다. 먼저 피부 분석을 진행해주세요.' };
  }

  if (!productsRef) {
    return { ok: false, message: '상품 데이터를 불러올 수 없습니다.' };
  }

  // 판매 중이고 성분 분석 완료된 상품만
  const analyzedProducts = productsRef.filter(
    p => p.productSaleStatus && p.ingredientAnalysis?.result
  );

  if (analyzedProducts.length === 0) {
    return { ok: true, data: [] };
  }

  // 적합도 점수 계산 + 정렬
  const scored = analyzedProducts
    .map(product => ({
      productCode: product.productCode,
      productName: product.productName || '',
      productImage: product.mainImages?.[0] || '',
      productPrice: product.productPrice || 0,
      brandName: product.brand?.brandName || '',
      compatibilityScore: scoreProductForUser(product, profile.skinScores),
      skinScores: product.ingredientAnalysis.result.skin_scores,
      keyIngredients: (product.ingredientAnalysis.result.key_ingredients || []).slice(0, 5),
      routinePlacement: product.ingredientAnalysis.result.routine_placement || null,
      summary: product.ingredientAnalysis.result.summary || '',
    }))
    .sort((a, b) => b.compatibilityScore - a.compatibilityScore)
    .slice(0, 20); // 최대 20개

  return { ok: true, data: scored };
}

/**
 * 단일 제품의 호환성 상세 (적합도 + 매칭 근거)
 * @param {string} userId
 * @param {string} productCode
 * @returns {{ ok: boolean, data?: object, message?: string }}
 */
function getProductCompatibility(userId, productCode) {
  const profile = findProfile(userId);

  if (!profile || !profile.skinScores) {
    return { ok: true, data: null }; // 프로필 없으면 null (에러 아님)
  }

  const product = productsRef?.find(p => p.productCode === productCode);
  if (!product || !product.ingredientAnalysis?.result) {
    return { ok: true, data: null };
  }

  const result = product.ingredientAnalysis.result;
  const compatibilityScore = scoreProductForUser(product, profile.skinScores);

  // 매칭된 피부 타입 (사용자 점수 ≥ 50 + 제품 점수 ≥ 60)
  const matchedNeeds = [];
  const skinTypeKo = {
    dry: '건성', oily: '지성', sensitive: '민감성',
    combination: '복합성', aging: '노화', acne: '여드름성',
  };
  for (const [type, label] of Object.entries(skinTypeKo)) {
    const userScore = profile.skinScores[type] || 0;
    const productScore = result.skin_scores[type] || 0;
    if (userScore >= 50 && productScore >= 60) {
      matchedNeeds.push({ type, label, userScore, productScore });
    }
  }

  // 주의 성분 (caution_ingredients에서)
  const cautions = result.caution_ingredients || [];

  return {
    ok: true,
    data: {
      productCode,
      compatibilityScore,
      matchedNeeds,
      cautions,
      routinePlacement: result.routine_placement || null,
    },
  };
}

// ───────────────────────────────────────────
// 헬스체크
// ───────────────────────────────────────────

function getStatus() {
  return {
    claudeAvailable: isClaudeAvailable(),
    model: VISION_MODEL,
    profileCount: skinProfilesRef?.length || 0,
  };
}

module.exports = {
  initialize,
  isClaudeAvailable,
  analyzePhoto,
  getProfile,
  deleteProfile,
  getRecommendations,
  getProductCompatibility,
  getStatus,
};
