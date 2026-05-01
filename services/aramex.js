/**
 * Aramex Shipping API Service
 * https://developer.aramex.com/
 *
 * Aramex는 MENA(중동·아프리카) 시장 주력 택배사.
 * FedEx와 달리 OAuth 토큰 불필요 — ClientInfo 객체를 매 요청마다 포함.
 *
 * 핵심 기능:
 * 1. 배송비 견적 (Rate Calculator)
 * 2. 배송 생성 + 라벨 발급 (Shipping)
 * 3. 배송 추적 (Tracking)
 * 4. 픽업 예약/취소 (Pickup)
 * 5. 주소 검증 (Location)
 */

const nodeFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : require('node-fetch');

const ARAMEX_MODE = process.env.ARAMEX_MODE || 'test';
const ARAMEX_API_BASE = ARAMEX_MODE === 'production'
  ? 'https://ws.aramex.net/ShippingAPI.V2'
  : 'https://ws.aramex.net/ShippingAPI.V2'; // Aramex는 동일 base, test 모드는 ClientInfo.Source로 구분

// ───────────────────────────────────────────
// 인증 — ClientInfo 객체 (매 요청 포함)
// ───────────────────────────────────────────

/**
 * Aramex ClientInfo 빌드
 * 모든 API 요청 body에 포함해야 함
 */
function buildClientInfo() {
  const username = process.env.ARAMEX_USERNAME;
  const password = process.env.ARAMEX_PASSWORD;
  const accountNumber = process.env.ARAMEX_ACCOUNT_NUMBER;
  const accountPin = process.env.ARAMEX_ACCOUNT_PIN;
  const accountEntity = process.env.ARAMEX_ACCOUNT_ENTITY || 'DXB';
  const accountCountryCode = process.env.ARAMEX_ACCOUNT_COUNTRY || 'AE';

  if (!username || !password || !accountNumber || !accountPin) {
    throw new Error('Aramex credentials not configured. Set ARAMEX_USERNAME, ARAMEX_PASSWORD, ARAMEX_ACCOUNT_NUMBER, ARAMEX_ACCOUNT_PIN.');
  }

  return {
    UserName: username,
    Password: password,
    Version: 'v1.0',
    AccountNumber: accountNumber,
    AccountPin: accountPin,
    AccountEntity: accountEntity,
    AccountCountryCode: accountCountryCode,
    Source: ARAMEX_MODE === 'test' ? 24 : 24, // Source 24 = API
  };
}

/**
 * 발송지 정보 (환경변수 기반)
 */
function getShipperInfo() {
  return {
    Reference1: 'Datepalm Bay',
    AccountNumber: process.env.ARAMEX_ACCOUNT_NUMBER,
    PartyAddress: {
      Line1: process.env.ARAMEX_SHIPPER_STREET || '123 Warehouse St',
      City: process.env.ARAMEX_SHIPPER_CITY || 'Seoul',
      StateOrProvinceCode: process.env.ARAMEX_SHIPPER_STATE || '',
      PostCode: process.env.ARAMEX_SHIPPER_POSTAL || '06100',
      CountryCode: process.env.ARAMEX_SHIPPER_COUNTRY || 'KR',
    },
    Contact: {
      PersonName: process.env.ARAMEX_SHIPPER_NAME || 'Datepalm Bay',
      CompanyName: 'Datepalm Bay',
      PhoneNumber1: process.env.ARAMEX_SHIPPER_PHONE || '02-1234-5678',
      EmailAddress: process.env.ARAMEX_SHIPPER_EMAIL || 'logistics@datepalmbay.com',
    },
  };
}

/**
 * Aramex API 공통 요청 함수
 */
async function aramexRequest(endpoint, body) {
  const url = `${ARAMEX_API_BASE}/${endpoint}`;
  console.log(`[Aramex] → ${url}`);

  const response = await nodeFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('[Aramex] API 오류:', JSON.stringify(data, null, 2));
    throw new Error(data.HasErrors ? (data.Notifications?.[0]?.Message || 'Aramex API error') : 'Aramex API request failed');
  }

  if (data.HasErrors) {
    const msg = data.Notifications?.map(n => n.Message).join(' | ') || 'Aramex API error';
    console.error('[Aramex] 응답 오류:', msg);
    throw new Error(msg);
  }

  return data;
}

