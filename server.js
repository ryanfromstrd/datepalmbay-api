require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// SNS 리뷰 수집기 서비스
const snsCollector = require('./services/snsReviewCollector');
// 리뷰 요약 서비스
const reviewSummarizer = require('./services/reviewSummarizer');
// Claude AI 리뷰 분석 서비스
const claudeReviewSummarizer = require('./services/claudeReviewSummarizer');
// SKIN OS 성분 분석 서비스
const skinOS = require('./services/skinOS');
// SKIN OS Vision — Claude Vision 피부 분석 서비스
const visionSkin = require('./services/visionSkin');
// PayPal 결제 서비스
const paypalService = require('./services/paypal');
// FedEx 물류 서비스
const fedexService = require('./services/fedex');
// Aramex 물류 서비스
const aramexService = require('./services/aramex');
// MySQL Database 서비스
const database = require('./services/database');
// Twilio Verify 서비스 — 환경변수 정규식 정제 (비허용 문자 제거)
const TWILIO_ACCOUNT_SID = (process.env.TWILIO_ACCOUNT_SID || '').replace(/[^a-zA-Z0-9]/g, '');
const TWILIO_AUTH_TOKEN = (process.env.TWILIO_AUTH_TOKEN || '').replace(/[^a-f0-9]/gi, '');
const TWILIO_VERIFY_SID = (process.env.TWILIO_VERIFY_SERVICE_SID || '').replace(/[^a-zA-Z0-9]/g, '');
const twilioClient = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
  ? require('twilio')(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  : null;

let _useMySQL = false;
let _saveTimer = null;

// ========================================
// 파일 기반 영속성 (서버 재시작 시 데이터 유지)
// ========================================
// Railway Volume 지원: DATA_DIR 환경변수가 설정되면 해당 경로에 데이터 저장
// Railway Volume 미사용 시 앱 디렉토리에 저장 (배포 시 데이터 유실됨)
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'mock-data.json');

// DATA_DIR 디렉토리 생성 (Volume 마운트 시 하위 디렉토리 보장)
if (DATA_DIR !== __dirname && !fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log(`📂 데이터 디렉토리 생성: ${DATA_DIR}`);
}

// Volume 사용 시, 초기 데이터가 없으면 앱 디렉토리에서 복사
if (DATA_DIR !== __dirname && !fs.existsSync(DATA_FILE)) {
  const srcDataFile = path.join(__dirname, 'mock-data.json');
  if (fs.existsSync(srcDataFile)) {
    fs.copyFileSync(srcDataFile, DATA_FILE);
    console.log(`📋 초기 데이터를 Volume으로 복사: ${srcDataFile} → ${DATA_FILE}`);
  }
}

// ========================================
// MySQL 연결 대기 (지수 백오프 재시도)
// ========================================
async function waitForMySQL(maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await database.initTable();
      console.log('🗄️  MySQL 연결 성공, data_store 테이블 준비 완료');
      return true;
    } catch (e) {
      const delay = Math.min(1000 * Math.pow(2, i), 10000);
      console.log(`⏳ MySQL 연결 재시도 ${i + 1}/${maxRetries} (${delay}ms 후)... [${e.message}]`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  console.log('⚠️  MySQL 연결 실패, JSON 파일 모드로 동작');
  return false;
}

// ========================================
// 데이터 로드 함수 (MySQL → JSON 파일 → 빈 저장소)
// ========================================
async function loadData() {
  const emptyData = { products: [], snsReviews: [], brands: [], orders: null, members: null, users: null, userCoupons: null, coupons: null, groupBuyTeams: [], events: null, snsReviewOverrides: [], productInsights: [], aiFeedbackHistory: [], skinProfiles: [] };

  // 1단계: MySQL에서 로드 시도
  if (_useMySQL) {
    try {
      const mysqlData = await database.loadAll();
      if (mysqlData && Object.keys(mysqlData).length > 0) {
        console.log(`🗄️  MySQL에서 데이터 로드: ${mysqlData.products?.length || 0}개 상품, ${mysqlData.brands?.length || 0}개 브랜드, ${(mysqlData.orders || []).length}개 주문`);
        return {
          products: mysqlData.products || [],
          snsReviews: mysqlData.snsReviews || [],
          brands: mysqlData.brands || [],
          orders: mysqlData.orders || null,
          members: mysqlData.members || null,
          users: mysqlData.users || null,
          userCoupons: mysqlData.userCoupons || null,
          coupons: mysqlData.coupons || null,
          groupBuyTeams: mysqlData.groupBuyTeams || [],
          events: mysqlData.events || null,
          snsReviewOverrides: mysqlData.snsReviewOverrides || [],
          productInsights: mysqlData.productInsights || [],
          aiFeedbackHistory: mysqlData.aiFeedbackHistory || [],
        };
      }
      console.log('🗄️  MySQL 비어있음, JSON 파일 확인...');
    } catch (e) {
      console.error('❌ MySQL 로드 실패:', e.message);
    }
  }

  // 2단계: JSON 파일에서 로드 (+ MySQL 자동 마이그레이션)
  if (fs.existsSync(DATA_FILE)) {
    try {
      const fileContent = fs.readFileSync(DATA_FILE, 'utf-8');
      const data = JSON.parse(fileContent);
      console.log(`📁 JSON 파일에서 데이터 로드: ${data.products?.length || 0}개 상품, ${data.snsReviews?.length || 0}개 SNS 리뷰, ${data.brands?.length || 0}개 브랜드, ${(data.orders || []).length}개 주문`);

      // MySQL 사용 가능 시, JSON → MySQL 자동 마이그레이션
      if (_useMySQL) {
        console.log('🔄 JSON → MySQL 자동 마이그레이션 시작...');
        try {
          await database.saveAll({
            products: data.products || [],
            snsReviews: data.snsReviews || [],
            brands: data.brands || [],
            orders: data.orders || [],
            members: data.members || [],
            users: data.users || [],
            userCoupons: data.userCoupons || [],
            coupons: data.coupons || [],
            groupBuyTeams: data.groupBuyTeams || [],
            events: data.events || [],
          });
          console.log('✅ JSON → MySQL 마이그레이션 완료');
        } catch (e) {
          console.error('❌ MySQL 마이그레이션 실패 (JSON 데이터로 계속):', e.message);
        }
      }

      return {
        products: data.products || [],
        snsReviews: data.snsReviews || [],
        brands: data.brands || [],
        orders: data.orders || null,
        members: data.members || null,
        users: data.users || null,
        userCoupons: data.userCoupons || null,
        coupons: data.coupons || null,
        groupBuyTeams: data.groupBuyTeams || [],
        events: data.events || null,
      };
    } catch (e) {
      console.error('❌ JSON 데이터 로드 실패:', e.message);
    }
  }

  // 3단계: 저장된 데이터 없음
  console.log('📁 저장된 데이터 없음, 기본 데이터 사용');
  return emptyData;
}

// ========================================
// 데이터 저장 함수 (500ms debounce → MySQL, 실패 시 JSON 폴백)
// 동기 함수 시그니처 유지 (28개 호출부 변경 불필요)
// ========================================
function saveData() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => _saveDataImpl(), 500);
}

async function _saveDataImpl() {
  _saveTimer = null;
  const entities = {
    products: products,
    snsReviews: snsReviews,
    brands: brands,
    orders: customerOrders,
    members: members,
    users: users,
    userCoupons: userCoupons,
    coupons: coupons,
    groupBuyTeams: groupBuyTeams,
    events: events,
    snsReviewOverrides: snsReviewOverrides,
    productInsights: productInsights,
    aiFeedbackHistory: aiFeedbackHistory,
    skinProfiles: skinProfiles,
  };

  if (_useMySQL) {
    try {
      await database.saveAll(entities);
      console.log(`🗄️  MySQL 저장 완료: ${products.length}개 상품, ${(customerOrders || []).length}개 주문, ${(members || []).length}개 회원`);
      return;
    } catch (e) {
      console.error('❌ MySQL 저장 실패, JSON 파일로 폴백:', e.message);
    }
  }

  // JSON 파일 폴백
  _saveToFile(entities);
}

function _saveToFile(entities) {
  try {
    const dataToSave = { ...entities, savedAt: new Date().toISOString() };
    fs.writeFileSync(DATA_FILE, JSON.stringify(dataToSave, null, 2), 'utf-8');
    console.log(`💾 파일 저장 완료: ${entities.products.length}개 상품, ${(entities.orders || []).length}개 주문`);
  } catch (e) {
    console.error('❌ 파일 저장 실패:', e.message);
  }
}

const app = express();
const port = 8080;

// Railway 등 리버스 프록시 환경에서 req.protocol이 https를 반환하도록 설정
app.set('trust proxy', true);

// 이미지 URL 생성 시 사용할 base URL 헬퍼
function getBaseUrl(req) {
  if (process.env.API_BASE_URL) {
    return process.env.API_BASE_URL.replace(/\/$/, '');
  }
  const protocol = req.protocol;
  const host = req.get('host');
  return `${protocol}://${host}`;
}

// 업로드 폴더 생성 (Volume 지원)
const uploadDir = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
console.log(`📁 업로드 디렉토리: ${uploadDir}`);

// CORS 설정
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Form data 처리

// 정적 파일 서빙 (업로드된 이미지)
app.use('/uploads', express.static(uploadDir));

// 기존 저장된 http://localhost URL을 실제 배포 URL로 자동 변환하는 미들웨어
app.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (body) {
      const baseUrl = getBaseUrl(req);
      // localhost가 아닌 환경에서만 URL 변환 (배포 환경)
      if (!baseUrl.includes('localhost')) {
        const bodyStr = JSON.stringify(body);
        const rewritten = bodyStr.replace(/http:\/\/localhost:\d+/g, baseUrl);
        return originalJson(JSON.parse(rewritten));
      }
    }
    return originalJson(body);
  };
  next();
});

// 이미지 검증 설정
const IMAGE_VALIDATION = {
  MAX_FILE_SIZE: 10 * 1024 * 1024, // 10MB
  ALLOWED_TYPES: ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'],
  ALLOWED_EXTENSIONS: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'],
  MIN_WIDTH: 300,
  MIN_HEIGHT: 300,
  MAX_WIDTH: 5000,
  MAX_HEIGHT: 5000,
  RECOMMENDED_MAIN_SIZE: { width: 800, height: 800 },
  RECOMMENDED_DETAIL_SIZE: { width: 1200, height: 1600 }
};

// 이미지 파일 검증 함수
const validateImageFile = (file) => {
  const errors = [];

  // 파일 크기 검증
  if (file.size > IMAGE_VALIDATION.MAX_FILE_SIZE) {
    errors.push(`파일 크기가 ${IMAGE_VALIDATION.MAX_FILE_SIZE / 1024 / 1024}MB를 초과합니다. (현재: ${(file.size / 1024 / 1024).toFixed(2)}MB)`);
  }

  if (file.size === 0) {
    errors.push('빈 파일입니다.');
  }

  // 파일 타입 검증
  if (!IMAGE_VALIDATION.ALLOWED_TYPES.includes(file.mimetype)) {
    errors.push(`JPG, PNG, GIF, WEBP, SVG 형식만 지원합니다. (현재: ${file.mimetype})`);
  }

  // 파일 확장자 검증
  const ext = path.extname(file.originalname).toLowerCase();
  if (!IMAGE_VALIDATION.ALLOWED_EXTENSIONS.includes(ext)) {
    errors.push(`JPG, PNG, GIF, WEBP, SVG 형식만 지원합니다. (현재: ${ext})`);
  }

  return {
    valid: errors.length === 0,
    errors: errors
  };
};

// Multer 설정 (디스크 스토리지로 실제 파일 저장)
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    // 파일명: timestamp-원본파일명
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    const basename = path.basename(file.originalname, ext);
    const safeName = basename.replace(/[^a-zA-Z0-9가-힣]/g, '_');
    cb(null, uniqueSuffix + '-' + safeName + ext);
  }
});

// 파일 필터 (업로드 전 검증)
const fileFilter = (req, file, cb) => {
  // request와 detailInfo는 JSON/텍스트 Blob이므로 검증 스킵
  if (file.fieldname === 'request' || file.fieldname === 'detailInfo') {
    cb(null, true);
    return;
  }

  // 이미지 파일만 검증 (mainImages, detailImages)
  const validation = validateImageFile(file);
  if (!validation.valid) {
    cb(new Error(validation.errors.join(' | ')), false);
  } else {
    cb(null, true);
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: IMAGE_VALIDATION.MAX_FILE_SIZE
  }
});

// Multer 에러 핸들링 미들웨어
const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    // Multer 에러
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        ok: false,
        data: null,
        message: `파일 크기가 너무 큽니다. 최대 ${IMAGE_VALIDATION.MAX_FILE_SIZE / 1024 / 1024}MB까지 업로드 가능합니다.`
      });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        ok: false,
        data: null,
        message: '업로드 가능한 파일 개수를 초과했습니다.'
      });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({
        ok: false,
        data: null,
        message: '예상하지 못한 파일 필드입니다. 필드 이름을 확인해주세요.'
      });
    }
    return res.status(400).json({
      ok: false,
      data: null,
      message: `파일 업로드 오류: ${err.message}`
    });
  } else if (err) {
    // 파일 필터 에러 (검증 실패)
    return res.status(400).json({
      ok: false,
      data: null,
      message: `이미지 검증 실패: ${err.message}`,
      hint: '권장사항: 대표이미지는 800x800px 이상, 상세이미지는 1200x1600px 이상, JPG/PNG 형식, 10MB 이하'
    });
  }
  next();
};

// 데이터 변수 선언 (startServer()에서 MySQL/JSON으로부터 로드하여 재할당)
let products = [];
let brands = [];

// Mock 문의 데이터 저장소
const contacts = [
  {
    code: 'INQ-001',
    subject: '배송 문의',
    type: 'DELIVERY',
    answered: false,
    content: '배송은 언제쯤 도착하나요?',
    createdAt: new Date('2024-01-20').toISOString()
  },
  {
    code: 'INQ-002',
    subject: '상품 문의',
    type: 'PRODUCT',
    answered: true,
    content: '상품 재고 있나요?',
    createdAt: new Date('2024-01-19').toISOString()
  },
  {
    code: 'INQ-003',
    subject: '환불 요청',
    type: 'REFUND',
    answered: false,
    content: '환불하고 싶습니다',
    createdAt: new Date('2024-01-18').toISOString()
  }
];

// Mock 회원 데이터 저장소 (기본 시드 데이터, startServer()에서 덮어씀)
let members = [
  {
    code: 'MEM-001',
    name: '김철수',
    phone: '010-1234-5678',
    email: 'kim@example.com',
    createAt: new Date('2024-01-01').toISOString(),
    status: 'ACTIVE'
  },
  {
    code: 'MEM-002',
    name: '이영희',
    phone: '010-2345-6789',
    email: 'lee@example.com',
    createAt: new Date('2024-01-05').toISOString(),
    status: 'ACTIVE'
  },
  {
    code: 'MEM-003',
    name: '박민수',
    phone: '010-3456-7890',
    email: 'park@example.com',
    createAt: new Date('2024-01-10').toISOString(),
    status: 'DISABLE'
  }
];

// Mock 로그인 사용자 데이터 (기본 시드 데이터, startServer()에서 덮어씀)
let users = [
  {
    id: 'test',
    password: 'test1234',
    code: 'USER-001',
    name: 'Test User',
    phone: '010-1111-2222',
    email: 'test@datepalmbay.com',
    createAt: new Date('2024-01-01').toISOString(),
    status: 'ACTIVE',
    // 쿠폰 자격 조건용 추가 필드
    memberLevel: 'SILVER',
    birthMonth: 2, // 2월 생일
    lastPurchaseDate: new Date('2025-01-20').toISOString(),
    totalPurchaseCount: 5,
    totalPurchaseAmount: 250
  },
  {
    id: 'demo',
    password: 'demo1234',
    code: 'USER-002',
    name: 'Demo User',
    phone: '010-3333-4444',
    email: 'demo@datepalmbay.com',
    createAt: new Date('2024-01-15').toISOString(),
    status: 'ACTIVE',
    memberLevel: 'GOLD',
    birthMonth: 6,
    lastPurchaseDate: new Date('2025-02-01').toISOString(),
    totalPurchaseCount: 15,
    totalPurchaseAmount: 750
  },
  {
    id: 'customer1',
    password: 'customer1234',
    code: 'USER-003',
    name: '김고객',
    phone: '010-5555-6666',
    email: 'customer1@datepalmbay.com',
    createAt: new Date('2024-02-01').toISOString(),
    status: 'ACTIVE',
    memberLevel: 'BRONZE',
    birthMonth: 9,
    lastPurchaseDate: new Date('2024-10-15').toISOString(), // 휴면 유저 (90일+ 미구매)
    totalPurchaseCount: 2,
    totalPurchaseAmount: 80
  },
  {
    id: 'customer2',
    password: 'customer1234',
    code: 'USER-004',
    name: '이고객',
    phone: '010-7777-8888',
    email: 'customer2@datepalmbay.com',
    createAt: new Date('2024-02-05').toISOString(),
    status: 'ACTIVE',
    memberLevel: 'VIP',
    birthMonth: 12,
    lastPurchaseDate: new Date('2025-02-05').toISOString(),
    totalPurchaseCount: 30,
    totalPurchaseAmount: 2500
  },
  {
    id: 'user1',
    password: 'user1234',
    code: 'USER-005',
    name: '박사용자',
    phone: '010-9999-0000',
    email: 'user1@datepalmbay.com',
    createAt: new Date('2025-01-25').toISOString(), // 신규 회원 (14일 이내)
    status: 'ACTIVE',
    memberLevel: 'BRONZE',
    birthMonth: 3,
    lastPurchaseDate: null,
    totalPurchaseCount: 0,
    totalPurchaseAmount: 0
  },
  {
    id: 'user2',
    password: 'user1234',
    code: 'USER-006',
    name: '최사용자',
    phone: '010-1234-5678',
    email: 'user2@datepalmbay.com',
    createAt: new Date('2024-02-15').toISOString(),
    status: 'ACTIVE',
    memberLevel: 'SILVER',
    birthMonth: 8,
    lastPurchaseDate: new Date('2025-01-10').toISOString(),
    totalPurchaseCount: 8,
    totalPurchaseAmount: 400
  }
];

// 유저별 다운로드한 쿠폰 저장소 (기본 시드 데이터, startServer()에서 덮어씀)
let userCoupons = [
  {
    id: 'UC-001',
    userId: 'USER-001',
    couponCode: 'CPN-SPRING10',
    downloadedAt: '2025-02-01T10:00:00Z',
    usedAt: null,
    usedOrderCode: null
  }
];

// Mock 주문 데이터 저장소
const orders = [
  {
    orderCode: 'ORD-001',
    orderedAt: new Date('2024-01-20T10:30:00').toISOString(),
    orderStatus: 'PENDING',
    ordererName: '김철수',
    ordererContact: '010-1234-5678',
    productName: '데이트팜 선물세트',
    paymentType: 'CARD',
    paymentPrice: 50000
  },
  {
    orderCode: 'ORD-002',
    orderedAt: new Date('2024-01-19T14:20:00').toISOString(),
    orderStatus: 'COMPLETED',
    ordererName: '이영희',
    ordererContact: '010-2345-6789',
    productName: '프리미엄 데이트팜',
    paymentType: 'TRANSFER',
    paymentPrice: 75000
  }
];

// 유틸리티 함수
const validateProductRequest = (requestData) => {
  const errors = [];

  if (!requestData.name || requestData.name.trim() === '') {
    errors.push('상품명은 필수입니다.');
  }

  if (!requestData.category) {
    errors.push('카테고리는 필수입니다.');
  }

  if (requestData.saleStatus === undefined || requestData.saleStatus === null) {
    errors.push('판매 상태는 필수입니다.');
  }

  if (!requestData.productOriginPrice || requestData.productOriginPrice <= 0) {
    errors.push('원가는 0보다 커야 합니다.');
  }

  if (!requestData.productRegularPrice || requestData.productRegularPrice <= 0) {
    errors.push('정가는 0보다 커야 합니다.');
  }

  if (requestData.discountStatus && !requestData.discountType) {
    errors.push('할인 상태가 활성화된 경우 할인 유형은 필수입니다.');
  }

  if (requestData.discountStatus && (!requestData.discountPrice || requestData.discountPrice <= 0)) {
    errors.push('할인 상태가 활성화된 경우 할인 금액은 0보다 커야 합니다.');
  }

  return errors;
};

const calculatePrice = (regularPrice, discountStatus, discountType, discountPrice) => {
  if (!discountStatus || !discountPrice) {
    return regularPrice;
  }

  if (discountType === 'STATIC') {
    return regularPrice - discountPrice;
  } else if (discountType === 'PERCENT') {
    return regularPrice - Math.floor(regularPrice * discountPrice / 100);
  }

  return regularPrice;
};

// 상품 생성 API
app.post('/datepalm-bay/api/admin/product/create', upload.fields([
  { name: 'mainImages', maxCount: 5 },
  { name: 'detailImages', maxCount: 20 },
  { name: 'request', maxCount: 1 },
  { name: 'detailInfo', maxCount: 1 }
]), (req, res) => {
  console.log('\n=== 상품 생성 요청 받음 ===');
  console.log('Files:', req.files);
  console.log('Body:', req.body);

  try {
    // request 필드에서 JSON 데이터 파싱
    let requestData = {};
    if (req.files.request && req.files.request[0]) {
      // diskStorage를 사용하므로 파일에서 읽어야 함
      const requestFilePath = req.files.request[0].path;
      const requestFileContent = fs.readFileSync(requestFilePath, 'utf-8');
      requestData = JSON.parse(requestFileContent);
      // 읽은 후 임시 파일 삭제
      fs.unlinkSync(requestFilePath);
    }

    console.log('=== 파싱된 요청 데이터 ===');
    console.log(JSON.stringify(requestData, null, 2));

    // 요청 데이터 검증
    const validationErrors = validateProductRequest(requestData);
    if (validationErrors.length > 0) {
      console.log('=== 유효성 검사 실패 ===');
      console.log('오류 목록:', validationErrors);
      return res.status(400).json({
        ok: false,
        data: null,
        message: `입력 데이터 오류: ${validationErrors.join(', ')}`
      });
    }

    // mainImages 검증 (1-5개 필수)
    const mainImageFiles = req.files.mainImages || [];
    if (mainImageFiles.length < 1 || mainImageFiles.length > 5) {
      return res.status(400).json({
        ok: false,
        data: null,
        message: '대표 이미지는 최소 1개, 최대 5개까지 등록 가능합니다.'
      });
    }

    // detailImages 검증 (0-20개 선택)
    const detailImageFiles = req.files.detailImages || [];
    if (detailImageFiles.length > 20) {
      return res.status(400).json({
        ok: false,
        data: null,
        message: '상세 이미지는 최대 20개까지 등록 가능합니다.'
      });
    }

    // detailInfo 파일에서 읽기
    let detailInfo = '';
    if (req.files.detailInfo && req.files.detailInfo[0]) {
      const detailInfoPath = req.files.detailInfo[0].path;
      detailInfo = fs.readFileSync(detailInfoPath, 'utf-8');
      fs.unlinkSync(detailInfoPath);
    }
    const productCode = `PROD-${Date.now()}`;

    const productPrice = calculatePrice(
      requestData.productRegularPrice,
      requestData.discountStatus,
      requestData.discountType,
      requestData.discountPrice
    );

    // 이미지 구조 생성 (mainImages, detailImages)
    // 실제 업로드된 파일의 URL 사용
    const baseUrl = getBaseUrl(req);
    const mainImages = mainImageFiles.map((file, index) => ({
      code: `${productCode}-M${index + 1}`,
      url: `${baseUrl}/uploads/${file.filename}`,
      originalName: file.originalname,
      size: file.size,
      mimetype: file.mimetype,
      order: index + 1
    }));

    const detailImages = detailImageFiles.map((file, index) => ({
      code: `${productCode}-D${index + 1}`,
      url: `${baseUrl}/uploads/${file.filename}`,
      originalName: file.originalname,
      size: file.size,
      mimetype: file.mimetype,
      order: index + 1
    }));

    const newProduct = {
      productCode: productCode,
      productName: requestData.name,
      productSaleStatus: requestData.saleStatus,
      category: requestData.category,
      productOriginPrice: requestData.productOriginPrice,
      productRegularPrice: requestData.productRegularPrice,
      discountType: requestData.discountType,
      productDiscountPrice: requestData.discountPrice || 0,
      productPrice: productPrice,
      introduction: requestData.introduction,
      policy: requestData.policy,
      detailInfo,
      files: {
        mainImages: mainImages,
        detailImages: detailImages
      },
      groupBuyTiers: requestData.groupBuyTiers || [],
      productOptions: requestData.productOptions || [],
      // 배송비 관련 필드
      shippingCostType: requestData.shippingCostType || 'FREE',
      shippingCost: requestData.shippingCost || 0,
      freeShippingThreshold: requestData.freeShippingThreshold || 0,
      // 브랜드
      brand: requestData.brand || '',
      createdAt: new Date().toISOString()
    };

    products.push(newProduct);
    saveData(); // 파일에 저장

    console.log('=== 상품 생성 성공 ===');
    console.log('생성된 상품:', newProduct);

    res.json({
      ok: true,
      data: productCode,
      message: '상품이 성공적으로 생성되었습니다.'
    });
  } catch (error) {
    console.error('=== 상품 생성 실패 ===');
    console.error(error);
    res.status(500).json({
      ok: false,
      data: null,
      message: '상품 생성에 실패했습니다.'
    });
  }
});

