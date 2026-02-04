/**
 * Review Summarizer Service
 *
 * 키워드 기반 자체 요약 엔진
 * - 리뷰 텍스트에서 자주 등장하는 키워드 추출
 * - 제형, 성분, 효과, 향, 사용감 카테고리별 분석
 * - 템플릿 기반 요약문 생성
 */

// 카테고리별 키워드 사전 (한국어/영어)
const KEYWORD_DICTIONARY = {
  // 제형 (Texture) - 메이크업/테크 포함
  texture: {
    keywords: {
      // 한국어 기본 제형
      '크림': { weight: 1, en: 'cream' },
      '젤': { weight: 1, en: 'gel' },
      '로션': { weight: 1, en: 'lotion' },
      '세럼': { weight: 1, en: 'serum' },
      '에센스': { weight: 1, en: 'essence' },
      '오일': { weight: 1, en: 'oil' },
      '워터': { weight: 1, en: 'water' },
      '폼': { weight: 1, en: 'foam' },
      '밤': { weight: 1, en: 'balm' },
      '파우더': { weight: 1, en: 'powder' },
      '묽은': { weight: 0.8, en: 'light' },
      '진한': { weight: 0.8, en: 'thick' },
      '가벼운': { weight: 0.8, en: 'lightweight' },
      '무거운': { weight: 0.8, en: 'heavy' },
      '부드러운': { weight: 0.8, en: 'smooth' },
      '쫀쫀한': { weight: 0.8, en: 'bouncy' },
      '촉촉한': { weight: 0.8, en: 'hydrating' },
      // 메이크업/테크 (한국어)
      '세컨드스킨': { weight: 1.2, en: 'second-skin' },
      '블러링': { weight: 1.2, en: 'blurring' },
      '립오일': { weight: 1.1, en: 'lip oil' },
      '립글로스': { weight: 1.0, en: 'lip gloss' },
      '하이브리드': { weight: 1.1, en: 'hybrid' },
      '쿠션': { weight: 1.0, en: 'cushion' },
      // 영어 기본 제형
      'cream': { weight: 1 },
      'gel': { weight: 1 },
      'lotion': { weight: 1 },
      'serum': { weight: 1 },
      'essence': { weight: 1 },
      'oil': { weight: 1 },
      'water': { weight: 1 },
      'foam': { weight: 1 },
      'balm': { weight: 1 },
      'lightweight': { weight: 0.8 },
      'thick': { weight: 0.8 },
      'smooth': { weight: 0.8 },
      'bouncy': { weight: 0.8 },
      // 메이크업/테크 (영어) - Makeup & Tech
      'second-skin': { weight: 1.2 },
      'second skin': { weight: 1.2 },
      'skin-like': { weight: 1.1 },
      'blurring': { weight: 1.2 },
      'blur': { weight: 1.1 },
      'soft-focus': { weight: 1.1 },
      'soft focus': { weight: 1.1 },
      'lip oil': { weight: 1.1 },
      'lip gloss': { weight: 1.0 },
      'lip tint': { weight: 1.0 },
      'hybrid makeup': { weight: 1.1 },
      'hybrid': { weight: 1.0 },
      'skincare-makeup': { weight: 1.1 },
      'cushion': { weight: 1.0 },
      'cushion compact': { weight: 1.0 },
      'bb cream': { weight: 1.0 },
      'cc cream': { weight: 1.0 },
      'tinted moisturizer': { weight: 1.0 },
      'skin tint': { weight: 1.0 },
      'no-makeup makeup': { weight: 1.1 },
      'natural finish': { weight: 1.0 },
      'matte': { weight: 1.0 },
      'dewy finish': { weight: 1.1 },
      'satin': { weight: 1.0 },
      'velvet': { weight: 1.0 },
      'glossy': { weight: 1.0 },
      'sheer': { weight: 1.0 },
      'buildable': { weight: 1.0 },
      'full coverage': { weight: 1.0 },
      'light coverage': { weight: 1.0 },
      'medium coverage': { weight: 1.0 },
      'transfer-proof': { weight: 1.0 },
      'long-wear': { weight: 1.0 },
      'long-lasting': { weight: 1.0 },
      'waterproof': { weight: 1.0 },
      'water-resistant': { weight: 1.0 },
      'smudge-proof': { weight: 1.0 },
      'mask-proof': { weight: 1.1 }
    },
    label: { ko: '제형', en: 'Texture' }
  },

  // 성분 (Ingredients) - 차세대 성분 포함
  ingredients: {
    keywords: {
      // 한국어 기본 성분
      '히알루론산': { weight: 1, en: 'hyaluronic acid' },
      '비타민C': { weight: 1, en: 'vitamin C' },
      '비타민': { weight: 0.8, en: 'vitamin' },
      '나이아신아마이드': { weight: 1, en: 'niacinamide' },
      '레티놀': { weight: 1, en: 'retinol' },
      '세라마이드': { weight: 1, en: 'ceramide' },
      '콜라겐': { weight: 1, en: 'collagen' },
      '펩타이드': { weight: 1, en: 'peptide' },
      'AHA': { weight: 1, en: 'AHA' },
      'BHA': { weight: 1, en: 'BHA' },
      '살리실산': { weight: 1, en: 'salicylic acid' },
      '글리콜산': { weight: 1, en: 'glycolic acid' },
      '티트리': { weight: 1, en: 'tea tree' },
      '알로에': { weight: 1, en: 'aloe' },
      '녹차': { weight: 1, en: 'green tea' },
      '센텔라': { weight: 1, en: 'centella' },
      '병풀': { weight: 1, en: 'centella' },
      '마데카': { weight: 1, en: 'madeca' },
      '스쿠알란': { weight: 1, en: 'squalane' },
      '프로폴리스': { weight: 1, en: 'propolis' },
      '달팽이': { weight: 1, en: 'snail mucin' },
      // 차세대 성분 (한국어)
      '피디알엔': { weight: 1.2, en: 'PDRN' },
      '엑소좀': { weight: 1.2, en: 'exosomes' },
      '폴리뉴클레오타이드': { weight: 1.2, en: 'polynucleotides' },
      '바쿠치올': { weight: 1.2, en: 'bakuchiol' },
      '글루타치온': { weight: 1.2, en: 'glutathione' },
      '트라넥삼산': { weight: 1.2, en: 'tranexamic acid' },
      '아젤라산': { weight: 1.2, en: 'azelaic acid' },
      '포스트바이오틱스': { weight: 1.2, en: 'postbiotics' },
      '레스베라트롤': { weight: 1.2, en: 'resveratrol' },
      // 영어 기본 성분
      'hyaluronic': { weight: 1 },
      'vitamin': { weight: 0.8 },
      'niacinamide': { weight: 1 },
      'retinol': { weight: 1 },
      'ceramide': { weight: 1 },
      'collagen': { weight: 1 },
      'peptide': { weight: 1 },
      'centella': { weight: 1 },
      'squalane': { weight: 1 },
      'propolis': { weight: 1 },
      'snail': { weight: 1 },
      // 차세대 성분 (영어) - Next-Gen Ingredients
      'pdrn': { weight: 1.2 },
      'phyto-pdrn': { weight: 1.2 },
      'exosomes': { weight: 1.2 },
      'exosome': { weight: 1.2 },
      'polynucleotides': { weight: 1.2 },
      'polynucleotide': { weight: 1.2 },
      'pn': { weight: 1.0 },
      'nmn': { weight: 1.2 },
      'nhn': { weight: 1.2 },
      'ectoin': { weight: 1.2 },
      'bakuchiol': { weight: 1.2 },
      'egf': { weight: 1.2 },
      'fgf': { weight: 1.2 },
      'postbiotics': { weight: 1.2 },
      'postbiotic': { weight: 1.2 },
      'probiotics': { weight: 1.1 },
      'prebiotics': { weight: 1.1 },
      'glutathione': { weight: 1.2 },
      'copper tripeptide': { weight: 1.2 },
      'copper peptide': { weight: 1.2 },
      'ghk-cu': { weight: 1.2 },
      'tranexamic': { weight: 1.2 },
      'tranexamic acid': { weight: 1.2 },
      'azelaic': { weight: 1.2 },
      'azelaic acid': { weight: 1.2 },
      'pha': { weight: 1.1 },
      'lha': { weight: 1.1 },
      'resveratrol': { weight: 1.2 },
      'astaxanthin': { weight: 1.2 },
      'fullerene': { weight: 1.2 },
      'salmon': { weight: 1.1 },
      'salmon dna': { weight: 1.2 },
      'bifida': { weight: 1.1 },
      'galactomyces': { weight: 1.1 },
      'saccharomyces': { weight: 1.1 },
      'ferment': { weight: 1.0 },
      'fermented': { weight: 1.0 },
      'adenosine': { weight: 1.1 },
      'allantoin': { weight: 1.0 },
      'panthenol': { weight: 1.0 },
      'mugwort': { weight: 1.1 },
      'artemisia': { weight: 1.1 },
      'cica': { weight: 1.1 },
      'madecassoside': { weight: 1.1 },
      'beta glucan': { weight: 1.1 },
      'licorice': { weight: 1.0 },
      'arbutin': { weight: 1.1 },
      'kojic acid': { weight: 1.1 },
      'alpha arbutin': { weight: 1.1 }
    },
    label: { ko: '성분', en: 'Ingredients' }
  },

  // 효과 (Effects) - 스킨케어 컨셉 포함
  effects: {
    keywords: {
      // 한국어 기본 효과
      '보습': { weight: 1, en: 'hydrating' },
      '수분': { weight: 1, en: 'moisturizing' },
      '미백': { weight: 1, en: 'brightening' },
      '브라이트닝': { weight: 1, en: 'brightening' },
      '톤업': { weight: 1, en: 'tone-up' },
      '화이트닝': { weight: 1, en: 'whitening' },
      '주름': { weight: 1, en: 'anti-wrinkle' },
      '탄력': { weight: 1, en: 'firming' },
      '리프팅': { weight: 1, en: 'lifting' },
      '진정': { weight: 1, en: 'soothing' },
      '트러블': { weight: 1, en: 'acne' },
      '여드름': { weight: 1, en: 'acne' },
      '모공': { weight: 1, en: 'pore' },
      '각질': { weight: 1, en: 'exfoliating' },
      '클렌징': { weight: 1, en: 'cleansing' },
      '노화방지': { weight: 1, en: 'anti-aging' },
      '안티에이징': { weight: 1, en: 'anti-aging' },
      '재생': { weight: 1, en: 'regenerating' },
      '영양': { weight: 0.8, en: 'nourishing' },
      '윤기': { weight: 0.8, en: 'glow' },
      '광채': { weight: 0.8, en: 'radiance' },
      // 스킨케어 컨셉 (한국어)
      '슬로에이징': { weight: 1.2, en: 'slow-aging' },
      '스키니멀리즘': { weight: 1.2, en: 'skinimalism' },
      '유리피부': { weight: 1.2, en: 'glass skin' },
      '글래스스킨': { weight: 1.2, en: 'glass skin' },
      '물광': { weight: 1.2, en: 'dewy' },
      '구름피부': { weight: 1.2, en: 'cloud skin' },
      '장벽케어': { weight: 1.2, en: 'barrier care' },
      '피부장벽': { weight: 1.2, en: 'skin barrier' },
      '마이크로바이옴': { weight: 1.2, en: 'microbiome' },
      // 영어 기본 효과
      'hydrating': { weight: 1 },
      'moisturizing': { weight: 1 },
      'brightening': { weight: 1 },
      'whitening': { weight: 1 },
      'anti-aging': { weight: 1 },
      'firming': { weight: 1 },
      'soothing': { weight: 1 },
      'acne': { weight: 1 },
      'pore': { weight: 1 },
      'exfoliating': { weight: 1 },
      'glow': { weight: 0.8 },
      'radiance': { weight: 0.8 },
      // 스킨케어 컨셉 (영어) - Skincare Concepts
      'slow-aging': { weight: 1.2 },
      'slow aging': { weight: 1.2 },
      'skinimalism': { weight: 1.2 },
      'glass skin': { weight: 1.2 },
      'glass-skin': { weight: 1.2 },
      'cloud skin': { weight: 1.2 },
      'dewy': { weight: 1.1 },
      'dewy skin': { weight: 1.1 },
      'barrier': { weight: 1.1 },
      'barrier care': { weight: 1.2 },
      'skin barrier': { weight: 1.2 },
      'microbiome': { weight: 1.2 },
      'skin cycling': { weight: 1.2 },
      'slugging': { weight: 1.1 },
      'skin fasting': { weight: 1.1 },
      'skip care': { weight: 1.1 },
      'clean beauty': { weight: 1.1 },
      'waterless beauty': { weight: 1.1 },
      'plumping': { weight: 1.0 },
      'plump': { weight: 1.0 },
      'bouncy': { weight: 1.0 },
      'glassy': { weight: 1.0 },
      'translucent': { weight: 1.0 },
      'poreless': { weight: 1.0 },
      'lit from within': { weight: 1.1 },
      'healthy glow': { weight: 1.0 },
      'natural glow': { weight: 1.0 },
      'luminous': { weight: 1.0 },
      'radiant': { weight: 1.0 },
      'regenerating': { weight: 1.0 },
      'nourishing': { weight: 1.0 },
      'rejuvenating': { weight: 1.0 },
      'revitalizing': { weight: 1.0 }
    },
    label: { ko: '효과', en: 'Effects' }
  },

  // 향 (Scent)
  scent: {
    keywords: {
      // 한국어
      '무향': { weight: 1, en: 'fragrance-free' },
      '은은한': { weight: 0.8, en: 'subtle' },
      '향긋한': { weight: 0.8, en: 'pleasant' },
      '플로럴': { weight: 1, en: 'floral' },
      '시트러스': { weight: 1, en: 'citrus' },
      '허브': { weight: 1, en: 'herbal' },
      '민트': { weight: 1, en: 'mint' },
      '라벤더': { weight: 1, en: 'lavender' },
      '장미': { weight: 1, en: 'rose' },
      '자스민': { weight: 1, en: 'jasmine' },
      '인공향': { weight: 0.8, en: 'artificial scent' },
      // 영어
      'fragrance-free': { weight: 1 },
      'unscented': { weight: 1 },
      'floral': { weight: 1 },
      'citrus': { weight: 1 },
      'herbal': { weight: 1 },
      'lavender': { weight: 1 },
      'rose': { weight: 1 }
    },
    label: { ko: '향', en: 'Scent' }
  },

  // 사용감 (Usage Feel)
  usageFeel: {
    keywords: {
      // 한국어
      '흡수': { weight: 1, en: 'absorbs well' },
      '빠른흡수': { weight: 1, en: 'fast absorption' },
      '끈적임': { weight: 0.8, en: 'sticky' },
      '끈적이지 않는': { weight: 1, en: 'non-sticky' },
      '산뜻한': { weight: 1, en: 'refreshing' },
      '쫀쫀한': { weight: 0.8, en: 'bouncy' },
      '촉촉한': { weight: 1, en: 'moist' },
      '건조함': { weight: 0.8, en: 'dry' },
      '자극': { weight: 0.8, en: 'irritating' },
      '순한': { weight: 1, en: 'gentle' },
      '저자극': { weight: 1, en: 'low-irritation' },
      '민감성': { weight: 0.8, en: 'sensitive skin' },
      '지성': { weight: 0.8, en: 'oily skin' },
      '건성': { weight: 0.8, en: 'dry skin' },
      '복합성': { weight: 0.8, en: 'combination skin' },
      // 영어
      'absorbs': { weight: 1 },
      'sticky': { weight: 0.8 },
      'non-sticky': { weight: 1 },
      'refreshing': { weight: 1 },
      'gentle': { weight: 1 },
      'sensitive': { weight: 0.8 },
      'oily': { weight: 0.8 },
      'dry': { weight: 0.8 }
    },
    label: { ko: '사용감', en: 'Usage Feel' }
  },

  // 대상/피부타입 (Target)
  target: {
    keywords: {
      // 한국어
      '민감성': { weight: 1, en: 'sensitive skin' },
      '지성': { weight: 1, en: 'oily skin' },
      '건성': { weight: 1, en: 'dry skin' },
      '복합성': { weight: 1, en: 'combination skin' },
      '트러블': { weight: 1, en: 'acne-prone' },
      '모든 피부': { weight: 1, en: 'all skin types' },
      '남성': { weight: 0.8, en: 'men' },
      '여성': { weight: 0.8, en: 'women' },
      '20대': { weight: 0.8, en: '20s' },
      '30대': { weight: 0.8, en: '30s' },
      '40대': { weight: 0.8, en: '40s' },
      '50대': { weight: 0.8, en: '50s' },
      // 영어
      'sensitive': { weight: 1 },
      'oily': { weight: 1 },
      'dry': { weight: 1 },
      'combination': { weight: 1 },
      'acne-prone': { weight: 1 },
      'all skin': { weight: 1 }
    },
    label: { ko: '추천 대상', en: 'Recommended For' }
  },

  // 감성/평가 (Sentiment) - 마케팅/소셜 키워드 포함
  sentiment: {
    keywords: {
      // 긍정 (한국어)
      '좋아요': { weight: 1, sentiment: 'positive', en: 'love it' },
      '최고': { weight: 1, sentiment: 'positive', en: 'best' },
      '강추': { weight: 1, sentiment: 'positive', en: 'highly recommend' },
      '추천': { weight: 0.8, sentiment: 'positive', en: 'recommend' },
      '만족': { weight: 1, sentiment: 'positive', en: 'satisfied' },
      '대박': { weight: 1, sentiment: 'positive', en: 'amazing' },
      '짱': { weight: 1, sentiment: 'positive', en: 'awesome' },
      '인생템': { weight: 1, sentiment: 'positive', en: 'holy grail' },
      '재구매': { weight: 1, sentiment: 'positive', en: 'repurchase' },
      // 마케팅/소셜 (한국어)
      '갓성비': { weight: 1.2, sentiment: 'positive', en: 'best value' },
      '가성비': { weight: 1.1, sentiment: 'positive', en: 'good value' },
      '듀프': { weight: 1.1, sentiment: 'positive', en: 'dupe' },
      '바이럴': { weight: 1.1, sentiment: 'positive', en: 'viral' },
      '핫템': { weight: 1.1, sentiment: 'positive', en: 'trending' },
      // 긍정 (영어)
      'amazing': { weight: 1, sentiment: 'positive' },
      'love': { weight: 1, sentiment: 'positive' },
      'best': { weight: 1, sentiment: 'positive' },
      'recommend': { weight: 0.8, sentiment: 'positive' },
      'great': { weight: 0.8, sentiment: 'positive' },
      'holy grail': { weight: 1.2, sentiment: 'positive' },
      'hg': { weight: 1.2, sentiment: 'positive' },
      // 마케팅/소셜 (영어) - Marketing & Social
      'dupe': { weight: 1.2, sentiment: 'positive' },
      'worth the hype': { weight: 1.2, sentiment: 'positive' },
      'game-changer': { weight: 1.2, sentiment: 'positive' },
      'game changer': { weight: 1.2, sentiment: 'positive' },
      'must-have': { weight: 1.1, sentiment: 'positive' },
      'must have': { weight: 1.1, sentiment: 'positive' },
      'staple': { weight: 1.0, sentiment: 'positive' },
      'cult favorite': { weight: 1.2, sentiment: 'positive' },
      'cult-favorite': { weight: 1.2, sentiment: 'positive' },
      'viral': { weight: 1.1, sentiment: 'positive' },
      'trending': { weight: 1.0, sentiment: 'positive' },
      'hype': { weight: 1.0, sentiment: 'positive' },
      'hyped': { weight: 1.0, sentiment: 'positive' },
      'obsessed': { weight: 1.1, sentiment: 'positive' },
      'in love': { weight: 1.0, sentiment: 'positive' },
      'favorite': { weight: 1.0, sentiment: 'positive' },
      'fave': { weight: 1.0, sentiment: 'positive' },
      'repurchase': { weight: 1.1, sentiment: 'positive' },
      'will repurchase': { weight: 1.2, sentiment: 'positive' },
      'worth it': { weight: 1.1, sentiment: 'positive' },
      'game over': { weight: 1.1, sentiment: 'positive' },
      'chef kiss': { weight: 1.0, sentiment: 'positive' },
      'no skip': { weight: 1.0, sentiment: 'positive' },
      'slaps': { weight: 1.0, sentiment: 'positive' },
      'fire': { weight: 0.9, sentiment: 'positive' },
      'bomb': { weight: 0.9, sentiment: 'positive' },
      'slay': { weight: 0.9, sentiment: 'positive' },
      // 콘텐츠 타입 (중립)
      'grwm': { weight: 1.0, sentiment: 'neutral' },
      'get ready with me': { weight: 1.0, sentiment: 'neutral' },
      'ugc': { weight: 1.0, sentiment: 'neutral' },
      'haul': { weight: 1.0, sentiment: 'neutral' },
      'unboxing': { weight: 1.0, sentiment: 'neutral' },
      'first impressions': { weight: 1.0, sentiment: 'neutral' },
      'empties': { weight: 1.0, sentiment: 'neutral' },
      'favorites': { weight: 1.0, sentiment: 'positive' },
      'best of': { weight: 1.0, sentiment: 'positive' },
      'top picks': { weight: 1.0, sentiment: 'positive' },
      'honest review': { weight: 1.0, sentiment: 'neutral' },
      // 부정 (한국어)
      '별로': { weight: 0.8, sentiment: 'negative', en: 'not great' },
      '실망': { weight: 1, sentiment: 'negative', en: 'disappointed' },
      '효과없음': { weight: 1, sentiment: 'negative', en: 'no effect' },
      // 부정 (영어)
      'disappointed': { weight: 1, sentiment: 'negative' },
      'not worth': { weight: 1, sentiment: 'negative' },
      'not worth it': { weight: 1.1, sentiment: 'negative' },
      'overhyped': { weight: 1.1, sentiment: 'negative' },
      'overrated': { weight: 1.0, sentiment: 'negative' },
      'meh': { weight: 0.8, sentiment: 'negative' },
      'pass': { weight: 0.8, sentiment: 'negative' },
      'skip': { weight: 0.8, sentiment: 'negative' },
      'waste': { weight: 1.0, sentiment: 'negative' },
      'broke me out': { weight: 1.2, sentiment: 'negative' },
      'breakout': { weight: 1.0, sentiment: 'negative' },
      'irritation': { weight: 1.0, sentiment: 'negative' },
      'allergic': { weight: 1.1, sentiment: 'negative' }
    },
    label: { ko: '평가', en: 'Reviews' }
  }
};