// ───────────────────────────────────────────
// 1. 배송비 견적
// ───────────────────────────────────────────

/**
 * 배송비 견적 조회
 * @param {Object} params
 * @param {Object} params.recipient - { city, countryCode, postalCode? }
 * @param {Array}  params.packages  - [{ weight (kg), length (cm), width (cm), height (cm) }]
 * @param {string} [params.productGroup] - 'EXP' (Express) | 'DOM' (Domestic) — 기본값 EXP
 * @param {string} [params.productType]  - 'PPX' (Priority) | 'PDX' (Economy) | 'EPX' (Express Plus)
 */
async function getRates({ recipient, packages, productGroup = 'EXP', productType }) {
  const clientInfo = buildClientInfo();
  const shipper = getShipperInfo();

  // 총 중량 합산
  const totalWeight = packages.reduce((sum, p) => sum + p.weight, 0);

  // 부피 중량 계산 (가장 큰 패키지 기준)
  const volumeWeight = packages.reduce((max, p) => {
    const v = (p.length * p.width * p.height) / 5000; // Aramex 기준
    return Math.max(max, v);
  }, 0);

  const chargeableWeight = Math.max(totalWeight, volumeWeight);

  console.log('\n=== [Aramex] 배송비 견적 ===');
  console.log(`  목적지: ${recipient.countryCode} ${recipient.city || ''}`);
  console.log(`  실중량: ${totalWeight}kg, 부피중량: ${volumeWeight.toFixed(2)}kg, 청구중량: ${chargeableWeight.toFixed(2)}kg`);

  // productType이 없으면 Priority + Economy 두 견적 모두 조회
  const typesToQuery = productType
    ? [productType]
    : ['PPX', 'PDX'];

  const results = [];

  for (const type of typesToQuery) {
    try {
      const body = {
        ClientInfo: clientInfo,
        OriginAddress: {
          Line1: shipper.PartyAddress.Line1,
          City: shipper.PartyAddress.City,
          PostCode: shipper.PartyAddress.PostCode,
          CountryCode: shipper.PartyAddress.CountryCode,
        },
        DestinationAddress: {
          Line1: recipient.address || '',
          City: recipient.city || '',
          PostCode: recipient.postalCode || '',
          CountryCode: recipient.countryCode,
        },
        ShipmentDetails: {
          Dimensions: null,
          ActualWeight: { Unit: 'KG', Value: totalWeight },
          ChargeableWeight: { Unit: 'KG', Value: chargeableWeight },
          DescriptionOfGoods: 'K-Beauty Products',
          GoodsOriginCountry: 'KR',
          NumberOfPieces: packages.length,
          ProductGroup: productGroup,
          ProductType: type,
          PaymentType: 'P',  // P = Prepaid (발송인 부담)
          PaymentOptions: '',
          Services: '',
        },
        PreferredCurrencyCode: 'USD',
      };

      const data = await aramexRequest('rate/v1/RateCalculator', body);

      results.push({
        productType: type,
        productGroup,
        serviceName: type === 'PPX' ? 'Priority Parcel Express' : type === 'PDX' ? 'Priority Document Express' : type,
        totalAmount: data.TotalAmount?.Value || 0,
        currency: data.TotalAmount?.CurrencyCode || 'USD',
        transitDays: data.TransitDays || null,
        rateDetails: data.RateDetails || [],
      });
    } catch (e) {
      console.warn(`[Aramex] ${type} 견적 실패 (계속):`, e.message);
    }
  }

  console.log(`✅ [Aramex] 견적 완료: ${results.length}개 옵션`);
  return results;
}

// ───────────────────────────────────────────
// 2. 배송 생성 + 라벨 발급
// ───────────────────────────────────────────

