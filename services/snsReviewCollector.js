/**
 * SNS Review Collector Service
 *
 * YouTube, TikTok, Instagram에서 상품 관련 리뷰를 자동으로 수집합니다.
 */

const { searchProductReviews, extractHashtagsFromProduct } = require('./youtube');
const instagram = require('./instagram');
const tiktok = require('./tiktok');

// 상품별 최대 수집 개수
const MAX_REVIEWS_PER_PRODUCT = 50;

// 수집된 리뷰를 저장할 참조 (server.js에서 주입)
let snsReviewsRef = null;
let productsRef = null;
let saveCallback = null; // 파일 저장 콜백
let nextReviewId = 100;

/**
 * 참조 설정 (server.js에서 호출)
 * @param {Array} snsReviews - SNS 리뷰 배열 참조
 * @param {Array} products - 상품 배열 참조
 * @param {Function} onSave - 데이터 저장 콜백 함수
 */
function setReferences(snsReviews, products, onSave) {
  snsReviewsRef = snsReviews;
  productsRef = products;
  saveCallback = onSave || null;
  nextReviewId = Math.max(...snsReviews.map(r => r.id), 0) + 1;
}

/**
 * YouTube 리뷰 수집
 */
async function collectYouTubeReviews() {
  if (!productsRef || !snsReviewsRef) {
    console.error('❌ References not set. Call setReferences first.');
    return { success: false, collected: 0 };
  }

  console.log('\n🎬 ========== YouTube 리뷰 수집 시작 ==========');

  const activeProducts = productsRef.filter(p => p.productSaleStatus === true);
  console.log(`📦 활성 상품 수: ${activeProducts.length}`);

  let totalCollectedCount = 0;

  for (const product of activeProducts) {
    // 상품별 수집 개수 초기화
    let productCollectedCount = 0;

    // 해시태그 추출
    const hashtags = extractHashtagsFromProduct(product);
    console.log(`\n🔍 상품 검색: ${product.productName}`);
    if (hashtags.length > 0) {
      console.log(`  📌 해시태그 사용: ${hashtags.map(t => '#' + t).join(', ')}`);
    }

    try {
      const videos = await searchProductReviews(product);

      for (const video of videos) {
        // 상품별 최대 수집 개수 체크
        if (productCollectedCount >= MAX_REVIEWS_PER_PRODUCT) {
          console.log(`  ⚠️ 상품별 최대 수집 개수(${MAX_REVIEWS_PER_PRODUCT})에 도달`);
          break;
        }

        // 이미 수집된 영상인지 확인
        const exists = snsReviewsRef.some(
          r => r.platform === 'YOUTUBE' && r.externalId === video.videoId
        );

        if (exists) {
          console.log(`  ⏭️ 이미 수집됨: ${video.title.substring(0, 30)}...`);
          continue;
        }

        // 해시태그 또는 상품명 기반 매칭
        const searchText = `${video.title} ${video.description}`.toLowerCase();
        const productNameLower = product.productName.trim().toLowerCase();

        // 매칭 조건: 해시태그 중 하나라도 포함 OR 상품명 포함
        let isMatched = false;
        let matchScore = 0;

        // 해시태그 매칭 (우선순위 높음)
        if (hashtags.length > 0) {
          const matchedHashtags = hashtags.filter(tag =>
            searchText.includes(tag.toLowerCase())
          );
          if (matchedHashtags.length > 0) {
            isMatched = true;
            // 매칭된 해시태그 비율에 따른 점수 (최대 100점)
            matchScore = Math.round((matchedHashtags.length / hashtags.length) * 100);
            console.log(`  🏷️ 해시태그 매칭: ${matchedHashtags.map(t => '#' + t).join(', ')} (${matchScore}점)`);
          }
        }

        // 상품명 매칭 (fallback)
        if (!isMatched && searchText.includes(productNameLower)) {
          isMatched = true;
          matchScore = 80; // 상품명 매칭은 80점
        }

        if (isMatched) {
          const newReview = {
            id: nextReviewId++,
            platform: 'YOUTUBE',
            externalId: video.videoId,
            contentUrl: `https://www.youtube.com/watch?v=${video.videoId}`,
            thumbnailUrl: video.thumbnailUrl,
            title: video.title,
            description: video.description,
            authorName: video.channelTitle,
            authorId: video.channelId,
            publishedAt: video.publishedAt,
            viewCount: video.viewCount,
            likeCount: video.likeCount,
            status: 'PENDING', // 수동 승인 대기
            matchedProducts: [{ productCode: product.productCode, matchScore: matchScore }],
            createdAt: new Date().toISOString()
          };

          snsReviewsRef.push(newReview);
          productCollectedCount++;
          totalCollectedCount++;

          console.log(`  ✅ 수집 완료: ${video.title.substring(0, 30)}...`);
        } else {
          console.log(`  ⏭️ 매칭 실패: ${video.title.substring(0, 30)}...`);
        }
      }

      // API 쿼터 보호를 위한 딜레이
      await new Promise(resolve => setTimeout(resolve, 1000));

    } catch (error) {
      console.error(`  ❌ 에러: ${error.message}`);
    }
  }

  console.log(`\n🎬 ========== YouTube 수집 완료: ${totalCollectedCount}개 ==========\n`);

  // 수집된 데이터를 파일에 저장
  if (totalCollectedCount > 0 && saveCallback) {
    saveCallback();
  }

  return { success: true, collected: totalCollectedCount };
}