// ========== 동적 키워드 추출 (사전 없이) ==========

// 불용어 (제외할 단어)
const STOP_WORDS = new Set([
  // 영어 불용어
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought', 'used',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into',
  'about', 'like', 'through', 'after', 'over', 'between', 'out', 'against',
  'and', 'but', 'or', 'nor', 'so', 'yet', 'both', 'either', 'neither',
  'not', 'only', 'own', 'same', 'than', 'too', 'very', 'just', 'also',
  'this', 'that', 'these', 'those', 'it', 'its', 'my', 'your', 'his', 'her',
  'i', 'you', 'he', 'she', 'we', 'they', 'me', 'him', 'us', 'them',
  'what', 'which', 'who', 'whom', 'whose', 'where', 'when', 'why', 'how',
  'all', 'each', 'every', 'any', 'some', 'no', 'none', 'more', 'most', 'other',
  'up', 'down', 'here', 'there', 'now', 'then', 'if', 'because', 'while',
  // 유튜브/SNS 관련 불용어
  'video', 'videos', 'subscribe', 'channel', 'watch', 'review', 'reviews', 'tutorial',
  'routine', 'routines', 'using', 'trying', 'tried', 'try', 'test', 'testing', 'tested',
  'get', 'got', 'getting', 'use', 'used', 'make', 'made', 'making', 'see', 'look',
  'looking', 'looks', 'new', 'one', 'first', 'day', 'days', 'time', 'way', 'back',
  'really', 'actually', 'literally', 'honestly', 'think', 'know', 'want', 'need',
  'going', 'come', 'coming', 'take', 'taking', 'put', 'give', 'work', 'works',
  'link', 'below', 'check', 'comment', 'comments', 'share', 'follow', 'like', 'likes',
  // 한국어 불용어
  '이', '그', '저', '것', '수', '등', '및', '더', '또', '안', '좀', '잘', '못',
  '너무', '많이', '정말', '진짜', '완전', '되게', '엄청',
  // URL/기술 관련 불용어
  'https', 'http', 'www', 'com', 'org', 'net', 'youtube', 'youtu',
  'bit', 'linktr', 'instagram', 'tiktok', 'facebook', 'twitter',
  // 일반 단어 불용어
  'products', 'product', 'skin', 'face', 'here', 'best', 'good', 'bad',
  'right', 'wrong', 'full', 'free', 'shop', 'buy', 'sale', 'off', 'code',
  'affiliate', 'sponsored', 'gifted', 'discount', 'coupon'
]);