// 상품 수정 API
app.put('/datepalm-bay/api/admin/product/edit', upload.fields([
  { name: 'mainImages', maxCount: 5 },
  { name: 'detailImages', maxCount: 20 },
  { name: 'request', maxCount: 1 },
  { name: 'detailInfo', maxCount: 1 }
]), (req, res) => {
  console.log('\n=== 상품 수정 요청 받음 ===');
  console.log('Files:', req.files);
  console.log('Body:', req.body);

  try {
    // request 필드에서 JSON 데이터 파싱
    let requestData = {};
    if (req.files.request && req.files.request[0]) {
      // diskStorage를 사용하므로 파일에서 읽어야 함
      const requestFilePath = req.files.request[0].path;
      const requestFileContent = fs.readFileSync(requestFilePath, 'utf-8');
      requestData = JSON.parse(requestFileContent);
      // 읽은 후 임시 파일 삭제
      fs.unlinkSync(requestFilePath);
    }

    const productIndex = products.findIndex(p => p.productCode === requestData.code);

    if (productIndex === -1) {
      return res.status(404).json({
        ok: false,
        data: null,
        message: '상품을 찾을 수 없습니다.'
      });
    }

    // 요청 데이터 검증
    const validationErrors = validateProductRequest(requestData);
    if (validationErrors.length > 0) {
      return res.status(400).json({
        ok: false,
        data: null,
        message: `입력 데이터 오류: ${validationErrors.join(', ')}`
      });
    }

    // detailInfo 파일에서 읽기
    let detailInfo = products[productIndex].detailInfo || '';
    if (req.files.detailInfo && req.files.detailInfo[0]) {
      const detailInfoPath = req.files.detailInfo[0].path;
      detailInfo = fs.readFileSync(detailInfoPath, 'utf-8');
      fs.unlinkSync(detailInfoPath);
    }

    const productPrice = calculatePrice(
      requestData.productRegularPrice,
      requestData.discountStatus,
      requestData.discountType,
      requestData.discountPrice
    );

    // 기존 이미지 가져오기
    let existingMainImages = products[productIndex].files?.mainImages || [];
    let existingDetailImages = products[productIndex].files?.detailImages || [];

    // 삭제할 이미지 제거
    if (requestData.deletedMainImages && requestData.deletedMainImages.length > 0) {
      existingMainImages = existingMainImages.filter(img => !requestData.deletedMainImages.includes(img.code));
    }
    if (requestData.deletedDetailImages && requestData.deletedDetailImages.length > 0) {
      existingDetailImages = existingDetailImages.filter(img => !requestData.deletedDetailImages.includes(img.code));
    }

    // 새로운 mainImages 추가
    const mainImageFiles = req.files.mainImages || [];
    const baseUrl = getBaseUrl(req);
    const newMainImages = mainImageFiles.map((file, index) => ({
      code: `${requestData.code}-M${existingMainImages.length + index + 1}`,
      url: `${baseUrl}/uploads/${file.filename}`,
      originalName: file.originalname,
      size: file.size,
      mimetype: file.mimetype,
      order: existingMainImages.length + index + 1
    }));

    // 새로운 detailImages 추가
    const detailImageFiles = req.files.detailImages || [];
    const newDetailImages = detailImageFiles.map((file, index) => ({
      code: `${requestData.code}-D${existingDetailImages.length + index + 1}`,
      url: `${baseUrl}/uploads/${file.filename}`,
      originalName: file.originalname,
      size: file.size,
      mimetype: file.mimetype,
      order: existingDetailImages.length + index + 1
    }));

    // 최종 이미지 배열
    const finalMainImages = [...existingMainImages, ...newMainImages];
    const finalDetailImages = [...existingDetailImages, ...newDetailImages];

    // mainImages 개수 검증 (1-5개)
    if (finalMainImages.length < 1 || finalMainImages.length > 5) {
      return res.status(400).json({
        ok: false,
        data: null,
        message: '대표 이미지는 최소 1개, 최대 5개까지 등록 가능합니다.'
      });
    }

    // detailImages 개수 검증 (0-20개)
    if (finalDetailImages.length > 20) {
      return res.status(400).json({
        ok: false,
        data: null,
        message: '상세 이미지는 최대 20개까지 등록 가능합니다.'
      });
    }

    products[productIndex] = {
      ...products[productIndex],
      productName: requestData.name,
      productSaleStatus: requestData.saleStatus,
      category: requestData.category,
      productOriginPrice: requestData.productOriginPrice,
      productRegularPrice: requestData.productRegularPrice,
      discountType: requestData.discountType,
      productDiscountPrice: requestData.discountPrice || 0,
      productPrice: productPrice,
      introduction: requestData.introduction,
      policy: requestData.policy,
      detailInfo,
      files: {
        mainImages: finalMainImages,
        detailImages: finalDetailImages
      },
      groupBuyTiers: requestData.groupBuyTiers || [],
      productOptions: requestData.productOptions || [],
      // 배송비 관련 필드
      shippingCostType: requestData.shippingCostType || 'FREE',
      shippingCost: requestData.shippingCost || 0,
      freeShippingThreshold: requestData.freeShippingThreshold || 0,
      // 브랜드
      brand: requestData.brand !== undefined ? requestData.brand : (products[productIndex].brand || ''),
      updatedAt: new Date().toISOString()
    };
    saveData(); // 파일에 저장

    console.log('=== 상품 수정 성공 ===');
    console.log('수정된 상품:', products[productIndex]);
    res.json({
      ok: true,
      data: requestData.code,
      message: '상품이 성공적으로 수정되었습니다.'
    });
  } catch (error) {
    console.error('=== 상품 수정 실패 ===');
    console.error(error);
    res.status(500).json({
      ok: false,
      data: null,
      message: '상품 수정에 실패했습니다.'
    });
  }
});

// 상품 삭제 API
app.delete('/datepalm-bay/api/admin/product/delete', (req, res) => {
  console.log('\n=== 상품 삭제 요청 받음 ===');
  console.log('삭제할 상품 코드:', req.body.deleteCodes);

  try {
    const { deleteCodes } = req.body;

    if (!deleteCodes || !Array.isArray(deleteCodes) || deleteCodes.length === 0) {
      return res.status(400).json({
        ok: false,
        data: null,
        message: '삭제할 상품 코드가 없습니다.'
      });
    }

    const deletedCount = deleteCodes.length;

    deleteCodes.forEach(code => {
      const index = products.findIndex(p => p.productCode === code);
      if (index !== -1) {
        products.splice(index, 1);
      }
    });
    saveData(); // 파일에 저장

    console.log(`=== ${deletedCount}개 상품 삭제 성공 ===`);
    console.log(`남은 상품 수: ${products.length}`);

    res.json({
      ok: true,
      data: deletedCount.toString(),
      message: `${deletedCount}개의 상품이 삭제되었습니다.`
    });
  } catch (error) {
    console.error('=== 상품 삭제 실패 ===');
    console.error(error);
    res.status(500).json({
      ok: false,
      data: null,
      message: '상품 삭제에 실패했습니다.'
    });
  }
});

// 어드민 - 브랜드 목록 조회 (저장된 브랜드 + 상품에서 추출한 브랜드 병합)
app.get('/datepalm-bay/api/admin/product/brands', (req, res) => {
  console.log('\n=== [어드민] 브랜드 목록 조회 ===');

  const brandSet = new Set();
  // 독립 저장된 브랜드
  brands.forEach(b => brandSet.add(b));
  // 상품에서 추출한 브랜드
  products.forEach(p => {
    if (p.brand && p.brand.trim() !== '') {
      brandSet.add(p.brand.trim());
    }
  });

  const allBrands = Array.from(brandSet).sort((a, b) => a.localeCompare(b));
  console.log(`총 ${allBrands.length}개 브랜드 조회 (저장 ${brands.length} + 상품 추출)`);

  res.json({
    ok: true,
    data: allBrands,
    message: '브랜드 목록 조회 성공'
  });
});

// 어드민 - 브랜드 생성 (독립 저장)
app.post('/datepalm-bay/api/admin/product/brands', (req, res) => {
  console.log('\n=== [어드민] 브랜드 생성 ===');
  const { name } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({
      ok: false,
      message: '브랜드명을 입력해주세요.'
    });
  }

  const trimmedName = name.trim();

  // 중복 체크 (저장된 브랜드 + 상품 브랜드)
  const existingBrands = new Set([...brands]);
  products.forEach(p => {
    if (p.brand && p.brand.trim() !== '') {
      existingBrands.add(p.brand.trim());
    }
  });

  if (existingBrands.has(trimmedName)) {
    console.log(`브랜드 "${trimmedName}" 이미 존재`);
    return res.json({
      ok: true,
      data: trimmedName,
      message: '이미 존재하는 브랜드입니다.'
    });
  }

  brands.push(trimmedName);
  saveData();
  console.log(`브랜드 "${trimmedName}" 생성 완료`);

  res.json({
    ok: true,
    data: trimmedName,
    message: '브랜드 생성 성공'
  });
});

// 상품 목록 조회 API (페이징)
app.get('/datepalm-bay/api/admin/product/list', (req, res) => {
  console.log('\n=== 상품 목록 조회 (페이징) ===');
  const pageNo = parseInt(req.query.pageNo) || 0;
  const pageSize = parseInt(req.query.pageSize) || 10;
  const { code, name, status, category } = req.query;

  console.log('필터 조건:', { code, name, status, category });

  // 필터링
  let filteredProducts = [...products];

  if (code) {
    filteredProducts = filteredProducts.filter(p =>
      p.productCode.toLowerCase().includes(code.toLowerCase())
    );
  }

  if (name) {
    filteredProducts = filteredProducts.filter(p =>
      p.productName.toLowerCase().includes(name.toLowerCase())
    );
  }

  if (status !== undefined) {
    const saleStatus = status === 'true' || status === true;
    filteredProducts = filteredProducts.filter(p => p.productSaleStatus === saleStatus);
  }

  if (category) {
    filteredProducts = filteredProducts.filter(p => p.category === category);
  }

  const start = pageNo * pageSize;
  const end = start + pageSize;
  const paginatedProducts = filteredProducts.slice(start, end);

  console.log(`페이지: ${pageNo}, 크기: ${pageSize}`);
  console.log(`총 ${filteredProducts.length}개 상품 중 ${paginatedProducts.length}개 반환`);

  res.json({
    ok: true,
    data: {
      content: paginatedProducts,
      pageable: {
        pageNumber: pageNo,
        pageSize: pageSize
      },
      totalElements: filteredProducts.length,
      totalPages: Math.ceil(filteredProducts.length / pageSize),
      size: pageSize,
      number: pageNo,
      first: pageNo === 0,
      last: pageNo >= Math.floor(filteredProducts.length / pageSize),
      numberOfElements: paginatedProducts.length
    },
    message: '상품 목록 조회 성공'
  });
});

// 상품 상세 조회 API
app.get('/datepalm-bay/api/admin/product/detail/:code', (req, res) => {
  console.log('\n=== 상품 상세 조회 ===');
  const { code } = req.params;
  console.log(`상품 코드: ${code}`);

  const product = products.find(p => p.productCode === code);

  if (!product) {
    return res.status(404).json({
      ok: false,
      data: null,
      message: '상품을 찾을 수 없습니다.'
    });
  }

  const mainImages = product.files?.mainImages || [];
  const detailImages = product.files?.detailImages || [];

  const detailResponse = {
    code: product.productCode,
    name: product.productName,
    category: product.category,
    introduction: product.introduction || '',
    note: '',
    discountStatus: product.productDiscountPrice > 0,
    saleStatus: product.productSaleStatus,
    discountType: product.discountType,
    originPrice: product.productOriginPrice,
    regularPrice: product.productRegularPrice,
    discountPrice: product.productDiscountPrice,
    price: product.productPrice,
    refundPolicy: product.policy?.refundPolicy || '',
    deliveryPolicy: product.policy?.deliveryPolicy || '',
    exchangePolicy: product.policy?.exchangePolicy || '',
    mainImages: mainImages.map((img) => ({
      code: img.code,
      url: img.url,
      order: img.order
    })),
    detailImages: detailImages.map((img) => ({
      code: img.code,
      url: img.url,
      order: img.order
    })),
    detailInfo: product.detailInfo || '',
    groupBuyTiers: product.groupBuyTiers || [],
    productOptions: product.productOptions || [],
    // 배송비 관련 필드
    shippingCostType: product.shippingCostType || 'FREE',
    shippingCost: product.shippingCost || 0,
    freeShippingThreshold: product.freeShippingThreshold || 0,
    brand: product.brand || '',
    // SKIN OS 성분 분석
    ingredientAnalysis: product.ingredientAnalysis || null
  };

  console.log('조회 성공:', product.productName);

  res.json({
    ok: true,
    data: detailResponse,
    message: '상품 상세 조회 성공'
  });
});

// 상품 목록 조회 API (전체)
app.get('/datepalm-bay/api/admin/products', (req, res) => {
  console.log('\n=== 상품 전체 목록 조회 ===');
  console.log(`총 ${products.length}개 상품`);

  res.json({
    ok: true,
    data: products,
    message: '상품 목록 조회 성공'
  });
});

// 문의 목록 조회 API
app.get('/datepalm-bay/api/admin/inquiry/list', (req, res) => {
  console.log('\n=== 문의 목록 조회 ===');
  const pageNo = parseInt(req.query.pageNo) || 0;
  const pageSize = parseInt(req.query.pageSize) || 10;

  const start = pageNo * pageSize;
  const end = start + pageSize;
  const paginatedContacts = contacts.slice(start, end);

  console.log(`페이지: ${pageNo}, 크기: ${pageSize}`);
  console.log(`총 ${contacts.length}개 문의 중 ${paginatedContacts.length}개 반환`);

  res.json({
    ok: true,
    data: {
      content: paginatedContacts,
      pageable: {
        pageNumber: pageNo,
        pageSize: pageSize
      },
      totalElements: contacts.length,
      totalPages: Math.ceil(contacts.length / pageSize),
      size: pageSize,
      number: pageNo,
      first: pageNo === 0,
      last: pageNo >= Math.floor(contacts.length / pageSize),
      numberOfElements: paginatedContacts.length
    },
    message: '문의 목록 조회 성공'
  });
});

// 문의 상세 조회 API
app.get('/datepalm-bay/api/admin/inquiry/detail/:code', (req, res) => {
  console.log('\n=== 문의 상세 조회 ===');
  const { code } = req.params;
  console.log(`문의 코드: ${code}`);

  const contact = contacts.find(c => c.code === code);

  if (!contact) {
    return res.status(404).json({
      ok: false,
      data: null,
      message: '문의를 찾을 수 없습니다.'
    });
  }

  console.log('조회 성공:', contact.subject);

  res.json({
    ok: true,
    data: contact,
    message: '문의 상세 조회 성공'
  });
});

// 회원 목록 조회 API
app.get('/datepalm-bay/api/admin/member/list', (req, res) => {
  console.log('\n=== 회원 목록 조회 ===');
  const pageNo = parseInt(req.query.pageNo) || 0;
  const pageSize = parseInt(req.query.pageSize) || 10;
  const { code, name, phone, country, status } = req.query;

  // users를 source of truth로 사용하여 회원 목록 생성
  let allMembers = users.map(u => ({
    code: u.code,
    name: u.name,
    phone: u.phone || '',
    email: u.email,
    status: u.status || 'ACTIVE',
    createAt: u.createAt,
    birthDate: u.birthDate || '',
    country: u.country || '',
    memberLevel: u.memberLevel || 'BASIC',
  }));

  // 검색 필터 적용
  if (code) allMembers = allMembers.filter(m => m.code.toLowerCase().includes(String(code).toLowerCase()));
  if (name) allMembers = allMembers.filter(m => m.name.toLowerCase().includes(String(name).toLowerCase()));
  if (phone) allMembers = allMembers.filter(m => m.phone.includes(String(phone)));
  if (country) allMembers = allMembers.filter(m => m.country === country);
  if (status) allMembers = allMembers.filter(m => m.status === status);

  // 최신 가입순 정렬
  allMembers.sort((a, b) => new Date(b.createAt).getTime() - new Date(a.createAt).getTime());

  const start = pageNo * pageSize;
  const end = start + pageSize;
  const paginatedMembers = allMembers.slice(start, end);

  console.log(`페이지: ${pageNo}, 크기: ${pageSize}`);
  console.log(`총 ${allMembers.length}개 회원 중 ${paginatedMembers.length}개 반환`);

  res.json({
    ok: true,
    data: {
      content: paginatedMembers,
      pageable: {
        pageNumber: pageNo,
        pageSize: pageSize
      },
      totalElements: allMembers.length,
      totalPages: Math.ceil(allMembers.length / pageSize),
      size: pageSize,
      number: pageNo,
      first: pageNo === 0,
      last: pageNo >= Math.floor(allMembers.length / pageSize),
      numberOfElements: paginatedMembers.length
    },
    message: '회원 목록 조회 성공'
  });
});

// 회원 상세 조회 API
app.get('/datepalm-bay/api/admin/member/detail/:code', (req, res) => {
  console.log('\n=== 회원 상세 조회 ===');
  const { code } = req.params;
  console.log(`회원 코드: ${code}`);

  // users에서 직접 조회 (source of truth)
  const user = users.find(u => u.code === code);

  if (!user) {
    return res.status(404).json({
      ok: false,
      data: null,
      message: '회원을 찾을 수 없습니다.'
    });
  }

  console.log('조회 성공:', user.name);

  res.json({
    ok: true,
    data: {
      code: user.code,
      name: user.name,
      phone: user.phone || '',
      email: user.email,
      status: user.status || 'ACTIVE',
      createAt: user.createAt,
      birthDate: user.birthDate || '',
      country: user.country || '',
      memberLevel: user.memberLevel || 'BASIC',
      memoList: []
    },
    message: '회원 상세 조회 성공'
  });
});

// 주문 목록 조회 API
app.get('/datepalm-bay/api/admin/order/list', (req, res) => {
  console.log('\n=== 주문 목록 조회 ===');
  const pageNo = parseInt(req.query.pageNo) || 0;
  const pageSize = parseInt(req.query.pageSize) || 10;

  const start = pageNo * pageSize;
  const end = start + pageSize;
  const paginatedOrders = orders.slice(start, end);

  console.log(`페이지: ${pageNo}, 크기: ${pageSize}`);
  console.log(`총 ${orders.length}개 주문 중 ${paginatedOrders.length}개 반환`);

  res.json({
    ok: true,
    data: {
      content: paginatedOrders,
      pageable: {
        pageNumber: pageNo,
        pageSize: pageSize
      },
      totalElements: orders.length,
      totalPages: Math.ceil(orders.length / pageSize),
      size: pageSize,
      number: pageNo,
      first: pageNo === 0,
      last: pageNo >= Math.floor(orders.length / pageSize),
      numberOfElements: paginatedOrders.length
    },
    message: '주문 목록 조회 성공'
  });
});

// 주문 상세 조회 API
app.get('/datepalm-bay/api/admin/order/detail/:code', (req, res) => {
  console.log('\n=== 주문 상세 조회 ===');
  const { code } = req.params;
  console.log(`주문 코드: ${code}`);

  const order = orders.find(o => o.orderCode === code);

  if (!order) {
    return res.status(404).json({
      ok: false,
      data: null,
      message: '주문을 찾을 수 없습니다.'
    });
  }

  console.log('조회 성공:', order.orderCode);

  res.json({
    ok: true,
    data: order,
    message: '주문 상세 조회 성공'
  });
});

// 회원별 주문 목록 조회 API
app.get('/datepalm-bay/api/admin/order/member-orders', (req, res) => {
  console.log('\n=== 회원별 주문 목록 조회 ===');
  const memberCode = req.query.memberCode;
  const pageNo = parseInt(req.query.pageNo) || 0;
  const pageSize = parseInt(req.query.pageSize) || 10;

  // 실제로는 memberCode로 필터링해야 하지만, 현재는 모든 주문 반환
  const start = pageNo * pageSize;
  const end = start + pageSize;
  const paginatedOrders = orders.slice(start, end);

  console.log(`회원 코드: ${memberCode}, 페이지: ${pageNo}`);
  console.log(`총 ${orders.length}개 주문 중 ${paginatedOrders.length}개 반환`);

  res.json({
    ok: true,
    data: {
      content: paginatedOrders,
      pageable: {
        pageNumber: pageNo,
        pageSize: pageSize
      },
      totalElements: orders.length,
      totalPages: Math.ceil(orders.length / pageSize),
      size: pageSize,
      number: pageNo,
      first: pageNo === 0,
      last: pageNo >= Math.floor(orders.length / pageSize),
      numberOfElements: paginatedOrders.length
    },
    message: '회원별 주문 목록 조회 성공'
  });
});

// ========================================
// 프론트엔드(고객용) API
// ========================================

// 프론트 - 상품 목록 조회 (판매중인 상품만)
app.get('/datepalm-bay/api/mvp/product/normal/list', (req, res) => {
  console.log('\n=== [프론트] 상품 목록 조회 ===');
  const pageNo = parseInt(req.query.pageNo) || 0;
  const pageSize = parseInt(req.query.pageSize) || 10;
  const { sortType, category } = req.query;

  console.log('필터 조건:', { pageNo, pageSize, sortType, category });

  // 판매중인 상품만 필터링
  let filteredProducts = products.filter(p => p.productSaleStatus === true);

  // 카테고리 필터링
  if (category) {
    filteredProducts = filteredProducts.filter(p => p.category === category);
  }

  // 정렬
  if (sortType === 'NEWEST') {
    filteredProducts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } else if (sortType === 'OLDEST') {
    filteredProducts.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  } else if (sortType === 'PRICE_HIGH') {
    filteredProducts.sort((a, b) => b.productPrice - a.productPrice);
  } else if (sortType === 'PRICE_LOW') {
    filteredProducts.sort((a, b) => a.productPrice - b.productPrice);
  }

  const start = pageNo * pageSize;
  const end = start + pageSize;
  const paginatedProducts = filteredProducts.slice(start, end);

  // 프론트엔드가 기대하는 형식으로 변환
  const formattedProducts = paginatedProducts.map(p => ({
    code: p.productCode,
    name: p.productName,
    productNote: '',
    regularPrice: p.productRegularPrice,
    discountPrice: p.productDiscountPrice,
    discountType: p.discountType,
    summary: p.introduction,
    price: p.productPrice,
    thumbnailUrl: p.files?.mainImages?.[0]?.url || '',  // 첫 번째 main image 사용
    brand: p.brand || ''
  }));

  console.log(`페이지: ${pageNo}, 크기: ${pageSize}`);
  console.log(`총 ${filteredProducts.length}개 상품 중 ${formattedProducts.length}개 반환`);

  res.json({
    ok: true,
    data: {
      content: formattedProducts,
      pageable: {
        pageNumber: pageNo,
        pageSize: pageSize
      },
      totalElements: filteredProducts.length,
      totalPages: Math.ceil(filteredProducts.length / pageSize),
      size: pageSize,
      number: pageNo,
      first: pageNo === 0,
      last: pageNo >= Math.floor(filteredProducts.length / pageSize),
      numberOfElements: formattedProducts.length
    },
    message: '상품 목록 조회 성공'
  });
});

// 프론트 - 상품 상세 조회
app.get('/datepalm-bay/api/mvp/product/normal/detail/:code', (req, res) => {
  console.log('\n=== [프론트] 상품 상세 조회 ===');
  const { code } = req.params;
  console.log(`상품 코드: ${code}`);

  const product = products.find(p => p.productCode === code && p.productSaleStatus === true);

  if (!product) {
    return res.status(404).json({
      ok: false,
      data: null,
      message: '상품을 찾을 수 없습니다.'
    });
  }

  // 프론트엔드가 기대하는 형식으로 변환
  // mainImages와 detailImages로 분리
  const mainImages = product.files?.mainImages || [];
  const detailImages = product.files?.detailImages || [];

  // 첫 번째 main image를 thumbnailUrl로 사용 (list view 호환성)
  const thumbnailUrl = mainImages.length > 0 ? mainImages[0].url : '';

  // 기본 이미지가 없으면 placeholder 추가
  if (mainImages.length === 0) {
    mainImages.push({
      code: 'IMG-DEFAULT',
      url: `https://via.placeholder.com/600?text=${encodeURIComponent(product.productName)}`,
      order: 1
    });
  }

  const detailResponse = {
    code: product.productCode,
    name: product.productName,
    productNote: '',
    discountType: product.discountType,
    regularPrice: product.productRegularPrice,
    discountPrice: product.productDiscountPrice,
    price: product.productPrice,
    thumbnailUrl: thumbnailUrl,
    summary: product.introduction || '',
    mainImages: mainImages.map(img => ({
      code: img.code,
      name: img.url.split('/').pop() || 'image',
      url: img.url,
      order: img.order
    })),
    detailImages: detailImages.map(img => ({
      code: img.code,
      name: img.url.split('/').pop() || 'detail-image',
      url: img.url,
      order: img.order
    })),
    detailInfo: product.detailInfo || '',
    deliveryPolicy: product.policy?.deliveryPolicy || '',
    refundPolicy: product.policy?.refundPolicy || '',
    exchangePolicy: product.policy?.exchangePolicy || '',
    canReviewWrite: false,
    groupBuyTiers: product.groupBuyTiers || [],
    productOptions: product.productOptions || [],
    // 배송비 관련 필드 (상위 레벨 또는 policy 객체에서 가져옴)
    shippingCostType: product.shippingCostType || product.policy?.shippingCostType || 'FREE',
    shippingCost: product.shippingCost ?? product.policy?.shippingCost ?? 0,
    freeShippingThreshold: product.freeShippingThreshold ?? product.policy?.freeShippingThreshold ?? 0,
    brand: product.brand || ''
  };

  console.log('조회 성공:', product.productName);

  res.json({
    ok: true,
    data: detailResponse,
    message: '상품 상세 조회 성공'
  });
});

// ======================================
// Brand Endpoints
// ======================================

// 프론트 - 브랜드 목록 조회
app.get('/datepalm-bay/api/mvp/product/brands', (req, res) => {
  console.log('\n=== [프론트] 브랜드 목록 조회 ===');

  const brandSet = new Set();
  products.forEach(p => {
    if (p.productSaleStatus === true && p.brand && p.brand.trim() !== '') {
      brandSet.add(p.brand.trim());
    }
  });

  const brands = Array.from(brandSet).sort((a, b) => a.localeCompare(b));
  console.log(`총 ${brands.length}개 브랜드 조회`);

  res.json({
    ok: true,
    data: brands,
    message: '브랜드 목록 조회 성공'
  });
});

