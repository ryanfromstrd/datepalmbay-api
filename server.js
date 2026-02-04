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
// PayPal 결제 서비스
const paypalService = require('./services/paypal');

// ========================================
// 파일 기반 영속성 (서버 재시작 시 데이터 유지)
// ========================================
const DATA_FILE = path.join(__dirname, 'mock-data.json');

// 데이터 로드 함수
function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const fileContent = fs.readFileSync(DATA_FILE, 'utf-8');
      const data = JSON.parse(fileContent);
      console.log(`📁 데이터 로드 완료: ${data.products?.length || 0}개 상품, ${data.snsReviews?.length || 0}개 SNS 리뷰`);
      return {
        products: data.products || [],
        snsReviews: data.snsReviews || []
      };
    } catch (e) {
      console.error('❌ 데이터 로드 실패:', e.message);
      return { products: [], snsReviews: [] };
    }
  }
  console.log('📁 저장된 데이터 없음, 빈 저장소로 시작');
  return { products: [], snsReviews: [] };
}

// 데이터 저장 함수
function saveData() {
  try {
    const dataToSave = {
      products: products,
      snsReviews: snsReviews,
      savedAt: new Date().toISOString()
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(dataToSave, null, 2), 'utf-8');
    console.log(`💾 데이터 저장 완료: ${products.length}개 상품, ${snsReviews.length}개 SNS 리뷰`);
  } catch (e) {
    console.error('❌ 데이터 저장 실패:', e.message);
  }
}

const app = express();
const port = 8080;

// 업로드 폴더 생성
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// CORS 설정
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Form data 처리

// 정적 파일 서빙 (업로드된 이미지)
app.use('/uploads', express.static(uploadDir));

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

// 파일에서 영속 데이터 로드
const loadedData = loadData();

// Mock 상품 데이터 저장소 (파일에서 로드)
const products = loadedData.products;

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