/**
 * 배송 생성
 * @param {Object} params
 * @param {string} params.orderCode
 * @param {Object} params.recipient - { name, phone, email, address, city, stateOrProvince, postalCode, countryCode }
 * @param {Array}  params.packages  - [{ weight, length, width, height, description? }]
 * @param {string} [params.productType] - 'PPX' | 'PDX' | 'EPX' (기본값: PPX)
 * @param {string} [params.productGroup] - 'EXP' | 'DOM' (기본값: EXP)
 * @param {number} [params.declaredValue] - 신고 금액 (USD)
 * @param {string} [params.specialInstructions]
 */
async function createShipment({
  orderCode,
  recipient,
  packages,
  productType = 'PPX',
  productGroup = 'EXP',
  declaredValue = 0,
  specialInstructions = '',
}) {
  const clientInfo = buildClientInfo();
  const shipper = getShipperInfo();

  const totalWeight = packages.reduce((sum, p) => sum + p.weight, 0);
  const volumeWeight = packages.reduce((max, p) => {
    const v = (p.length * p.width * p.height) / 5000;
    return Math.max(max, v);
  }, 0);
  const chargeableWeight = Math.max(totalWeight, volumeWeight);

  console.log('\n=== [Aramex] 배송 생성 ===');
  console.log(`  주문: ${orderCode}`);
  console.log(`  목적지: ${recipient.countryCode} ${recipient.city}`);
  console.log(`  서비스: ${productGroup}/${productType}`);

  const shipmentDetails = {
    Dimensions: packages.length === 1 ? {
      Length: packages[0].length,
      Width: packages[0].width,
      Height: packages[0].height,
      Unit: 'CM',
    } : null,
    ActualWeight: { Unit: 'KG', Value: totalWeight },
    ChargeableWeight: { Unit: 'KG', Value: chargeableWeight },
    DescriptionOfGoods: packages[0]?.description || 'K-Beauty Products',
    GoodsOriginCountry: 'KR',
    NumberOfPieces: packages.length,
    ProductGroup: productGroup,
    ProductType: productType,
    PaymentType: 'P',
    PaymentOptions: '',
    Services: '',
    CashOnDeliveryAmount: { Value: 0, CurrencyCode: 'USD' },
    InsuranceAmount: { Value: declaredValue, CurrencyCode: 'USD' },
    CollectAmount: { Value: 0, CurrencyCode: 'USD' },
    CustomsValueAmount: { Value: declaredValue, CurrencyCode: 'USD' },
  };

  const body = {
    ClientInfo: clientInfo,
    LabelInfo: {
      ReportID: 9201,   // 9201 = Standard Thermal Label
      ReportType: 'URL',
    },
    Shipments: [{
      Shipper: shipper,
      Consignee: {
        Reference1: orderCode,
        AccountNumber: '',
        PartyAddress: {
          Line1: recipient.address,
          City: recipient.city,
          StateOrProvinceCode: recipient.stateOrProvince || '',
          PostCode: recipient.postalCode || '',
          CountryCode: recipient.countryCode,
        },
        Contact: {
          PersonName: recipient.name,
          CompanyName: recipient.company || '',
          PhoneNumber1: recipient.phone || '',
          EmailAddress: recipient.email || '',
        },
      },
      ShippingDateTime: new Date().toISOString(),
      DueDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      Comments: specialInstructions,
      PickupLocation: 'Reception',
      OperationsInstructions: '',
      AccountingInstrcutions: '',
      ServiceOptions: {
        CODAmount: { Value: 0, CurrencyCode: 'USD' },
        Insurance: false,
      },
      Pieces: packages.map((pkg, idx) => ({
        PackageType: 'Box',
        Quantity: 1,
        Weight: { Unit: 'KG', Value: pkg.weight },
        Comments: pkg.description || `Package ${idx + 1}`,
        Reference: `${orderCode}-${idx + 1}`,
        PiecesDimensions: {
          Length: pkg.length,
          Width: pkg.width,
          Height: pkg.height,
          Unit: 'CM',
        },
        CashOnDeliveryAmount: { Value: 0, CurrencyCode: 'USD' },
        InsuranceAmount: { Value: 0, CurrencyCode: 'USD' },
        CollectAmount: { Value: 0, CurrencyCode: 'USD' },
        CustomsValue: { Value: 0, CurrencyCode: 'USD' },
      })),
      ShipmentDetails: shipmentDetails,
      Reference1: orderCode,
      Reference2: '',
      Reference3: '',
      ForeignHAWB: '',
      TransportType: 0,
      PickupGUID: null,
      Number: null,
    }],
  };

  const data = await aramexRequest('shipping/v1/CreateShipments', body);

  const shipmentResult = data.Shipments?.[0];
  if (!shipmentResult) {
    throw new Error('Aramex shipment creation failed: no shipment returned');
  }

  const trackingNumber = shipmentResult.ID || shipmentResult.Number;
  const labelUrl = data.ShipmentLabel?.LabelURL || null;

  console.log(`✅ [Aramex] 배송 생성 완료`);
  console.log(`  추적번호: ${trackingNumber}`);
  console.log(`  라벨 URL: ${labelUrl || '없음'}`);

  return {
    trackingNumber,
    labelUrl,
    shipmentId: shipmentResult.ID,
    foreignHAWB: shipmentResult.ForeignHAWB || null,
    chargeableWeight,
    totalWeight,
  };
}