// 뷰티 관련 키워드 부스트 (우선순위 높임) - 100+ 트렌드 키워드 포함
const BEAUTY_BOOST_WORDS = new Set([
  // ========== 차세대 성분 (Next-Gen Ingredients) ==========
  'pdrn', 'phyto-pdrn', 'exosomes', 'exosome', 'polynucleotides', 'polynucleotide',
  'nmn', 'nhn', 'ectoin', 'bakuchiol', 'egf', 'fgf',
  'postbiotics', 'postbiotic', 'probiotics', 'prebiotics',
  'glutathione', 'ghk-cu', 'copper',
  'tranexamic', 'azelaic', 'pha', 'lha', 'resveratrol',
  'astaxanthin', 'fullerene', 'salmon',
  // 기존 인기 성분
  'collagen', 'peptide', 'niacinamide', 'retinol', 'hyaluronic',
  'vitamin', 'ceramide', 'cica', 'centella', 'snail', 'propolis', 'aha', 'bha',
  'adenosine', 'bifida', 'galactomyces', 'saccharomyces', 'ferment', 'fermented',
  'mugwort', 'artemisia', 'madecassoside', 'allantoin', 'panthenol',
  'arbutin', 'kojic', 'licorice', 'glucan',

  // ========== 스킨케어 컨셉 (Skincare Concepts) ==========
  'slow-aging', 'skinimalism', 'glass', 'glassy', 'cloud',
  'barrier', 'microbiome', 'skin-cycling', 'slugging',
  'skip-care', 'clean', 'waterless',
  'dewy', 'plump', 'plumping', 'bouncy', 'translucent', 'poreless',
  'luminous', 'radiant', 'radiance', 'glow', 'glowy',
  'regenerating', 'rejuvenating', 'revitalizing',

  // ========== 메이크업 & 테크 (Makeup & Tech) ==========
  'second-skin', 'blurring', 'blur', 'soft-focus',
  'lip-oil', 'hybrid', 'cushion',
  'tinted', 'skin-tint', 'bb', 'cc',
  'matte', 'satin', 'velvet', 'glossy', 'sheer',
  'buildable', 'coverage', 'transfer-proof', 'long-wear',
  'waterproof', 'smudge-proof', 'mask-proof',

  // ========== 마케팅 & 소셜 (Marketing & Social) ==========
  'holy-grail', 'hg', 'dupe', 'viral', 'hype', 'hyped',
  'trending', 'game-changer', 'must-have', 'staple',
  'cult-favorite', 'obsessed', 'favorite', 'fave',
  'repurchase', 'worth', 'slaps', 'slay',
  'grwm', 'ugc', 'haul', 'unboxing', 'empties',

  // ========== 제형 (Texture) ==========
  'serum', 'cream', 'gel', 'lotion', 'essence', 'toner', 'ampoule', 'mask',
  'moisturizer', 'cleanser', 'sunscreen', 'spf', 'oil', 'balm',

  // ========== 효과 (Effects) ==========
  'hydrating', 'brightening', 'moisturizing', 'soothing', 'firming', 'anti-aging',
  'acne', 'pore', 'pores', 'wrinkle', 'lifting', 'exfoliating', 'nourishing',

  // ========== 사용감 (Usage Feel) ==========
  'lightweight', 'smooth', 'absorbs', 'sticky', 'refreshing', 'silky',

  // ========== 브랜드 & K-Beauty ==========
  'medicube', 'anua', 'cosrx', 'beauty', 'korean', 'kbeauty', 'skincare',
  'innisfree', 'laneige', 'sulwhasoo', 'amorepacific', 'missha', 'etude',
  'klairs', 'isntree', 'goodal', 'round-lab', 'torriden', 'skin1004'
]);