// 프론트 - 브랜드별 상품 목록 조회
app.get('/datepalm-bay/api/mvp/product/brand/list', (req, res) => {
  console.log('\n=== [프론트] 브랜드별 상품 목록 조회 ===');
  const pageNo = parseInt(req.query.pageNo) || 0;
  const pageSize = parseInt(req.query.pageSize) || 10;
  const { sortType, brand } = req.query;

  console.log('필터 조건:', { pageNo, pageSize, sortType, brand });

  // 판매중인 상품만 필터링
  let filteredProducts = products.filter(p => p.productSaleStatus === true);

  // 브랜드 필터링
  if (brand) {
    filteredProducts = filteredProducts.filter(p => p.brand && p.brand.trim() === brand.trim());
  } else {
    // brand 미지정 시 brand가 있는 상품만 반환
    filteredProducts = filteredProducts.filter(p => p.brand && p.brand.trim() !== '');
  }

  // 정렬
  if (sortType === 'NEWEST') {
    filteredProducts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } else if (sortType === 'OLDEST') {
    filteredProducts.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  } else if (sortType === 'PRICE_HIGH') {
    filteredProducts.sort((a, b) => b.productPrice - a.productPrice);
  } else if (sortType === 'PRICE_LOW') {
    filteredProducts.sort((a, b) => a.productPrice - b.productPrice);
  }

  const start = pageNo * pageSize;
  const end = start + pageSize;
  const paginatedProducts = filteredProducts.slice(start, end);

  const formattedProducts = paginatedProducts.map(p => ({
    code: p.productCode,
    name: p.productName,
    productNote: '',
    regularPrice: p.productRegularPrice,
    discountPrice: p.productDiscountPrice,
    discountType: p.discountType,
    summary: p.introduction,
    price: p.productPrice,
    thumbnailUrl: p.files?.mainImages?.[0]?.url || '',
    brand: p.brand || ''
  }));

  console.log(`총 ${filteredProducts.length}개 상품 중 ${formattedProducts.length}개 반환`);

  res.json({
    ok: true,
    data: {
      content: formattedProducts,
      pageable: {
        pageNumber: pageNo,
        pageSize: pageSize
      },
      totalElements: filteredProducts.length,
      totalPages: Math.ceil(filteredProducts.length / pageSize),
      size: pageSize,
      number: pageNo,
      first: pageNo === 0,
      last: pageNo >= Math.floor(filteredProducts.length / pageSize),
      numberOfElements: formattedProducts.length
    },
    message: '브랜드별 상품 목록 조회 성공'
  });
});

// ======================================
// Group Buy Team Endpoints
// ======================================

// Mock Group Buy Teams storage (startServer()에서 로드)
let groupBuyTeams = [];

// Helper function to generate invite code
const generateInviteCode = () => {
  return Math.random().toString(36).substring(2, 10).toUpperCase();
};

// Helper function to check if team is expired
const isTeamExpired = (expiresAt) => {
  return new Date(expiresAt) < new Date();
};

// Create Team
app.post('/datepalm-bay/api/mvp/group-buy/teams', (req, res) => {
  console.log('\n=== [Group Buy] Create Team ===');
  console.log('Request body:', req.body);

  // Handle both { data: { ... } } and direct { ... } formats
  const requestData = req.body.data || req.body;
  const { productCode, targetParticipants, quantityPerPerson, createdBy } = requestData;

  console.log('Parsed data:', { productCode, targetParticipants, quantityPerPerson, createdBy });

  if (!productCode || !targetParticipants || !quantityPerPerson || !createdBy) {
    return res.status(400).json({
      ok: false,
      data: null,
      message: 'Missing required fields'
    });
  }

  // Find product
  const product = products.find(p => p.productCode === productCode);
  if (!product) {
    return res.status(404).json({
      ok: false,
      data: null,
      message: 'Product not found'
    });
  }

  const teamId = `team-${Date.now()}`;
  const inviteCode = generateInviteCode();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(); // 12 hours from now

  // Find creator user info
  const creator = users.find(u => u.id === createdBy || u.code === createdBy);
  const creatorName = creator ? creator.name : 'Team Creator';
  const creatorEmail = creator ? creator.email : 'creator@example.com';

  // Use product's groupBuyTiers or create fallback
  let discountTiers = product.groupBuyTiers || [];

  // Fallback: if no tiers configured, use product's regular discount as single tier
  if (discountTiers.length === 0) {
    discountTiers = [{
      id: 'default-tier',
      minParticipants: 2,
      discountType: product.discountType || 'PERCENT',
      discountValue: product.productDiscountPrice || 0,
    }];
  }

  // Convert admin tiers to frontend DiscountTier format
  const convertedTiers = discountTiers.map((tier) => {
    let pricePerUnit;
    if (tier.discountType === 'PERCENT') {
      pricePerUnit = Math.floor(product.productPrice * (1 - tier.discountValue / 100));
    } else {
      pricePerUnit = product.productPrice - tier.discountValue;
    }

    return {
      minParticipants: tier.minParticipants,
      maxParticipants: tier.maxParticipants,
      discountRate: tier.discountType === 'PERCENT' ? tier.discountValue : 0,
      pricePerUnit: pricePerUnit,
    };
  });

  // Calculate groupPrice (use the best tier's price)
  const bestTierPrice = convertedTiers.length > 0
    ? convertedTiers[convertedTiers.length - 1].pricePerUnit
    : Math.floor(product.productPrice * 0.7);

  // Get product image (use first main image)
  const productImage = product.files?.mainImages?.[0]?.url || `https://via.placeholder.com/120?text=${encodeURIComponent(product.productName)}`;
  console.log('Product image URL:', productImage);
  console.log('Product files:', JSON.stringify(product.files, null, 2));

  const newTeam = {
    teamId,
    groupBuyItemId: product.productCode,
    productCode: product.productCode,
    productName: product.productName,
    productImage: productImage,
    createdBy,
    members: [
      {
        userId: createdBy,
        name: creatorName,
        email: creatorEmail,
        quantity: quantityPerPerson,
        joinedAt: now,
        status: 'JOINED'
      }
    ],
    status: 'WAITING',
    inviteCode,
    inviteLink: `https://datepalmbay.com/group-buy/invite/${inviteCode}`,
    whatsappShareUrl: `https://wa.me/?text=${encodeURIComponent(`Join my group buy for ${product.productName}! Better prices together. https://datepalmbay.com/group-buy/invite/${inviteCode}`)}`,
    targetParticipants,
    currentParticipants: 1,
    targetQuantity: targetParticipants * quantityPerPerson,
    currentQuantity: quantityPerPerson,
    singlePrice: product.productPrice,
    groupPrice: bestTierPrice,
    discountTiers: convertedTiers,
    createdAt: now,
    expiresAt
  };

  groupBuyTeams.push(newTeam);

  console.log(`Team created: ${teamId}, Invite Code: ${inviteCode}`);
  saveData();

  res.json({
    ok: true,
    data: { team: newTeam },
    message: 'Team created successfully'
  });
});

// Get Team Detail
app.get('/datepalm-bay/api/mvp/group-buy/teams/:teamId', (req, res) => {
  console.log('\n=== [Group Buy] Get Team Detail ===');
  const { teamId } = req.params;

  const team = groupBuyTeams.find(t => t.teamId === teamId);

  if (!team) {
    return res.status(404).json({
      ok: false,
      data: null,
      message: 'Team not found'
    });
  }

  // Update team status if expired
  if (isTeamExpired(team.expiresAt) && team.status === 'WAITING') {
    team.status = 'EXPIRED';
  }

  // Update status to COMPLETED if target reached
  if (team.currentParticipants >= team.targetParticipants && team.status === 'WAITING') {
    team.status = 'COMPLETED';
    team.completedAt = new Date().toISOString();
  }

  console.log(`Team detail retrieved: ${teamId}`);
  console.log(`Team productImage: ${team.productImage}`);
  console.log(`Team productName: ${team.productName}`);

  res.json({
    ok: true,
    data: { team },
    message: 'Team detail retrieved successfully'
  });
});

// Get Team by Invite Code
app.get('/datepalm-bay/api/mvp/group-buy/teams/invite/:inviteCode', (req, res) => {
  console.log('\n=== [Group Buy] Get Team by Invite Code ===');
  const { inviteCode } = req.params;

  const team = groupBuyTeams.find(t => t.inviteCode === inviteCode);

  if (!team) {
    return res.status(404).json({
      ok: false,
      data: null,
      message: 'Team not found'
    });
  }

  // Update team status if expired
  if (isTeamExpired(team.expiresAt) && team.status === 'WAITING') {
    team.status = 'EXPIRED';
  }

  // Update status to COMPLETED if target reached
  if (team.currentParticipants >= team.targetParticipants && team.status === 'WAITING') {
    team.status = 'COMPLETED';
    team.completedAt = new Date().toISOString();
  }

  console.log(`Team found by invite code: ${inviteCode}`);

  res.json({
    ok: true,
    data: { team },
    message: 'Team found successfully'
  });
});

// Join Team
app.post('/datepalm-bay/api/mvp/group-buy/teams/:teamId/join', (req, res) => {
  console.log('\n=== [Group Buy] Join Team ===');
  const { teamId } = req.params;
  const { userId, userName, userEmail, quantity } = req.body;

  if (!userId || !userName || !quantity) {
    return res.status(400).json({
      ok: false,
      data: null,
      message: 'Missing required fields'
    });
  }

  const team = groupBuyTeams.find(t => t.teamId === teamId);

  if (!team) {
    return res.status(404).json({
      ok: false,
      data: null,
      message: 'Team not found'
    });
  }

  // Check if team is expired
  if (isTeamExpired(team.expiresAt)) {
    team.status = 'EXPIRED';
    return res.status(400).json({
      ok: false,
      data: null,
      message: 'Team has expired'
    });
  }

  // Check if team is full
  if (team.currentParticipants >= team.targetParticipants) {
    return res.status(400).json({
      ok: false,
      data: null,
      message: 'Team is full'
    });
  }

  // Check if user already joined
  if (team.members.some(m => m.userId === userId)) {
    return res.status(400).json({
      ok: false,
      data: null,
      message: 'User already joined this team'
    });
  }

  // Add new member
  const newMember = {
    userId,
    name: userName,
    email: userEmail || '',
    quantity,
    joinedAt: new Date().toISOString(),
    status: 'JOINED'
  };

  team.members.push(newMember);
  team.currentParticipants += 1;
  team.currentQuantity += quantity;

  // Check if team is now complete
  if (team.currentParticipants >= team.targetParticipants) {
    team.status = 'COMPLETED';
    team.completedAt = new Date().toISOString();
  }

  console.log(`User ${userId} joined team ${teamId}`);
  saveData();

  res.json({
    ok: true,
    data: { team, success: true },
    message: 'Successfully joined team'
  });
});

// Get User's Teams
app.get('/datepalm-bay/api/mvp/group-buy/teams/user/:userId', (req, res) => {
  console.log('\n=== [Group Buy] Get User Teams ===');
  const { userId } = req.params;

  const userTeams = groupBuyTeams.filter(team =>
    team.members.some(member => member.userId === userId)
  );

  // Update status for expired teams
  userTeams.forEach(team => {
    if (isTeamExpired(team.expiresAt) && team.status === 'WAITING') {
      team.status = 'EXPIRED';
    }
    if (team.currentParticipants >= team.targetParticipants && team.status === 'WAITING') {
      team.status = 'COMPLETED';
      team.completedAt = new Date().toISOString();
    }
  });

  console.log(`Found ${userTeams.length} teams for user ${userId}`);

  res.json({
    ok: true,
    data: userTeams,
    message: 'User teams retrieved successfully'
  });
});

// Checkout Team Purchase
app.post('/datepalm-bay/api/mvp/group-buy/teams/:teamId/checkout', (req, res) => {
  console.log('\n=== [Group Buy] Checkout Team ===');
  const { teamId } = req.params;
  const orderData = req.body;

  const team = groupBuyTeams.find(t => t.teamId === teamId);

  if (!team) {
    return res.status(404).json({
      ok: false,
      data: null,
      message: 'Team not found'
    });
  }

  if (team.status !== 'COMPLETED') {
    return res.status(400).json({
      ok: false,
      data: null,
      message: 'Team is not complete yet'
    });
  }

  // Mock order creation for GROUP_BUY type
  const orderCode = `ORD-GB-${Date.now()}`;
  const paymentCode = `PAY-GB-${Date.now()}`;

  console.log(`Creating GROUP_BUY order: ${orderCode} for team ${teamId}`);
  saveData();

  res.json({
    ok: true,
    data: {
      paymentCode,
      applicationId: 'bootpay-test-app-id',
      paymentPrice: team.groupPrice * orderData.quantity
    },
    message: 'Order created successfully'
  });
});

// Close Team (by team creator)
app.post('/datepalm-bay/api/mvp/group-buy/teams/:teamId/close', (req, res) => {
  console.log('\n=== [Group Buy] Close Team ===');
  const { teamId } = req.params;
  const { userId } = req.body;

  const team = groupBuyTeams.find(t => t.teamId === teamId);

  if (!team) {
    return res.status(404).json({
      ok: false,
      data: null,
      message: 'Team not found'
    });
  }

  // Only team creator can close the team
  if (team.createdBy !== userId) {
    return res.status(403).json({
      ok: false,
      data: null,
      message: 'Only team creator can close the team'
    });
  }

  // Check if team is already closed or expired
  if (team.status !== 'WAITING') {
    return res.status(400).json({
      ok: false,
      data: null,
      message: `Team is already ${team.status.toLowerCase()}`
    });
  }

  // Close the team
  team.status = 'CLOSED';
  team.closedAt = new Date().toISOString();

  console.log(`Team ${teamId} closed by ${userId}`);

  res.json({
    ok: true,
    data: { team },
    message: 'Team closed successfully'
  });
});

// ======================================
// Auth - Login Endpoint
// ======================================

// Login
app.post('/datepalm-bay/mvp/login', (req, res) => {
  console.log('\n=== [Auth] Login Request ===');
  console.log('Request body:', req.body);
  console.log('Content-Type:', req.headers['content-type']);

  const { id, password } = req.body;

  if (!id || !password) {
    console.log('Missing credentials - ID:', id, 'Password:', password ? '****' : 'undefined');
    return res.status(400).json({
      ok: false,
      data: null,
      message: 'ID and password are required'
    });
  }

  // Find user by id or email
  const user = users.find(u => (u.id === id || u.email === id) && u.password === password);

  if (!user) {
    console.log(`Login failed: Invalid credentials for ID ${id}`);
    return res.status(401).json({
      ok: false,
      data: null,
      message: 'Invalid ID or password'
    });
  }

  if (user.status !== 'ACTIVE') {
    console.log(`Login failed: User ${id} is not active`);
    return res.status(403).json({
      ok: false,
      data: null,
      message: 'Account is not active'
    });
  }

  // Generate mock access token
  const accessToken = `mock-token-${user.id}-${Date.now()}`;

  console.log(`Login successful: ${user.name} (${user.id})`);

  // Return data directly (not wrapped) - frontend saga expects this format
  res.json({
    accessToken,
    id: user.id,
    code: user.code,
    name: user.name,
    email: user.email,
    phone: user.phone,
    birthDate: user.birthDate || '1990-01-01',
    country: user.country || 'UAE',
    status: user.status
  });
});

// Get User Profile (Me)
app.get('/datepalm-bay/api/mvp/member/detail/me', (req, res) => {
  console.log('\n=== [Auth] Get User Profile ===');

  // Mock authentication - in real app, would verify token from header
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({
      ok: false,
      data: null,
      message: 'Authorization token required'
    });
  }

  // Extract user ID from mock token (format: mock-token-{userId}-{timestamp})
  const token = authHeader.replace('Bearer ', '');
  const userId = token.split('-')[2];

  const user = users.find(u => u.id === userId);

  if (!user) {
    return res.status(404).json({
      ok: false,
      data: null,
      message: 'User not found'
    });
  }

  console.log(`Profile retrieved: ${user.name} (${user.id})`);

  res.json({
    ok: true,
    data: {
      id: user.id,
      code: user.code,
      name: user.name,
      email: user.email,
      phone: user.phone,
      status: user.status,
      createAt: user.createAt
    },
    message: 'User profile retrieved successfully'
  });
});

// ======================================
// Google Mock Login
// ======================================
app.post('/datepalm-bay/mvp/google-login', (req, res) => {
  console.log('\n=== [Auth] Google Mock Login ===');

  // Return first test user as the Google-authenticated user
  const user = users[0];
  const accessToken = `mock-google-token-${user.id}-${Date.now()}`;

  console.log(`Google login successful (mock): ${user.name} (${user.email})`);

  // Return data directly (same format as regular login)
  res.json({
    accessToken,
    id: user.id,
    code: user.code,
    name: user.name,
    email: user.email,
    phone: user.phone,
    birthDate: user.birthDate || '1990-01-01',
    country: user.country || 'UNITED_ARAB_EMIRATES',
    status: user.status,
  });
});

// ======================================
// SMS Verification (Twilio Verify API)
// ======================================
const smsVerifications = {};

app.post('/datepalm-bay/api/mvp/member/sms/send', async (req, res) => {
  console.log('\n=== [SMS] Send Verification Code ===');
  const { phone, countryCode } = req.body;

  if (!phone) {
    return res.json({ ok: false, data: null, message: 'Phone number is required' });
  }

  // E.164 형식: 국가코드 + 번호 (앞자리 0 제거)
  const cleanPhone = phone.replace(/^0+/, '');
  const fullPhone = `${countryCode || ''}${cleanPhone}`;
  const requestId = `sms-${Date.now()}`;

  // Twilio Verify API로 인증 코드 발송
  if (twilioClient && TWILIO_VERIFY_SID) {
    try {
      await twilioClient.verify.v2
        .services(TWILIO_VERIFY_SID)
        .verifications.create({ to: fullPhone, channel: 'sms' });
      console.log(`✅ Twilio Verify sent to ${fullPhone}`);
      // requestId → phone 매핑 저장 (verify 시 phone 필요)
      smsVerifications[requestId] = { phone: fullPhone, createdAt: Date.now() };
    } catch (err) {
      console.error(`❌ Twilio Verify failed:`, err.message);
      return res.json({ ok: false, data: null, message: 'Failed to send SMS. Please try again.' });
    }
  } else {
    // Twilio 미설정 시 폴백 (개발용)
    const code = String(Math.floor(100000 + Math.random() * 900000));
    smsVerifications[requestId] = { code, phone: fullPhone, createdAt: Date.now() };
    console.log(`⚠️  Twilio not configured - fallback code: ${code}`);
  }

  res.json({ ok: true, data: requestId, message: 'SMS verification code sent' });
});

app.post('/datepalm-bay/api/mvp/member/sms/verify', async (req, res) => {
  console.log('\n=== [SMS] Verify Code ===');
  const { requestId, code } = req.body;

  const verification = smsVerifications[requestId];

  if (!verification) {
    return res.json({ ok: false, data: null, message: 'Invalid request' });
  }

  // Twilio Verify API로 코드 검증
  if (twilioClient && TWILIO_VERIFY_SID) {
    try {
      const check = await twilioClient.verify.v2
        .services(TWILIO_VERIFY_SID)
        .verificationChecks.create({ to: verification.phone, code });

      if (check.status === 'approved') {
        delete smsVerifications[requestId];
        console.log('✅ Twilio Verify approved');
        return res.json({ ok: true, data: 'verified', message: 'Phone verified successfully' });
      } else {
        console.log(`❌ Twilio Verify rejected: ${check.status}`);
        return res.json({ ok: false, data: null, message: 'Code does not match' });
      }
    } catch (err) {
      console.error(`❌ Twilio Verify check failed:`, err.message);
      return res.json({ ok: false, data: null, message: 'Verification failed. Please try again.' });
    }
  } else {
    // Twilio 미설정 시 폴백 (개발용)
    if (Date.now() - verification.createdAt > 5 * 60 * 1000) {
      delete smsVerifications[requestId];
      return res.json({ ok: false, data: null, message: 'Code expired' });
    }
    if (verification.code !== code) {
      return res.json({ ok: false, data: null, message: 'Code does not match' });
    }
    delete smsVerifications[requestId];
    console.log('✅ SMS verification successful (fallback)');
    return res.json({ ok: true, data: 'verified', message: 'Phone verified successfully' });
  }
});

// ======================================
// Email Verification (Sign Up)
// ======================================
const emailVerifications = {};

app.post('/datepalm-bay/api/mvp/member/email/verify/send', async (req, res) => {
  console.log('\n=== [Email] Send Verification Code ===');
  const { email } = req.body;

  if (!email) {
    return res.json({ ok: false, data: null, message: 'Email is required' });
  }

  const existingUser = users.find(u => u.email === email);
  if (existingUser) {
    return res.json({ ok: false, data: null, message: 'This email is already in use.' });
  }

  const requestId = `email-${Date.now()}`;
  emailVerifications[requestId] = { email, createdAt: Date.now() };

  if (twilioClient && TWILIO_VERIFY_SID) {
    try {
      await twilioClient.verify.v2
        .services(TWILIO_VERIFY_SID)
        .verifications.create({ to: email, channel: 'email' });
      console.log(`📧 Twilio Verify email sent to ${email}`);
    } catch (err) {
      console.error('Twilio Verify email error:', err.message);
      return res.json({ ok: false, data: null, message: 'Failed to send verification email.' });
    }
  } else {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    emailVerifications[requestId].code = code;
    console.log(`📧 [DEV] Email OTP for ${email}: ${code}`);
  }
  console.log(`   Request ID: ${requestId}`);

  res.json({ ok: true, data: requestId, message: 'Email verification code sent' });
});

app.patch('/datepalm-bay/api/mvp/member/verify/auth-email', async (req, res) => {
  console.log('\n=== [Email] Verify OTP Code ===');
  const { requestId, code } = req.body;

  const verification = emailVerifications[requestId];

  if (!verification) {
    return res.json({ ok: false, data: null, message: 'Invalid request' });
  }

  if (twilioClient && TWILIO_VERIFY_SID) {
    try {
      const check = await twilioClient.verify.v2
        .services(TWILIO_VERIFY_SID)
        .verificationChecks.create({ to: verification.email, code });

      if (check.status === 'approved') {
        delete emailVerifications[requestId];
        console.log('✅ Email verification successful (Twilio Verify)');
        return res.json({ ok: true, data: 'verified', message: 'Email verified successfully' });
      } else {
        console.log(`❌ Email verification failed: status=${check.status}`);
        return res.json({ ok: false, data: null, message: 'Code does not match' });
      }
    } catch (err) {
      console.error('Twilio Verify check error:', err.message);
      return res.json({ ok: false, data: null, message: 'Verification failed' });
    }
  } else {
    // DEV fallback: 로컬 코드 비교
    if (Date.now() - verification.createdAt > 5 * 60 * 1000) {
      delete emailVerifications[requestId];
      return res.json({ ok: false, data: null, message: 'Code expired' });
    }
    if (verification.code !== code) {
      console.log(`❌ Email code mismatch: expected ${verification.code}, got ${code}`);
      return res.json({ ok: false, data: null, message: 'Code does not match' });
    }
    delete emailVerifications[requestId];
    console.log('✅ Email verification successful (DEV)');
    return res.json({ ok: true, data: 'verified', message: 'Email verified successfully' });
  }
});

// ======================================
// Check Duplicate ID / Email
// ======================================
app.post('/datepalm-bay/api/mvp/member/check-id', (req, res) => {
  console.log('\n=== [Member] Check Duplicate ID ===');
  const { id } = req.body;
  const isDuplicate = users.some(u => u.id === id);
  console.log(`ID "${id}" duplicate: ${isDuplicate}`);
  res.json({ ok: true, data: isDuplicate });
});

app.post('/datepalm-bay/api/mvp/member/check-email', (req, res) => {
  console.log('\n=== [Member] Check Duplicate Email ===');
  const email = req.body?.email || req.body;
  // Google OAuth 유저(password 없음)는 이메일 가입 중복에서 제외
  const isDuplicate = users.some(u => u.email === email && u.password);
  console.log(`Email "${email}" duplicate: ${isDuplicate}`);
  res.json({ ok: true, data: isDuplicate });
});

// ======================================
// Member Create (Sign Up)
// ======================================
app.post('/datepalm-bay/api/mvp/member/create', (req, res) => {
  console.log('\n=== [Member] Create New Member ===');
  const { id, password, name, email, phone, birthdate, country } = req.body;

  if (!id || !password || !name || !email) {
    return res.json({ ok: false, data: null, message: 'Required fields missing' });
  }

  // Google OAuth 유저가 이메일로 재가입하는 경우 → 기존 유저 업데이트
  const existingGoogleUser = users.find(u => u.email === email && !u.password);
  if (existingGoogleUser) {
    Object.assign(existingGoogleUser, { id, password, name, phone: phone || '', birthDate: birthdate || '', country: country || 'UNITED_STATES' });
    // members에도 추가 (없으면)
    if (!members.find(m => m.code === existingGoogleUser.code)) {
      members.push({ code: existingGoogleUser.code, name, phone: phone || '', email, status: 'ACTIVE', createAt: existingGoogleUser.createAt, birthDate: birthdate || '', country: country || 'UNITED_STATES' });
    }
    console.log(`✅ Google user upgraded to email account: ${name} (${email})`);
    saveData();
    return res.json({ ok: true, data: { id: existingGoogleUser.id, code: existingGoogleUser.code, name, email, phone: phone || '', birthDate: birthdate || '', country: country || 'UNITED_STATES', status: 'ACTIVE', createDatetime: existingGoogleUser.createAt }, message: 'Member created successfully' });
  }

  const existingUser = users.find(u => u.id === id || u.email === email);
  if (existingUser) {
    return res.json({ ok: false, data: null, message: 'User already exists' });
  }

  const newUser = {
    id,
    password,
    code: `USER-${String(users.length + 1).padStart(3, '0')}`,
    name,
    phone: phone || '',
    email,
    createAt: new Date().toISOString(),
    status: 'ACTIVE',
    birthDate: birthdate || '',
    country: country || 'UNITED_STATES',
    memberLevel: 'BRONZE',
    birthMonth: birthdate ? new Date(birthdate).getMonth() + 1 : 1,
    lastPurchaseDate: null,
    totalPurchaseCount: 0,
    totalPurchaseAmount: 0,
  };

  users.push(newUser);

  // Also add to members list
  const newMember = {
    code: newUser.code,
    name: newUser.name,
    phone: newUser.phone,
    email: newUser.email,
    status: 'ACTIVE',
    createAt: newUser.createAt,
    birthDate: newUser.birthDate,
    country: newUser.country,
  };
  members.push(newMember);

  console.log(`✅ New member created: ${name} (${email})`);
  saveData();

  res.json({
    ok: true,
    data: {
      id: newUser.id,
      code: newUser.code,
      name: newUser.name,
      email: newUser.email,
      phone: newUser.phone,
      birthDate: newUser.birthDate,
      country: newUser.country,
      status: newUser.status,
      createDatetime: newUser.createAt,
    },
    message: 'Member created successfully',
  });
});

