/**
 * Instagram Graph API Service
 *
 * Instagram에서 해시태그 기반으로 상품 관련 게시물을 검색하고 수집합니다.
 *
 * 필요한 환경변수:
 * - INSTAGRAM_ACCESS_TOKEN: Instagram Graph API 액세스 토큰
 * - INSTAGRAM_BUSINESS_ACCOUNT_ID: Instagram 비즈니스 계정 ID
 *
 * Instagram Graph API 사용을 위해 필요한 것:
 * 1. Facebook Developer App
 * 2. Instagram Business 또는 Creator 계정
 * 3. Facebook Page와 Instagram 계정 연결
 * 4. instagram_basic, instagram_content_publish, pages_read_engagement 권한
 */

const https = require('https');

const INSTAGRAM_API_BASE = 'https://graph.facebook.com/v18.0';

/**
 * Instagram Graph API 호출 함수
 */
function callInstagramAPI(endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;

    if (!accessToken) {
      reject(new Error('INSTAGRAM_ACCESS_TOKEN is not set in environment variables'));
      return;
    }

    const queryParams = new URLSearchParams({
      ...params,
      access_token: accessToken
    });

    const url = `${INSTAGRAM_API_BASE}/${endpoint}?${queryParams}`;

    https.get(url, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            reject(new Error(`Instagram API Error: ${json.error.message}`));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(new Error(`Failed to parse Instagram API response: ${e.message}`));
        }
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * 해시태그 ID 검색
 * @param {string} hashtag - 검색할 해시태그 (# 제외)
 * @returns {string|null} - 해시태그 ID
 */
async function searchHashtagId(hashtag) {
  const businessAccountId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;

  if (!businessAccountId) {
    throw new Error('INSTAGRAM_BUSINESS_ACCOUNT_ID is not set in environment variables');
  }

  console.log(`🔍 Instagram 해시태그 검색: #${hashtag}`);

  try {
    const response = await callInstagramAPI('ig_hashtag_search', {
      user_id: businessAccountId,
      q: hashtag
    });

    if (response.data && response.data.length > 0) {
      const hashtagId = response.data[0].id;
      console.log(`✅ 해시태그 ID 발견: ${hashtagId}`);
      return hashtagId;
    }

    console.log(`⚠️ 해시태그를 찾을 수 없음: #${hashtag}`);
    return null;
  } catch (error) {
    console.error(`❌ 해시태그 검색 실패: ${error.message}`);
    return null;
  }
}

/**
 * 해시태그의 최근 미디어 검색
 * @param {string} hashtagId - 해시태그 ID
 * @param {number} limit - 최대 결과 수 (기본값: 30)
 */
async function getRecentHashtagMedia(hashtagId, limit = 30) {
  const businessAccountId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;

  if (!businessAccountId) {
    throw new Error('INSTAGRAM_BUSINESS_ACCOUNT_ID is not set in environment variables');
  }

  try {
    const response = await callInstagramAPI(`${hashtagId}/recent_media`, {
      user_id: businessAccountId,
      fields: 'id,caption,media_type,media_url,permalink,thumbnail_url,timestamp,like_count,comments_count,username',
      limit: limit
    });

    if (response.data) {
      console.log(`✅ ${response.data.length}개 게시물 발견`);
      return response.data;
    }

    return [];
  } catch (error) {
    console.error(`❌ 해시태그 미디어 조회 실패: ${error.message}`);
    return [];
  }
}

/**
 * 해시태그의 인기 미디어 검색
 * @param {string} hashtagId - 해시태그 ID
 * @param {number} limit - 최대 결과 수 (기본값: 30)
 */
async function getTopHashtagMedia(hashtagId, limit = 30) {
  const businessAccountId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;

  if (!businessAccountId) {
    throw new Error('INSTAGRAM_BUSINESS_ACCOUNT_ID is not set in environment variables');
  }

  try {
    const response = await callInstagramAPI(`${hashtagId}/top_media`, {
      user_id: businessAccountId,
      fields: 'id,caption,media_type,media_url,permalink,thumbnail_url,timestamp,like_count,comments_count,username',
      limit: limit
    });

    if (response.data) {
      console.log(`✅ ${response.data.length}개 인기 게시물 발견`);
      return response.data;
    }

    return [];
  } catch (error) {
    console.error(`❌ 인기 미디어 조회 실패: ${error.message}`);
    return [];
  }
}

/**
 * 상품 관련 Instagram 게시물 검색 (해시태그 기반)
 * @param {Object} product - 상품 정보
 * @param {string[]} hashtags - 검색할 해시태그 배열
 */
async function searchProductPosts(product, hashtags) {
  const allPosts = [];
  const seenIds = new Set();

  // 해시태그가 없으면 상품명에서 추출
  const searchHashtags = hashtags.length > 0
    ? hashtags
    : [product.productName.replace(/\s+/g, '').toLowerCase()];

  console.log(`📷 Instagram 검색: ${searchHashtags.map(t => '#' + t).join(', ')}`);

  // 각 해시태그에 대해 검색 (최대 3개)
  for (const hashtag of searchHashtags.slice(0, 3)) {
    try {
      const hashtagId = await searchHashtagId(hashtag);

      if (!hashtagId) continue;

      // 최근 미디어 검색
      const recentMedia = await getRecentHashtagMedia(hashtagId, 20);

      // 인기 미디어 검색
      const topMedia = await getTopHashtagMedia(hashtagId, 10);

      // 결과 병합 (중복 제거)
      for (const post of [...topMedia, ...recentMedia]) {
        if (!seenIds.has(post.id)) {
          seenIds.add(post.id);
          allPosts.push({
            ...post,
            searchedHashtag: hashtag
          });
        }
      }

      // API 쿼터 보호를 위한 딜레이
      await new Promise(resolve => setTimeout(resolve, 1000));

    } catch (error) {
      console.error(`❌ 해시태그 #${hashtag} 검색 실패: ${error.message}`);
    }
  }

  // 게시물을 SNS Review 형식으로 변환
  return allPosts.map(post => ({
    postId: post.id,
    caption: post.caption || '',
    mediaType: post.media_type,
    mediaUrl: post.media_url || post.thumbnail_url,
    thumbnailUrl: post.thumbnail_url || post.media_url,
    permalink: post.permalink,
    timestamp: post.timestamp,
    likeCount: post.like_count || 0,
    commentsCount: post.comments_count || 0,
    username: post.username,
    searchedHashtag: post.searchedHashtag,
    matchedProductCode: product.productCode
  }));
}

/**
 * Instagram 게시물과 상품 매칭 점수 계산
 * @param {Object} post - Instagram 게시물
 * @param {Object} product - 상품 정보
 * @param {string[]} hashtags - 상품 해시태그
 */
function calculateMatchScore(post, product, hashtags) {
  let score = 0;
  const caption = (post.caption || '').toLowerCase();

  // 해시태그 매칭 (최대 60점)
  const matchedHashtags = hashtags.filter(tag =>
    caption.includes(`#${tag.toLowerCase()}`) || caption.includes(tag.toLowerCase())
  );
  score += Math.min(matchedHashtags.length * 20, 60);

  // 상품명 매칭 (30점)
  const productNameLower = product.productName.toLowerCase().replace(/\s+/g, '');
  if (caption.includes(productNameLower)) {
    score += 30;
  }

  // 리뷰 관련 키워드 (10점)
  const reviewKeywords = ['리뷰', 'review', '후기', '추천', 'recommend', '좋아요', 'love', 'amazing', 'best'];
  if (reviewKeywords.some(kw => caption.includes(kw.toLowerCase()))) {
    score += 10;
  }

  return score;
}

/**
 * Instagram API 연결 상태 확인
 */
async function checkConnection() {
  const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
  const businessAccountId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;

  if (!accessToken || !businessAccountId) {
    return {
      connected: false,
      message: 'Instagram API credentials not configured',
      details: {
        hasAccessToken: !!accessToken,
        hasBusinessAccountId: !!businessAccountId
      }
    };
  }

  try {
    // 비즈니스 계정 정보 조회로 연결 테스트
    const response = await callInstagramAPI(businessAccountId, {
      fields: 'id,username,name,profile_picture_url,followers_count,media_count'
    });

    return {
      connected: true,
      message: 'Instagram API connected successfully',
      account: {
        id: response.id,
        username: response.username,
        name: response.name,
        profilePicture: response.profile_picture_url,
        followers: response.followers_count,
        mediaCount: response.media_count
      }
    };
  } catch (error) {
    return {
      connected: false,
      message: `Instagram API connection failed: ${error.message}`,
      error: error.message
    };
  }
}

/**
 * Instagram API 설정 가이드 출력
 */
function printSetupGuide() {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║              Instagram Graph API 설정 가이드                    ║
╠════════════════════════════════════════════════════════════════╣
║                                                                ║
║  1. Facebook Developer 계정 생성                               ║
║     https://developers.facebook.com/                           ║
║                                                                ║
║  2. 새 앱 생성 (비즈니스 타입)                                 ║
║     - 앱 대시보드에서 "Instagram Graph API" 추가               ║
║                                                                ║
║  3. Instagram Business 계정 연결                               ║
║     - Facebook 페이지 생성 또는 기존 페이지 사용               ║
║     - Instagram 계정을 Business/Creator로 전환                 ║
║     - Facebook 페이지와 Instagram 계정 연결                    ║
║                                                                ║
║  4. 필요한 권한 요청                                           ║
║     - instagram_basic                                          ║
║     - instagram_content_publish (선택)                         ║
║     - pages_read_engagement                                    ║
║                                                                ║
║  5. 액세스 토큰 생성                                           ║
║     - Graph API Explorer에서 토큰 생성                         ║
║     - 장기 토큰으로 변환 (60일 유효)                           ║
║                                                                ║
║  6. 환경변수 설정 (.env 파일)                                  ║
║     INSTAGRAM_ACCESS_TOKEN=your_access_token                   ║
║     INSTAGRAM_BUSINESS_ACCOUNT_ID=your_business_id             ║
║                                                                ║
║  참고 문서:                                                    ║
║  https://developers.facebook.com/docs/instagram-api/           ║
║                                                                ║
╚════════════════════════════════════════════════════════════════╝
  `);
}

module.exports = {
  searchHashtagId,
  getRecentHashtagMedia,
  getTopHashtagMedia,
  searchProductPosts,
  calculateMatchScore,
  checkConnection,
  printSetupGuide
};
