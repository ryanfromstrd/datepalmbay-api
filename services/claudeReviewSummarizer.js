/**
 * Claude AI Review Summarizer Service
 *
 * K-Beauty 리뷰를 Claude AI로 분석하여 지속적으로 학습하고 발전하는 시스템.
 *
 * 핵심 기능:
 * 1. 리뷰 분석 & 요약 생성 (Claude API)
 * 2. 상품별 지식 축적 (productInsights)
 * 3. Admin 피드백 학습 (few-shot learning)
 * 4. 자동 재분석 트리거
 * 5. Fallback: API 키 없거나 실패 시 기존 키워드 방식 자동 전환
 */

const Anthropic = require('@anthropic-ai/sdk').default;

// Anthropic 클라이언트 (환경변수에서 API 키 로드)
let anthropicClient = null;
const AI_MODEL = process.env.AI_MODEL || 'claude-haiku-4-5-20251001';
const AI_PROVIDER = process.env.AI_PROVIDER || 'keyword'; // 'claude' or 'keyword'

// 외부 참조 (server.js에서 주입)
let productInsightsRef = null;
let aiFeedbackHistoryRef = null;
let snsReviewOverridesRef = null;
let saveCallback = null;

// 분석 캐시 (productCode → { summary, analyzedReviewIds, timestamp })
const analysisCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30분

/**
 * 초기화 — server.js에서 호출
 */
function initialize(refs) {
  productInsightsRef = refs.productInsights;
  aiFeedbackHistoryRef = refs.aiFeedbackHistory;
  snsReviewOverridesRef = refs.snsReviewOverrides;
  saveCallback = refs.onSave || null;

  // Anthropic 클라이언트 초기화
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (apiKey && apiKey.startsWith('sk-ant-')) {
    try {
      anthropicClient = new Anthropic({ apiKey });
      console.log('🤖 Claude AI Review Summarizer initialized (model: ' + AI_MODEL + ')');
    } catch (e) {
      console.error('❌ Claude AI 초기화 실패:', e.message);
      anthropicClient = null;
    }
  } else {
    console.log('⚠️  ANTHROPIC_API_KEY not configured — using keyword fallback');
  }
}

/**
 * Claude AI 사용 가능 여부
 */
function isClaudeAvailable() {
  return AI_PROVIDER === 'claude' && anthropicClient !== null;
}

/**
 * 상품별 기존 insights 조회
 */
function getProductInsights(productCode) {
  if (!productInsightsRef) return null;
  return productInsightsRef.find(i => i.productCode === productCode) || null;
}

/**
 * 상품별 피드백 이력 조회 (최근 5개)
 */
function getRecentFeedback(productCode) {
  if (!aiFeedbackHistoryRef) return [];
  return aiFeedbackHistoryRef
    .filter(f => f.productCode === productCode)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 5);
}

/**
 * 시스템 프롬프트 생성
 */
function buildSystemPrompt(productInsights, feedbackHistory, adminDirection) {
  let prompt = `You are a K-Beauty review analyst for Datepalm Bay, a global K-Beauty e-commerce platform.
Your task is to analyze YouTube video reviews about K-Beauty products and generate insights.

Guidelines:
- Write in English only
- Focus on product effectiveness, ingredients, user experience, and value
- Be specific about what reviewers mention (ingredients, results, comparisons)
- Use professional but approachable tone
- Generate relevant hashtags that customers would search for`;

  // Admin 방향 지시 (최우선)
  if (adminDirection) {
    prompt += `\n\n[IMPORTANT - Admin direction for this product]:\n${adminDirection}\nYou MUST follow this direction when analyzing reviews.`;
  }

  // 기존 분석 컨텍스트 추가
  if (productInsights && productInsights.insights) {
    prompt += `\n\n[Previous analysis for this product]:\n${productInsights.insights}`;
  }

  // Admin 피드백 few-shot 예시 추가
  if (feedbackHistory && feedbackHistory.length > 0) {
    prompt += '\n\n[Admin style preferences - learn from these corrections]:';
    for (const fb of feedbackHistory) {
      prompt += `\n- Original: "${fb.originalSummary}"\n  Corrected to: "${fb.correctedSummary}"`;
    }
    prompt += '\n\nApply these style preferences to your new analysis.';
  }

  return prompt;
}

/**
 * 리뷰 데이터를 분석용 텍스트로 변환
 */
function formatReviewsForAnalysis(reviews) {
  return reviews.map((r, i) => {
    const parts = [`Review ${i + 1}:`];
    if (r.title) parts.push(`  Title: ${r.title}`);
    if (r.description) parts.push(`  Description: ${r.description.substring(0, 500)}`);
    if (r.authorName) parts.push(`  Channel: ${r.authorName}`);
    if (r.viewCount) parts.push(`  Views: ${r.viewCount.toLocaleString()}`);
    if (r.platform) parts.push(`  Platform: ${r.platform}`);
    return parts.join('\n');
  }).join('\n\n');
}