// Mock 회원 데이터 저장소
const members = [
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

// Mock 로그인 사용자 데이터 (id와 password 포함)
const users = [
  {
    id: 'test',
    password: 'test1234',
    code: 'USER-001',
    name: 'Test User',
    phone: '010-1111-2222',
    email: 'test@datepalmbay.com',
    createAt: new Date('2024-01-01').toISOString(),
    status: 'ACTIVE'
  },
  {
    id: 'demo',
    password: 'demo1234',
    code: 'USER-002',
    name: 'Demo User',
    phone: '010-3333-4444',
    email: 'demo@datepalmbay.com',
    createAt: new Date('2024-01-15').toISOString(),
    status: 'ACTIVE'
  },
  {
    id: 'customer1',
    password: 'customer1234',
    code: 'USER-003',
    name: '김고객',
    phone: '010-5555-6666',
    email: 'customer1@datepalmbay.com',
    createAt: new Date('2024-02-01').toISOString(),
    status: 'ACTIVE'
  },
  {
    id: 'customer2',
    password: 'customer1234',
    code: 'USER-004',
    name: '이고객',
    phone: '010-7777-8888',
    email: 'customer2@datepalmbay.com',
    createAt: new Date('2024-02-05').toISOString(),
    status: 'ACTIVE'
  },
  {
    id: 'user1',
    password: 'user1234',
    code: 'USER-005',
    name: '박사용자',
    phone: '010-9999-0000',
    email: 'user1@datepalmbay.com',
    createAt: new Date('2024-02-10').toISOString(),
    status: 'ACTIVE'
  },
  {
    id: 'user2',
    password: 'user1234',
    code: 'USER-006',
    name: '최사용자',
    phone: '010-1234-5678',
    email: 'user2@datepalmbay.com',
    createAt: new Date('2024-02-15').toISOString(),
    status: 'ACTIVE'
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
    const mainImages = mainImageFiles.map((file, index) => ({
      code: `${productCode}-M${index + 1}`,
      url: `http://localhost:${port}/uploads/${file.filename}`,
      originalName: file.originalname,
      size: file.size,
      mimetype: file.mimetype,
      order: index + 1
    }));

    const detailImages = detailImageFiles.map((file, index) => ({
      code: `${productCode}-D${index + 1}`,
      url: `http://localhost:${port}/uploads/${file.filename}`,
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
    const newMainImages = mainImageFiles.map((file, index) => ({
      code: `${requestData.code}-M${existingMainImages.length + index + 1}`,
      url: `http://localhost:${port}/uploads/${file.filename}`,
      originalName: file.originalname,
      size: file.size,
      mimetype: file.mimetype,
      order: existingMainImages.length + index + 1
    }));

    // 새로운 detailImages 추가
    const detailImageFiles = req.files.detailImages || [];
    const newDetailImages = detailImageFiles.map((file, index) => ({
      code: `${requestData.code}-D${existingDetailImages.length + index + 1}`,
      url: `http://localhost:${port}/uploads/${file.filename}`,
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
    groupBuyTiers: product.groupBuyTiers || []
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

  const start = pageNo * pageSize;
  const end = start + pageSize;
  const paginatedMembers = members.slice(start, end);

  console.log(`페이지: ${pageNo}, 크기: ${pageSize}`);
  console.log(`총 ${members.length}개 회원 중 ${paginatedMembers.length}개 반환`);

  res.json({
    ok: true,
    data: {
      content: paginatedMembers,
      pageable: {
        pageNumber: pageNo,
        pageSize: pageSize
      },
      totalElements: members.length,
      totalPages: Math.ceil(members.length / pageSize),
      size: pageSize,
      number: pageNo,
      first: pageNo === 0,
      last: pageNo >= Math.floor(members.length / pageSize),
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

  const member = members.find(m => m.code === code);

  if (!member) {
    return res.status(404).json({
      ok: false,
      data: null,
      message: '회원을 찾을 수 없습니다.'
    });
  }

  console.log('조회 성공:', member.name);

  res.json({
    ok: true,
    data: {
      ...member,
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
    thumbnailUrl: p.files?.mainImages?.[0]?.url || ''  // 첫 번째 main image 사용
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
    groupBuyTiers: product.groupBuyTiers || []
  };

  console.log('조회 성공:', product.productName);

  res.json({
    ok: true,
    data: detailResponse,
    message: '상품 상세 조회 성공'
  });
});

// ======================================
// Group Buy Team Endpoints
// ======================================

// Mock Group Buy Teams storage
const groupBuyTeams = [];

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
    inviteLink: `http://localhost:3000/group-buy/invite/${inviteCode}`,
    whatsappShareUrl: `https://wa.me/?text=${encodeURIComponent(`Join my group buy for ${product.productName}!`)}`,
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

  // Find user
  const user = users.find(u => u.id === id && u.password === password);

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
// Mock Events Data
// ======================================
const events = [
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
// New Products Endpoint (Products created within 1 week)
// ======================================
app.get('/datepalm-bay/api/mvp/product/new/list', (req, res) => {
  console.log('\n=== [Frontend] New Products List ===');
  const pageNo = parseInt(req.query.pageNo) || 0;
  const pageSize = parseInt(req.query.pageSize) || 10;
  const { sortType } = req.query;

  console.log('Filter:', { pageNo, pageSize, sortType });

  // Filter products created within 1 week and on sale
  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

  let filteredProducts = products.filter(p => {
    if (p.productSaleStatus !== true) return false;
    const createdDate = new Date(p.createdAt || Date.now());
    return createdDate >= oneWeekAgo;
  });

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

  const bannerImage = bannerFiles?.[0]
    ? `http://localhost:8080/uploads/${bannerFiles[0].filename}`
    : 'https://via.placeholder.com/1200x400?text=Event+Banner';

  const thumbnailImage = thumbnailFiles?.[0]
    ? `http://localhost:8080/uploads/${thumbnailFiles[0].filename}`
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

  const bannerImage = bannerFiles?.[0]
    ? `http://localhost:8080/uploads/${bannerFiles[0].filename}`
    : existingEvent.bannerImage;

  const thumbnailImage = thumbnailFiles?.[0]
    ? `http://localhost:8080/uploads/${thumbnailFiles[0].filename}`
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

  res.json({
    ok: true,
    data: null,
    message: 'Event deleted successfully'
  });
});

// ========================================
// SNS 리뷰 Mock 데이터 및 API
// ========================================

// SNS 리뷰 Mock 데이터 저장소 (파일에서 로드)
const snsReviews = loadedData.snsReviews;

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

// Instagram API 연결 상태 확인
app.get('/datepalm-bay/api/admin/sns-reviews/instagram/status', async (req, res) => {
  try {
    const instagram = require('./services/instagram');
    const status = await instagram.checkConnection();

    res.json({
      ok: status.connected,
      data: status,
      message: status.message
    });
  } catch (error) {
    res.json({
      ok: false,
      data: { connected: false },
      message: error.message
    });
  }
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

// 상품별 SNS 리뷰 요약 (AI 요약 - 키워드 기반 자체 구현)
app.get('/datepalm-bay/api/mvp/product/:productCode/sns-reviews/summary', (req, res) => {
  const { productCode } = req.params;

  console.log(`📊 SNS Review Summary requested for product: ${productCode}`);

  // 승인된 리뷰만 필터링
  const approvedReviews = snsReviews.filter(r =>
    r.status === 'APPROVED' &&
    r.matchedProducts.some(m => m.productCode === productCode)
  );

  console.log(`Found ${approvedReviews.length} approved reviews for summary`);

  // 리뷰 요약 생성
  const summary = reviewSummarizer.summarizeReviews(approvedReviews);

  res.json({
    ok: true,
    data: summary,
    message: 'SNS review summary generated successfully'
  });
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
        // YouTube API로 상세 정보 가져오기
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
          console.log('YouTube API error, using basic info:', err.message);
        }

        // API 실패 시 기본 정보로 저장
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

    // Instagram URL 파싱
    if (url.includes('instagram.com')) {
      const postId = extractInstagramPostId(url);
      reviewData = {
        platform: 'INSTAGRAM',
        externalId: postId || `manual_${Date.now()}`,
        contentUrl: url,
        thumbnailUrl: '',
        title: null,
        description: 'Manually added Instagram review',
        authorName: 'Instagram User',
        authorId: 'unknown',
        publishedAt: new Date().toISOString(),
        viewCount: 0,
        likeCount: 0,
      };
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
        message: 'Unsupported URL format. Please use YouTube, TikTok, or Instagram URLs.'
      });
    }

    // 중복 체크
    const exists = snsReviews.some(
      r => r.platform === reviewData.platform && r.externalId === reviewData.externalId
    );

    if (exists) {
      return res.status(400).json({
        ok: false,
        message: 'This review already exists'
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

// Instagram Post ID 추출 헬퍼 함수
function extractInstagramPostId(url) {
  const match = url.match(/instagram\.com\/(?:p|reel|reels)\/([^\/\?]+)/);
  return match ? match[1] : null;
}

// ========================================
// 결제 API (Toss Payments)
// ========================================

// 주문 목록 저장소 (메모리)
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
    currency = 'USD'
  } = orderData;

  // 상품 조회
  const product = products.find(p => p.productCode === productCode);
  if (!product) {
    return res.status(404).json({
      ok: false,
      data: null,
      message: 'Product not found'
    });
  }

  // 주문 ID 생성
  const orderId = `ORDER-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

  // 금액 계산 (USD 기준 - 국제 결제용)
  const priceUSD = product.productPriceUSD || product.productPrice;
  const amount = priceUSD * quantity;
  const orderName = quantity > 1
    ? `${product.productName} and ${quantity - 1} more`
    : product.productName;

  // 주문 정보 저장
  const newOrder = {
    orderId,
    productCode,
    productName: product.productName,
    quantity,
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
    status: 'PENDING',
    paypalOrderId: null,
    captureId: null,
    paymentMethod: null,
    approvedAt: null,
    createdAt: new Date().toISOString()
  };

  customerOrders.push(newOrder);

  console.log(`✅ 주문 생성 완료: ${orderId}`);
  console.log(`  상품: ${product.productName}`);
  console.log(`  수량: ${quantity}`);
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

// 전역 에러 핸들러 (모든 라우트 이후에 배치)
app.use(handleMulterError);

app.listen(port, () => {
  console.log(`
╔═══════════════════════════════════════╗
║   Mock API Server Running             ║
║   Port: ${port}                          ║
║   URL: http://localhost:${port}         ║
╚═══════════════════════════════════════╝

Available Endpoints:

📦 Admin - Products:
  POST   /datepalm-bay/api/admin/product/create
  PUT    /datepalm-bay/api/admin/product/edit
  DELETE /datepalm-bay/api/admin/product/delete
  GET    /datepalm-bay/api/admin/product/list
  GET    /datepalm-bay/api/admin/product/detail/:code
  GET    /datepalm-bay/api/admin/products

👥 Admin - Members:
  GET    /datepalm-bay/api/admin/member/list
  GET    /datepalm-bay/api/admin/member/detail/:code

📝 Admin - Contacts/Inquiry:
  GET    /datepalm-bay/api/admin/inquiry/list
  GET    /datepalm-bay/api/admin/inquiry/detail/:code

🛒 Admin - Orders:
  GET    /datepalm-bay/api/admin/order/list
  GET    /datepalm-bay/api/admin/order/detail/:code
  GET    /datepalm-bay/api/admin/order/member-orders

🎉 Admin - Events:
  GET    /datepalm-bay/api/admin/event/list
  GET    /datepalm-bay/api/admin/event/detail/:code
  POST   /datepalm-bay/api/admin/event/create
  PUT    /datepalm-bay/api/admin/event/edit
  DELETE /datepalm-bay/api/admin/event/delete/:code

🔐 Frontend - Auth:
  POST   /datepalm-bay/mvp/login
  GET    /datepalm-bay/api/mvp/member/detail/me

🌐 Frontend - Products:
  GET    /datepalm-bay/api/mvp/product/normal/list
  GET    /datepalm-bay/api/mvp/product/normal/detail/:code

🤝 Frontend - Group Buy Teams:
  POST   /datepalm-bay/api/mvp/group-buy/teams
  GET    /datepalm-bay/api/mvp/group-buy/teams/:teamId
  GET    /datepalm-bay/api/mvp/group-buy/teams/invite/:inviteCode
  POST   /datepalm-bay/api/mvp/group-buy/teams/:teamId/join
  GET    /datepalm-bay/api/mvp/group-buy/teams/user/:userId
  POST   /datepalm-bay/api/mvp/group-buy/teams/:teamId/checkout

📱 SNS Reviews:
  GET    /datepalm-bay/api/mvp/product/:productCode/sns-reviews
  GET    /datepalm-bay/api/admin/sns-reviews
  GET    /datepalm-bay/api/admin/sns-reviews/:id
  PUT    /datepalm-bay/api/admin/sns-reviews/:id/status
  POST   /datepalm-bay/api/admin/sns-reviews/collect
  GET    /datepalm-bay/api/admin/sns-reviews/stats
  `);

  // API 연결 상태 출력
  console.log('\n🔗 API Connection Status:');
  console.log(`  YouTube API: ${process.env.YOUTUBE_API_KEY ? '✅ Configured' : '❌ Not configured'}`);
  console.log(`  TikTok API: ${process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET ? '✅ Configured' : '⚠️  Not configured (optional)'}`);
  console.log(`  Instagram API: ${process.env.INSTAGRAM_ACCESS_TOKEN && process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID ? '✅ Configured' : '⚠️  Not configured (optional)'}`);

  if (!process.env.TIKTOK_CLIENT_KEY || !process.env.TIKTOK_CLIENT_SECRET) {
    console.log('\n  📝 TikTok API 설정 방법:');
    console.log('     1. https://developers.tiktok.com/ 에서 개발자 계정 생성');
    console.log('     2. App 생성 후 Client Key, Client Secret 발급');
    console.log('     3. .env 파일에 TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET 설정');
  }

  if (!process.env.INSTAGRAM_ACCESS_TOKEN || !process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID) {
    console.log('\n  📝 Instagram API 설정 방법:');
    console.log('     1. Facebook Developer App 생성');
    console.log('     2. Instagram Business 계정 연결');
    console.log('     3. .env 파일에 INSTAGRAM_ACCESS_TOKEN, INSTAGRAM_BUSINESS_ACCOUNT_ID 설정');
  }
  console.log('');
});