/**
 * 동적 키워드 추출 (사전 불필요)
 * @param {Array} reviews - SNS 리뷰 배열
 * @returns {Array} - 자주 언급되는 키워드 목록
 */
function extractDynamicKeywords(reviews) {
  const wordFrequency = {};

  for (const review of reviews) {
    const text = `${review.title || ''} ${review.description || ''}`.toLowerCase();

    // 단어 분리 (영어 3글자 이상, 한국어 2글자 이상)
    const words = text.match(/[a-z]{3,}|[가-힣]{2,}/g) || [];

    for (const word of words) {
      if (STOP_WORDS.has(word)) continue;
      if (word.length < 3) continue;

      if (!wordFrequency[word]) {
        wordFrequency[word] = {
          count: 0,
          boost: BEAUTY_BOOST_WORDS.has(word) ? 2 : 1
        };
      }
      wordFrequency[word].count++;
    }
  }

  // 점수 계산 (count × boost) 후 정렬
  const sortedKeywords = Object.entries(wordFrequency)
    .map(([word, data]) => ({
      keyword: word,
      count: data.count,
      score: data.count * data.boost,
      isBoosted: data.boost > 1
    }))
    .filter(k => k.count >= 2)  // 최소 2회 이상 언급
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);  // 상위 30개

  return sortedKeywords;
}