/**
 * Instagram 리뷰 수집
 */
async function collectInstagramReviews() {
  if (!productsRef || !snsReviewsRef) {
    console.error('❌ References not set. Call setReferences first.');
    return { success: false, collected: 0 };
  }

  // Instagram API 연결 상태 확인
  const connectionStatus = await instagram.checkConnection();
  if (!connectionStatus.connected) {
    console.log('\n📷 ========== Instagram API 미설정 ==========');
    console.log(`⚠️ ${connectionStatus.message}`);
    instagram.printSetupGuide();
    return {
      success: false,
      collected: 0,
      message: connectionStatus.message,
      setupRequired: true
    };
  }

  console.log('\n📷 ========== Instagram 리뷰 수집 시작 ==========');
  console.log(`✅ 연결된 계정: @${connectionStatus.account.username}`);

  const activeProducts = productsRef.filter(p => p.productSaleStatus === true);
  console.log(`📦 활성 상품 수: ${activeProducts.length}`);

  let totalCollectedCount = 0;

  for (const product of activeProducts) {
    let productCollectedCount = 0;

    // 해시태그 추출
    const hashtags = extractHashtagsFromProduct(product);
    console.log(`\n🔍 상품 검색: ${product.productName}`);
    if (hashtags.length > 0) {
      console.log(`  📌 해시태그 사용: ${hashtags.map(t => '#' + t).join(', ')}`);
    }

    try {
      const posts = await instagram.searchProductPosts(product, hashtags);

      for (const post of posts) {
        // 상품별 최대 수집 개수 체크
        if (productCollectedCount >= MAX_REVIEWS_PER_PRODUCT) {
          console.log(`  ⚠️ 상품별 최대 수집 개수(${MAX_REVIEWS_PER_PRODUCT})에 도달`);
          break;
        }

        // 이미 수집된 게시물인지 확인
        const exists = snsReviewsRef.some(
          r => r.platform === 'INSTAGRAM' && r.externalId === post.postId
        );

        if (exists) {
          console.log(`  ⏭️ 이미 수집됨: ${(post.caption || '').substring(0, 30)}...`);
          continue;
        }

        // 매칭 점수 계산
        const matchScore = instagram.calculateMatchScore(post, product, hashtags);

        // 최소 점수 이상이면 수집 (20점 이상)
        if (matchScore >= 20) {
          const newReview = {
            id: nextReviewId++,
            platform: 'INSTAGRAM',
            externalId: post.postId,
            contentUrl: post.permalink,
            thumbnailUrl: post.thumbnailUrl || post.mediaUrl,
            title: `@${post.username}의 Instagram 게시물`,
            description: post.caption || '',
            authorName: post.username,
            authorId: post.username,
            publishedAt: post.timestamp,
            viewCount: 0, // Instagram은 조회수 미제공
            likeCount: post.likeCount || 0,
            commentCount: post.commentsCount || 0,
            mediaType: post.mediaType,
            status: 'PENDING', // 수동 승인 대기
            matchedProducts: [{ productCode: product.productCode, matchScore: matchScore }],
            createdAt: new Date().toISOString()
          };

          snsReviewsRef.push(newReview);
          productCollectedCount++;
          totalCollectedCount++;

          console.log(`  ✅ 수집 완료: @${post.username} (${matchScore}점)`);
        } else {
          console.log(`  ⏭️ 매칭 점수 낮음: @${post.username} (${matchScore}점)`);
        }
      }

      // API 쿼터 보호를 위한 딜레이
      await new Promise(resolve => setTimeout(resolve, 2000));

    } catch (error) {
      console.error(`  ❌ 에러: ${error.message}`);
    }
  }

  console.log(`\n📷 ========== Instagram 수집 완료: ${totalCollectedCount}개 ==========\n`);

  // 수집된 데이터를 파일에 저장
  if (totalCollectedCount > 0 && saveCallback) {
    saveCallback();
  }

  return { success: true, collected: totalCollectedCount };
}