// ======================================
// Forgot Account - Send Auth Mail
// ======================================
app.put('/datepalm-bay/api/mvp/member/send-auth-mail', async (req, res) => {
  console.log('\n=== [Auth] Send Auth Mail ===');
  const { email, type } = req.body;

  const user = users.find(u => u.email === email);
  if (!user) {
    return res.json({ ok: false, data: null, message: 'No user found with this email.' });
  }

  const requestId = `auth-mail-${Date.now()}`;
  emailVerifications[requestId] = { email, type, createdAt: Date.now() };

  if (twilioClient && TWILIO_VERIFY_SID) {
    try {
      await twilioClient.verify.v2
        .services(TWILIO_VERIFY_SID)
        .verifications.create({ to: email, channel: 'email' });
      console.log(`📧 Twilio Verify email sent to ${email} (${type})`);
    } catch (err) {
      console.error('Twilio Verify email error:', err.message);
      return res.json({ ok: false, data: null, message: 'Failed to send verification email.' });
    }
  } else {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    emailVerifications[requestId].code = code;
    console.log(`📧 [DEV] Auth mail OTP for ${email} (${type}): ${code}`);
  }
  console.log(`   Request ID: ${requestId}`);

  res.json({ ok: true, data: requestId, message: 'Auth mail sent' });
});

// ======================================
// Reset Password
// ======================================
app.patch('/datepalm-bay/api/mvp/member/edit/change-password', (req, res) => {
  console.log('\n=== [Auth] Change Password ===');
  const { requestId, email, newPassword } = req.body;

  const user = users.find(u => u.email === email);
  if (!user) {
    return res.json({ ok: false, data: null, message: 'User not found' });
  }

  user.password = newPassword;
  saveData();
  console.log(`✅ Password changed for ${email}`);

  res.json({ ok: true, data: 'success', message: 'Password changed successfully' });
});

// ======================================
// Member Withdraw (회원 탈퇴)
// ======================================
app.delete('/datepalm-bay/api/mvp/member/withdraw', (req, res) => {
  console.log('\n=== [Member] Withdraw Account ===');
  const { email } = req.body;

  if (!email) {
    return res.json({ ok: false, data: null, message: 'Email is required' });
  }

  const userIndex = users.findIndex(u => u.email === email);
  if (userIndex === -1) {
    return res.json({ ok: false, data: null, message: 'User not found' });
  }

  const user = users[userIndex];
  users.splice(userIndex, 1);

  const memberIndex = members.findIndex(m => m.email === email || m.code === user.code);
  if (memberIndex !== -1) {
    members.splice(memberIndex, 1);
  }

  saveData();
  console.log(`✅ Account deleted: ${user.name} (${email})`);

  res.json({ ok: true, data: null, message: 'Account deleted successfully' });
});

// ======================================
// Mock Events Data (기본 시드 데이터, startServer()에서 덮어씀)
// ======================================
let events = [
  {
    code: 'EVT-001',
    title: 'New Year Sale 2025',
    subtitle: 'Up to 50% Off on Selected Items',
    description: 'Celebrate the new year with amazing discounts on K-Beauty and K-Pop merchandise! Limited time only.',
    content: '<p>Don\'t miss our biggest sale of the year! Get up to 50% off on selected K-Beauty products and K-Pop merchandise.</p><ul><li>Free shipping on orders over $50</li><li>Extra 10% off with code NEWYEAR25</li></ul>',
    bannerImage: 'https://via.placeholder.com/1200x400?text=New+Year+Sale+2025',
    thumbnailImage: 'https://via.placeholder.com/400x300?text=New+Year+Sale',
    startDate: '2025-01-01T00:00:00Z',
    endDate: '2025-01-31T23:59:59Z',
    status: 'ONGOING',
    linkedProducts: [],
    eventType: 'SALE',
    priority: 1,
    createdAt: '2024-12-20T00:00:00Z'
  },
  {
    code: 'EVT-002',
    title: 'Valentine\'s Day Special',
    subtitle: 'Love is in the Air',
    description: 'Find the perfect gift for your loved one with our Valentine\'s Day collection.',
    content: '<p>Express your love with our specially curated Valentine\'s Day collection. From skincare sets to K-Pop albums, find the perfect gift.</p>',
    bannerImage: 'https://via.placeholder.com/1200x400?text=Valentine+Day+Special',
    thumbnailImage: 'https://via.placeholder.com/400x300?text=Valentine+Special',
    startDate: '2025-02-01T00:00:00Z',
    endDate: '2025-02-14T23:59:59Z',
    status: 'UPCOMING',
    linkedProducts: [],
    eventType: 'PROMOTION',
    priority: 2,
    createdAt: '2025-01-15T00:00:00Z'
  },
  {
    code: 'EVT-003',
    title: 'Black Friday 2024',
    subtitle: 'Biggest Discounts of the Year',
    description: 'Our Black Friday sale has ended. Thanks for shopping with us!',
    content: '<p>Thank you for participating in our Black Friday sale!</p>',
    bannerImage: 'https://via.placeholder.com/1200x400?text=Black+Friday+2024',
    thumbnailImage: 'https://via.placeholder.com/400x300?text=Black+Friday',
    startDate: '2024-11-25T00:00:00Z',
    endDate: '2024-11-30T23:59:59Z',
    status: 'ENDED',
    linkedProducts: [],
    eventType: 'SALE',
    priority: 3,
    createdAt: '2024-11-01T00:00:00Z'
  }
];

// ======================================
// Mock Coupons Data (기본 시드 데이터, startServer()에서 덮어씀)
// ======================================
let coupons = [
  {
    code: 'CPN-WELCOME15',
    name: '15% Welcome Coupon',
    description: 'Welcome discount for new members! Join us and save on your first order.',
    discountType: 'PERCENT',
    discountValue: 15,
    minOrderAmount: 30,
    maxDiscountAmount: 50,
    startDate: '2026-01-01T00:00:00Z',
    endDate: '2027-12-31T23:59:59Z',
    status: 'ACTIVE',
    usageCount: 145,
    usageLimit: 1000,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    // 새 필드
    couponType: 'WELCOME',
    isDownloadable: true,
    isAutoIssue: false,
    targetCondition: {
      newMemberOnly: true,
      newMemberDays: 30 // 가입 후 30일 이내
    },
    applicableCategories: [], // 빈 배열 = 전체 카테고리
    applicableProductCodes: [],
    stackable: false
  },
  {
    code: 'CPN-SPRING10',
    name: '10% Spring Sale',
    description: 'Spring season special discount for all members!',
    discountType: 'PERCENT',
    discountValue: 10,
    minOrderAmount: 20,
    maxDiscountAmount: 30,
    startDate: '2026-01-01T00:00:00Z',
    endDate: '2027-05-31T23:59:59Z',
    status: 'ACTIVE',
    usageCount: 89,
    usageLimit: 500,
    createdAt: '2026-02-15T00:00:00Z',
    updatedAt: '2026-02-15T00:00:00Z',
    couponType: 'GENERAL',
    isDownloadable: true,
    isAutoIssue: false,
    targetCondition: {}, // 전체 회원
    applicableCategories: [],
    applicableProductCodes: [],
    stackable: true
  },
  {
    code: 'CPN-FIXED5',
    name: '$5 Off Coupon',
    description: 'Fixed $5 discount on orders over $40',
    discountType: 'FIXED',
    discountValue: 5,
    minOrderAmount: 40,
    maxDiscountAmount: null,
    startDate: '2026-01-01T00:00:00Z',
    endDate: '2027-06-30T23:59:59Z',
    status: 'ACTIVE',
    usageCount: 234,
    usageLimit: null,
    createdAt: '2026-01-15T00:00:00Z',
    updatedAt: '2026-01-15T00:00:00Z',
    couponType: 'GENERAL',
    isDownloadable: true,
    isAutoIssue: false,
    targetCondition: {},
    applicableCategories: [],
    applicableProductCodes: [],
    stackable: true
  },
  {
    code: 'CPN-VIP20',
    name: '20% VIP Exclusive',
    description: 'Exclusive 20% discount for our VIP members. Thank you for your loyalty!',
    discountType: 'PERCENT',
    discountValue: 20,
    minOrderAmount: 50,
    maxDiscountAmount: 100,
    startDate: '2025-01-01T00:00:00Z',
    endDate: '2027-12-31T23:59:59Z',
    status: 'ACTIVE',
    usageCount: 12,
    usageLimit: 100,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    couponType: 'VIP_EXCLUSIVE',
    isDownloadable: true,
    isAutoIssue: false,
    targetCondition: {
      memberLevels: ['VIP']
    },
    applicableCategories: [],
    applicableProductCodes: [],
    stackable: false
  },
  {
    code: 'CPN-COMEBACK10',
    name: 'We Miss You! 10% Off',
    description: 'Come back and enjoy 10% off on your next purchase!',
    discountType: 'PERCENT',
    discountValue: 10,
    minOrderAmount: 25,
    maxDiscountAmount: 40,
    startDate: '2025-01-01T00:00:00Z',
    endDate: '2027-12-31T23:59:59Z',
    status: 'ACTIVE',
    usageCount: 45,
    usageLimit: 500,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    couponType: 'COMEBACK',
    isDownloadable: true,
    isAutoIssue: false,
    targetCondition: {
      dormantDays: 60 // 60일 이상 미구매 회원
    },
    applicableCategories: [],
    applicableProductCodes: [],
    stackable: true
  },
  {
    code: 'CPN-BIRTHDAY15',
    name: 'Happy Birthday! 15% Off',
    description: 'Celebrate your birthday with a special 15% discount!',
    discountType: 'PERCENT',
    discountValue: 15,
    minOrderAmount: 30,
    maxDiscountAmount: 50,
    startDate: '2025-01-01T00:00:00Z',
    endDate: '2027-12-31T23:59:59Z',
    status: 'ACTIVE',
    usageCount: 28,
    usageLimit: null,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    couponType: 'BIRTHDAY',
    isDownloadable: true,
    isAutoIssue: false,
    targetCondition: {
      birthdayMonth: true // 이번 달 생일인 회원
    },
    applicableCategories: [],
    applicableProductCodes: [],
    stackable: true
  },
  {
    code: 'CPN-GOLD15',
    name: 'Gold Member Special',
    description: '15% off for Gold and VIP members',
    discountType: 'PERCENT',
    discountValue: 15,
    minOrderAmount: 40,
    maxDiscountAmount: 60,
    startDate: '2025-01-01T00:00:00Z',
    endDate: '2027-12-31T23:59:59Z',
    status: 'ACTIVE',
    usageCount: 67,
    usageLimit: 300,
    createdAt: '2025-01-15T00:00:00Z',
    updatedAt: '2025-01-15T00:00:00Z',
    couponType: 'GENERAL',
    isDownloadable: true,
    isAutoIssue: false,
    targetCondition: {
      memberLevels: ['GOLD', 'VIP']
    },
    applicableCategories: [],
    applicableProductCodes: [],
    stackable: false
  },
  {
    code: 'CPN-BEAUTY10',
    name: 'K-Beauty 10% Off',
    description: 'Special discount for K-Beauty products',
    discountType: 'PERCENT',
    discountValue: 10,
    minOrderAmount: 30,
    maxDiscountAmount: 30,
    startDate: '2025-01-01T00:00:00Z',
    endDate: '2027-06-30T23:59:59Z',
    status: 'ACTIVE',
    usageCount: 156,
    usageLimit: 1000,
    createdAt: '2025-01-20T00:00:00Z',
    updatedAt: '2025-01-20T00:00:00Z',
    couponType: 'CATEGORY',
    isDownloadable: true,
    isAutoIssue: false,
    targetCondition: {},
    applicableCategories: ['BEAUTY'],
    applicableProductCodes: [],
    stackable: true
  },
  {
    code: 'CPN-FIRST25',
    name: '25% First Purchase',
    description: 'Get 25% off on your very first order!',
    discountType: 'PERCENT',
    discountValue: 25,
    minOrderAmount: 50,
    maxDiscountAmount: 75,
    startDate: '2025-01-01T00:00:00Z',
    endDate: '2027-12-31T23:59:59Z',
    status: 'ACTIVE',
    usageCount: 89,
    usageLimit: 500,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    couponType: 'FIRST_PURCHASE',
    isDownloadable: true,
    isAutoIssue: false,
    targetCondition: {
      minPurchaseCount: 0 // 구매 이력이 없는 회원만
    },
    applicableCategories: [],
    applicableProductCodes: [],
    stackable: false
  },
  {
    code: 'CPN-EXPIRED',
    name: 'Expired Coupon',
    description: 'This coupon has expired',
    discountType: 'PERCENT',
    discountValue: 20,
    minOrderAmount: 50,
    maxDiscountAmount: 100,
    startDate: '2024-01-01T00:00:00Z',
    endDate: '2024-12-31T23:59:59Z',
    status: 'EXPIRED',
    usageCount: 500,
    usageLimit: 500,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-12-31T23:59:59Z',
    couponType: 'GENERAL',
    isDownloadable: false,
    isAutoIssue: false,
    targetCondition: {},
    applicableCategories: [],
    applicableProductCodes: [],
    stackable: false
  }
];