/**
 * 리뷰 텍스트에서 키워드 추출
 */
function extractKeywords(text) {
  if (!text) return {};

  const normalizedText = text.toLowerCase();
  const result = {};

  for (const [category, data] of Object.entries(KEYWORD_DICTIONARY)) {
    result[category] = {
      found: [],
      label: data.label
    };

    for (const [keyword, info] of Object.entries(data.keywords)) {
      if (normalizedText.includes(keyword.toLowerCase())) {
        result[category].found.push({
          keyword,
          weight: info.weight,
          sentiment: info.sentiment,
          en: info.en
        });
      }
    }
  }

  return result;
}

/**
 * 여러 리뷰에서 키워드 집계
 */
function aggregateKeywords(reviews) {
  const aggregated = {};

  // 카테고리별 초기화
  for (const [category, data] of Object.entries(KEYWORD_DICTIONARY)) {
    aggregated[category] = {
      label: data.label,
      keywords: {},
      topKeywords: []
    };
  }

  // 각 리뷰에서 키워드 추출 및 집계
  for (const review of reviews) {
    const text = `${review.title || ''} ${review.description || ''}`;
    const extracted = extractKeywords(text);

    for (const [category, data] of Object.entries(extracted)) {
      for (const found of data.found) {
        const key = found.keyword.toLowerCase();
        if (!aggregated[category].keywords[key]) {
          aggregated[category].keywords[key] = {
            keyword: found.keyword,
            count: 0,
            totalWeight: 0,
            sentiment: found.sentiment,
            en: found.en
          };
        }
        aggregated[category].keywords[key].count++;
        aggregated[category].keywords[key].totalWeight += found.weight;
      }
    }
  }

  // 각 카테고리별 상위 키워드 정렬
  for (const category of Object.keys(aggregated)) {
    const keywords = Object.values(aggregated[category].keywords);
    keywords.sort((a, b) => b.totalWeight - a.totalWeight);
    aggregated[category].topKeywords = keywords.slice(0, 5);
  }

  return aggregated;
}