/**
 * TikTok 리뷰 수집
 *
 * 참고: TikTok은 공개 해시태그 검색 API를 제공하지 않습니다.
 * - Display API: 사용자 OAuth 필요, 본인 콘텐츠만 접근 가능
 * - Research API: 연구자 승인 필요
 * - oEmbed API: URL 기반 메타데이터만 제공 (검색 불가)
 *
 * 따라서 TikTok 리뷰는 Admin 페이지에서 URL을 수동으로 입력하여 추가합니다.
 */
async function collectTikTokReviews() {
  console.log('\n🎵 ========== TikTok 자동 수집 불가 ==========');
  console.log('⚠️ TikTok은 공개 해시태그 검색 API를 제공하지 않습니다.');
  console.log('📱 TikTok 리뷰는 Admin 페이지에서 URL을 수동으로 추가해주세요.');
  console.log('   지원 URL 형식:');
  console.log('   • https://www.tiktok.com/@username/video/1234567890');
  console.log('   • https://vm.tiktok.com/XXXXXXXXX/');
  tiktok.printSetupGuide();

  return {
    success: false,
    collected: 0,
    message: 'TikTok automatic collection not available. Use manual URL addition instead.',
    manualOnly: true
  };
}

/**
 * 수동 수집 트리거 (API 엔드포인트용)
 */
async function triggerCollection(platform = 'ALL') {
  const results = { youtube: null, tiktok: null, instagram: null };

  if (platform === 'ALL' || platform === 'YOUTUBE') {
    results.youtube = await collectYouTubeReviews();
  }

  if (platform === 'ALL' || platform === 'TIKTOK') {
    results.tiktok = await collectTikTokReviews();
  }

  if (platform === 'ALL' || platform === 'INSTAGRAM') {
    results.instagram = await collectInstagramReviews();
  }

  return results;
}

/**
 * 수집 통계 조회
 */
function getCollectionStats() {
  if (!snsReviewsRef) {
    return { error: 'References not set' };
  }

  const youtubeReviews = snsReviewsRef.filter(r => r.platform === 'YOUTUBE');
  const tiktokReviews = snsReviewsRef.filter(r => r.platform === 'TIKTOK');
  const instagramReviews = snsReviewsRef.filter(r => r.platform === 'INSTAGRAM');

  return {
    total: snsReviewsRef.length,
    youtube: {
      total: youtubeReviews.length,
      pending: youtubeReviews.filter(r => r.status === 'PENDING').length,
      approved: youtubeReviews.filter(r => r.status === 'APPROVED').length,
      rejected: youtubeReviews.filter(r => r.status === 'REJECTED').length
    },
    tiktok: {
      total: tiktokReviews.length,
      pending: tiktokReviews.filter(r => r.status === 'PENDING').length,
      approved: tiktokReviews.filter(r => r.status === 'APPROVED').length,
      rejected: tiktokReviews.filter(r => r.status === 'REJECTED').length
    },
    instagram: {
      total: instagramReviews.length,
      pending: instagramReviews.filter(r => r.status === 'PENDING').length,
      approved: instagramReviews.filter(r => r.status === 'APPROVED').length,
      rejected: instagramReviews.filter(r => r.status === 'REJECTED').length
    }
  };
}

module.exports = {
  setReferences,
  collectYouTubeReviews,
  collectTikTokReviews,
  collectInstagramReviews,
  triggerCollection,
  getCollectionStats
};