// ======================================
// New Products Endpoint (Products created within 1 week)
// ======================================
app.get('/datepalm-bay/api/mvp/product/new/list', (req, res) => {
  console.log('\n=== [Frontend] New Products List ===');
  const pageNo = parseInt(req.query.pageNo) || 0;
  const pageSize = parseInt(req.query.pageSize) || 10;
  const { sortType } = req.query;

  console.log('Filter:', { pageNo, pageSize, sortType });

  // Filter on-sale products created within 2 weeks
  const twoWeeksAgo = new Date();
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

  const onSaleProducts = products.filter(p => p.productSaleStatus === true);

  let filteredProducts = onSaleProducts.filter(p => {
    const createdDate = new Date(p.createdAt || Date.now());
    return createdDate >= twoWeeksAgo;
  });

  // If no products within 2 weeks, show the 4 most recently registered products
  if (filteredProducts.length === 0) {
    filteredProducts = [...onSaleProducts]
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      .slice(0, 4);
  }

  // Sort
  if (sortType === 'NEWEST') {
    filteredProducts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } else if (sortType === 'PRICE_HIGH') {
    filteredProducts.sort((a, b) => b.productPrice - a.productPrice);
  } else if (sortType === 'PRICE_LOW') {
    filteredProducts.sort((a, b) => a.productPrice - b.productPrice);
  } else {
    // Default: newest first
    filteredProducts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  const start = pageNo * pageSize;
  const end = start + pageSize;
  const paginatedProducts = filteredProducts.slice(start, end);

  const formattedProducts = paginatedProducts.map(p => ({
    code: p.productCode,
    name: p.productName,
    productNote: '',
    regularPrice: p.productRegularPrice,
    discountPrice: p.productDiscountPrice,
    discountType: p.discountType,
    summary: p.introduction,
    price: p.productPrice,
    thumbnailUrl: p.files?.mainImages?.[0]?.url || ''
  }));

  console.log(`Page: ${pageNo}, Size: ${pageSize}`);
  console.log(`Total ${filteredProducts.length} new products, returning ${formattedProducts.length}`);

  res.json({
    ok: true,
    data: {
      content: formattedProducts,
      pageable: {
        pageNumber: pageNo,
        pageSize: pageSize
      },
      totalElements: filteredProducts.length,
      totalPages: Math.ceil(filteredProducts.length / pageSize),
      size: pageSize,
      number: pageNo,
      first: pageNo === 0,
      last: pageNo >= Math.floor(filteredProducts.length / pageSize),
      numberOfElements: formattedProducts.length
    },
    message: 'New products list retrieved successfully'
  });
});

// ======================================
// Best Seller Endpoint (Products sorted by salesCount)
// ======================================
app.get('/datepalm-bay/api/mvp/product/bestseller/list', (req, res) => {
  console.log('\n=== [Frontend] Best Seller List ===');
  const pageNo = parseInt(req.query.pageNo) || 0;
  const pageSize = parseInt(req.query.pageSize) || 10;
  const { sortType } = req.query;

  console.log('Filter:', { pageNo, pageSize, sortType });

  // Filter products on sale and add salesCount if not exists
  let filteredProducts = products
    .filter(p => p.productSaleStatus === true)
    .map(p => ({
      ...p,
      salesCount: p.salesCount || Math.floor(Math.random() * 100), // Mock sales count if not set
      rank: 0
    }));

  // Sort by sales count (descending) by default
  if (sortType === 'PRICE_HIGH') {
    filteredProducts.sort((a, b) => b.productPrice - a.productPrice);
  } else if (sortType === 'PRICE_LOW') {
    filteredProducts.sort((a, b) => a.productPrice - b.productPrice);
  } else {
    // Default: by sales count (best sellers first)
    filteredProducts.sort((a, b) => b.salesCount - a.salesCount);
  }

  // Add rank
  filteredProducts = filteredProducts.map((p, index) => ({
    ...p,
    rank: index + 1
  }));

  const start = pageNo * pageSize;
  const end = start + pageSize;
  const paginatedProducts = filteredProducts.slice(start, end);

  const formattedProducts = paginatedProducts.map(p => ({
    code: p.productCode,
    name: p.productName,
    productNote: '',
    regularPrice: p.productRegularPrice,
    discountPrice: p.productDiscountPrice,
    discountType: p.discountType,
    summary: p.introduction,
    price: p.productPrice,
    thumbnailUrl: p.files?.mainImages?.[0]?.url || '',
    salesCount: p.salesCount,
    rank: p.rank
  }));

  console.log(`Page: ${pageNo}, Size: ${pageSize}`);
  console.log(`Total ${filteredProducts.length} best sellers, returning ${formattedProducts.length}`);

  res.json({
    ok: true,
    data: {
      content: formattedProducts,
      pageable: {
        pageNumber: pageNo,
        pageSize: pageSize
      },
      totalElements: filteredProducts.length,
      totalPages: Math.ceil(filteredProducts.length / pageSize),
      size: pageSize,
      number: pageNo,
      first: pageNo === 0,
      last: pageNo >= Math.floor(filteredProducts.length / pageSize),
      numberOfElements: formattedProducts.length
    },
    message: 'Best seller list retrieved successfully'
  });
});

// ======================================
// Event Endpoints
// ======================================

// Event List
app.get('/datepalm-bay/api/mvp/event/list', (req, res) => {
  console.log('\n=== [Frontend] Event List ===');
  const pageNo = parseInt(req.query.pageNo) || 0;
  const pageSize = parseInt(req.query.pageSize) || 10;
  const { status } = req.query;

  console.log('Filter:', { pageNo, pageSize, status });

  // Update event statuses based on current date
  const now = new Date();
  events.forEach(event => {
    const startDate = new Date(event.startDate);
    const endDate = new Date(event.endDate);

    if (now < startDate) {
      event.status = 'UPCOMING';
    } else if (now > endDate) {
      event.status = 'ENDED';
    } else {
      event.status = 'ONGOING';
    }
  });

  let filteredEvents = [...events];

  // Filter by status
  if (status) {
    filteredEvents = filteredEvents.filter(e => e.status === status);
  }

  // Sort by priority
  filteredEvents.sort((a, b) => a.priority - b.priority);

  const start = pageNo * pageSize;
  const end = start + pageSize;
  const paginatedEvents = filteredEvents.slice(start, end);

  res.json({
    ok: true,
    data: {
      content: paginatedEvents,
      pageable: {
        pageNumber: pageNo,
        pageSize: pageSize
      },
      totalElements: filteredEvents.length,
      totalPages: Math.ceil(filteredEvents.length / pageSize),
      size: pageSize,
      number: pageNo,
      first: pageNo === 0,
      last: pageNo >= Math.floor(filteredEvents.length / pageSize),
      numberOfElements: paginatedEvents.length
    },
    message: 'Event list retrieved successfully'
  });
});

// Featured Events (for Hero Banner)
app.get('/datepalm-bay/api/mvp/event/featured', (req, res) => {
  console.log('\n=== [Frontend] Featured Events ===');

  // Update event statuses
  const now = new Date();
  events.forEach(event => {
    const startDate = new Date(event.startDate);
    const endDate = new Date(event.endDate);

    if (now < startDate) {
      event.status = 'UPCOMING';
    } else if (now > endDate) {
      event.status = 'ENDED';
    } else {
      event.status = 'ONGOING';
    }
  });

  // Return ongoing events sorted by priority
  const featuredEvents = events
    .filter(e => e.status === 'ONGOING')
    .sort((a, b) => a.priority - b.priority)
    .slice(0, 3);

  res.json({
    ok: true,
    data: {
      list: featuredEvents
    },
    message: 'Featured events retrieved successfully'
  });
});

// Event Detail
app.get('/datepalm-bay/api/mvp/event/detail/:code', (req, res) => {
  console.log('\n=== [Frontend] Event Detail ===');
  const { code } = req.params;
  console.log(`Event code: ${code}`);

  const event = events.find(e => e.code === code);

  if (!event) {
    return res.status(404).json({
      ok: false,
      data: null,
      message: 'Event not found'
    });
  }

  // Update event status
  const now = new Date();
  const startDate = new Date(event.startDate);
  const endDate = new Date(event.endDate);

  if (now < startDate) {
    event.status = 'UPCOMING';
  } else if (now > endDate) {
    event.status = 'ENDED';
  } else {
    event.status = 'ONGOING';
  }

  res.json({
    ok: true,
    data: event,
    message: 'Event detail retrieved successfully'
  });
});

// ======================================
// Admin Event Endpoints
// ======================================

// Admin - Event List
app.get('/datepalm-bay/api/admin/event/list', (req, res) => {
  console.log('\n=== [Admin] Event List ===');
  const pageNo = parseInt(req.query.pageNo) || 0;
  const pageSize = parseInt(req.query.pageSize) || 10;
  const { status, eventType, keyword } = req.query;

  // Update event statuses
  const now = new Date();
  events.forEach(event => {
    const startDate = new Date(event.startDate);
    const endDate = new Date(event.endDate);

    if (now < startDate) {
      event.status = 'UPCOMING';
    } else if (now > endDate) {
      event.status = 'ENDED';
    } else {
      event.status = 'ONGOING';
    }
  });

  let filteredEvents = [...events];

  // Filter by status
  if (status) {
    filteredEvents = filteredEvents.filter(e => e.status === status);
  }

  // Filter by event type
  if (eventType) {
    filteredEvents = filteredEvents.filter(e => e.eventType === eventType);
  }

  // Filter by keyword
  if (keyword) {
    filteredEvents = filteredEvents.filter(e =>
      e.title.toLowerCase().includes(keyword.toLowerCase()) ||
      e.subtitle.toLowerCase().includes(keyword.toLowerCase())
    );
  }

  // Sort by priority
  filteredEvents.sort((a, b) => a.priority - b.priority);

  const start = pageNo * pageSize;
  const end = start + pageSize;
  const paginatedEvents = filteredEvents.slice(start, end);

  res.json({
    ok: true,
    data: {
      content: paginatedEvents,
      pageable: {
        pageNumber: pageNo,
        pageSize: pageSize
      },
      totalElements: filteredEvents.length,
      totalPages: Math.ceil(filteredEvents.length / pageSize),
      size: pageSize,
      number: pageNo,
      first: pageNo === 0,
      last: pageNo >= Math.floor(filteredEvents.length / pageSize),
      numberOfElements: paginatedEvents.length
    },
    message: 'Admin event list retrieved successfully'
  });
});

// Admin - Event Detail
app.get('/datepalm-bay/api/admin/event/detail/:code', (req, res) => {
  console.log('\n=== [Admin] Event Detail ===');
  const { code } = req.params;

  const event = events.find(e => e.code === code);

  if (!event) {
    return res.status(404).json({
      ok: false,
      data: null,
      message: 'Event not found'
    });
  }

  // Update status
  const now = new Date();
  const startDate = new Date(event.startDate);
  const endDate = new Date(event.endDate);

  if (now < startDate) {
    event.status = 'UPCOMING';
  } else if (now > endDate) {
    event.status = 'ENDED';
  } else {
    event.status = 'ONGOING';
  }

  res.json({
    ok: true,
    data: event,
    message: 'Event detail retrieved successfully'
  });
});

// Admin - Create Event
app.post('/datepalm-bay/api/admin/event/create', upload.fields([
  { name: 'bannerImage', maxCount: 1 },
  { name: 'thumbnailImage', maxCount: 1 },
  { name: 'request', maxCount: 1 }
]), (req, res) => {
  console.log('\n=== [Admin] Create Event ===');

  let requestData;
  try {
    if (req.body.request) {
      requestData = JSON.parse(req.body.request);
    } else {
      requestData = req.body;
    }
  } catch (e) {
    requestData = req.body;
  }

  const code = `EVT-${Date.now()}`;

  const bannerFiles = req.files?.bannerImage;
  const thumbnailFiles = req.files?.thumbnailImage;
  const eventBaseUrl = getBaseUrl(req);

  const bannerImage = bannerFiles?.[0]
    ? `${eventBaseUrl}/uploads/${bannerFiles[0].filename}`
    : 'https://via.placeholder.com/1200x400?text=Event+Banner';

  const thumbnailImage = thumbnailFiles?.[0]
    ? `${eventBaseUrl}/uploads/${thumbnailFiles[0].filename}`
    : 'https://via.placeholder.com/400x300?text=Event+Thumbnail';

  const newEvent = {
    code,
    title: requestData.title,
    subtitle: requestData.subtitle || '',
    description: requestData.description || '',
    content: requestData.content || '',
    bannerImage,
    thumbnailImage,
    startDate: requestData.startDate,
    endDate: requestData.endDate,
    status: 'UPCOMING',
    linkedProducts: requestData.linkedProducts || [],
    eventType: requestData.eventType || 'SALE',
    priority: requestData.priority || 1,
    createdAt: new Date().toISOString()
  };

  events.push(newEvent);

  console.log(`Event created: ${code}`);
  saveData();

  res.json({
    ok: true,
    data: newEvent,
    message: 'Event created successfully'
  });
});

// Admin - Edit Event
app.put('/datepalm-bay/api/admin/event/edit', upload.fields([
  { name: 'bannerImage', maxCount: 1 },
  { name: 'thumbnailImage', maxCount: 1 },
  { name: 'request', maxCount: 1 }
]), (req, res) => {
  console.log('\n=== [Admin] Edit Event ===');

  let requestData;
  try {
    if (req.body.request) {
      requestData = JSON.parse(req.body.request);
    } else {
      requestData = req.body;
    }
  } catch (e) {
    requestData = req.body;
  }

  const eventIndex = events.findIndex(e => e.code === requestData.code);

  if (eventIndex === -1) {
    return res.status(404).json({
      ok: false,
      data: null,
      message: 'Event not found'
    });
  }

  const existingEvent = events[eventIndex];

  const bannerFiles = req.files?.bannerImage;
  const thumbnailFiles = req.files?.thumbnailImage;
  const editBaseUrl = getBaseUrl(req);

  const bannerImage = bannerFiles?.[0]
    ? `${editBaseUrl}/uploads/${bannerFiles[0].filename}`
    : existingEvent.bannerImage;

  const thumbnailImage = thumbnailFiles?.[0]
    ? `${editBaseUrl}/uploads/${thumbnailFiles[0].filename}`
    : existingEvent.thumbnailImage;

  events[eventIndex] = {
    ...existingEvent,
    title: requestData.title,
    subtitle: requestData.subtitle || '',
    description: requestData.description || '',
    content: requestData.content || '',
    bannerImage,
    thumbnailImage,
    startDate: requestData.startDate,
    endDate: requestData.endDate,
    linkedProducts: requestData.linkedProducts || [],
    eventType: requestData.eventType || existingEvent.eventType,
    priority: requestData.priority || existingEvent.priority,
  };

  console.log(`Event updated: ${requestData.code}`);
  saveData();

  res.json({
    ok: true,
    data: events[eventIndex],
    message: 'Event updated successfully'
  });
});

// Admin - Delete Event
app.delete('/datepalm-bay/api/admin/event/delete/:code', (req, res) => {
  console.log('\n=== [Admin] Delete Event ===');
  const { code } = req.params;

  const eventIndex = events.findIndex(e => e.code === code);

  if (eventIndex === -1) {
    return res.status(404).json({
      ok: false,
      data: null,
      message: 'Event not found'
    });
  }

  events.splice(eventIndex, 1);

  console.log(`Event deleted: ${code}`);
  saveData();

  res.json({
    ok: true,
    data: null,
    message: 'Event deleted successfully'
  });
});

// ========================================
// SNS 리뷰 Mock 데이터 및 API
// ========================================

// SNS 리뷰 Mock 데이터 저장소 (startServer()에서 로드)
let snsReviews = [];
// AI 리뷰 오버라이드/인사이트/피드백 저장소
let snsReviewOverrides = [];
let productInsights = [];
let aiFeedbackHistory = [];
// SKIN OS Vision — 피부 프로필 저장소
let skinProfiles = [];

// SNS 수집기에 참조 및 저장 콜백 설정
snsCollector.setReferences(snsReviews, products, saveData);

// ========================================
// SNS 리뷰 수집 API (어드민용)
// ========================================

// 수동 수집 트리거
app.post('/datepalm-bay/api/admin/sns-reviews/collect', async (req, res) => {
  const { platform = 'ALL' } = req.body;

  console.log(`🚀 Manual SNS collection triggered for: ${platform}`);

  try {
    const results = await snsCollector.triggerCollection(platform);

    res.json({
      ok: true,
      data: results,
      message: 'Collection completed'
    });
  } catch (error) {
    console.error('Collection error:', error);
    res.status(500).json({
      ok: false,
      data: null,
      message: `Collection failed: ${error.message}`
    });
  }
});

// 수집 통계 조회
app.get('/datepalm-bay/api/admin/sns-reviews/stats', (req, res) => {
  const stats = snsCollector.getCollectionStats();

  res.json({
    ok: true,
    data: stats,
    message: 'Stats retrieved successfully'
  });
});

// 상품별 SNS 리뷰 조회 (프론트엔드용) - 페이지네이션 지원
app.get('/datepalm-bay/api/mvp/product/:productCode/sns-reviews', (req, res) => {
  const { productCode } = req.params;
  const { platform, pageNo = 0, pageSize = 3 } = req.query;

  console.log(`📱 SNS Reviews requested for product: ${productCode}, platform: ${platform || 'ALL'}, page: ${pageNo}`);

  let filtered = snsReviews.filter(r =>
    r.status === 'APPROVED' &&
    r.matchedProducts.some(m => m.productCode === productCode)
  );

  if (platform) {
    filtered = filtered.filter(r => r.platform === platform.toUpperCase());
  }

  // 최신순 정렬
  filtered.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  const total = filtered.length;
  const start = parseInt(pageNo) * parseInt(pageSize);
  const paged = filtered.slice(start, start + parseInt(pageSize));

  console.log(`Found ${paged.length}/${total} SNS reviews for product ${productCode} (page ${pageNo})`);

  res.json({
    ok: true,
    data: {
      content: paged,
      page: {
        current: parseInt(pageNo),
        total: total,
        lastPage: Math.max(0, Math.ceil(total / parseInt(pageSize)) - 1),
        pageSize: parseInt(pageSize)
      }
    },
    message: 'SNS reviews retrieved successfully'
  });
});

// 상품별 SNS 리뷰 요약 (오버라이드 → Claude AI → 키워드 fallback)
app.get('/datepalm-bay/api/mvp/product/:productCode/sns-reviews/summary', async (req, res) => {
  const { productCode } = req.params;

  console.log(`📊 SNS Review Summary requested for product: ${productCode}`);

  // 승인된 리뷰만 필터링
  const approvedReviews = snsReviews.filter(r =>
    r.status === 'APPROVED' &&
    r.matchedProducts.some(m => m.productCode === productCode)
  );

  console.log(`Found ${approvedReviews.length} approved reviews for summary`);

  try {
    // Claude AI 서비스를 통한 요약 (오버라이드 → Claude → 키워드 fallback 체인)
    const rawSummary = await claudeReviewSummarizer.getSummary(
      productCode,
      approvedReviews,
      reviewSummarizer.summarizeReviews.bind(reviewSummarizer)
    );

    // Frontend 호환 형식으로 정규화
    // Frontend는 summary: {ko, en}, hashtags: [{tag, displayTag, count, category}] 기대
    const isKeywordFormat = rawSummary.aiProvider === 'keyword';
    let summary;

    if (isKeywordFormat) {
      // 키워드 fallback → 이미 Frontend 호환 형식 (원본 그대로 전달)
      const kwResult = reviewSummarizer.summarizeReviews(approvedReviews);
      summary = { ...kwResult, aiProvider: 'keyword' };
    } else {
      // Claude/override/insights → plain string을 Frontend 형식으로 변환
      const summaryText = typeof rawSummary.summary === 'string' ? rawSummary.summary : (rawSummary.summary?.en || '');
      const hashtagItems = (rawSummary.hashtags || []).map((h, i) => {
        if (typeof h === 'object' && h.tag) return h; // 이미 객체면 그대로
        return { tag: String(h).toLowerCase().replace(/\s+/g, ''), displayTag: String(h), count: 1, category: 'ai' };
      });

      summary = {
        hasData: !!summaryText,
        reviewCount: rawSummary.reviewCount || approvedReviews.length,
        summary: { ko: summaryText, en: summaryText },
        hashtags: hashtagItems,
        sentiment: rawSummary.sentiment || { positiveRatio: 0, negativeRatio: 0 },
        aiProvider: rawSummary.aiProvider,
      };
    }

    res.json({
      ok: true,
      data: summary,
      message: 'SNS review summary generated successfully'
    });
  } catch (error) {
    console.error(`❌ Summary generation failed:`, error.message);
    // 최종 fallback: 키워드 방식
    const summary = reviewSummarizer.summarizeReviews(approvedReviews);
    res.json({
      ok: true,
      data: { ...summary, aiProvider: 'keyword-fallback' },
      message: 'SNS review summary generated (keyword fallback)'
    });
  }
});

// 어드민: 전체 SNS 리뷰 목록
app.get('/datepalm-bay/api/admin/sns-reviews', (req, res) => {
  const { platform, status, productCode, pageNo = 0, pageSize = 20 } = req.query;

  console.log(`📱 Admin SNS Reviews list requested - platform: ${platform || 'ALL'}, status: ${status || 'ALL'}, productCode: ${productCode || 'ALL'}`);
  console.log(`📊 전체 SNS 리뷰 개수: ${snsReviews.length}개`);

  // 저장된 리뷰들의 productCode 목록 출력 (디버깅용)
  if (snsReviews.length > 0) {
    const allProductCodes = [...new Set(snsReviews.flatMap(r => r.matchedProducts?.map(m => m.productCode) || []))];
    console.log(`📋 저장된 리뷰들의 productCode 목록:`, allProductCodes);
  }

  let filtered = [...snsReviews];

  // productCode 필터 (상품별 SNS 리뷰 조회)
  if (productCode) {
    console.log(`🔍 productCode 필터 적용: ${productCode}`);
    filtered = filtered.filter(r =>
      r.matchedProducts && r.matchedProducts.some(m => m.productCode === productCode)
    );
    console.log(`📊 productCode 필터 후 결과: ${filtered.length}개`);
  }

  if (platform) {
    filtered = filtered.filter(r => r.platform === platform.toUpperCase());
  }

  if (status) {
    filtered = filtered.filter(r => r.status === status.toUpperCase());
  }

  // 최신순 정렬
  filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const start = parseInt(pageNo) * parseInt(pageSize);
  const paged = filtered.slice(start, start + parseInt(pageSize));

  res.json({
    ok: true,
    data: {
      content: paged,
      page: {
        current: parseInt(pageNo),
        total: filtered.length,
        lastPage: Math.max(0, Math.ceil(filtered.length / parseInt(pageSize)) - 1)
      }
    },
    message: 'SNS reviews retrieved successfully'
  });
});

// 어드민: SNS 리뷰 상태 변경 (승인/거절)
app.put('/datepalm-bay/api/admin/sns-reviews/:id/status', (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  console.log(`📱 SNS Review status update: id=${id}, status=${status}`);

  const reviewIndex = snsReviews.findIndex(r => r.id === parseInt(id));

  if (reviewIndex === -1) {
    return res.status(404).json({
      ok: false,
      data: null,
      message: 'Review not found'
    });
  }

  if (!['PENDING', 'APPROVED', 'REJECTED'].includes(status?.toUpperCase())) {
    return res.status(400).json({
      ok: false,
      data: null,
      message: 'Invalid status. Must be PENDING, APPROVED, or REJECTED'
    });
  }

  snsReviews[reviewIndex].status = status.toUpperCase();
  saveData(); // 파일에 저장

  console.log(`SNS Review ${id} status updated to ${status.toUpperCase()}`);

  res.json({
    ok: true,
    data: snsReviews[reviewIndex],
    message: 'Review status updated successfully'
  });
});

// 어드민: SNS 리뷰 삭제
app.delete('/datepalm-bay/api/admin/sns-reviews/:id', (req, res) => {
  const { id } = req.params;

  console.log(`🗑️ SNS Review delete: id=${id}`);

  const reviewIndex = snsReviews.findIndex(r => r.id === parseInt(id));

  if (reviewIndex === -1) {
    return res.status(404).json({
      ok: false,
      data: null,
      message: 'Review not found'
    });
  }

  const deletedReview = snsReviews.splice(reviewIndex, 1)[0];
  saveData();

  console.log(`SNS Review ${id} deleted successfully`);

  res.json({
    ok: true,
    data: deletedReview,
    message: 'Review deleted successfully'
  });
});

// 어드민: SNS 리뷰 상세 조회
app.get('/datepalm-bay/api/admin/sns-reviews/:id', (req, res) => {
  const { id } = req.params;

  const review = snsReviews.find(r => r.id === parseInt(id));

  if (!review) {
    return res.status(404).json({
      ok: false,
      data: null,
      message: 'Review not found'
    });
  }

  res.json({
    ok: true,
    data: review,
    message: 'Review retrieved successfully'
  });
});

// 어드민: 전체 PENDING 리뷰 일괄 승인
app.put('/datepalm-bay/api/admin/sns-reviews/approve-all', (req, res) => {
  const { productCode } = req.body;

  console.log(`📱 Bulk approve pending reviews for product: ${productCode || 'ALL'}`);

  let targetReviews = snsReviews.filter(r => r.status === 'PENDING');

  if (productCode) {
    targetReviews = targetReviews.filter(r =>
      r.matchedProducts && r.matchedProducts.some(m => m.productCode === productCode)
    );
  }

  let approvedCount = 0;
  targetReviews.forEach(review => {
    review.status = 'APPROVED';
    approvedCount++;
  });

  // 파일 저장
  if (approvedCount > 0) {
    saveData();
  }

  console.log(`✅ ${approvedCount} reviews approved`);

  res.json({
    ok: true,
    data: { approvedCount },
    message: `${approvedCount} reviews approved successfully`
  });
});

// 어드민: 선택한 리뷰 벌크 액션 (승인/거절/삭제)
app.put('/datepalm-bay/api/admin/sns-reviews/bulk-action', (req, res) => {
  const { ids, action } = req.body;

  console.log(`📱 Bulk action: ${action} for ${ids?.length || 0} reviews`);

  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ ok: false, message: 'ids array is required' });
  }

  if (!['APPROVED', 'REJECTED', 'DELETE'].includes(action)) {
    return res.status(400).json({ ok: false, message: 'action must be APPROVED, REJECTED, or DELETE' });
  }

  let processedCount = 0;

  if (action === 'DELETE') {
    const beforeCount = snsReviews.length;
    snsReviews = snsReviews.filter(r => !ids.includes(r.id));
    processedCount = beforeCount - snsReviews.length;
  } else {
    snsReviews.forEach(review => {
      if (ids.includes(review.id)) {
        review.status = action;
        processedCount++;
      }
    });
  }

  if (processedCount > 0) {
    saveData();
  }

  const actionLabel = action === 'DELETE' ? 'deleted' : action === 'APPROVED' ? 'approved' : 'rejected';
  console.log(`✅ ${processedCount} reviews ${actionLabel}`);

  res.json({
    ok: true,
    data: { processedCount },
    message: `${processedCount} reviews ${actionLabel} successfully`
  });
});

// 어드민: URL로 SNS 리뷰 수동 추가
app.post('/datepalm-bay/api/admin/sns-reviews/manual', async (req, res) => {
  const { url, productCode } = req.body;

  console.log(`📱 Manual review add: ${url} for product: ${productCode}`);

  if (!url || !productCode) {
    return res.status(400).json({
      ok: false,
      message: 'URL and productCode are required'
    });
  }

  try {
    let reviewData = null;

    // YouTube URL 파싱
    if (url.includes('youtube.com') || url.includes('youtu.be')) {
      const videoId = extractYouTubeVideoId(url);
      if (videoId) {
        // 1차: YouTube Data API로 상세 정보 가져오기
        try {
          const youtubeService = require('./services/youtube');
          const details = await youtubeService.getVideoDetails([videoId]);
          if (details && details.length > 0) {
            const video = details[0];
            reviewData = {
              platform: 'YOUTUBE',
              externalId: videoId,
              contentUrl: `https://www.youtube.com/watch?v=${videoId}`,
              thumbnailUrl: video.thumbnailUrl || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
              title: video.title || 'YouTube Video',
              description: video.description || '',
              authorName: video.channelTitle || 'Unknown',
              authorId: video.channelId || 'unknown',
              publishedAt: video.publishedAt || new Date().toISOString(),
              viewCount: video.viewCount || 0,
              likeCount: video.likeCount || 0,
            };
          }
        } catch (err) {
          console.log('YouTube Data API error, trying oEmbed:', err.message);
        }

        // 2차: YouTube oEmbed API (API 키 불필요, 실제 제목 가져오기)
        if (!reviewData) {
          try {
            const https = require('https');
            const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
            const oembedData = await new Promise((resolve, reject) => {
              https.get(oembedUrl, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                  try { resolve(JSON.parse(data)); }
                  catch (e) { reject(e); }
                });
              }).on('error', reject);
            });
            console.log(`YouTube oEmbed success: "${oembedData.title}"`);
            reviewData = {
              platform: 'YOUTUBE',
              externalId: videoId,
              contentUrl: `https://www.youtube.com/watch?v=${videoId}`,
              thumbnailUrl: oembedData.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
              title: oembedData.title || 'YouTube Video',
              description: '',
              authorName: oembedData.author_name || 'Unknown',
              authorId: 'unknown',
              publishedAt: new Date().toISOString(),
              viewCount: 0,
              likeCount: 0,
            };
          } catch (err) {
            console.log('YouTube oEmbed also failed:', err.message);
          }
        }

        // 3차: 모두 실패 시 기본 정보
        if (!reviewData) {
          reviewData = {
            platform: 'YOUTUBE',
            externalId: videoId,
            contentUrl: `https://www.youtube.com/watch?v=${videoId}`,
            thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
            title: 'YouTube Video',
            description: '',
            authorName: 'Unknown',
            authorId: 'unknown',
            publishedAt: new Date().toISOString(),
            viewCount: 0,
            likeCount: 0,
          };
        }
      }
    }

    // TikTok URL 파싱 (oEmbed 사용)
    if (url.includes('tiktok.com')) {
      try {
        const tiktokService = require('./services/tiktok');
        reviewData = await tiktokService.createReviewFromUrl(url, productCode);
        if (reviewData) {
          // matchedProducts는 나중에 설정되므로 여기서는 제거
          delete reviewData.matchedProducts;
          delete reviewData.status;
        }
      } catch (err) {
        console.log('TikTok oEmbed error:', err.message);
        // 실패 시 기본 정보로 저장
        const videoId = url.match(/video\/(\d+)/)?.[1] || `manual_${Date.now()}`;
        reviewData = {
          platform: 'TIKTOK',
          externalId: videoId,
          contentUrl: url,
          thumbnailUrl: '',
          title: 'TikTok Video',
          description: 'Manually added TikTok review',
          authorName: 'TikTok User',
          authorId: 'unknown',
          publishedAt: new Date().toISOString(),
          viewCount: 0,
          likeCount: 0,
          commentCount: 0,
          shareCount: 0,
        };
      }
    }

    if (!reviewData) {
      return res.status(400).json({
        ok: false,
        message: 'Unsupported URL format. Please use YouTube or TikTok URLs.'
      });
    }

    // 중복 체크 → 중복이면 기존 리뷰 업데이트 (제목/썸네일 등 갱신)
    const existingIdx = snsReviews.findIndex(
      r => r.platform === reviewData.platform && r.externalId === reviewData.externalId
    );

    if (existingIdx >= 0) {
      const existing = snsReviews[existingIdx];
      // 기존 리뷰의 제목/썸네일/작성자 등을 최신 데이터로 업데이트
      if (reviewData.title && reviewData.title !== 'YouTube Video' && reviewData.title !== 'TikTok Video') {
        existing.title = reviewData.title;
      }
      if (reviewData.thumbnailUrl) existing.thumbnailUrl = reviewData.thumbnailUrl;
      if (reviewData.authorName && reviewData.authorName !== 'Unknown') existing.authorName = reviewData.authorName;
      if (reviewData.description) existing.description = reviewData.description;
      // 상품 매칭 추가 (이미 없는 경우만)
      if (!existing.matchedProducts.some(m => m.productCode === productCode)) {
        existing.matchedProducts.push({ productCode, matchScore: 100 });
      }
      saveData();
      console.log(`🔄 Existing review updated: ${existing.id} (${existing.title})`);
      return res.json({
        ok: true,
        data: existing,
        message: 'Review updated with latest info'
      });
    }

    // 새 리뷰 생성
    const newReview = {
      id: Math.max(...snsReviews.map(r => r.id), 0) + 1,
      ...reviewData,
      status: 'APPROVED', // 수동 추가는 자동 승인
      matchedProducts: [{ productCode, matchScore: 100 }],
      createdAt: new Date().toISOString()
    };

    snsReviews.push(newReview);
    saveData();

    console.log(`✅ Manual review added: ${newReview.id}`);

    res.json({
      ok: true,
      data: newReview,
      message: 'Review added successfully'
    });

  } catch (error) {
    console.error('Manual add failed:', error);
    res.status(500).json({
      ok: false,
      message: error.message
    });
  }
});

// ========================================
// AI 리뷰 요약 오버라이드 & Claude 재분석 API (어드민용)
// ========================================

// 오버라이드 + 자동생성 요약 조회
app.get('/datepalm-bay/api/admin/sns-reviews/:productCode/summary-override', async (req, res) => {
  const { productCode } = req.params;

  console.log(`📝 Admin: Summary override requested for ${productCode}`);

  // 오버라이드 데이터
  const override = snsReviewOverrides.find(o => o.productCode === productCode) || null;

  // 승인된 리뷰
  const approvedReviews = snsReviews.filter(r =>
    r.status === 'APPROVED' &&
    r.matchedProducts.some(m => m.productCode === productCode)
  );

  // 자동생성 요약 (키워드 기반) — 결과를 문자열로 정규화
  const rawAutoGenerated = reviewSummarizer.summarizeReviews(approvedReviews);
  const autoGenerated = {
    summary: typeof rawAutoGenerated.summary === 'object' ? (rawAutoGenerated.summary.en || rawAutoGenerated.summary.ko || '') : (rawAutoGenerated.summary || ''),
    hashtags: (rawAutoGenerated.hashtags || []).map(h => typeof h === 'object' ? (h.displayTag || h.tag || '') : h).filter(Boolean),
    sentiment: rawAutoGenerated.sentiment || { positiveRatio: 0, negativeRatio: 0 },
  };

  // Claude AI 분석 결과 (저장된 insights)
  const insights = claudeReviewSummarizer.getProductInsights(productCode);

  // AI 분석 상태
  const aiStatus = claudeReviewSummarizer.getAnalysisStatus();

  res.json({
    ok: true,
    data: {
      override,
      autoGenerated,
      insights,
      aiStatus,
      approvedReviewCount: approvedReviews.length,
    },
    message: 'Summary override data retrieved'
  });
});

// 수동 편집 저장
app.put('/datepalm-bay/api/admin/sns-reviews/:productCode/summary-override', (req, res) => {
  const { productCode } = req.params;
  const { summary, hashtags, sentiment, direction } = req.body;

  console.log(`📝 Admin: Saving summary override for ${productCode}`);

  // summary 또는 direction 중 하나는 있어야 함
  if ((!summary || typeof summary !== 'string') && !direction) {
    return res.status(400).json({ ok: false, message: 'summary or direction is required' });
  }

  // 기존 오버라이드 찾기
  const existingIdx = snsReviewOverrides.findIndex(o => o.productCode === productCode);

  // 피드백 기록 (기존 자동생성 → 수정본)
  const approvedReviews = snsReviews.filter(r =>
    r.status === 'APPROVED' &&
    r.matchedProducts.some(m => m.productCode === productCode)
  );
  const autoGenerated = reviewSummarizer.summarizeReviews(approvedReviews);
  if (autoGenerated && autoGenerated.summary) {
    const originalSummary = existingIdx >= 0
      ? snsReviewOverrides[existingIdx].summary
      : autoGenerated.summary;
    claudeReviewSummarizer.recordFeedback(productCode, originalSummary, summary);
  }

  // 기존 데이터 보존하면서 업데이트
  const existingData = existingIdx >= 0 ? snsReviewOverrides[existingIdx] : {};
  const overrideData = {
    ...existingData,
    productCode,
    summary: summary || existingData.summary || '',
    hashtags: hashtags || existingData.hashtags || [],
    sentiment: sentiment || existingData.sentiment || null,
    direction: direction !== undefined ? direction : (existingData.direction || ''),
    updatedAt: new Date().toISOString(),
  };

  if (existingIdx >= 0) {
    snsReviewOverrides[existingIdx] = overrideData;
  } else {
    snsReviewOverrides.push(overrideData);
  }

  saveData();

  res.json({
    ok: true,
    data: overrideData,
    message: 'Summary override saved successfully'
  });
});

// 오버라이드 삭제 (자동생성 복원)
app.delete('/datepalm-bay/api/admin/sns-reviews/:productCode/summary-override', (req, res) => {
  const { productCode } = req.params;

  console.log(`📝 Admin: Deleting summary override for ${productCode}`);

  const idx = snsReviewOverrides.findIndex(o => o.productCode === productCode);
  if (idx >= 0) {
    snsReviewOverrides.splice(idx, 1);
    saveData();
  }

  res.json({
    ok: true,
    message: 'Summary override deleted, auto-generated summary restored'
  });
});

