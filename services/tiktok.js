/**
 * TikTok oEmbed Service
 *
 * TikTok URL을 입력받아 기본 메타데이터를 가져옵니다.
 * 공식 TikTok oEmbed API를 사용합니다. (API 키 불필요)
 *
 * 주의: TikTok은 공개 해시태그 검색 API를 제공하지 않습니다.
 * - Display API: 사용자 OAuth 필요, 본인 콘텐츠만 접근 가능
 * - Research API: 연구자 승인 필요
 * - oEmbed API: URL 기반 메타데이터만 제공 (통계 없음)
 *
 * 따라서 TikTok 리뷰는 관리자가 URL을 수동으로 입력하는 방식으로 운영합니다.
 */

const https = require('https');

const TIKTOK_OEMBED_URL = 'https://www.tiktok.com/oembed';

/**
 * HTTPS GET 요청 헬퍼
 */
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);

    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'DatepalmBay-SNS-Collector/1.0'
      }
    };

    const req = https.request(options, (res) => {
      let responseData = '';

      res.on('data', (chunk) => {
        responseData += chunk;
      });

      res.on('end', () => {
        try {
          const json = JSON.parse(responseData);
          resolve({ statusCode: res.statusCode, data: json });
        } catch (e) {
          reject(new Error(`Failed to parse response: ${e.message}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.end();
  });
}

/**
 * TikTok URL에서 비디오 ID 추출
 * @param {string} url - TikTok 동영상 URL
 * @returns {string|null} - 비디오 ID 또는 null
 */
function extractVideoId(url) {
  // 지원하는 URL 형식:
  // https://www.tiktok.com/@username/video/1234567890123456789
  // https://vm.tiktok.com/XXXXXXXXX/
  // https://www.tiktok.com/t/XXXXXXXXX/

  try {
    const urlObj = new URL(url);

    // 일반 TikTok URL
    if (urlObj.hostname.includes('tiktok.com')) {
      const videoMatch = urlObj.pathname.match(/video\/(\d+)/);
      if (videoMatch) {
        return videoMatch[1];
      }

      // 단축 URL에서는 ID를 직접 추출할 수 없음 (oEmbed로 처리)
      return urlObj.pathname.replace(/\//g, '') || null;
    }

    return null;
  } catch (error) {
    console.error('  ❌ URL 파싱 오류:', error.message);
    return null;
  }
}

/**
 * TikTok URL 유효성 검사
 * @param {string} url - 검사할 URL
 * @returns {boolean} - 유효한 TikTok URL인지 여부
 */
function isValidTikTokUrl(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.includes('tiktok.com');
  } catch {
    return false;
  }
}

/**
 * oEmbed API로 TikTok 동영상 메타데이터 조회
 * @param {string} videoUrl - TikTok 동영상 URL
 * @returns {Object|null} - 메타데이터 또는 null
 */
async function getVideoMetadata(videoUrl) {
  if (!isValidTikTokUrl(videoUrl)) {
    console.log('  ❌ 유효하지 않은 TikTok URL:', videoUrl);
    return null;
  }

  console.log(`  🎵 TikTok 메타데이터 조회: ${videoUrl}`);

  try {
    const oembedUrl = `${TIKTOK_OEMBED_URL}?url=${encodeURIComponent(videoUrl)}`;
    const response = await httpsGet(oembedUrl);

    if (response.statusCode !== 200) {
      console.log(`  ❌ TikTok oEmbed 오류: HTTP ${response.statusCode}`);
      return null;
    }

    const data = response.data;

    // oEmbed 응답 형식:
    // {
    //   "version": "1.0",
    //   "type": "video",
    //   "title": "영상 제목/설명",
    //   "author_url": "https://www.tiktok.com/@username",
    //   "author_name": "username",
    //   "thumbnail_url": "https://...",
    //   "thumbnail_width": 720,
    //   "thumbnail_height": 1280,
    //   "html": "<blockquote>...</blockquote>",
    //   "provider_url": "https://www.tiktok.com",
    //   "provider_name": "TikTok"
    // }

    console.log(`  ✅ TikTok 메타데이터 조회 성공: "${data.title?.slice(0, 50)}..."`);

    return {
      title: data.title || '',
      description: data.title || '',  // TikTok은 title에 설명이 포함됨
      authorName: data.author_name || '',
      authorId: data.author_name || '',
      authorUrl: data.author_url || '',
      thumbnailUrl: data.thumbnail_url || '',
      thumbnailWidth: data.thumbnail_width || 0,
      thumbnailHeight: data.thumbnail_height || 0,
      embedHtml: data.html || '',
      contentUrl: videoUrl,
      // oEmbed에서 제공하지 않는 필드 (0으로 설정)
      viewCount: 0,
      likeCount: 0,
      commentCount: 0,
      shareCount: 0
    };
  } catch (error) {
    console.error(`  ❌ TikTok oEmbed 오류: ${error.message}`);
    return null;
  }
}

/**
 * TikTok URL로부터 SNS 리뷰 객체 생성
 * @param {string} videoUrl - TikTok 동영상 URL
 * @param {string} productCode - 연결할 상품 코드 (선택)
 * @returns {Object|null} - SNS 리뷰 객체 또는 null
 */
async function createReviewFromUrl(videoUrl, productCode = null) {
  const metadata = await getVideoMetadata(videoUrl);

  if (!metadata) {
    return null;
  }

  const videoId = extractVideoId(videoUrl);

  return {
    platform: 'TIKTOK',
    externalId: videoId || `tiktok-${Date.now()}`,
    contentUrl: metadata.contentUrl,
    thumbnailUrl: metadata.thumbnailUrl,
    title: metadata.title,
    description: metadata.description,
    authorName: metadata.authorName,
    authorId: metadata.authorId,
    publishedAt: new Date().toISOString(),  // oEmbed에서 날짜 미제공
    viewCount: metadata.viewCount,
    likeCount: metadata.likeCount,
    commentCount: metadata.commentCount,
    shareCount: metadata.shareCount,
    status: 'PENDING',
    matchedProducts: productCode ? [{
      productCode: productCode,
      matchScore: 100  // 수동 추가이므로 100점
    }] : []
  };
}

/**
 * TikTok 서비스 상태 확인
 * oEmbed는 API 키가 필요 없으므로 항상 사용 가능
 */
function checkConnection() {
  return {
    configured: true,  // oEmbed는 항상 사용 가능
    mode: 'oembed',
    note: 'TikTok oEmbed API - 수동 URL 추가만 지원'
  };
}

/**
 * TikTok 사용 가이드 출력
 */
function printSetupGuide() {
  console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║                    TikTok 리뷰 추가 가이드                          ║
╠═══════════════════════════════════════════════════════════════════╣
║                                                                   ║
║  TikTok은 공개 해시태그 검색 API를 제공하지 않습니다.                ║
║  대신 관리자가 URL을 수동으로 입력하여 리뷰를 추가할 수 있습니다.     ║
║                                                                   ║
║  사용 방법:                                                        ║
║  1. TikTok에서 관련 리뷰 영상을 찾습니다                            ║
║  2. 영상 URL을 복사합니다                                          ║
║     예: https://www.tiktok.com/@user/video/1234567890             ║
║  3. Admin 페이지에서 "TikTok URL 추가" 기능을 사용합니다             ║
║                                                                   ║
║  지원 URL 형식:                                                    ║
║  • https://www.tiktok.com/@username/video/1234567890             ║
║  • https://vm.tiktok.com/XXXXXXXXX/                              ║
║  • https://www.tiktok.com/t/XXXXXXXXX/                           ║
║                                                                   ║
║  참고: oEmbed API는 조회수, 좋아요 등 통계를 제공하지 않습니다.       ║
║                                                                   ║
╚═══════════════════════════════════════════════════════════════════╝
  `);
}

/**
 * API 제한 사항 안내
 */
function getApiLimitations() {
  return {
    automaticCollection: false,
    hashtagSearch: false,
    viewCounts: false,
    likeCounts: false,
    commentCounts: false,
    shareCounts: false,
    manualUrlAdd: true,
    basicMetadata: true,
    thumbnail: true,
    authorInfo: true,
    message: 'TikTok oEmbed API는 기본 메타데이터만 제공합니다. 통계(조회수, 좋아요 등)는 사용할 수 없습니다.'
  };
}

module.exports = {
  checkConnection,
  isValidTikTokUrl,
  extractVideoId,
  getVideoMetadata,
  createReviewFromUrl,
  printSetupGuide,
  getApiLimitations
};