/**
 * 감성 분석 점수 계산
 */
function calculateSentiment(aggregated) {
  const sentimentData = aggregated.sentiment;
  let positiveScore = 0;
  let negativeScore = 0;
  let totalCount = 0;

  for (const kw of Object.values(sentimentData.keywords)) {
    if (kw.sentiment === 'positive') {
      positiveScore += kw.count * kw.totalWeight;
    } else if (kw.sentiment === 'negative') {
      negativeScore += kw.count * kw.totalWeight;
    }
    totalCount += kw.count;
  }

  const total = positiveScore + negativeScore;
  const positiveRatio = total > 0 ? (positiveScore / total) * 100 : 50;

  return {
    positiveRatio: Math.round(positiveRatio),
    negativeRatio: Math.round(100 - positiveRatio),
    positiveCount: Math.round(positiveScore),
    negativeCount: Math.round(negativeScore),
    totalMentions: totalCount
  };
}

/**
 * 모든 키워드를 영어 해시태그 형식으로 추출 (동적 키워드 포함)
 * @param {Object} aggregated - 사전 기반 집계 결과
 * @param {Array} dynamicKeywords - 동적 추출 키워드
 */
function extractAllHashtags(aggregated, dynamicKeywords = []) {
  const hashtags = [];
  const seenKeywords = new Set();

  // 1. 동적 키워드 먼저 추가 (실제 리뷰에서 추출된 키워드 우선)
  for (const kw of dynamicKeywords) {
    const normalizedKey = kw.keyword.toLowerCase();

    if (!seenKeywords.has(normalizedKey)) {
      seenKeywords.add(normalizedKey);
      hashtags.push({
        tag: kw.keyword.toLowerCase(),
        displayTag: kw.keyword,
        count: kw.count,
        category: 'dynamic',
        isBoosted: kw.isBoosted
      });
    }
  }

  // 2. 사전 기반 키워드 추가 (중복 제외)
  const categories = ['effects', 'texture', 'ingredients', 'usageFeel', 'scent', 'target'];

  for (const category of categories) {
    if (aggregated[category] && aggregated[category].topKeywords) {
      for (const kw of aggregated[category].topKeywords) {
        // 영어 변환 (en 속성이 있으면 사용, 없으면 원본 키워드)
        const englishKeyword = kw.en || kw.keyword;
        const normalizedKey = englishKeyword.toLowerCase().replace(/\s+/g, '_');

        if (!seenKeywords.has(normalizedKey)) {
          seenKeywords.add(normalizedKey);
          hashtags.push({
            tag: englishKeyword.toLowerCase().replace(/\s+/g, ''),
            displayTag: englishKeyword,
            count: kw.count,
            category: category
          });
        }
      }
    }
  }

  // 점수 기준으로 정렬 (부스트 키워드 우선, 그 다음 카운트)
  hashtags.sort((a, b) => {
    // 부스트된 키워드 우선
    if (a.isBoosted && !b.isBoosted) return -1;
    if (!a.isBoosted && b.isBoosted) return 1;
    // 카운트로 정렬
    return b.count - a.count;
  });

  return hashtags.slice(0, 20); // 최대 20개 태그
}

// 뷰티 리뷰어 표현 템플릿 로드
let beautyExpressions;
try {
  beautyExpressions = require('./beautyExpressions.json');
} catch (e) {
  console.warn('beautyExpressions.json not found, using default expressions');
  beautyExpressions = null;
}

/**
 * 랜덤 요소 선택 헬퍼
 */