// Claude AI 수동 재분석 트리거
app.post('/datepalm-bay/api/admin/sns-reviews/:productCode/ai-analyze', async (req, res) => {
  const { productCode } = req.params;

  console.log(`🤖 Admin: AI re-analysis triggered for ${productCode}`);

  const approvedReviews = snsReviews.filter(r =>
    r.status === 'APPROVED' &&
    r.matchedProducts.some(m => m.productCode === productCode)
  );

  if (approvedReviews.length === 0) {
    return res.json({
      ok: false,
      message: 'No approved reviews to analyze'
    });
  }

  // 상품명 찾기
  const product = products.find(p => p.productCode === productCode);
  const productName = product ? product.productName : productCode;

  try {
    const result = await claudeReviewSummarizer.triggerReanalysis(productCode, approvedReviews, productName);
    console.log(`🤖 AI re-analysis result:`, JSON.stringify(result).substring(0, 200));

    res.json({
      ok: result.success,
      data: result.data || null,
      message: result.message || (result.success ? 'AI re-analysis completed' : 'AI re-analysis failed')
    });
  } catch (error) {
    console.error(`❌ AI re-analysis error:`, error);
    res.status(500).json({
      ok: false,
      data: null,
      message: `AI re-analysis failed: ${error.message}`
    });
  }
});

// AI 분석 상태 조회
app.get('/datepalm-bay/api/admin/sns-reviews/ai-status', (req, res) => {
  res.json({
    ok: true,
    data: claudeReviewSummarizer.getAnalysisStatus(),
    message: 'AI analysis status retrieved'
  });
});

// YouTube 비디오 ID 추출 헬퍼 함수
function extractYouTubeVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/,
    /youtube\.com\/embed\/([^&\n?#]+)/,
    /youtube\.com\/v\/([^&\n?#]+)/,
    /youtube\.com\/shorts\/([^&\n?#]+)/
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// ========================================
// 결제 API
// ========================================

// 주문 목록 저장소 (startServer()에서 MySQL/JSON으로부터 로드)
let customerOrders = [];

// 주문 생성 API (주문 정보만 저장, PayPal 결제는 별도)
app.post('/datepalm-bay/api/mvp/order/create', async (req, res) => {
  console.log('\n=== [Payment] 주문 생성 ===');
  const orderData = req.body.data || req.body;

  console.log('주문 데이터:', orderData);

  const {
    productCode,
    quantity,
    orderType,
    teamId,
    ordererName,
    ordererContact,
    ordererEmail,
    recipientName,
    recipientContact,
    postalCode,
    address,
    detailAddress,
    deliveryMemo,
    currency = 'USD',
    // 번들 주문 필드
    isBundleOrder,
    bundleItems,
    totalAmount,
    shippingCost,
    couponCode,
    couponDiscount,
    selectedOptions
  } = orderData;

  // 주문 ID 생성
  const orderId = `ORDER-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

  let amount;
  let orderName;

  // 번들 주문인 경우
  if (isBundleOrder && bundleItems && bundleItems.length > 0) {
    // 프론트엔드에서 계산한 총액 사용
    amount = totalAmount || bundleItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);

    // 쿠폰 할인 적용
    if (couponDiscount) {
      amount = amount - couponDiscount;
    }

    // 배송비 추가 (이미 totalAmount에 포함되어 있으면 중복 추가 안함)
    // totalAmount가 있으면 이미 배송비가 포함되어 있음

    orderName = bundleItems.length > 1
      ? `Bundle Order (${bundleItems.length} items)`
      : products.find(p => p.productCode === bundleItems[0].productCode)?.productName || 'Product';

    console.log(`📦 번들 주문: ${bundleItems.length}개 상품`);
    console.log(`  총액: $${amount}`);
    console.log(`  쿠폰 할인: $${couponDiscount || 0}`);
    console.log(`  배송비: $${shippingCost || 0}`);
  } else {
    // 단일 상품 주문
    const product = products.find(p => p.productCode === productCode);
    if (!product) {
      return res.status(404).json({
        ok: false,
        data: null,
        message: 'Product not found'
      });
    }

    // 금액 계산 (USD 기준 - 국제 결제용)
    const priceUSD = product.productPriceUSD || product.productPrice;
    amount = priceUSD * quantity;

    // 쿠폰 할인 적용
    if (couponDiscount) {
      amount = amount - couponDiscount;
    }

    // 배송비 추가
    if (shippingCost) {
      amount = amount + shippingCost;
    }

    orderName = quantity > 1
      ? `${product.productName} and ${quantity - 1} more`
      : product.productName;
  }

  // 금액이 0 이하가 되지 않도록
  amount = Math.max(0, amount);

  // 주문 정보 저장
  const newOrder = {
    orderId,
    productCode: isBundleOrder ? bundleItems.map(i => i.productCode).join(',') : productCode,
    productName: orderName,
    quantity: isBundleOrder ? bundleItems.reduce((sum, i) => sum + i.quantity, 0) : quantity,
    amount,
    currency,
    orderType: orderType || 'NORMAL',
    teamId: teamId || null,
    ordererName,
    ordererContact,
    ordererEmail,
    recipientName,
    recipientContact,
    postalCode,
    address,
    detailAddress,
    deliveryMemo,
    isBundleOrder: isBundleOrder || false,
    bundleItems: isBundleOrder ? bundleItems : null,
    couponCode: couponCode || null,
    couponDiscount: couponDiscount || 0,
    selectedOptions: selectedOptions || [],
    shippingCost: shippingCost || 0,
    status: 'PENDING',
    paypalOrderId: null,
    captureId: null,
    paymentMethod: null,
    approvedAt: null,
    // FedEx 물류 필드
    fedexTrackingNumber: null,
    fedexLabelBase64: null,
    fedexServiceType: null,
    fedexEstimatedDelivery: null,
    fedexShippedAt: null,
    fedexPickupConfirmation: null,
    fedexPickupDate: null,
    fedexPickupTime: null,
    fedexTradeDocuments: [],
    // Aramex 물류 필드
    aramexTrackingNumber: null,
    aramexShipmentId: null,
    aramexLabelUrl: null,
    aramexServiceType: null,
    aramexShippedAt: null,
    aramexPickupId: null,
    aramexPickupDate: null,
    courier: null,
    createdAt: new Date().toISOString()
  };

  customerOrders.push(newOrder);
  saveData();

  console.log(`✅ 주문 생성 완료: ${orderId}`);
  console.log(`  상품: ${orderName}`);
  console.log(`  수량: ${newOrder.quantity}`);
  console.log(`  금액: $${amount.toFixed(2)} ${currency}`);

  res.json({
    ok: true,
    data: {
      orderId,
      amount,
      currency,
      orderName
    },
    message: 'Order created successfully'
  });
});

// PayPal 주문 생성 API
app.post('/datepalm-bay/api/mvp/paypal/create-order', async (req, res) => {
  console.log('\n=== [PayPal] 결제 주문 생성 ===');
  const { orderId } = req.body.data || req.body;

  // 주문 조회
  const order = customerOrders.find(o => o.orderId === orderId);
  if (!order) {
    return res.status(404).json({
      ok: false,
      data: null,
      message: 'Order not found'
    });
  }

  try {
    // PayPal 주문 생성
    const paypalOrder = await paypalService.createOrder({
      orderId: order.orderId,
      amount: order.amount,
      orderName: order.productName,
      currency: order.currency || 'USD'
    });

    // PayPal 주문 ID 저장
    order.paypalOrderId = paypalOrder.id;

    console.log(`✅ PayPal 주문 생성: ${paypalOrder.id}`);

    res.json({
      ok: true,
      data: {
        paypalOrderId: paypalOrder.id
      },
      message: 'PayPal order created'
    });
  } catch (error) {
    console.error('PayPal create order error:', error);
    res.status(500).json({
      ok: false,
      data: null,
      message: error.message || 'Failed to create PayPal order'
    });
  }
});

// PayPal 결제 승인(Capture) API
app.post('/datepalm-bay/api/mvp/paypal/capture-order', async (req, res) => {
  console.log('\n=== [PayPal] 결제 승인 ===');
  const { paypalOrderId } = req.body.data || req.body;

  console.log(`  PayPal Order ID: ${paypalOrderId}`);

  // 주문 조회
  const order = customerOrders.find(o => o.paypalOrderId === paypalOrderId);
  if (!order) {
    return res.status(404).json({
      ok: false,
      data: null,
      message: 'Order not found'
    });
  }

  try {
    // PayPal 결제 승인
    const captureResult = await paypalService.captureOrder(paypalOrderId);

    // 주문 상태 업데이트
    order.status = 'SUCCESS';
    order.paymentMethod = 'PAYPAL';
    order.captureId = captureResult.purchase_units?.[0]?.payments?.captures?.[0]?.id;
    order.approvedAt = new Date().toISOString();
    saveData();

    console.log(`✅ PayPal 결제 완료: ${order.orderId}`);

    res.json({
      ok: true,
      data: {
        orderId: order.orderId,
        status: order.status,
        captureId: order.captureId,
        paymentMethod: order.paymentMethod,
        approvedAt: order.approvedAt
      },
      message: 'Payment captured successfully'
    });
  } catch (error) {
    console.error('PayPal capture error:', error);
    res.status(500).json({
      ok: false,
      data: null,
      message: error.message || 'Failed to capture PayPal payment'
    });
  }
});

// PayPal 주문 상태 조회 API
app.get('/datepalm-bay/api/mvp/paypal/order/:orderId', async (req, res) => {
  console.log('\n=== [PayPal] 주문 상태 조회 ===');
  const { orderId } = req.params;

  const order = customerOrders.find(o => o.orderId === orderId);
  if (!order) {
    return res.status(404).json({
      ok: false,
      data: null,
      message: 'Order not found'
    });
  }

  try {
    if (order.paypalOrderId) {
      const paypalOrder = await paypalService.getOrder(order.paypalOrderId);
      res.json({
        ok: true,
        data: {
          orderId: order.orderId,
          status: order.status,
          paypalStatus: paypalOrder.status,
          amount: order.amount,
          currency: order.currency
        },
        message: 'Order retrieved'
      });
    } else {
      res.json({
        ok: true,
        data: {
          orderId: order.orderId,
          status: order.status,
          amount: order.amount,
          currency: order.currency
        },
        message: 'Order retrieved (no PayPal order yet)'
      });
    }
  } catch (error) {
    res.status(500).json({
      ok: false,
      data: null,
      message: error.message
    });
  }
});

// 결제 환불 API (PayPal)
app.post('/datepalm-bay/api/mvp/payment/refund', async (req, res) => {
  console.log('\n=== [Payment] 환불 요청 ===');
  const { paymentCode, refundContext } = req.body.data || req.body;

  console.log(`  paymentCode: ${paymentCode}`);
  console.log(`  refundContext: ${refundContext}`);

  // 주문 조회
  const order = customerOrders.find(o => o.orderId === paymentCode);
  if (!order) {
    return res.status(404).json({
      ok: false,
      data: null,
      message: 'Order not found'
    });
  }

  if (!order.captureId) {
    return res.status(400).json({
      ok: false,
      data: null,
      message: 'Payment not found for this order'
    });
  }

  try {
    // PayPal 환불 호출
    await paypalService.refundPayment(order.captureId, {
      note_to_payer: refundContext || 'Refund for your order'
    });

    order.status = 'REFUNDED';
    saveData();

    console.log(`✅ 환불 완료: ${paymentCode}`);

    res.json({
      ok: true,
      data: 'Refund processed successfully',
      message: 'Refund processed successfully'
    });
  } catch (error) {
    console.log(`❌ 환불 실패: ${error.message}`);

    res.status(400).json({
      ok: false,
      data: null,
      message: error.message || 'Refund failed'
    });
  }
});

// 주문 내역 조회 API
app.get('/datepalm-bay/api/mvp/orders', (req, res) => {
  console.log('\n=== [Payment] 주문 내역 조회 ===');

  // TODO: 실제 구현에서는 인증된 사용자의 주문만 조회
  const paidOrders = customerOrders.filter(o => o.status === 'SUCCESS' || o.status === 'REFUNDED');

  res.json({
    ok: true,
    data: paidOrders,
    message: 'Orders retrieved successfully'
  });
});

// ======================================
// Frontend - Customer Order History
// ======================================

function mapOrderStatus(serverStatus, order) {
  if (order.courier === 'FEDEX' && order.fedexTrackingNumber && serverStatus === 'SUCCESS') return 'DELIVERY';
  if (serverStatus === 'DELIVERY') return 'DELIVERY';
  if (serverStatus === 'DELIVERED') return 'DELIVERED';
  if (serverStatus === 'SUCCESS') return 'SUCCESS';
  if (serverStatus === 'REFUNDED') return 'CANCEL';
  return 'PROCESSING';
}

function mapPaymentStatus(serverStatus) {
  if (['SUCCESS', 'DELIVERY', 'DELIVERED'].includes(serverStatus)) return 'SUCCESS';
  if (serverStatus === 'REFUNDED') return 'REFUND';
  return 'PROCESS';
}

// Customer - Order History List
app.get('/datepalm-bay/api/mvp/order/history', (req, res) => {
  console.log('\n=== [Customer] 주문 내역 조회 ===');

  const visibleStatuses = ['SUCCESS', 'DELIVERY', 'DELIVERED', 'REFUNDED'];
  const visibleOrders = customerOrders.filter(o => visibleStatuses.includes(o.status));

  const content = visibleOrders.map(o => {
    const product = products.find(p => p.productCode === o.productCode);
    const thumbnail = product?.files?.mainImages?.[0]?.url || '';
    return {
      thumbnail,
      orderCode: o.orderId,
      productName: o.productName,
      orderStatus: mapOrderStatus(o.status, o),
      orderAt: o.approvedAt || o.createdAt,
      paymentAmount: o.amount || 0,
    };
  }).sort((a, b) => new Date(b.orderAt) - new Date(a.orderAt));

  console.log(`총 ${content.length}개 주문 반환`);

  res.json({ ok: true, data: content, message: 'Order history retrieved' });
});

// Customer - Order Detail
app.get('/datepalm-bay/api/mvp/order/detail/:code', (req, res) => {
  console.log(`\n=== [Customer] 주문 상세 조회: ${req.params.code} ===`);

  const order = customerOrders.find(o => o.orderId === req.params.code);
  if (!order) {
    return res.status(404).json({ ok: false, data: null, message: 'Order not found' });
  }

  const product = products.find(p => p.productCode === order.productCode);
  const imageUrl = product?.files?.mainImages?.[0]?.url || '';
  const orderStatus = mapOrderStatus(order.status, order);

  res.json({
    ok: true,
    data: {
      orderInfo: {
        orderStatus,
        imageUrl,
        orderCode: order.orderId,
        productCode: order.productCode,
        productName: order.productName,
        quantity: order.quantity,
        orderAmount: order.amount,
        ordererName: order.ordererName,
        ordererContact: order.ordererContact,
        orderEmail: order.ordererEmail || '',
      },
      deliveryInfo: {
        recipientName: order.recipientName,
        recipientPhone: order.recipientContact,
        address: [order.address, order.detailAddress].filter(Boolean).join(' '),
        deliveryMemo: order.deliveryMemo || '',
        courier: order.courier || '',
        invoiceNum: order.fedexTrackingNumber || '',
        orderStatus,
        fedexTrackingNumber: order.fedexTrackingNumber || null,
        fedexServiceType: order.fedexServiceType || null,
        fedexEstimatedDelivery: order.fedexEstimatedDelivery || null,
        fedexShippedAt: order.fedexShippedAt || null,
      },
      paymentInfo: {
        paymentCode: order.orderId,
        paymentStatus: mapPaymentStatus(order.status),
        paymentType: order.paymentMethod || 'PAYPAL',
        paymentApprovedAt: order.approvedAt || order.createdAt,
        paymentAmount: order.amount || 0,
      },
    },
    message: 'Order detail retrieved',
  });
});

// Customer - Order Status Count
app.get('/datepalm-bay/api/mvp/order/status-count', (req, res) => {
  console.log('\n=== [Customer] 주문 상태 카운트 ===');

  const orders = customerOrders.filter(o => ['SUCCESS', 'DELIVERY', 'DELIVERED'].includes(o.status));

  res.json({
    ok: true,
    data: {
      orderCompleted: orders.filter(o => o.status === 'SUCCESS').length,
      shipping: orders.filter(o => o.status === 'DELIVERY').length,
      delivered: orders.filter(o => o.status === 'DELIVERED').length,
      purchaseConfirmed: 0,
    },
    message: 'Status count retrieved',
  });
});

// ======================================
// Admin - Coupon Management
// ======================================

// Admin - Coupon List
app.get('/datepalm-bay/api/admin/coupon/list', (req, res) => {
  console.log('\n=== [Admin] Coupon List ===');
  const pageNo = parseInt(req.query.pageNo) || 0;
  const pageSize = parseInt(req.query.pageSize) || 10;
  const { status, keyword } = req.query;

  // Update coupon statuses based on current date
  const now = new Date();
  coupons.forEach(coupon => {
    const endDate = new Date(coupon.endDate);
    if (now > endDate && coupon.status !== 'INACTIVE') {
      coupon.status = 'EXPIRED';
    }
  });

  let filteredCoupons = [...coupons];

  // Filter by status
  if (status) {
    filteredCoupons = filteredCoupons.filter(c => c.status === status);
  }

  // Filter by keyword
  if (keyword) {
    filteredCoupons = filteredCoupons.filter(c =>
      c.name.toLowerCase().includes(keyword.toLowerCase()) ||
      c.code.toLowerCase().includes(keyword.toLowerCase())
    );
  }

  // Sort by createdAt (newest first)
  filteredCoupons.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const start = pageNo * pageSize;
  const end = start + pageSize;
  const paginatedCoupons = filteredCoupons.slice(start, end);

  res.json({
    ok: true,
    data: {
      content: paginatedCoupons,
      pageable: {
        pageNumber: pageNo,
        pageSize: pageSize
      },
      totalElements: filteredCoupons.length,
      totalPages: Math.ceil(filteredCoupons.length / pageSize),
      size: pageSize,
      number: pageNo,
      first: pageNo === 0,
      last: pageNo >= Math.floor(filteredCoupons.length / pageSize),
      numberOfElements: paginatedCoupons.length
    },
    message: 'Admin coupon list retrieved successfully'
  });
});

// Admin - Coupon Detail
app.get('/datepalm-bay/api/admin/coupon/detail/:code', (req, res) => {
  console.log('\n=== [Admin] Coupon Detail ===');
  const { code } = req.params;

  const coupon = coupons.find(c => c.code === code);

  if (!coupon) {
    return res.status(404).json({
      ok: false,
      data: null,
      message: 'Coupon not found'
    });
  }

  // Update status
  const now = new Date();
  const endDate = new Date(coupon.endDate);
  if (now > endDate && coupon.status !== 'INACTIVE') {
    coupon.status = 'EXPIRED';
  }

  res.json({
    ok: true,
    data: coupon,
    message: 'Coupon detail retrieved successfully'
  });
});

// Admin - Create Coupon
app.post('/datepalm-bay/api/admin/coupon/create', express.json(), (req, res) => {
  console.log('\n=== [Admin] Create Coupon ===');

  const requestData = req.body;
  const code = `CPN-${Date.now()}`;

  const newCoupon = {
    code,
    name: requestData.name,
    description: requestData.description || '',
    discountType: requestData.discountType,
    discountValue: requestData.discountValue,
    minOrderAmount: requestData.minOrderAmount || 0,
    maxDiscountAmount: requestData.maxDiscountAmount || null,
    startDate: requestData.startDate,
    endDate: requestData.endDate,
    status: 'ACTIVE',
    usageCount: 0,
    usageLimit: requestData.usageLimit || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  coupons.push(newCoupon);

  console.log(`Coupon created: ${code}`);
  saveData();

  res.json({
    ok: true,
    data: newCoupon,
    message: 'Coupon created successfully'
  });
});

// Admin - Edit Coupon
app.put('/datepalm-bay/api/admin/coupon/edit', express.json(), (req, res) => {
  console.log('\n=== [Admin] Edit Coupon ===');

  const requestData = req.body;
  const couponIndex = coupons.findIndex(c => c.code === requestData.code);

  if (couponIndex === -1) {
    return res.status(404).json({
      ok: false,
      data: null,
      message: 'Coupon not found'
    });
  }

  const existingCoupon = coupons[couponIndex];

  coupons[couponIndex] = {
    ...existingCoupon,
    name: requestData.name,
    description: requestData.description || '',
    discountType: requestData.discountType,
    discountValue: requestData.discountValue,
    minOrderAmount: requestData.minOrderAmount || 0,
    maxDiscountAmount: requestData.maxDiscountAmount || null,
    startDate: requestData.startDate,
    endDate: requestData.endDate,
    status: requestData.status || existingCoupon.status,
    usageLimit: requestData.usageLimit || null,
    updatedAt: new Date().toISOString()
  };

  console.log(`Coupon updated: ${requestData.code}`);
  saveData();

  res.json({
    ok: true,
    data: coupons[couponIndex],
    message: 'Coupon updated successfully'
  });
});

// Admin - Delete Coupon
app.delete('/datepalm-bay/api/admin/coupon/delete/:code', (req, res) => {
  console.log('\n=== [Admin] Delete Coupon ===');
  const { code } = req.params;

  const couponIndex = coupons.findIndex(c => c.code === code);

  if (couponIndex === -1) {
    return res.status(404).json({
      ok: false,
      data: null,
      message: 'Coupon not found'
    });
  }

  coupons.splice(couponIndex, 1);

  console.log(`Coupon deleted: ${code}`);
  saveData();

  res.json({
    ok: true,
    data: null,
    message: 'Coupon deleted successfully'
  });
});

// Frontend - Get Available Coupons (for product page)
app.get('/datepalm-bay/api/mvp/coupons/available', (req, res) => {
  console.log('\n=== [Frontend] Available Coupons ===');

  const now = new Date();
  const availableCoupons = coupons.filter(coupon => {
    const startDate = new Date(coupon.startDate);
    const endDate = new Date(coupon.endDate);
    return coupon.status === 'ACTIVE' && now >= startDate && now <= endDate;
  });

  res.json({
    ok: true,
    data: availableCoupons.map(c => ({
      code: c.code,
      name: c.name,
      description: c.description,
      discountType: c.discountType,
      discountValue: c.discountValue,
      minOrderAmount: c.minOrderAmount,
      maxDiscountAmount: c.maxDiscountAmount,
      endDate: c.endDate
    })),
    message: 'Available coupons retrieved successfully'
  });
});

// ======================================
// Frontend - Coupon Center APIs (서버 저장 방식)
// ======================================

// 토큰에서 userId 추출 함수
// 토큰 형식: mock-token-{userId}-{timestamp}
function extractUserIdFromToken(token) {
  if (!token) return null;

  // mock-token-{userId}-{timestamp} 형식 처리
  if (token.startsWith('mock-token-')) {
    const parts = token.split('-');
    // parts: ['mock', 'token', '{userId}', '{timestamp}']
    if (parts.length >= 4) {
      // userId가 여러 단어인 경우 (예: USER-001) 처리
      // mock-token-USER-001-1234567890 → parts = ['mock', 'token', 'USER', '001', '1234567890']
      // 마지막은 timestamp이므로 제외하고 3번째부터 합침
      const userIdParts = parts.slice(2, -1);
      return userIdParts.join('-');
    }
  }

  // 다른 형식은 그대로 반환
  return token;
}

// 유저의 쿠폰 자격 조건 확인 함수
function checkCouponEligibility(user, coupon) {
  const condition = coupon.targetCondition || {};
  const now = new Date();

  // 조건이 없으면 모든 회원 가능
  if (Object.keys(condition).length === 0) {
    return { eligible: true };
  }

  // 회원 등급 조건
  if (condition.memberLevels && condition.memberLevels.length > 0) {
    if (!condition.memberLevels.includes(user.memberLevel)) {
      return { eligible: false, reason: `${condition.memberLevels.join(' or ')} members only` };
    }
  }

  // 신규 회원 조건
  if (condition.newMemberOnly) {
    const createdAt = new Date(user.createAt);
    const daysSinceJoin = Math.floor((now - createdAt) / (1000 * 60 * 60 * 24));
    const maxDays = condition.newMemberDays || 30;
    if (daysSinceJoin > maxDays) {
      return { eligible: false, reason: `New members only (within ${maxDays} days)` };
    }
  }

  // 휴면 회원 조건 (N일 이상 미구매)
  if (condition.dormantDays) {
    if (!user.lastPurchaseDate) {
      // 구매 이력이 없으면 휴면 조건 충족
    } else {
      const lastPurchase = new Date(user.lastPurchaseDate);
      const daysSincePurchase = Math.floor((now - lastPurchase) / (1000 * 60 * 60 * 24));
      if (daysSincePurchase < condition.dormantDays) {
        return { eligible: false, reason: `For customers who haven't purchased in ${condition.dormantDays}+ days` };
      }
    }
  }

  // 최소 구매 횟수 조건
  if (condition.minPurchaseCount !== undefined) {
    if (condition.minPurchaseCount === 0) {
      // 첫 구매 쿠폰: 구매 이력이 없어야 함
      if (user.totalPurchaseCount > 0) {
        return { eligible: false, reason: 'First purchase only' };
      }
    } else if (user.totalPurchaseCount < condition.minPurchaseCount) {
      return { eligible: false, reason: `Requires ${condition.minPurchaseCount}+ purchases` };
    }
  }

  // 최소 누적 구매금액 조건
  if (condition.minTotalPurchaseAmount) {
    if (user.totalPurchaseAmount < condition.minTotalPurchaseAmount) {
      return { eligible: false, reason: `Requires $${condition.minTotalPurchaseAmount}+ total purchases` };
    }
  }

  // 생일 월 조건
  if (condition.birthdayMonth) {
    const currentMonth = now.getMonth() + 1; // JavaScript months are 0-indexed
    if (user.birthMonth !== currentMonth) {
      return { eligible: false, reason: 'Birthday month only' };
    }
  }

  return { eligible: true };
}

// Frontend - 다운로드 가능한 쿠폰 목록 (자격 조건 필터링)
app.get('/datepalm-bay/api/mvp/coupons/downloadable', (req, res) => {
  console.log('\n=== [Frontend] Downloadable Coupons ===');

  // Authorization 헤더에서 userId 추출 (간단한 Mock 인증)
  const authHeader = req.headers.authorization;
  let userId = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    userId = extractUserIdFromToken(token);
    console.log(`Token: ${token} -> Extracted userId: ${userId}`);
  }

  if (!userId) {
    console.log('No userId found - returning 401');
    return res.status(401).json({
      ok: false,
      data: null,
      message: 'Authentication required'
    });
  }

  const user = users.find(u => u.code === userId || u.id === userId);
  if (!user) {
    console.log(`User not found for userId: ${userId}`);
    return res.status(404).json({
      ok: false,
      data: null,
      message: 'User not found'
    });
  }

  console.log(`User found: ${user.name} (${user.memberLevel}, id: ${user.id}, code: ${user.code})`);

  const now = new Date();

  // 다운로드 가능한 쿠폰 필터링
  const downloadableCoupons = coupons.filter(coupon => {
    // 기본 조건: ACTIVE + 유효기간 내 + isDownloadable
    const startDate = new Date(coupon.startDate);
    const endDate = new Date(coupon.endDate);
    if (coupon.status !== 'ACTIVE' || now < startDate || now > endDate) {
      return false;
    }
    if (!coupon.isDownloadable) {
      return false;
    }

    // 이미 다운로드한 쿠폰 제외
    const alreadyDownloaded = userCoupons.some(
      uc => uc.userId === user.code && uc.couponCode === coupon.code
    );
    if (alreadyDownloaded) {
      return false;
    }

    // 자격 조건 확인
    const eligibility = checkCouponEligibility(user, coupon);
    return eligibility.eligible;
  });

  console.log(`Found ${downloadableCoupons.length} downloadable coupons for user`);

  res.json({
    ok: true,
    data: downloadableCoupons.map(c => ({
      code: c.code,
      name: c.name,
      description: c.description,
      couponType: c.couponType,
      discountType: c.discountType,
      discountValue: c.discountValue,
      minOrderAmount: c.minOrderAmount,
      maxDiscountAmount: c.maxDiscountAmount,
      startDate: c.startDate,
      endDate: c.endDate,
      applicableCategories: c.applicableCategories,
      stackable: c.stackable
    })),
    message: 'Downloadable coupons retrieved successfully'
  });
});

// Frontend - 쿠폰 다운로드
app.post('/datepalm-bay/api/mvp/coupons/download/:code', (req, res) => {
  console.log('\n=== [Frontend] Download Coupon ===');

  const { code } = req.params;
  const authHeader = req.headers.authorization;
  let userId = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    userId = extractUserIdFromToken(token);
  }

  if (!userId) {
    return res.status(401).json({
      ok: false,
      data: null,
      message: 'Authentication required'
    });
  }

  const user = users.find(u => u.code === userId || u.id === userId);
  if (!user) {
    return res.status(404).json({
      ok: false,
      data: null,
      message: 'User not found'
    });
  }

  const coupon = coupons.find(c => c.code === code);
  if (!coupon) {
    return res.status(404).json({
      ok: false,
      data: null,
      message: 'Coupon not found'
    });
  }

  // 이미 다운로드 여부 확인
  const alreadyDownloaded = userCoupons.some(
    uc => uc.userId === user.code && uc.couponCode === coupon.code
  );
  if (alreadyDownloaded) {
    return res.status(400).json({
      ok: false,
      data: null,
      message: 'Coupon already downloaded'
    });
  }

  // 자격 조건 확인
  const eligibility = checkCouponEligibility(user, coupon);
  if (!eligibility.eligible) {
    return res.status(403).json({
      ok: false,
      data: null,
      message: `Not eligible: ${eligibility.reason}`
    });
  }

  // 쿠폰 다운로드 저장
  const newUserCoupon = {
    id: `UC-${Date.now()}`,
    userId: user.code,
    couponCode: coupon.code,
    downloadedAt: new Date().toISOString(),
    usedAt: null,
    usedOrderCode: null
  };
  userCoupons.push(newUserCoupon);

  console.log(`Coupon ${code} downloaded by user ${user.name}`);
  saveData();

  res.json({
    ok: true,
    data: {
      code: coupon.code,
      name: coupon.name,
      description: coupon.description,
      couponType: coupon.couponType,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      minOrderAmount: coupon.minOrderAmount,
      maxDiscountAmount: coupon.maxDiscountAmount,
      endDate: coupon.endDate,
      downloadedAt: newUserCoupon.downloadedAt
    },
    message: 'Coupon downloaded successfully'
  });
});

// Frontend - 내 쿠폰 목록
app.get('/datepalm-bay/api/mvp/coupons/my', (req, res) => {
  console.log('\n=== [Frontend] My Coupons ===');

  const authHeader = req.headers.authorization;
  let userId = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    userId = extractUserIdFromToken(token);
    console.log(`Token: ${token} -> Extracted userId: ${userId}`);
  }

  if (!userId) {
    console.log('No userId found - returning 401');
    return res.status(401).json({
      ok: false,
      data: null,
      message: 'Authentication required'
    });
  }

  const user = users.find(u => u.code === userId || u.id === userId);
  if (!user) {
    console.log(`User not found for userId: ${userId}`);
    return res.status(404).json({
      ok: false,
      data: null,
      message: 'User not found'
    });
  }

  console.log(`User found: ${user.name} (id: ${user.id}, code: ${user.code})`);

  // 유저의 쿠폰 목록
  const myUserCoupons = userCoupons.filter(uc => uc.userId === user.code);
  console.log(`Found ${myUserCoupons.length} coupons for user (searching by code: ${user.code})`);

  const now = new Date();
  const myCoupons = myUserCoupons.map(uc => {
    const coupon = coupons.find(c => c.code === uc.couponCode);
    if (!coupon) return null;

    // 상태 결정
    let status = 'USABLE';
    if (uc.usedAt) {
      status = 'USED';
    } else if (new Date(coupon.endDate) < now) {
      status = 'EXPIRED';
    }

    return {
      code: coupon.code,
      name: coupon.name,
      description: coupon.description,
      couponType: coupon.couponType,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      minOrderAmount: coupon.minOrderAmount,
      maxDiscountAmount: coupon.maxDiscountAmount,
      startDate: coupon.startDate,
      endDate: coupon.endDate,
      applicableCategories: coupon.applicableCategories,
      stackable: coupon.stackable,
      downloadedAt: uc.downloadedAt,
      usedAt: uc.usedAt,
      usedOrderCode: uc.usedOrderCode,
      status
    };
  }).filter(Boolean);

  // 상태별 분류
  const usableCoupons = myCoupons.filter(c => c.status === 'USABLE');
  const usedCoupons = myCoupons.filter(c => c.status === 'USED');
  const expiredCoupons = myCoupons.filter(c => c.status === 'EXPIRED');

  console.log(`User ${user.name}: ${usableCoupons.length} usable, ${usedCoupons.length} used, ${expiredCoupons.length} expired`);

  res.json({
    ok: true,
    data: {
      all: myCoupons,
      usable: usableCoupons,
      used: usedCoupons,
      expired: expiredCoupons,
      summary: {
        total: myCoupons.length,
        usable: usableCoupons.length,
        used: usedCoupons.length,
        expired: expiredCoupons.length
      }
    },
    message: 'My coupons retrieved successfully'
  });
});

// Frontend - 쿠폰 사용
app.post('/datepalm-bay/api/mvp/coupons/use/:code', (req, res) => {
  console.log('\n=== [Frontend] Use Coupon ===');

  const { code } = req.params;
  const { orderCode, orderAmount } = req.body;

  const authHeader = req.headers.authorization;
  let userId = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    userId = extractUserIdFromToken(token);
  }

  if (!userId) {
    return res.status(401).json({
      ok: false,
      data: null,
      message: 'Authentication required'
    });
  }

  const user = users.find(u => u.code === userId || u.id === userId);
  if (!user) {
    return res.status(404).json({
      ok: false,
      data: null,
      message: 'User not found'
    });
  }

  // 유저 쿠폰 찾기
  const userCouponIndex = userCoupons.findIndex(
    uc => uc.userId === user.code && uc.couponCode === code
  );

  if (userCouponIndex === -1) {
    return res.status(404).json({
      ok: false,
      data: null,
      message: 'Coupon not found in your coupon box'
    });
  }

  const userCoupon = userCoupons[userCouponIndex];

  // 이미 사용한 쿠폰 확인
  if (userCoupon.usedAt) {
    return res.status(400).json({
      ok: false,
      data: null,
      message: 'Coupon already used'
    });
  }

  const coupon = coupons.find(c => c.code === code);
  if (!coupon) {
    return res.status(404).json({
      ok: false,
      data: null,
      message: 'Coupon not found'
    });
  }

  // 만료 확인
  const now = new Date();
  if (new Date(coupon.endDate) < now) {
    return res.status(400).json({
      ok: false,
      data: null,
      message: 'Coupon has expired'
    });
  }

  // 최소 주문금액 확인
  if (orderAmount && orderAmount < coupon.minOrderAmount) {
    return res.status(400).json({
      ok: false,
      data: null,
      message: `Minimum order amount is $${coupon.minOrderAmount}`
    });
  }

  // 쿠폰 사용 처리
  userCoupons[userCouponIndex] = {
    ...userCoupon,
    usedAt: new Date().toISOString(),
    usedOrderCode: orderCode || null
  };

  // 쿠폰 사용 카운트 증가
  const couponIndex = coupons.findIndex(c => c.code === code);
  if (couponIndex !== -1) {
    coupons[couponIndex].usageCount = (coupons[couponIndex].usageCount || 0) + 1;
  }

  // 할인 금액 계산
  let discountAmount = 0;
  if (orderAmount) {
    if (coupon.discountType === 'PERCENT') {
      discountAmount = Math.floor(orderAmount * coupon.discountValue / 100);
      if (coupon.maxDiscountAmount) {
        discountAmount = Math.min(discountAmount, coupon.maxDiscountAmount);
      }
    } else {
      discountAmount = coupon.discountValue;
    }
  }

  console.log(`Coupon ${code} used by user ${user.name}, discount: $${discountAmount}`);
  saveData();

  res.json({
    ok: true,
    data: {
      couponCode: code,
      discountAmount,
      usedAt: userCoupons[userCouponIndex].usedAt
    },
    message: 'Coupon used successfully'
  });
});