/**
 * Claude API를 통한 리뷰 분석 & 요약 생성
 */
async function analyzeWithClaude(reviews, productCode, productName) {
  if (!anthropicClient) {
    throw new Error('Claude AI client not initialized');
  }

  const existingInsights = getProductInsights(productCode);
  const feedbackHistory = getRecentFeedback(productCode);
  // Admin direction 가져오기
  const override = snsReviewOverridesRef ? snsReviewOverridesRef.find(o => o.productCode === productCode) : null;
  const adminDirection = override?.direction || null;
  const systemPrompt = buildSystemPrompt(existingInsights, feedbackHistory, adminDirection);

  const reviewText = formatReviewsForAnalysis(reviews);

  const userPrompt = `Analyze these ${reviews.length} YouTube reviews for the K-Beauty product "${productName || productCode}".

${reviewText}

Return a JSON object with this exact structure (no markdown, no code blocks, just raw JSON):
{
  "summary": "A 2-3 sentence English summary highlighting key points from the reviews",
  "hashtags": ["array", "of", "15", "relevant", "english", "hashtags", "without", "hash", "symbol"],
  "sentiment": {
    "positiveRatio": 85,
    "negativeRatio": 15
  },
  "updatedInsights": "Updated comprehensive analysis of this product based on all reviews analyzed so far. Include key themes, commonly praised aspects, any concerns mentioned, and overall reviewer consensus. This will be used as context for future analyses."
}`;

  try {
    const response = await anthropicClient.messages.create({
      model: AI_MODEL,
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const responseText = response.content[0]?.text || '';

    // JSON 파싱 (코드 블록 래핑 제거)
    let jsonStr = responseText.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const result = JSON.parse(jsonStr);

    // productInsights 업데이트
    if (result.updatedInsights && productInsightsRef) {
      const existingIdx = productInsightsRef.findIndex(i => i.productCode === productCode);
      const insightData = {
        productCode,
        insights: result.updatedInsights,
        summary: { en: result.summary },
        hashtags: result.hashtags || [],
        sentiment: result.sentiment || { positiveRatio: 0, negativeRatio: 0 },
        reviewIds: reviews.map(r => r.id),
        lastAnalyzedAt: new Date().toISOString(),
        version: existingIdx >= 0 ? (productInsightsRef[existingIdx].version || 0) + 1 : 1,
      };

      if (existingIdx >= 0) {
        productInsightsRef[existingIdx] = insightData;
      } else {
        productInsightsRef.push(insightData);
      }

      if (saveCallback) saveCallback();
    }

    // 캐시 업데이트
    analysisCache.set(productCode, {
      summary: result,
      analyzedReviewIds: reviews.map(r => r.id).sort().join(','),
      timestamp: Date.now(),
    });

    console.log(`🤖 Claude 분석 완료: ${productCode} (${reviews.length}개 리뷰, v${result.updatedInsights ? 'updated' : 'new'})`);

    return {
      summary: result.summary,
      hashtags: (result.hashtags || []).map(h => h.replace(/^#/, '')),
      sentiment: result.sentiment,
      reviewCount: reviews.length,
      aiProvider: 'claude',
      analyzedAt: new Date().toISOString(),
    };

  } catch (error) {
    console.error(`❌ Claude 분석 실패 (${productCode}):`, error.message);
    throw error;
  }
}

/**
 * 캐시 확인 — 리뷰 변경 없으면 캐시 반환
 */
function getCachedAnalysis(productCode, currentReviewIds) {
  const cached = analysisCache.get(productCode);
  if (!cached) return null;

  // TTL 체크
  if (Date.now() - cached.timestamp > CACHE_TTL) {
    analysisCache.delete(productCode);
    return null;
  }

  // 리뷰 변경 체크
  const currentIds = currentReviewIds.sort().join(',');
  if (cached.analyzedReviewIds !== currentIds) return null;

  return cached.summary;
}

/**
 * 메인 요약 함수 — 오버라이드 → Claude → 키워드 fallback 체인
 */
async function getSummary(productCode, approvedReviews, keywordFallback) {
  // 1. 오버라이드 체크
  if (snsReviewOverridesRef) {
    const override = snsReviewOverridesRef.find(o => o.productCode === productCode);
    if (override) {
      console.log(`📝 오버라이드 요약 사용: ${productCode}`);
      return {
        summary: override.summary,
        hashtags: override.hashtags || [],
        sentiment: override.sentiment || { positiveRatio: 0, negativeRatio: 0 },
        reviewCount: approvedReviews.length,
        aiProvider: 'override',
        overriddenAt: override.updatedAt,
      };
    }
  }

  // 2. Claude AI 분석
  if (isClaudeAvailable() && approvedReviews.length > 0) {
    try {
      // 캐시 확인
      const cached = getCachedAnalysis(productCode, approvedReviews.map(r => r.id));
      if (cached) {
        console.log(`💾 캐시된 Claude 분석 반환: ${productCode}`);
        return {
          ...cached,
          reviewCount: approvedReviews.length,
          aiProvider: 'claude-cached',
        };
      }

      // Claude 분석 실행
      return await analyzeWithClaude(approvedReviews, productCode);
    } catch (error) {
      console.error(`⚠️ Claude 분석 실패, 키워드 fallback 전환: ${error.message}`);
    }
  }

  // 3. productInsights에 저장된 이전 분석 결과 사용
  const existingInsights = getProductInsights(productCode);
  if (existingInsights && existingInsights.summary) {
    console.log(`📊 저장된 insights 사용: ${productCode} (v${existingInsights.version})`);
    return {
      summary: existingInsights.summary.en || existingInsights.summary,
      hashtags: existingInsights.hashtags || [],
      sentiment: existingInsights.sentiment || { positiveRatio: 0, negativeRatio: 0 },
      reviewCount: approvedReviews.length,
      aiProvider: 'insights-cached',
      analyzedAt: existingInsights.lastAnalyzedAt,
    };
  }

  // 4. 키워드 기반 fallback
  if (keywordFallback && approvedReviews.length > 0) {
    console.log(`🔤 키워드 fallback 사용: ${productCode}`);
    const kwResult = keywordFallback(approvedReviews);
    // kwResult.summary가 {ko, en} 객체일 수 있음 → 문자열로 정규화
    const normalizedSummary = typeof kwResult.summary === 'object'
      ? (kwResult.summary.en || kwResult.summary.ko || '')
      : (kwResult.summary || '');
    const normalizedHashtags = (kwResult.hashtags || []).map(
      h => typeof h === 'object' ? (h.displayTag || h.tag || '') : h
    ).filter(Boolean);
    return {
      ...kwResult,
      summary: normalizedSummary,
      hashtags: normalizedHashtags,
      aiProvider: 'keyword',
    };
  }

  // 5. 리뷰 없음
  return {
    summary: '',
    hashtags: [],
    sentiment: { positiveRatio: 0, negativeRatio: 0 },
    reviewCount: 0,
    aiProvider: 'none',
  };
}

/**
 * Admin 피드백 기록 — 수정 시 (original, corrected) 쌍 저장
 */
function recordFeedback(productCode, originalSummary, correctedSummary) {
  if (!aiFeedbackHistoryRef) return;

  aiFeedbackHistoryRef.push({
    productCode,
    originalSummary,
    correctedSummary,
    createdAt: new Date().toISOString(),
  });

  // 상품별 최대 10개만 유지
  const productFeedbacks = aiFeedbackHistoryRef.filter(f => f.productCode === productCode);
  if (productFeedbacks.length > 10) {
    const oldest = productFeedbacks[0];
    const idx = aiFeedbackHistoryRef.indexOf(oldest);
    if (idx >= 0) aiFeedbackHistoryRef.splice(idx, 1);
  }

  if (saveCallback) saveCallback();
  console.log(`📝 피드백 기록 완료: ${productCode} (총 ${productFeedbacks.length}개)`);
}

/**
 * 수동 재분석 트리거
 */
async function triggerReanalysis(productCode, approvedReviews, productName) {
  if (!isClaudeAvailable()) {
    return { success: false, message: 'Claude AI not available' };
  }

  if (approvedReviews.length === 0) {
    return { success: false, message: 'No approved reviews to analyze' };
  }

  // 캐시 무효화
  analysisCache.delete(productCode);

  try {
    const result = await analyzeWithClaude(approvedReviews, productCode, productName);
    return { success: true, data: result };
  } catch (error) {
    return { success: false, message: error.message };
  }
}

/**
 * 분석 상태 조회
 */
function getAnalysisStatus() {
  return {
    provider: AI_PROVIDER,
    claudeAvailable: isClaudeAvailable(),
    model: AI_MODEL,
    cacheSize: analysisCache.size,
    insightsCount: productInsightsRef ? productInsightsRef.length : 0,
    feedbackCount: aiFeedbackHistoryRef ? aiFeedbackHistoryRef.length : 0,
    overridesCount: snsReviewOverridesRef ? snsReviewOverridesRef.length : 0,
  };
}

module.exports = {
  initialize,
  isClaudeAvailable,
  getSummary,
  analyzeWithClaude,
  triggerReanalysis,
  recordFeedback,
  getProductInsights,
  getRecentFeedback,
  getAnalysisStatus,
};
