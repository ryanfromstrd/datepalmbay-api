/**
 * YouTube Data API v3 Service
 *
 * YouTube에서 상품 관련 리뷰 영상을 검색하고 수집합니다.
 */

const https = require('https');

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

/**
 * YouTube API 호출 함수
 */
function callYouTubeAPI(endpoint, params) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.YOUTUBE_API_KEY;

    if (!apiKey) {
      reject(new Error('YOUTUBE_API_KEY is not set in environment variables'));
      return;
    }

    const queryParams = new URLSearchParams({
      ...params,
      key: apiKey
    });

    const url = `${YOUTUBE_API_BASE}/${endpoint}?${queryParams}`;

    https.get(url, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            reject(new Error(`YouTube API Error: ${json.error.message}`));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(new Error(`Failed to parse YouTube API response: ${e.message}`));
        }
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * 키워드로 YouTube 영상 검색
 * @param {string} query - 검색 키워드
 * @param {number} maxResults - 최대 결과 수 (기본값: 10)
 */
async function searchVideos(query, maxResults = 10) {
  console.log(`🔍 YouTube 검색: "${query}"`);

  try {
    const response = await callYouTubeAPI('search', {
      part: 'snippet',
      q: query,
      type: 'video',
      maxResults: maxResults,
      order: 'relevance',
      relevanceLanguage: 'ko',
      regionCode: 'KR'
    });

    const videos = response.items.map(item => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      description: item.snippet.description,
      channelId: item.snippet.channelId,
      channelTitle: item.snippet.channelTitle,
      publishedAt: item.snippet.publishedAt,
      thumbnailUrl: item.snippet.thumbnails.high?.url || item.snippet.thumbnails.default?.url
    }));

    console.log(`✅ ${videos.length}개 영상 발견`);
    return videos;
  } catch (error) {
    console.error(`❌ YouTube 검색 실패: ${error.message}`);
    return [];
  }
}

/**
 * 영상 상세 정보 조회 (조회수, 좋아요수 등)
 * @param {string[]} videoIds - 영상 ID 배열
 * @param {Object[]} fallbackVideos - 상세 조회 실패 시 사용할 기본 영상 정보
 */
async function getVideoDetails(videoIds, fallbackVideos = []) {
  if (!videoIds || videoIds.length === 0) return [];

  const BATCH_SIZE = 50; // YouTube API 제한
  const allDetails = [];

  // video ID 검증 및 필터링
  const validVideoIds = videoIds.filter(id => id && typeof id === 'string' && id.length > 0);

  if (validVideoIds.length === 0) {
    console.error(`⚠️ 유효한 video ID가 없습니다. fallback 사용 (${fallbackVideos.length}개)`);
    return fallbackVideos.map(v => ({
      ...v,
      viewCount: 0,
      likeCount: 0,
      commentCount: 0
    }));
  }

  try {
    // video ID를 50개씩 배치로 나눠서 요청
    for (let i = 0; i < validVideoIds.length; i += BATCH_SIZE) {
      const batchIds = validVideoIds.slice(i, i + BATCH_SIZE);

      const response = await callYouTubeAPI('videos', {
        part: 'statistics,snippet',
        id: batchIds.join(',')
      });

      const batchDetails = response.items.map(item => ({
        videoId: item.id,
        title: item.snippet.title,
        description: item.snippet.description,
        channelId: item.snippet.channelId,
        channelTitle: item.snippet.channelTitle,
        publishedAt: item.snippet.publishedAt,
        thumbnailUrl: item.snippet.thumbnails.high?.url || item.snippet.thumbnails.default?.url,
        viewCount: parseInt(item.statistics.viewCount) || 0,
        likeCount: parseInt(item.statistics.likeCount) || 0,
        commentCount: parseInt(item.statistics.commentCount) || 0
      }));

      allDetails.push(...batchDetails);

      // API 쿼터 보호
      if (i + BATCH_SIZE < videoIds.length) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }

    return allDetails;
  } catch (error) {
    console.error(`❌ 영상 상세 정보 조회 실패: ${error.message}`);
    // 상세 조회 실패 시 기본 검색 정보를 fallback으로 사용
    console.error(`⚠️ 기본 검색 정보로 대체합니다 (${fallbackVideos.length}개)`);
    return fallbackVideos.map(v => ({
      ...v,
      viewCount: 0,
      likeCount: 0,
      commentCount: 0
    }));
  }
}

/**
 * 상품의 detailInfo에서 해시태그 추출
 * @param {Object} product - 상품 정보
 * @returns {string[]} - 해시태그 배열 (예: ['medicube', 'PDRN'])
 */
function extractHashtagsFromProduct(product) {
  if (!product.detailInfo) {
    console.log('  ⚠️ detailInfo가 없음, 상품명 사용');
    return [];
  }

  try {
    // Base64 디코딩
    const decodedHtml = Buffer.from(product.detailInfo, 'base64').toString('utf-8');

    // HTML에서 해시태그 추출 (#으로 시작하는 단어)
    const hashtagRegex = /#([a-zA-Z0-9가-힣_]+)/g;
    const matches = decodedHtml.match(hashtagRegex) || [];

    // # 제거하고 중복 제거
    const hashtags = [...new Set(matches.map(tag => tag.replace('#', '').trim()))];

    console.log(`  📌 추출된 해시태그: ${hashtags.length > 0 ? hashtags.map(t => '#' + t).join(', ') : '없음'}`);
    return hashtags;
  } catch (error) {
    console.error('  ❌ 해시태그 추출 실패:', error.message);
    return [];
  }
}