// ======================================
// SKIN OS 성분 분석 API
// ======================================

// GET /datepalm-bay/api/admin/product/:productCode/ingredient-analysis
// 현재 성분 분석 결과 조회 (없으면 result: null)
app.get('/datepalm-bay/api/admin/product/:productCode/ingredient-analysis', (req, res) => {
  console.log('\n=== [SKIN OS] 성분 분석 결과 조회 ===');
  const { productCode } = req.params;
  console.log(`  상품: ${productCode}`);

  const result = skinOS.getAnalysis(productCode);
  if (!result.ok) {
    return res.status(404).json({ ok: false, data: null, message: result.message });
  }

  res.json({ ok: true, data: result.data, message: '성분 분석 결과 조회 성공' });
});

// POST /datepalm-bay/api/admin/product/:productCode/ingredient-analysis/analyze
// Claude AI 성분 분석 실행
app.post('/datepalm-bay/api/admin/product/:productCode/ingredient-analysis/analyze', async (req, res) => {
  console.log('\n=== [SKIN OS] 성분 분석 실행 ===');
  const { productCode } = req.params;
  const { inciText, adminDirection } = req.body;

  console.log(`  상품: ${productCode}`);
  console.log(`  INCI 길이: ${(inciText || '').length}자`);

  if (!inciText || !inciText.trim()) {
    return res.status(400).json({ ok: false, data: null, message: 'INCI 성분 목록이 필요합니다.' });
  }

  const result = await skinOS.analyzeIngredients(productCode, inciText, adminDirection);

  if (!result.ok) {
    return res.status(500).json({ ok: false, data: null, message: result.message, rawResponse: result.rawResponse });
  }

  res.json({ ok: true, data: result.data, message: '성분 분석이 완료되었습니다.' });
});

// PUT /datepalm-bay/api/admin/product/:productCode/ingredient-analysis/override
// Admin 수동 편집 결과 저장
app.put('/datepalm-bay/api/admin/product/:productCode/ingredient-analysis/override', (req, res) => {
  console.log('\n=== [SKIN OS] 수동 편집 저장 ===');
  const { productCode } = req.params;
  const { result, adminDirection } = req.body;

  if (!result) {
    return res.status(400).json({ ok: false, data: null, message: '수정된 분석 결과가 필요합니다.' });
  }

  const saveResult = skinOS.saveOverride(productCode, result, adminDirection);
  if (!saveResult.ok) {
    return res.status(404).json({ ok: false, data: null, message: saveResult.message });
  }

  res.json({ ok: true, data: saveResult.data, message: '수동 편집이 저장되었습니다.' });
});

// DELETE /datepalm-bay/api/admin/product/:productCode/ingredient-analysis/override
// 수동 편집 해제 (isManualOverride: false 복원)
app.delete('/datepalm-bay/api/admin/product/:productCode/ingredient-analysis/override', (req, res) => {
  console.log('\n=== [SKIN OS] 수동 편집 해제 ===');
  const { productCode } = req.params;

  const resetResult = skinOS.resetOverride(productCode);
  if (!resetResult.ok) {
    return res.status(404).json({ ok: false, data: null, message: resetResult.message });
  }

  res.json({ ok: true, data: resetResult.data, message: '수동 편집이 해제되었습니다.' });
});

// GET /datepalm-bay/api/mvp/product/:productCode/ingredient-analysis
// 공개 엔드포인트 — 고객 FE용 (Phase 2)
app.get('/datepalm-bay/api/mvp/product/:productCode/ingredient-analysis', (req, res) => {
  const { productCode } = req.params;
  const result = skinOS.getPublicAnalysis(productCode);

  if (!result.ok) {
    return res.status(404).json({ ok: false, data: null, message: result.message });
  }

  res.json({ ok: true, data: result.data, message: '성분 분석 정보 조회 성공' });
});

// ======================================
// SKIN OS Vision — 피부 분석 API
// ======================================

// POST /datepalm-bay/api/mvp/skin-os/analyze
// 피부 사진 업로드 → Claude Vision 분석
app.post('/datepalm-bay/api/mvp/skin-os/analyze', upload.single('photo'), async (req, res) => {
  console.log('\n=== [SKIN OS Vision] 피부 분석 요청 ===');

  const authHeader = req.headers.authorization;
  let userId = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    userId = extractUserIdFromToken(authHeader.substring(7));
  }

  if (!userId) {
    if (req.file && req.file.path) {
      try { require('fs').unlinkSync(req.file.path); } catch (e) { /* ignore */ }
    }
    return res.status(401).json({ ok: false, data: null, message: '로그인이 필요합니다.' });
  }

  if (!req.file) {
    return res.status(400).json({ ok: false, data: null, message: '사진 파일이 업로드되지 않았습니다.' });
  }

  const consentToStore = req.body.consentToStore === 'true';
  console.log(`  userId: ${userId}, consentToStore: ${consentToStore}`);

  const result = await visionSkin.analyzePhoto(userId, req.file, consentToStore);

  if (!result.ok) {
    return res.status(400).json({ ok: false, data: null, message: result.message });
  }

  res.json({ ok: true, data: result.data, message: '피부 분석이 완료되었습니다.' });
});

// GET /datepalm-bay/api/mvp/skin-os/profile
// 사용자 피부 프로필 조회
app.get('/datepalm-bay/api/mvp/skin-os/profile', (req, res) => {
  console.log('\n=== [SKIN OS Vision] 프로필 조회 ===');

  const authHeader = req.headers.authorization;
  let userId = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    userId = extractUserIdFromToken(authHeader.substring(7));
  }

  if (!userId) {
    return res.status(401).json({ ok: false, data: null, message: '로그인이 필요합니다.' });
  }

  const result = visionSkin.getProfile(userId);
  res.json({ ok: true, data: result.data, message: result.data ? '프로필 조회 성공' : '분석 결과가 없습니다.' });
});

// GET /datepalm-bay/api/mvp/skin-os/recommendations
// 개인화 제품 추천 목록
app.get('/datepalm-bay/api/mvp/skin-os/recommendations', (req, res) => {
  console.log('\n=== [SKIN OS Vision] 제품 추천 조회 ===');

  const authHeader = req.headers.authorization;
  let userId = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    userId = extractUserIdFromToken(authHeader.substring(7));
  }

  if (!userId) {
    return res.status(401).json({ ok: false, data: null, message: '로그인이 필요합니다.' });
  }

  const result = visionSkin.getRecommendations(userId);

  if (!result.ok) {
    return res.status(400).json({ ok: false, data: null, message: result.message });
  }

  res.json({ ok: true, data: result.data, message: `${result.data.length}개 추천 제품` });
});

// GET /datepalm-bay/api/mvp/skin-os/recommendations/:productCode/compatibility
// 단일 제품 호환성 점수 + 근거
app.get('/datepalm-bay/api/mvp/skin-os/recommendations/:productCode/compatibility', (req, res) => {
  const { productCode } = req.params;
  console.log(`\n=== [SKIN OS Vision] 제품 호환성 조회: ${productCode} ===`);

  const authHeader = req.headers.authorization;
  let userId = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    userId = extractUserIdFromToken(authHeader.substring(7));
  }

  if (!userId) {
    return res.status(401).json({ ok: false, data: null, message: '로그인이 필요합니다.' });
  }

  const result = visionSkin.getProductCompatibility(userId, productCode);
  res.json({ ok: true, data: result.data, message: result.data ? '호환성 조회 성공' : '분석 결과가 없습니다.' });
});

// DELETE /datepalm-bay/api/mvp/skin-os/profile
// 피부 프로필 삭제 (GDPR)
app.delete('/datepalm-bay/api/mvp/skin-os/profile', (req, res) => {
  console.log('\n=== [SKIN OS Vision] 프로필 삭제 ===');

  const authHeader = req.headers.authorization;
  let userId = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    userId = extractUserIdFromToken(authHeader.substring(7));
  }

  if (!userId) {
    return res.status(401).json({ ok: false, data: null, message: '로그인이 필요합니다.' });
  }

  const result = visionSkin.deleteProfile(userId);

  if (!result.ok) {
    return res.status(404).json({ ok: false, data: null, message: result.message });
  }

  res.json({ ok: true, data: null, message: '피부 프로필이 삭제되었습니다.' });
});

// ======================================
// FedEx 물류 API
// ======================================

// FedEx 배송비 견적 조회
app.post('/datepalm-bay/api/fedex/rates', async (req, res) => {
  console.log('\n=== [FedEx] 배송비 견적 조회 ===');
  const { recipient, packages, serviceType } = req.body.data || req.body;

  if (!recipient || !packages || !packages.length) {
    return res.status(400).json({
      ok: false,
      data: null,
      message: 'recipient and packages are required'
    });
  }

  console.log(`  수신자: ${recipient.city}, ${recipient.countryCode}`);
  console.log(`  패키지 수: ${packages.length}`);

  try {
    const rates = await fedexService.getRates({ recipient, packages, serviceType });

    console.log(`✅ 배송비 견적 ${rates.length}건 조회 완료`);

    res.json({
      ok: true,
      data: { rates },
      message: 'Rate quotes retrieved successfully'
    });
  } catch (error) {
    console.error('FedEx rates error:', error.message);
    res.status(500).json({
      ok: false,
      data: null,
      message: error.message || 'Failed to get FedEx rate quotes'
    });
  }
});

// FedEx 배송 생성 + 라벨 발급 (Admin)
app.post('/datepalm-bay/api/admin/fedex/create-shipment', async (req, res) => {
  console.log('\n=== [FedEx] 배송 생성 ===');
  const { orderCode, serviceType, packages, labelFormat } = req.body.data || req.body;

  if (!orderCode) {
    return res.status(400).json({
      ok: false,
      data: null,
      message: 'orderCode is required'
    });
  }

  // 주문 조회
  const order = customerOrders.find(o => o.orderId === orderCode);
  if (!order) {
    return res.status(404).json({
      ok: false,
      data: null,
      message: 'Order not found'
    });
  }

  if (order.fedexTrackingNumber) {
    return res.status(400).json({
      ok: false,
      data: null,
      message: 'FedEx shipment already exists for this order'
    });
  }

  console.log(`  주문번호: ${orderCode}`);
  console.log(`  수신자: ${order.recipientName}`);
  console.log(`  서비스: ${serviceType || 'FEDEX_INTERNATIONAL_PRIORITY'}`);

  // 수신자 주소 자동 추출
  const recipient = {
    name: order.recipientName,
    phone: order.recipientContact,
    streetLines: [order.address, order.detailAddress].filter(Boolean),
    postalCode: order.postalCode,
    city: req.body.data?.recipientCity || '',
    stateOrProvince: req.body.data?.recipientState || '',
    countryCode: req.body.data?.recipientCountry || 'US'
  };

  const shipmentPackages = packages || [{
    weight: 1.0,
    length: 25,
    width: 20,
    height: 15
  }];

  try {
    const result = await fedexService.createShipment({
      recipient,
      packages: shipmentPackages,
      serviceType: serviceType || 'FEDEX_INTERNATIONAL_PRIORITY',
      labelFormat: labelFormat || 'PDF'
    });

    // 주문 데이터 업데이트
    order.fedexTrackingNumber = result.trackingNumber;
    order.fedexLabelBase64 = result.label;
    order.fedexServiceType = serviceType || 'FEDEX_INTERNATIONAL_PRIORITY';
    order.fedexEstimatedDelivery = result.estimatedDelivery;
    order.fedexShippedAt = new Date().toISOString();
    order.courier = 'FEDEX';
    order.status = 'DELIVERY';

    saveData();

    console.log(`✅ FedEx 배송 생성 완료`);
    console.log(`  트래킹 번호: ${result.trackingNumber}`);
    console.log(`  예상 배송일: ${result.estimatedDelivery}`);

    res.json({
      ok: true,
      data: {
        orderId: order.orderId,
        trackingNumber: result.trackingNumber,
        serviceType: order.fedexServiceType,
        estimatedDelivery: result.estimatedDelivery,
        status: order.status
      },
      message: 'FedEx shipment created successfully'
    });
  } catch (error) {
    console.error('FedEx create shipment error:', error.message);
    res.status(500).json({
      ok: false,
      data: null,
      message: error.message || 'Failed to create FedEx shipment'
    });
  }
});

