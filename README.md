# DatepalmBay Mock API Server

DatepalmBay 프로젝트의 Mock API 서버입니다. 실제 백엔드 API 없이 프론트엔드 개발을 진행할 수 있도록 Mock 데이터를 제공합니다.

## 시작하기

### 설치

```bash
npm install
```

### 실행

```bash
npm start
```

서버는 `http://localhost:8080`에서 실행됩니다.

## API 엔드포인트

### 상품 관리

#### 1. 상품 생성

**POST** `/datepalm-bay/api/admin/product/create`

**Content-Type**: `multipart/form-data`

**Request Body**:
- `request` (JSON Blob): 상품 정보
- `thumbnail` (File): 썸네일 이미지
- `files` (File[]): 추가 이미지들
- `detailInfo` (String): 상품 상세 정보 (Base64 인코딩)

**Request JSON 구조**:
```json
{
  "name": "상품명",
  "category": "BRAND | BEAUTY | SUPPLEMENT | K_CULTURE",
  "saleStatus": true,
  "productOriginPrice": 10000,
  "productRegularPrice": 15000,
  "discountStatus": true,
  "discountType": "STATIC | PERCENT",
  "discountPrice": 2000,
  "introduction": "상품 소개",
  "policy": {
    "deliveryPolicy": "배송 정책",
    "refundPolicy": "환불 정책",
    "exchangePolicy": "교환 정책"
  }
}
```

**Response**:
```json
{
  "ok": true,
  "data": "PROD-1234567890",
  "message": "상품이 성공적으로 생성되었습니다."
}
```

#### 2. 상품 목록 조회

**GET** `/datepalm-bay/api/admin/product/list`

**Query Parameters**:
- `pageNo` (number): 페이지 번호 (기본값: 0)
- `pageSize` (number): 페이지 크기 (기본값: 10)
- `code` (string, optional): 상품 코드 필터
- `name` (string, optional): 상품명 필터
- `status` (boolean, optional): 판매 상태 필터
- `category` (string, optional): 카테고리 필터

**Response**:
```json
{
  "ok": true,
  "data": {
    "content": [
      {
        "productCode": "PROD-1234567890",
        "productName": "상품명",
        "productSaleStatus": true,
        "category": "BRAND",
        "productOriginPrice": 10000,
        "productRegularPrice": 15000,
        "discountType": "STATIC",
        "productDiscountPrice": 2000,
        "productPrice": 13000
      }
    ],
    "pageable": {
      "pageNumber": 0,
      "pageSize": 10
    },
    "totalElements": 50,
    "totalPages": 5,
    "size": 10,
    "number": 0,
    "first": true,
    "last": false,
    "numberOfElements": 10
  },
  "message": "상품 목록 조회 성공"
}
```

#### 3. 상품 상세 조회

**GET** `/datepalm-bay/api/admin/product/detail/:code`

**Path Parameters**:
- `code` (string): 상품 코드

**Response**:
```json
{
  "ok": true,
  "data": {
    "code": "PROD-1234567890",
    "name": "상품명",
    "category": "BRAND",
    "introduction": "상품 소개",
    "note": "",
    "discountStatus": true,
    "saleStatus": true,
    "discountType": "STATIC",
    "originPrice": 10000,
    "regularPrice": 15000,
    "discountPrice": 2000,
    "price": 13000,
    "refundPolicy": "환불 정책",
    "deliveryPolicy": "배송 정책",
    "exchangePolicy": "교환 정책",
    "files": [
      {
        "id": "IMG-0",
        "path": "image1.jpg"
      }
    ]
  },
  "message": "상품 상세 조회 성공"
}
```

#### 4. 상품 수정

**PUT** `/datepalm-bay/api/admin/product/edit`

**Content-Type**: `multipart/form-data`

**Request Body**:
- `request` (JSON Blob): 수정할 상품 정보 (상품 생성과 동일한 구조 + `code` 필드 추가)
- `thumbnail` (File, optional): 새 썸네일 이미지
- `files` (File[], optional): 추가할 이미지들
- `detailInfo` (String, optional): 새 상품 상세 정보

**Response**:
```json
{
  "ok": true,
  "data": "PROD-1234567890",
  "message": "상품이 성공적으로 수정되었습니다."
}
```

#### 5. 상품 삭제

**DELETE** `/datepalm-bay/api/admin/product/delete`

**Request Body**:
```json
{
  "deleteCodes": ["PROD-1234567890", "PROD-0987654321"]
}
```

**Response**:
```json
{
  "ok": true,
  "data": "2",
  "message": "2개의 상품이 삭제되었습니다."
}
```

## 데이터 검증

상품 생성 및 수정 시 다음 항목들이 검증됩니다:

- 상품명은 필수
- 카테고리는 필수
- 판매 상태는 필수
- 원가는 0보다 커야 함
- 정가는 0보다 커야 함
- 할인 상태가 활성화된 경우:
  - 할인 유형은 필수
  - 할인 금액은 0보다 커야 함

## 가격 계산

할인이 적용된 경우 판매가는 다음과 같이 계산됩니다:

- **정적 할인 (STATIC)**: `판매가 = 정가 - 할인금액`
- **비율 할인 (PERCENT)**: `판매가 = 정가 - (정가 × 할인율 / 100)`

## 특징

- 인메모리 데이터 저장 (서버 재시작 시 초기화)
- 페이징 지원
- 필터링 지원 (상품 코드, 상품명, 판매 상태, 카테고리)
- 요청 데이터 검증
- 자동 가격 계산
- CORS 지원
- 파일 업로드 처리

## 주의사항

- 이 서버는 개발 목적으로만 사용해야 합니다
- 데이터는 메모리에 저장되므로 서버를 재시작하면 모든 데이터가 사라집니다
- 실제 파일 업로드는 메모리에만 저장되며 디스크에 저장되지 않습니다
- 프로덕션 환경에서는 실제 백엔드 API를 사용해야 합니다