// ───────────────────────────────────────────
// 3. 배송 추적
// ───────────────────────────────────────────

/**
 * 배송 추적 (복수 추적번호 동시 조회 가능)
 * @param {string|string[]} trackingNumbers
 */
async function trackShipment(trackingNumbers) {
  const clientInfo = buildClientInfo();
  const nums = Array.isArray(trackingNumbers) ? trackingNumbers : [trackingNumbers];

  console.log('\n=== [Aramex] 배송 추적 ===');
  console.log(`  추적번호: ${nums.join(', ')}`);

  const body = {
    ClientInfo: clientInfo,
    Shipments: nums,
    GetLastTrackingUpdateOnly: false,
  };

  const data = await aramexRequest('tracking/v1/TrackShipments', body);

  const results = (data.TrackingResults || []).map(result => {
    const details = result.Value;
    if (!details || details.length === 0) {
      return { trackingNumber: result.Key, status: 'UNKNOWN', events: [] };
    }

    const latest = details[0];
    return {
      trackingNumber: result.Key,
      status: latest.UpdateCode || 'UNKNOWN',
      statusDescription: latest.UpdateDescription || '',
      updateDateTime: latest.UpdateDateTime || null,
      updateLocation: latest.UpdateLocation || '',
      events: details.map(e => ({
        timestamp: e.UpdateDateTime,
        statusCode: e.UpdateCode,
        description: e.UpdateDescription,
        location: e.UpdateLocation,
        comments: e.Comments || '',
      })),
    };
  });

  console.log(`✅ [Aramex] 추적 완료: ${results.length}개`);
  return results.length === 1 ? results[0] : results;
}

// ───────────────────────────────────────────
// 4. 픽업 예약
// ───────────────────────────────────────────

/**
 * 픽업 예약
 * @param {Object} params
 * @param {string} params.pickupDate  - ISO date string (예: '2025-06-10T10:00:00')
 * @param {string} params.readyTime   - HH:MM (예: '10:00')
 * @param {string} params.closeTime   - HH:MM (예: '18:00')
 * @param {number} params.totalWeight - 총 중량 (kg)
 * @param {number} params.totalPieces - 총 박스 수
 * @param {string} [params.notes]
 */