// FedEx 라벨 다운로드 (Admin)
app.get('/datepalm-bay/api/admin/fedex/label/:orderCode', (req, res) => {
  console.log('\n=== [FedEx] 라벨 다운로드 ===');
  const { orderCode } = req.params;

  const order = customerOrders.find(o => o.orderId === orderCode);
  if (!order) {
    return res.status(404).json({
      ok: false,
      data: null,
      message: 'Order not found'
    });
  }

  if (!order.fedexLabelBase64) {
    return res.status(404).json({
      ok: false,
      data: null,
      message: 'No FedEx label available for this order'
    });
  }

  console.log(`  주문번호: ${orderCode}`);
  console.log(`  트래킹: ${order.fedexTrackingNumber}`);

  // base64 PDF를 바이너리로 변환하여 전송
  const labelBuffer = Buffer.from(order.fedexLabelBase64, 'base64');
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="fedex-label-${orderCode}.pdf"`,
    'Content-Length': labelBuffer.length
  });
  res.send(labelBuffer);
});

// FedEx 배송 추적
app.post('/datepalm-bay/api/fedex/track', async (req, res) => {
  console.log('\n=== [FedEx] 배송 추적 ===');
  const { trackingNumber, trackingNumbers } = req.body.data || req.body;

  const numbers = trackingNumbers || (trackingNumber ? [trackingNumber] : []);

  if (!numbers.length) {
    return res.status(400).json({
      ok: false,
      data: null,
      message: 'trackingNumber or trackingNumbers is required'
    });
  }

  console.log(`  추적 번호: ${numbers.join(', ')}`);

  try {
    const trackingResults = await fedexService.trackShipment(numbers);

    console.log(`✅ 배송 추적 완료: ${trackingResults.length}건`);

    res.json({
      ok: true,
      data: { trackingResults },
      message: 'Tracking information retrieved successfully'
    });
  } catch (error) {
    console.error('FedEx tracking error:', error.message);
    res.status(500).json({
      ok: false,
      data: null,
      message: error.message || 'Failed to track FedEx shipment'
    });
  }
});

// FedEx 주소 검증
app.post('/datepalm-bay/api/fedex/validate-address', async (req, res) => {
  console.log('\n=== [FedEx] 주소 검증 ===');
  const { address } = req.body.data || req.body;

  if (!address) {
    return res.status(400).json({
      ok: false,
      data: null,
      message: 'address is required'
    });
  }

  console.log(`  주소: ${address.streetLines?.[0]}, ${address.city}, ${address.countryCode}`);

  try {
    const validationResult = await fedexService.validateAddress(address);

    console.log(`✅ 주소 검증 완료`);

    res.json({
      ok: true,
      data: validationResult,
      message: 'Address validation completed'
    });
  } catch (error) {
    console.error('FedEx address validation error:', error.message);
    res.status(500).json({
      ok: false,
      data: null,
      message: error.message || 'Failed to validate address'
    });
  }
});

// ========================================
// FedEx Pickup (픽업 예약/취소)
// ========================================

// POST /datepalm-bay/api/admin/fedex/schedule-pickup - 픽업 예약
app.post('/datepalm-bay/api/admin/fedex/schedule-pickup', async (req, res) => {
  console.log('\n=== [FedEx] 픽업 예약 ===');
  const { orderCode, readyDate, readyTime, closeTime, pickupType, totalWeight, packageCount, remarks } = req.body.data || req.body;

  try {
    // 주문이 있으면 주문 정보에 픽업 정보 연결
    let order = null;
    if (orderCode) {
      order = customerOrders.find(o => o.orderCode === orderCode);
      if (!order) {
        return res.json({ ok: false, data: null, message: 'Order not found' });
      }
    }

    const result = await fedexService.schedulePickup({
      readyDate,
      readyTime,
      closeTime,
      pickupType: pickupType || 'FUTURE_DAY',
      totalWeight: totalWeight || 1.0,
      packageCount: packageCount || 1,
      remarks,
    });

    // 주문에 픽업 정보 저장
    if (order) {
      order.fedexPickupConfirmation = result.pickupConfirmationCode;
      order.fedexPickupDate = readyDate;
      order.fedexPickupTime = `${readyTime} ~ ${closeTime}`;
      saveData();
    }

    res.json({ ok: true, data: result, message: 'Pickup scheduled successfully' });
  } catch (error) {
    console.error('FedEx pickup schedule error:', error.message);
    res.status(500).json({ ok: false, data: null, message: error.message || 'Failed to schedule pickup' });
  }
});

// PUT /datepalm-bay/api/admin/fedex/cancel-pickup - 픽업 취소
app.put('/datepalm-bay/api/admin/fedex/cancel-pickup', async (req, res) => {
  console.log('\n=== [FedEx] 픽업 취소 ===');
  const { pickupConfirmationCode, scheduledDate, orderCode } = req.body.data || req.body;

  try {
    if (!pickupConfirmationCode || !scheduledDate) {
      return res.json({ ok: false, data: null, message: 'pickupConfirmationCode and scheduledDate are required' });
    }

    const result = await fedexService.cancelPickup(pickupConfirmationCode, scheduledDate);

    // 주문에서 픽업 정보 제거
    if (orderCode) {
      const order = customerOrders.find(o => o.orderCode === orderCode);
      if (order) {
        order.fedexPickupConfirmation = null;
        order.fedexPickupDate = null;
        order.fedexPickupTime = null;
        saveData();
      }
    }

    res.json({ ok: true, data: result, message: 'Pickup cancelled successfully' });
  } catch (error) {
    console.error('FedEx pickup cancel error:', error.message);
    res.status(500).json({ ok: false, data: null, message: error.message || 'Failed to cancel pickup' });
  }
});

// ======================================
// Aramex 물류 API
// ======================================

// POST /datepalm-bay/api/aramex/rates - 배송비 견적
app.post('/datepalm-bay/api/aramex/rates', async (req, res) => {
  console.log('\n=== [Aramex] 배송비 견적 조회 ===');
  const { recipient, packages, productGroup, productType } = req.body.data || req.body;

  if (!recipient || !packages || !packages.length) {
    return res.status(400).json({ ok: false, data: null, message: 'recipient and packages are required' });
  }

  try {
    const result = await aramexService.getRates({ recipient, packages, productGroup, productType });
    res.json({ ok: true, data: result, message: 'Rates retrieved successfully' });
  } catch (error) {
    console.error('Aramex rates error:', error.message);
    res.status(500).json({ ok: false, data: null, message: error.message || 'Failed to get rates' });
  }
});

// POST /datepalm-bay/api/admin/aramex/create-shipment - 배송 생성
app.post('/datepalm-bay/api/admin/aramex/create-shipment', async (req, res) => {
  console.log('\n=== [Aramex] 배송 생성 ===');
  const { orderCode, recipient, packages, productType, serviceType, description, reference, codAmount } = req.body.data || req.body;

  if (!orderCode || !recipient || !packages || !packages.length) {
    return res.status(400).json({ ok: false, data: null, message: 'orderCode, recipient, and packages are required' });
  }

  try {
    const result = await aramexService.createShipment({ orderCode, recipient, packages, productType, serviceType, description, reference, codAmount });

    const order = customerOrders.find(o => o.orderCode === orderCode);
    if (order) {
      order.aramexTrackingNumber = result.trackingNumber;
      order.aramexShipmentId = result.shipmentId;
      order.aramexLabelUrl = result.labelUrl;
      order.aramexServiceType = serviceType || 'PPX';
      order.aramexShippedAt = new Date().toISOString();
      order.deliveryStatus = '배송중';
      saveData();
    }

    res.json({ ok: true, data: result, message: 'Shipment created successfully' });
  } catch (error) {
    console.error('Aramex create shipment error:', error.message);
    res.status(500).json({ ok: false, data: null, message: error.message || 'Failed to create shipment' });
  }
});

// GET /datepalm-bay/api/admin/aramex/label/:orderCode - 라벨 URL 조회
app.get('/datepalm-bay/api/admin/aramex/label/:orderCode', async (req, res) => {
  console.log('\n=== [Aramex] 라벨 URL 조회 ===');
  const { orderCode } = req.params;

  const order = customerOrders.find(o => o.orderCode === orderCode);
  if (!order || !order.aramexLabelUrl) {
    return res.status(404).json({ ok: false, data: null, message: 'Aramex label not found for this order' });
  }

  res.json({ ok: true, data: { labelUrl: order.aramexLabelUrl, trackingNumber: order.aramexTrackingNumber }, message: 'Label URL retrieved' });
});

// POST /datepalm-bay/api/aramex/track - 배송 추적
app.post('/datepalm-bay/api/aramex/track', async (req, res) => {
  console.log('\n=== [Aramex] 배송 추적 ===');
  const { trackingNumbers } = req.body.data || req.body;

  if (!trackingNumbers || !trackingNumbers.length) {
    return res.status(400).json({ ok: false, data: null, message: 'trackingNumbers array is required' });
  }

  try {
    const result = await aramexService.trackShipment(trackingNumbers);
    res.json({ ok: true, data: result, message: 'Tracking info retrieved successfully' });
  } catch (error) {
    console.error('Aramex track error:', error.message);
    res.status(500).json({ ok: false, data: null, message: error.message || 'Failed to track shipment' });
  }
});

// POST /datepalm-bay/api/aramex/validate-address - 주소 검증
app.post('/datepalm-bay/api/aramex/validate-address', async (req, res) => {
  console.log('\n=== [Aramex] 주소 검증 ===');
  const { city, countryCode, postalCode } = req.body.data || req.body;

  if (!city || !countryCode) {
    return res.status(400).json({ ok: false, data: null, message: 'city and countryCode are required' });
  }

  try {
    const result = await aramexService.validateAddress({ city, countryCode, postalCode });
    res.json({ ok: true, data: result, message: 'Address validation complete' });
  } catch (error) {
    console.error('Aramex address validation error:', error.message);
    res.status(500).json({ ok: false, data: null, message: error.message || 'Failed to validate address' });
  }
});

// POST /datepalm-bay/api/admin/aramex/schedule-pickup - 픽업 예약
app.post('/datepalm-bay/api/admin/aramex/schedule-pickup', async (req, res) => {
  console.log('\n=== [Aramex] 픽업 예약 ===');
  const { pickupDate, readyTime, closeTime, totalWeight, totalPieces, orderCode } = req.body.data || req.body;

  if (!pickupDate || !readyTime || !closeTime) {
    return res.status(400).json({ ok: false, data: null, message: 'pickupDate, readyTime, and closeTime are required' });
  }

  try {
    const result = await aramexService.schedulePickup({ pickupDate, readyTime, closeTime, totalWeight, totalPieces });

    if (orderCode) {
      const order = customerOrders.find(o => o.orderCode === orderCode);
      if (order) {
        order.aramexPickupId = result.pickupId;
        order.aramexPickupDate = pickupDate;
        saveData();
      }
    }

    res.json({ ok: true, data: result, message: 'Pickup scheduled successfully' });
  } catch (error) {
    console.error('Aramex pickup schedule error:', error.message);
    res.status(500).json({ ok: false, data: null, message: error.message || 'Failed to schedule pickup' });
  }
});

// PUT /datepalm-bay/api/admin/aramex/cancel-pickup - 픽업 취소
app.put('/datepalm-bay/api/admin/aramex/cancel-pickup', async (req, res) => {
  console.log('\n=== [Aramex] 픽업 취소 ===');
  const { pickupId, orderCode } = req.body.data || req.body;

  if (!pickupId) {
    return res.status(400).json({ ok: false, data: null, message: 'pickupId is required' });
  }

  try {
    const result = await aramexService.cancelPickup(pickupId);

    if (orderCode) {
      const order = customerOrders.find(o => o.orderCode === orderCode);
      if (order) {
        order.aramexPickupId = null;
        order.aramexPickupDate = null;
        saveData();
      }
    }

    res.json({ ok: true, data: result, message: 'Pickup cancelled successfully' });
  } catch (error) {
    console.error('Aramex pickup cancel error:', error.message);
    res.status(500).json({ ok: false, data: null, message: error.message || 'Failed to cancel pickup' });
  }
});

// ═══════════════════════════════════════════════
// FedEx Global Trade API
// ═══════════════════════════════════════════════

// POST /datepalm-bay/api/fedex/global-trade/regulatory - 규제 서류 조회
app.post('/datepalm-bay/api/fedex/global-trade/regulatory', async (req, res) => {
  console.log('\n=== [FedEx] 규제 서류 조회 ===');
  const { destinationAddress, carrierCode, totalWeight, commodities, shipDate } = req.body.data || req.body;

  try {
    if (!destinationAddress?.countryCode) {
      return res.json({ ok: false, data: null, message: 'destinationAddress.countryCode is required' });
    }

    const result = await fedexService.retrieveRegulatoryDocuments({
      destinationAddress,
      carrierCode,
      totalWeight,
      commodities,
      shipDate,
    });

    console.log(`✅ 규제 서류 ${result.regulatoryDocuments.length}건, 주의사항 ${result.advisories.length}건`);

    res.json({
      ok: true,
      data: result,
      message: 'Regulatory documents retrieved successfully',
    });
  } catch (error) {
    console.error('FedEx regulatory docs error:', error.message);
    res.status(500).json({ ok: false, data: null, message: error.message || 'Failed to retrieve regulatory documents' });
  }
});

// ═══════════════════════════════════════════════
// FedEx Trade Documents Upload API
// ═══════════════════════════════════════════════

// POST /datepalm-bay/api/admin/fedex/upload-documents - 통관 서류 업로드 (Pre-shipment)
app.post('/datepalm-bay/api/admin/fedex/upload-documents', async (req, res) => {
  console.log('\n=== [FedEx] 통관 서류 업로드 ===');
  const { orderCode, destinationCountryCode, documents, workflowName, carrierCode } = req.body.data || req.body;

  try {
    if (!documents || documents.length === 0) {
      return res.json({ ok: false, data: null, message: 'At least one document is required' });
    }

    if (documents.length > 5) {
      return res.json({ ok: false, data: null, message: 'Maximum 5 documents per upload' });
    }

    if (!destinationCountryCode) {
      return res.json({ ok: false, data: null, message: 'destinationCountryCode is required' });
    }

    // 주문 조회 (orderCode가 있는 경우)
    let order = null;
    if (orderCode) {
      order = customerOrders.find(o => o.orderCode === orderCode);
      if (!order) {
        return res.json({ ok: false, data: null, message: `Order not found: ${orderCode}` });
      }
    }

    // Post-shipment인 경우 트래킹 번호 필요
    const isPostShipment = workflowName === 'ETDPostShipment';
    const trackingNumber = isPostShipment && order ? order.fedexTrackingNumber : undefined;

    if (isPostShipment && !trackingNumber) {
      return res.json({ ok: false, data: null, message: 'Post-shipment upload requires a tracking number. Create shipment first.' });
    }

    const result = await fedexService.uploadTradeDocuments({
      workflowName: workflowName || 'ETDPreShipment',
      carrierCode: carrierCode || 'FDXE',
      destinationCountryCode,
      documents,
      trackingNumber,
    });

    // 주문에 업로드된 서류 정보 저장
    if (order) {
      if (!order.fedexTradeDocuments) {
        order.fedexTradeDocuments = [];
      }
      result.documentStatuses.forEach((doc) => {
        order.fedexTradeDocuments.push({
          docId: doc.docId,
          documentType: doc.documentType,
          uploadedAt: new Date().toISOString(),
          workflow: workflowName || 'ETDPreShipment',
        });
      });
    }

    console.log(`✅ 서류 ${result.documentStatuses.length}건 업로드 완료`);

    res.json({
      ok: true,
      data: result,
      message: 'Trade documents uploaded successfully',
    });
  } catch (error) {
    console.error('FedEx document upload error:', error.message);
    res.status(500).json({ ok: false, data: null, message: error.message || 'Failed to upload trade documents' });
  }
});

// ======================================
// Dashboard Stats (Real Data from customerOrders)
// ======================================
app.get('/datepalm-bay/api/admin/dashboard/stats', (req, res) => {
  console.log('\n=== [Dashboard] Fetching Stats ===');

  const now = new Date();
  const thisMonth = now.getMonth();
  const thisYear = now.getFullYear();

  const paidStatuses = ['SUCCESS', 'DELIVERY', 'DELIVERED'];
  const paidOrders = customerOrders.filter(o => paidStatuses.includes(o.status));

  const thisMonthOrders = paidOrders.filter(o => {
    const d = new Date(o.createdAt);
    return d.getMonth() === thisMonth && d.getFullYear() === thisYear;
  });

  const lastMonth = thisMonth === 0 ? 11 : thisMonth - 1;
  const lastMonthYear = thisMonth === 0 ? thisYear - 1 : thisYear;
  const lastMonthOrders = paidOrders.filter(o => {
    const d = new Date(o.createdAt);
    return d.getMonth() === lastMonth && d.getFullYear() === lastMonthYear;
  });

  const monthlyRevenue = thisMonthOrders.reduce((sum, o) => sum + o.amount, 0);
  const previousMonthRevenue = lastMonthOrders.reduce((sum, o) => sum + o.amount, 0);
  const totalRevenue = paidOrders.reduce((sum, o) => sum + o.amount, 0);

  const allMembers = [...members, ...users];
  const totalMembers = allMembers.length;
  const newMembersThisMonth = allMembers.filter(m => {
    const d = new Date(m.createAt);
    return d.getMonth() === thisMonth && d.getFullYear() === thisYear;
  }).length;

  const ordersByStatus = {};
  ['PENDING', 'SUCCESS', 'DELIVERY', 'DELIVERED', 'REFUNDED'].forEach(s => {
    ordersByStatus[s] = customerOrders.filter(o => o.status === s).length;
  });

  const recentOrders = [...customerOrders]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 5)
    .map(o => ({
      orderId: o.orderId,
      status: o.status,
      customerName: o.ordererName,
      productName: o.productName,
      amount: o.amount,
      paymentMethod: o.paymentMethod || 'N/A',
      createdAt: o.createdAt,
    }));

  const productRevenue = {};
  paidOrders.forEach(o => {
    const name = o.productName || 'Unknown';
    productRevenue[name] = (productRevenue[name] || 0) + o.amount;
  });
  const categoryBreakdown = Object.entries(productRevenue).map(([label, amount]) => ({
    label,
    amount,
    percentage: totalRevenue > 0 ? Math.round((amount / totalRevenue) * 100) : 0,
  }));

  const monthlyTrend = [];
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  for (let i = 5; i >= 0; i--) {
    let m = thisMonth - i;
    let y = thisYear;
    if (m < 0) { m += 12; y -= 1; }
    const mOrders = paidOrders.filter(o => {
      const d = new Date(o.createdAt);
      return d.getMonth() === m && d.getFullYear() === y;
    });
    monthlyTrend.push({
      month: monthNames[m],
      revenue: mOrders.reduce((sum, o) => sum + o.amount, 0),
      orders: mOrders.length,
    });
  }

  const totalOrders = customerOrders.length;
  const avgOrderValue = paidOrders.length > 0 ? Math.round((totalRevenue / paidOrders.length) * 100) / 100 : 0;

  console.log(`Dashboard: Revenue=$${monthlyRevenue.toFixed(2)}, Orders=${totalOrders}, Members=${totalMembers}`);
  res.json({ ok: true, data: { monthlyRevenue, previousMonthRevenue, totalRevenue, totalOrders, totalMembers, newMembersThisMonth, avgOrderValue, ordersByStatus, recentOrders, categoryBreakdown, monthlyTrend } });
});

// ======================================
// Google OAuth Token Verification
// ======================================
app.post('/datepalm-bay/mvp/google-login-oauth', async (req, res) => {
  console.log('\n=== [Auth] Google OAuth Login ===');
  const { credential } = req.body;

  if (!credential) {
    return res.status(400).json({ message: 'No credential provided' });
  }

  try {
    let googlePayload;

    // Check if credential is a JWT (has 3 dot-separated parts) or an access_token
    const parts = credential.split('.');
    if (parts.length === 3) {
      // JWT credential from GoogleLogin component
      googlePayload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } else {
      // Access token from useGoogleLogin hook - fetch user info from Google
      console.log('Using access_token flow, fetching Google userinfo...');
      const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${credential}` },
      });
      if (!userInfoRes.ok) {
        return res.status(401).json({ message: 'Invalid Google access token' });
      }
      googlePayload = await userInfoRes.json();
    }

    console.log(`Google OAuth user: ${googlePayload.name} (${googlePayload.email})`);

    let user = users.find(u => u.email === googlePayload.email);
    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      const newUser = {
        id: googlePayload.email,
        password: '',
        code: `USER-G-${Date.now()}`,
        name: googlePayload.name || googlePayload.email.split('@')[0],
        phone: '',
        email: googlePayload.email,
        createAt: new Date().toISOString(),
        status: 'PENDING_PROFILE',
        memberLevel: 'BASIC',
        birthMonth: 1,
        lastPurchaseDate: null,
        totalPurchaseCount: 0,
        totalPurchaseAmount: 0,
        googleId: googlePayload.sub,
        picture: googlePayload.picture,
      };
      users.push(newUser);
      members.push({
        code: newUser.code,
        name: newUser.name,
        phone: newUser.phone,
        email: newUser.email,
        status: 'PENDING_PROFILE',
        createAt: newUser.createAt,
        birthDate: '',
        country: '',
      });
      user = newUser;
      saveData();
      console.log(`New Google user registered: ${user.name}`);
    }

    const accessToken = `google-oauth-${user.code}-${Date.now()}`;
    res.json({ accessToken, id: user.id, code: user.code, name: user.name, email: user.email, phone: user.phone, birthDate: user.birthDate || '', country: user.country || '', status: user.status, isNewUser });
  } catch (e) {
    console.error('Google token decode error:', e.message);
    res.status(401).json({ message: 'Invalid Google token' });
  }
});

// ======================================
// Google OAuth 프로필 완성 (추가정보 입력)
// ======================================
app.put('/datepalm-bay/api/mvp/member/complete-profile', (req, res) => {
  console.log('\n=== [Auth] Complete Profile ===');
  const { userCode, country, birthDate, phone } = req.body;

  if (!userCode) {
    return res.json({ ok: false, data: null, message: 'userCode is required' });
  }

  const user = users.find(u => u.code === userCode);
  if (!user) {
    return res.json({ ok: false, data: null, message: 'User not found' });
  }

  // 프로필 정보 업데이트
  user.country = country || '';
  user.birthDate = birthDate || '';
  user.phone = phone || '';
  user.birthMonth = birthDate ? new Date(birthDate).getMonth() + 1 : 1;
  user.status = 'ACTIVE';
  user.memberLevel = 'BRONZE';

  // members 배열도 동기화
  const member = members.find(m => m.code === userCode);
  if (member) {
    member.country = user.country;
    member.birthDate = user.birthDate;
    member.phone = user.phone;
    member.status = 'ACTIVE';
  }

  saveData();
  console.log(`✅ Profile completed: ${user.name} (${user.email}), country=${country}, phone=${phone}`);

  const accessToken = `google-oauth-${user.code}-${Date.now()}`;
  res.json({
    ok: true,
    data: {
      accessToken,
      id: user.id,
      code: user.code,
      name: user.name,
      email: user.email,
      phone: user.phone,
      birthDate: user.birthDate,
      country: user.country,
      status: user.status,
    },
    message: 'Profile completed successfully',
  });
});

// 전역 에러 핸들러 (모든 라우트 이후에 배치)
app.use(handleMulterError);

// ========================================
// Async 서버 시작 (MySQL 연결 → 데이터 로드 → 서버 시작)
// ========================================
async function startServer() {
  // 1. MySQL 연결 시도
  _useMySQL = await waitForMySQL(5);

  // 2. MySQL/JSON에서 데이터 로드
  const loadedData = await loadData();

  // 3. 로드된 데이터를 모듈 변수에 할당 (기본 시드 데이터를 덮어씀)
  if (loadedData.products && loadedData.products.length > 0) products = loadedData.products;
  if (loadedData.brands && loadedData.brands.length > 0) brands = loadedData.brands;
  if (loadedData.members) members = loadedData.members;
  if (loadedData.users) users = loadedData.users;

  // users에 있지만 members에 없는 유저를 members에 동기화
  for (const user of users) {
    if (!members.find(m => m.code === user.code || m.email === user.email)) {
      members.push({
        code: user.code,
        name: user.name,
        phone: user.phone || '',
        email: user.email,
        status: user.status || 'ACTIVE',
        createAt: user.createAt,
        birthDate: user.birthDate || '',
        country: user.country || '',
      });
    }
  }
  if (loadedData.userCoupons) userCoupons = loadedData.userCoupons;
  if (loadedData.groupBuyTeams && loadedData.groupBuyTeams.length > 0) groupBuyTeams = loadedData.groupBuyTeams;
  if (loadedData.events) events = loadedData.events;
  if (loadedData.coupons) coupons = loadedData.coupons;
  if (loadedData.snsReviews && loadedData.snsReviews.length > 0) snsReviews = loadedData.snsReviews;
  if (loadedData.orders) customerOrders = loadedData.orders;
  if (loadedData.snsReviewOverrides) snsReviewOverrides = loadedData.snsReviewOverrides;
  if (loadedData.productInsights) productInsights = loadedData.productInsights;
  if (loadedData.aiFeedbackHistory) aiFeedbackHistory = loadedData.aiFeedbackHistory;
  if (loadedData.skinProfiles && loadedData.skinProfiles.length > 0) skinProfiles = loadedData.skinProfiles;

  // 4. 더미/테스트 주문 데이터 정리
  const testOrderIds = ['ORDER-TEST-FEDEX-001', 'ORDER-TEST-002', 'ORDER-TEST-FEDEX-003'];
  const beforeCount = customerOrders.length;
  customerOrders = customerOrders.filter(o => !testOrderIds.includes(o.orderId));
  if (customerOrders.length < beforeCount) {
    console.log(`🧹 더미 주문 ${beforeCount - customerOrders.length}개 삭제`);
    // 즉시 저장 (debounce 무시)
    await _saveDataImpl();
  }

  // 5. SNS 수집기에 로드된 데이터 참조 재설정
  snsCollector.setReferences(snsReviews, products, saveData);

  // 6. Claude AI 리뷰 분석기 초기화
  claudeReviewSummarizer.initialize({
    productInsights,
    aiFeedbackHistory,
    snsReviewOverrides,
    onSave: saveData,
  });

  // 7. SKIN OS 성분 분석기 초기화
  skinOS.initialize({
    productsRef: products,
    onSave: saveData,
  });

  // 8. SKIN OS Vision 피부 분석기 초기화
  visionSkin.initialize({
    productsRef: products,
    skinProfilesRef: skinProfiles,
    onSave: saveData,
  });

  console.log(`\n📊 데이터 로드 완료: ${products.length}개 상품, ${brands.length}개 브랜드, ${(customerOrders || []).length}개 주문, ${(members || []).length}개 회원`);

  // 5. 서버 시작
  app.listen(port, () => {
    console.log(`
╔═══════════════════════════════════════╗
║   Mock API Server Running             ║
║   Port: ${port}                          ║
║   URL: http://localhost:${port}         ║
║   Storage: ${_useMySQL ? 'MySQL ✅' : 'JSON File 📁'}              ║
╚═══════════════════════════════════════╝
  `);

    // API 연결 상태 출력
    console.log('🔗 API Connection Status:');
    console.log(`  MySQL: ${_useMySQL ? '✅ Connected' : '⚠️  Not connected (JSON file mode)'}`);
    console.log(`  YouTube API: ${process.env.YOUTUBE_API_KEY ? '✅ Configured' : '❌ Not configured'}`);
    console.log(`  TikTok API: ${process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET ? '✅ Configured' : '⚠️  Not configured (optional)'}`);
    console.log(`  Instagram API: ${process.env.INSTAGRAM_ACCESS_TOKEN && process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID ? '✅ Configured' : '⚠️  Not configured (optional)'}`);
    console.log(`  FedEx API: ${process.env.FEDEX_API_KEY && process.env.FEDEX_SECRET_KEY ? '✅ Configured' : '⚠️  Not configured (optional)'}`);
    console.log(`  Claude AI: ${claudeReviewSummarizer.isClaudeAvailable() ? '✅ Connected (provider: claude)' : '⚠️  Not configured (keyword fallback)'}`);
    console.log('');
  });
}

// ========================================
// Graceful Shutdown (SIGTERM/SIGINT)
// ========================================
async function gracefulShutdown(signal) {
  console.log(`\n🛑 ${signal} received, shutting down gracefully...`);

  // 미완료 debounced save 강제 실행
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
    try {
      await _saveDataImpl();
      console.log('💾 미완료 저장 강제 실행 완료');
    } catch (e) {
      console.error('❌ 강제 저장 실패:', e.message);
    }
  }

  // MySQL 풀 종료
  if (_useMySQL) {
    try {
      await database.close();
      console.log('🗄️  MySQL connection pool closed');
    } catch (e) {
      console.error('❌ MySQL 풀 종료 실패:', e.message);
    }
  }

  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// 서버 시작!
startServer().catch(e => {
  console.error('❌ Server startup failed:', e);
  process.exit(1);
});