function pickRandom(arr) {
  if (!arr || arr.length === 0) return '';
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * 효과 타입 결정
 */
function getTopEffect(effectsData) {
  if (!effectsData || effectsData.topKeywords.length === 0) return 'hydrating';

  const topKeyword = (effectsData.topKeywords[0].en || effectsData.topKeywords[0].keyword).toLowerCase();

  if (topKeyword.includes('hydrat') || topKeyword.includes('moistur')) return 'hydrating';
  if (topKeyword.includes('bright') || topKeyword.includes('glow') || topKeyword.includes('radianc')) return 'brightening';
  if (topKeyword.includes('sooth') || topKeyword.includes('calm')) return 'soothing';
  if (topKeyword.includes('firm') || topKeyword.includes('lift')) return 'firming';
  if (topKeyword.includes('anti') || topKeyword.includes('wrinkle')) return 'antiAging';
  if (topKeyword.includes('acne') || topKeyword.includes('trouble') || topKeyword.includes('pore')) return 'acne';
  if (topKeyword.includes('nourish')) return 'nourishing';

  return 'hydrating';
}

/**
 * 제형 타입 결정
 */
function getTextureType(textureData) {
  if (!textureData || textureData.topKeywords.length === 0) return 'serum';

  const topKeyword = (textureData.topKeywords[0].en || textureData.topKeywords[0].keyword).toLowerCase();

  if (topKeyword.includes('cream') || topKeyword.includes('크림')) return 'creamy';
  if (topKeyword.includes('gel') || topKeyword.includes('젤')) return 'gel';
  if (topKeyword.includes('oil') || topKeyword.includes('오일')) return 'oil';
  if (topKeyword.includes('balm') || topKeyword.includes('밤')) return 'balm';
  if (topKeyword.includes('light') || topKeyword.includes('가벼')) return 'lightweight';

  return 'serum';
}

// 기본 표현 템플릿 (beautyExpressions.json 없을 경우 폴백)
const DEFAULT_EXPRESSIONS = {
  hypeIntros: [
    "This {product} has been getting major hype lately —",
    "Everyone's been talking about this {product}, and I finally tried it.",
    "The buzz around this {product} is real."
  ],
  effectClaims: {
    hydrating: [
      "it delivers serious hydration without feeling heavy.",
      "my skin has never felt this plump and bouncy.",
      "the hydration lasts all day, no joke."
    ],
    brightening: [
      "it genuinely brightens up my complexion.",
      "it gives that lit-from-within glow.",
      "the brightening effect is *chef's kiss*."
    ],
    soothing: [
      "it calms my redness like magic.",
      "my irritated skin finally feels at peace.",
      "it soothes everything almost instantly."
    ],
    antiAging: [
      "my fine lines are definitely less visible.",
      "the firming effect is actually noticeable.",
      "it makes my skin look younger, period."
    ],
    acne: [
      "my breakouts have calmed down significantly.",
      "it keeps my pores clear without drying me out.",
      "my skin has been so much clearer."
    ],
    firming: [
      "my skin feels noticeably tighter.",
      "it gives an instant lifting effect.",
      "my jawline looks more defined now."
    ],
    nourishing: [
      "it deeply nourishes without clogging pores.",
      "my skin barrier has never been stronger.",
      "my skin feels so healthy and balanced now."
    ]
  },
  textureFeel: {
    lightweight: [
      "The texture is super lightweight — like water, almost.",
      "It sinks in instantly, no residue at all.",
      "Perfect for layering without feeling heavy."
    ],
    creamy: [
      "The texture is rich but not greasy at all.",
      "It melts into the skin beautifully.",
      "Rich texture that doesn't clog pores — love that."
    ],
    gel: [
      "The gel texture is so refreshing.",
      "It has that bouncy, jelly-like consistency I love.",
      "Cooling and lightweight — perfect for any skin type."
    ],
    serum: [
      "The serum texture is silky smooth.",
      "A few drops go a long way.",
      "Glides on like a dream."
    ],
    oil: [
      "The oil sinks in surprisingly fast.",
      "It's not greasy at all, just pure glow.",
      "A little goes such a long way."
    ],
    balm: [
      "The balm melts on contact with skin.",
      "It transforms from solid to silky in seconds.",
      "Perfect for overnight treatments."
    ]
  },
  verdicts: {
    highlyRecommend: [
      "Honestly? This is a must-try. Highly recommend!",
      "If you're on the fence, just get it. You won't regret it.",
      "10/10 would repurchase. No questions asked.",
      "Worth every penny. This one's a keeper."
    ],
    recommendWithNote: [
      "Great product overall — just patch test first if you have sensitive skin.",
      "Solid choice if you're looking for something effective yet gentle.",
      "Works well for me — results may vary depending on skin type."
    ],
    mixed: [
      "It's decent, but not life-changing for me personally.",
      "It works, but I expected a bit more for the price.",
      "Try it if you're curious, but manage your expectations."
    ]
  },
  usageNotes: [
    "Works great under makeup.",
    "Perfect for both AM and PM routines.",
    "Layers beautifully with other products.",
    "No pilling whatsoever."
  ]
};

/**
 * 뷰티 리뷰어 스타일 요약 텍스트 생성 (최대 3줄, 줄당 1-2문장)
 *
 * 구조:
 * [Line 1] 인트로 + 핵심 효과 (1-2문장)
 * [Line 2] 제형/사용감 + 특징 (1-2문장)
 * [Line 3] 결론/추천 (1-2문장)
 */
function generateSummaryText(aggregated, reviewCount, sentiment) {
  const expressions = beautyExpressions || DEFAULT_EXPRESSIONS;
  const lines = [];

  // 제품 타입 추론 (기본값: serum)
  let productType = 'serum';
  if (aggregated.texture.topKeywords.length > 0) {
    const textureKw = (aggregated.texture.topKeywords[0].en || aggregated.texture.topKeywords[0].keyword).toLowerCase();
    if (textureKw.includes('cream')) productType = 'cream';
    else if (textureKw.includes('oil')) productType = 'oil';
    else if (textureKw.includes('gel')) productType = 'gel';
    else if (textureKw.includes('essence')) productType = 'essence';
    else if (textureKw.includes('toner')) productType = 'toner';
    else if (textureKw.includes('mask')) productType = 'mask';
    else if (textureKw.includes('balm')) productType = 'balm';
  }

  // === LINE 1: Hype Intro + Effect (1-2문장) ===
  const intro = pickRandom(expressions.hypeIntros).replace('{product}', productType);
  const topEffect = getTopEffect(aggregated.effects);
  const effectClaims = expressions.effectClaims[topEffect] || expressions.effectClaims.hydrating || DEFAULT_EXPRESSIONS.effectClaims.hydrating;
  const effectClaim = pickRandom(effectClaims);

  // 인트로와 효과 연결 (and honestly? 같은 필러 추가 가능)
  const fillers = expressions.casualFillers || ['and honestly?', '— and I get it now.', 'so yeah,'];
  const shouldAddFiller = Math.random() > 0.6;

  if (shouldAddFiller && intro.endsWith('—')) {
    lines.push(`${intro} ${pickRandom(fillers)} ${effectClaim}`);
  } else {
    lines.push(`${intro} ${effectClaim}`);
  }

  // === LINE 2: Texture + Usage (1-2문장) ===
  const textureType = getTextureType(aggregated.texture);
  const textureFeel = expressions.textureFeel[textureType] || expressions.textureFeel.serum || DEFAULT_EXPRESSIONS.textureFeel.serum;
  const textureLine = pickRandom(textureFeel);

  // 50% 확률로 사용감 추가 문장
  if (Math.random() > 0.5) {
    const usageNotes = expressions.usageNotes || DEFAULT_EXPRESSIONS.usageNotes;
    const usageNote = pickRandom(usageNotes);
    lines.push(`${textureLine} ${usageNote}`);
  } else {
    lines.push(textureLine);
  }

  // === LINE 3: Verdict (1-2문장) ===
  let verdictCategory = 'highlyRecommend';
  if (sentiment.positiveRatio >= 70) {
    verdictCategory = 'highlyRecommend';
  } else if (sentiment.positiveRatio >= 50) {
    verdictCategory = 'recommendWithNote';
  } else {
    verdictCategory = 'mixed';
  }

  const verdicts = expressions.verdicts[verdictCategory] || expressions.verdicts.highlyRecommend || DEFAULT_EXPRESSIONS.verdicts.highlyRecommend;
  lines.push(pickRandom(verdicts));

  // 줄바꿈으로 3줄 연결
  const summaryEn = lines.join('\n\n');

  // 한국어 요약 (백업용)
  const summaryParts = [];
  if (aggregated.effects.topKeywords.length > 0) {
    summaryParts.push(aggregated.effects.topKeywords.slice(0, 2).map(k => k.keyword).join(', ') + ' 효과');
  }
  if (aggregated.texture.topKeywords.length > 0) {
    summaryParts.push(aggregated.texture.topKeywords[0].keyword + ' 제형');
  }

  let sentimentKo = sentiment.positiveRatio >= 60 ? '긍정적 평가가 많습니다.' : '다양한 평가가 있습니다.';

  return {
    ko: `${reviewCount}개의 SNS 리뷰 분석: ${summaryParts.join(', ')}. ${sentimentKo}`,
    en: summaryEn
  };
}

/**
 * 리뷰 요약 생성 (메인 함수)
 */
function summarizeReviews(reviews) {
  if (!reviews || reviews.length === 0) {
    return {
      hasData: false,
      reviewCount: 0,
      summary: {
        ko: 'SNS 리뷰가 아직 없습니다.',
        en: 'No SNS reviews yet.'
      },
      hashtags: [],
      categories: {},
      sentiment: {
        positiveRatio: 50,
        negativeRatio: 50,
        positiveCount: 0,
        negativeCount: 0,
        totalMentions: 0
      },
      highlights: []
    };
  }

  // 키워드 집계 (사전 기반)
  const aggregated = aggregateKeywords(reviews);

  // 동적 키워드 추출 (사전 없이 빈도 분석)
  const dynamicKeywords = extractDynamicKeywords(reviews);

  // 감성 분석
  const sentiment = calculateSentiment(aggregated);

  // 요약 텍스트 생성
  const summaryText = generateSummaryText(aggregated, reviews.length, sentiment);

  // 해시태그 추출 (동적 키워드 + 사전 기반 병합)
  const hashtags = extractAllHashtags(aggregated, dynamicKeywords);

  // 주요 하이라이트 추출 (이전 버전 호환용)
  const highlights = [];

  // 각 카테고리에서 상위 키워드 추출
  for (const [category, data] of Object.entries(aggregated)) {
    if (category !== 'sentiment' && data.topKeywords.length > 0) {
      highlights.push({
        category: category,
        label: data.label,
        keywords: data.topKeywords.slice(0, 3).map(k => ({
          text: k.keyword,
          count: k.count,
          en: k.en
        }))
      });
    }
  }

  // 하이라이트 정렬 (키워드 수 기준)
  highlights.sort((a, b) => {
    const aTotal = a.keywords.reduce((sum, k) => sum + k.count, 0);
    const bTotal = b.keywords.reduce((sum, k) => sum + k.count, 0);
    return bTotal - aTotal;
  });

  return {
    hasData: true,
    reviewCount: reviews.length,
    summary: summaryText,
    // 새로운 해시태그 형식
    hashtags: hashtags,
    categories: {
      texture: {
        label: aggregated.texture.label,
        keywords: aggregated.texture.topKeywords.slice(0, 3)
      },
      ingredients: {
        label: aggregated.ingredients.label,
        keywords: aggregated.ingredients.topKeywords.slice(0, 3)
      },
      effects: {
        label: aggregated.effects.label,
        keywords: aggregated.effects.topKeywords.slice(0, 3)
      },
      scent: {
        label: aggregated.scent.label,
        keywords: aggregated.scent.topKeywords.slice(0, 3)
      },
      usageFeel: {
        label: aggregated.usageFeel.label,
        keywords: aggregated.usageFeel.topKeywords.slice(0, 3)
      },
      target: {
        label: aggregated.target.label,
        keywords: aggregated.target.topKeywords.slice(0, 3)
      }
    },
    sentiment,
    highlights: highlights.slice(0, 4),
    // 동적 추출 키워드 (디버깅/분석용)
    dynamicKeywords: dynamicKeywords.slice(0, 10)
  };
}

module.exports = {
  summarizeReviews,
  extractKeywords,
  aggregateKeywords,
  calculateSentiment
};
