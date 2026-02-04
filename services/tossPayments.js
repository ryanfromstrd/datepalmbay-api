/**
 * Toss Payments Service
 *
 * Toss Payments API와 통신하는 서비스입니다.
 * 결제 승인, 조회, 취소 등의 기능을 제공합니다.
 *
 * 참고: https://docs.tosspayments.com/reference
 */

const https = require('https');

const TOSS_CLIENT_KEY = process.env.TOSS_CLIENT_KEY;
const TOSS_SECRET_KEY = process.env.TOSS_SECRET_KEY;
const TOSS_API_URL = 'https://api.tosspayments.com';

/**
 * Basic 인증 헤더 생성
 * Toss Payments API는 시크릿 키를 Base64로 인코딩하여 사용
 */
function getAuthHeader() {
  const encoded = Buffer.from(`${TOSS_SECRET_KEY}:`).toString('base64');
  return `Basic ${encoded}`;
}

/**
 * HTTPS POST 요청 헬퍼
 */
function httpsPost(path, data) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(data);
    const url = new URL(path, TOSS_API_URL);

    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Authorization': getAuthHeader(),
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
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
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true, data: json });
          } else {
            resolve({ ok: false, error: json });
          }
        } catch (e) {
          reject(new Error(`Failed to parse response: ${e.message}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.write(postData);
    req.end();
  });
}

/**
 * HTTPS GET 요청 헬퍼
 */
function httpsGet(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, TOSS_API_URL);

    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'GET',
      headers: {
        'Authorization': getAuthHeader()
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
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true, data: json });
          } else {
            resolve({ ok: false, error: json });
          }
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
 * 결제 승인
 *
 * 클라이언트에서 결제 인증 후 서버에서 최종 승인을 요청합니다.
 *
 * @param {string} paymentKey - Toss Payments에서 발급한 결제 키
 * @param {string} orderId - 주문 ID
 * @param {number} amount - 결제 금액
 * @returns {Promise<Object>} - 결제 승인 결과
 */
async function confirmPayment(paymentKey, orderId, amount) {
  console.log('\n💳 [Toss Payments] 결제 승인 요청');
  console.log(`  paymentKey: ${paymentKey}`);
  console.log(`  orderId: ${orderId}`);
  console.log(`  amount: ${amount}`);

  try {
    const response = await httpsPost('/v1/payments/confirm', {
      paymentKey,
      orderId,
      amount
    });

    if (response.ok) {
      console.log('  ✅ 결제 승인 성공');
      console.log(`  status: ${response.data.status}`);
      console.log(`  method: ${response.data.method}`);
      return response;
    } else {
      console.log('  ❌ 결제 승인 실패');
      console.log(`  error: ${response.error?.message || JSON.stringify(response.error)}`);
      return response;
    }
  } catch (error) {
    console.error('  ❌ 결제 승인 오류:', error.message);
    return { ok: false, error: { message: error.message } };
  }
}

/**
 * 결제 조회
 *
 * paymentKey로 결제 정보를 조회합니다.
 *
 * @param {string} paymentKey - 결제 키
 * @returns {Promise<Object>} - 결제 정보
 */
async function getPayment(paymentKey) {
  console.log(`\n🔍 [Toss Payments] 결제 조회: ${paymentKey}`);

  try {
    const response = await httpsGet(`/v1/payments/${paymentKey}`);

    if (response.ok) {
      console.log('  ✅ 결제 조회 성공');
      return response;
    } else {
      console.log('  ❌ 결제 조회 실패');
      return response;
    }
  } catch (error) {
    console.error('  ❌ 결제 조회 오류:', error.message);
    return { ok: false, error: { message: error.message } };
  }
}

/**
 * 주문번호로 결제 조회
 *
 * @param {string} orderId - 주문 ID
 * @returns {Promise<Object>} - 결제 정보
 */
async function getPaymentByOrderId(orderId) {
  console.log(`\n🔍 [Toss Payments] 주문번호로 결제 조회: ${orderId}`);

  try {
    const response = await httpsGet(`/v1/payments/orders/${orderId}`);

    if (response.ok) {
      console.log('  ✅ 결제 조회 성공');
      return response;
    } else {
      console.log('  ❌ 결제 조회 실패');
      return response;
    }
  } catch (error) {
    console.error('  ❌ 결제 조회 오류:', error.message);
    return { ok: false, error: { message: error.message } };
  }
}

/**
 * 결제 취소/환불
 *
 * @param {string} paymentKey - 결제 키
 * @param {string} cancelReason - 취소 사유
 * @param {number} cancelAmount - 취소 금액 (부분 취소 시)
 * @returns {Promise<Object>} - 취소 결과
 */
async function cancelPayment(paymentKey, cancelReason, cancelAmount = null) {
  console.log('\n🔄 [Toss Payments] 결제 취소 요청');
  console.log(`  paymentKey: ${paymentKey}`);
  console.log(`  cancelReason: ${cancelReason}`);
  if (cancelAmount) {
    console.log(`  cancelAmount: ${cancelAmount} (부분 취소)`);
  }

  try {
    const data = { cancelReason };
    if (cancelAmount) {
      data.cancelAmount = cancelAmount;
    }

    const response = await httpsPost(`/v1/payments/${paymentKey}/cancel`, data);

    if (response.ok) {
      console.log('  ✅ 결제 취소 성공');
      return response;
    } else {
      console.log('  ❌ 결제 취소 실패');
      console.log(`  error: ${response.error?.message || JSON.stringify(response.error)}`);
      return response;
    }
  } catch (error) {
    console.error('  ❌ 결제 취소 오류:', error.message);
    return { ok: false, error: { message: error.message } };
  }
}

/**
 * API 연결 상태 확인
 */
function checkConnection() {
  const configured = !!(TOSS_CLIENT_KEY && TOSS_SECRET_KEY);
  return {
    configured,
    clientKey: TOSS_CLIENT_KEY ? `${TOSS_CLIENT_KEY.substring(0, 10)}...` : null,
    message: configured
      ? 'Toss Payments API configured'
      : 'Toss Payments API not configured. Set TOSS_CLIENT_KEY and TOSS_SECRET_KEY in .env'
  };
}

/**
 * 설정 가이드 출력
 */
function printSetupGuide() {
  console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║                    Toss Payments 설정 가이드                       ║
╠═══════════════════════════════════════════════════════════════════╣
║                                                                   ║
║  1. Toss Payments 개발자센터 가입                                  ║
║     https://developers.tosspayments.com                           ║
║                                                                   ║
║  2. 테스트 키 발급                                                 ║
║     - 가입 후 자동으로 테스트용 API 키 발급                          ║
║     - 클라이언트 키: test_ck_xxx                                   ║
║     - 시크릿 키: test_sk_xxx                                       ║
║                                                                   ║
║  3. .env 파일에 키 설정                                            ║
║     TOSS_CLIENT_KEY=test_ck_xxx                                   ║
║     TOSS_SECRET_KEY=test_sk_xxx                                   ║
║                                                                   ║
║  4. 프론트엔드 환경 변수                                            ║
║     VITE_TOSS_CLIENT_KEY=test_ck_xxx                              ║
║                                                                   ║
╚═══════════════════════════════════════════════════════════════════╝
  `);
}

module.exports = {
  confirmPayment,
  getPayment,
  getPaymentByOrderId,
  cancelPayment,
  checkConnection,
  printSetupGuide
};