async function schedulePickup({
  pickupDate,
  readyTime = '10:00',
  closeTime = '18:00',
  totalWeight,
  totalPieces,
  notes = '',
}) {
  const clientInfo = buildClientInfo();
  const shipper = getShipperInfo();

  console.log('\n=== [Aramex] 픽업 예약 ===');
  console.log(`  날짜: ${pickupDate}`);
  console.log(`  준비 시간: ${readyTime} ~ ${closeTime}`);

  const pickupDateObj = new Date(pickupDate);

  const body = {
    ClientInfo: clientInfo,
    Pickup: {
      PickupAddress: shipper.PartyAddress,
      PickupContact: shipper.Contact,
      PickupLocation: 'Reception',
      PickupDate: pickupDate,
      ReadyTime: readyTime,
      LastPickupTime: closeTime,
      ClosingTime: closeTime,
      Status: 'Ready',
      CargoDetails: [{
        Dimensions: null,
        ActualWeight: { Unit: 'KG', Value: totalWeight },
        ChargeableWeight: { Unit: 'KG', Value: totalWeight },
        DescriptionOfGoods: 'K-Beauty Products',
        GoodsOriginCountry: 'KR',
        NumberOfPieces: totalPieces,
        ProductGroup: 'EXP',
        ProductType: 'PPX',
        PaymentType: 'P',
        PaymentOptions: '',
        Services: '',
      }],
    },
    Comments: notes,
  };

  const data = await aramexRequest('pickup/v1/CreatePickup', body);

  const pickupId = data.ProcessedPickup?.ID;
  console.log(`✅ [Aramex] 픽업 예약 완료: ${pickupId}`);

  return {
    pickupId,
    guid: data.ProcessedPickup?.GUID || null,
    pickupDate,
    readyTime,
    closeTime,
  };
}

/**
 * 픽업 취소
 * @param {string} pickupId - schedulePickup에서 받은 ID
 */
async function cancelPickup(pickupId) {
  const clientInfo = buildClientInfo();

  console.log('\n=== [Aramex] 픽업 취소 ===');
  console.log(`  픽업 ID: ${pickupId}`);

  const body = {
    ClientInfo: clientInfo,
    PickupID: pickupId,
    Comments: 'Cancelled by admin',
  };

  const data = await aramexRequest('pickup/v1/CancelPickup', body);

  console.log('✅ [Aramex] 픽업 취소 완료');
  return { pickupId, cancelled: true };
}

// ───────────────────────────────────────────
// 5. 주소 검증
// ───────────────────────────────────────────

/**
 * 배송 가능 여부 확인 (Aramex 서비스 지역 조회)
 * @param {Object} address - { city, countryCode, postalCode? }
 */
async function validateAddress({ city, countryCode, postalCode }) {
  const clientInfo = buildClientInfo();

  console.log('\n=== [Aramex] 서비스 지역 확인 ===');
  console.log(`  주소: ${countryCode} ${city}`);

  // Aramex Location Validator
  const body = {
    ClientInfo: clientInfo,
    Transaction: null,
    AddressLine: '',
    City: city || '',
    CountryCode: countryCode,
    State: '',
    PostCode: postalCode || '',
  };

  try {
    const data = await aramexRequest('location/v1/ValidateAddress', body);

    const isValid = !data.HasErrors && (data.Result === 1 || data.Result === 0);
    console.log(`✅ [Aramex] 주소 검증: ${isValid ? '유효' : '무효'}`);

    return {
      isValid,
      result: data.Result,
      suggestedCity: data.Address?.City || city,
      suggestedCountryCode: data.Address?.CountryCode || countryCode,
    };
  } catch (e) {
    // 주소 검증 실패해도 배송은 시도할 수 있음
    console.warn('[Aramex] 주소 검증 실패 (서비스 자체는 가능할 수 있음):', e.message);
    return { isValid: null, error: e.message };
  }
}

// ───────────────────────────────────────────
// 설정 상태
// ───────────────────────────────────────────

function isConfigured() {
  return !!(
    process.env.ARAMEX_USERNAME &&
    process.env.ARAMEX_PASSWORD &&
    process.env.ARAMEX_ACCOUNT_NUMBER &&
    process.env.ARAMEX_ACCOUNT_PIN
  );
}

module.exports = {
  getRates,
  createShipment,
  trackShipment,
  schedulePickup,
  cancelPickup,
  validateAddress,
  isConfigured,
};