/**
 * 해시태그 기반 검색 쿼리 생성
 * 우선순위: 전체 해시태그 조합 → 개별 해시태그
 * @param {string[]} hashtags - 해시태그 배열
 * @param {string} productName - 상품명 (fallback)
 * @returns {string[]} - 검색 쿼리 배열
 */
function generateHashtagSearchQueries(hashtags, productName) {
  const queries = [];

  if (hashtags.length > 0) {
    // 교집합 큰 순서대로: 전체 → (n-1)개 조합 → ... → 2개 조합 → 개별
    // 예: [meebak, cica, cream]
    //   1순위: meebak cica cream (전체)
    //   2순위: meebak cica, meebak cream, cica cream (2개씩)
    //   3순위: meebak, cica, cream (개별)
    for (let size = hashtags.length; size >= 1; size--) {
      const combos = getCombinations(hashtags, size);
      for (const combo of combos) {
        queries.push(combo.join(' ') + ' review');
      }
    }
  }

  // Fallback: 상품명
  if (queries.length === 0) {
    queries.push(`${productName} review`);
    queries.push(`${productName} 리뷰`);
  }

  // 중복 제거
  return [...new Set(queries)];
}

/**
 * 배열에서 size개 원소의 모든 조합 생성
 * @param {string[]} arr - 원본 배열
 * @param {number} size - 조합 크기
 * @returns {string[][]} - 조합 배열
 */
function getCombinations(arr, size) {
  if (size === 1) return arr.map(item => [item]);
  if (size === arr.length) return [arr.slice()];

  const results = [];
  for (let i = 0; i <= arr.length - size; i++) {
    const head = arr[i];
    const tailCombos = getCombinations(arr.slice(i + 1), size - 1);
    for (const tail of tailCombos) {
      results.push([head, ...tail]);
    }
  }
  return results;
}

/**
 * 상품 관련 YouTube 리뷰 검색 (해시태그 기반)
 * @param {Object} product - 상품 정보
 */
async function searchProductReviews(product) {
  // 해시태그 추출
  const hashtags = extractHashtagsFromProduct(product);

  // 검색 쿼리 생성
  const searchQueries = generateHashtagSearchQueries(hashtags, product.productName);

  console.log(`  🔎 검색 쿼리 (${searchQueries.length}개): ${searchQueries.slice(0, 3).join(', ')}${searchQueries.length > 3 ? '...' : ''}`);

  const allVideos = [];
  const seenIds = new Set();

  // 최대 5개 쿼리만 실행 (API 쿼터 보호)
  for (const query of searchQueries.slice(0, 5)) {
    const videos = await searchVideos(query, 20);

    for (const video of videos) {
      if (!seenIds.has(video.videoId)) {
        seenIds.add(video.videoId);
        allVideos.push(video);
      }
    }

    // API 쿼터 보호를 위한 딜레이
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // 상세 정보 조회 (fallback으로 기본 검색 정보 전달)
  if (allVideos.length > 0) {
    const videoIds = allVideos.map(v => v.videoId);
    const details = await getVideoDetails(videoIds, allVideos);

    return details.map(detail => ({
      ...detail,
      matchedProductCode: product.productCode
    }));
  }

  return [];
}

/**
 * 상품-리뷰 매칭 점수 계산
 * @param {Object} video - 영상 정보
 * @param {Object} product - 상품 정보
 */
function calculateMatchScore(video, product) {
  let score = 0;
  const searchText = `${video.title} ${video.description}`.toLowerCase();

  // 상품명 매칭 (40점)
  if (searchText.includes(product.productName.toLowerCase())) {
    score += 40;
  }

  // 브랜드명 매칭 - DatepalmBay (30점)
  if (searchText.includes('datepalmbay') || searchText.includes('데이트팜베이')) {
    score += 30;
  }

  // 카테고리 키워드 매칭 (20점)
  const categoryKeywords = {
    'BEAUTY': ['세럼', 'serum', '화장품', 'skincare', '스킨케어', '뷰티', 'beauty'],
    'SUPPLEMENT': ['영양제', 'supplement', '비타민', 'vitamin', '건강'],
    'LIFESTYLE': ['라이프스타일', 'lifestyle']
  };

  const keywords = categoryKeywords[product.productCategory] || [];
  if (keywords.some(kw => searchText.includes(kw.toLowerCase()))) {
    score += 20;
  }

  // 리뷰/후기 키워드 (10점)
  if (searchText.includes('리뷰') || searchText.includes('후기') || searchText.includes('review')) {
    score += 10;
  }

  return score;
}

module.exports = {
  searchVideos,
  getVideoDetails,
  searchProductReviews,
  calculateMatchScore,
  extractHashtagsFromProduct,
  generateHashtagSearchQueries
};
