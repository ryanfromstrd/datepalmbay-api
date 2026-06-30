/**
 * 통화 변환 서비스
 * - 회원 가입국가 → ISO 4217 통화코드 매핑
 * - PayPal이 실제로 결제(currency_code)를 받아주는 통화만 "실청구" 대상으로 허용
 * - 나머지(주로 MENA: AED/SAR/QAR/KWD/BHD/OMR/JOD/EGP/MAD/DZD/TND/LBP/IQD/YER/LYD 등)는 USD로 폴백
 */

const fs = require('fs');
const path = require('path');

const nodeFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : require('node-fetch');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const CACHE_FILE = path.join(DATA_DIR, 'fx-rates-cache.json');
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12시간마다 갱신

// PayPal Orders API가 실제로 받아주는 통화 코드 (USD 제외 거래통화 목록)
// https://developer.paypal.com/api/rest/reference/currency-codes/
const PAYPAL_SUPPORTED_CURRENCIES = [
  'AUD', 'CAD', 'CZK', 'DKK', 'EUR', 'HKD', 'HUF', 'ILS', 'JPY', 'MYR',
  'MXN', 'TWD', 'NZD', 'NOK', 'PHP', 'PLN', 'GBP', 'SGD', 'SEK', 'CHF', 'THB',
  // BRL/CNY/RUB는 PayPal 계정 설정에 따라 수신 제한이 있을 수 있어 자동 실청구 대상에서 제외 (필요 시 추가)
];

// 통화별 소수 자릿수 (PayPal 기준 무소수점 통화)
const ZERO_DECIMAL_CURRENCIES = ['JPY', 'HUF', 'TWD'];

// 회원 가입국가(enum key) → ISO 4217 통화코드
const COUNTRY_TO_CURRENCY = {
  AFGHANISTAN: 'AFN', ALBANIA: 'ALL', ALGERIA: 'DZD', ANDORRA: 'EUR', ANGOLA: 'AOA',
  ANTIGUA_AND_BARBUDA: 'XCD', ARGENTINA: 'ARS', ARMENIA: 'AMD', AUSTRALIA: 'AUD', AUSTRIA: 'EUR',
  AZERBAIJAN: 'AZN', BAHAMAS: 'BSD', BAHRAIN: 'BHD', BANGLADESH: 'BDT', BARBADOS: 'BBD',
  BELARUS: 'BYN', BELGIUM: 'EUR', BELIZE: 'BZD', BENIN: 'XOF', BHUTAN: 'BTN',
  BOLIVIA: 'BOB', BOSNIA_AND_HERZEGOVINA: 'BAM', BOTSWANA: 'BWP', BRAZIL: 'BRL', BRUNEI: 'BND',
  BULGARIA: 'BGN', BURKINA_FASO: 'XOF', BURUNDI: 'BIF', CABO_VERDE: 'CVE', CAMBODIA: 'KHR',
  CAMEROON: 'XAF', CANADA: 'CAD', CENTRAL_AFRICAN_REPUBLIC: 'XAF', CHAD: 'XAF', CHILE: 'CLP',
  CHINA: 'CNY', COLOMBIA: 'COP', COMOROS: 'KMF', CONGO: 'XAF', COSTA_RICA: 'CRC',
  CROATIA: 'EUR', CUBA: 'CUP', CYPRUS: 'EUR', CZECH_REPUBLIC: 'CZK', DENMARK: 'DKK',
  DJIBOUTI: 'DJF', DOMINICA: 'XCD', DOMINICAN_REPUBLIC: 'DOP', DR_CONGO: 'CDF', ECUADOR: 'USD',
  EGYPT: 'EGP', EL_SALVADOR: 'USD', EQUATORIAL_GUINEA: 'XAF', ERITREA: 'ERN', ESTONIA: 'EUR',
  ESWATINI: 'SZL', ETHIOPIA: 'ETB', FIJI: 'FJD', FINLAND: 'EUR', FRANCE: 'EUR',
  GABON: 'XAF', GAMBIA: 'GMD', GEORGIA: 'GEL', GERMANY: 'EUR', GHANA: 'GHS',
  GREECE: 'EUR', GRENADA: 'XCD', GUATEMALA: 'GTQ', GUINEA: 'GNF', GUINEA_BISSAU: 'XOF',
  GUYANA: 'GYD', HAITI: 'HTG', HONDURAS: 'HNL', HUNGARY: 'HUF', ICELAND: 'ISK',
  INDIA: 'INR', INDONESIA: 'IDR', IRAN: 'IRR', IRAQ: 'IQD', IRELAND: 'EUR',
  ISRAEL: 'ILS', ITALY: 'EUR', IVORY_COAST: 'XOF', JAMAICA: 'JMD', JAPAN: 'JPY',
  JORDAN: 'JOD', KAZAKHSTAN: 'KZT', KENYA: 'KES', KIRIBATI: 'AUD', KOSOVO: 'EUR',
  KUWAIT: 'KWD', KYRGYZSTAN: 'KGS', LAOS: 'LAK', LATVIA: 'EUR', LEBANON: 'LBP',
  LESOTHO: 'LSL', LIBERIA: 'LRD', LIBYA: 'LYD', LIECHTENSTEIN: 'CHF', LITHUANIA: 'EUR',
  LUXEMBOURG: 'EUR', MADAGASCAR: 'MGA', MALAWI: 'MWK', MALAYSIA: 'MYR', MALDIVES: 'MVR',
  MALI: 'XOF', MALTA: 'EUR', MARSHALL_ISLANDS: 'USD', MAURITANIA: 'MRU', MAURITIUS: 'MUR',
  MEXICO: 'MXN', MICRONESIA: 'USD', MOLDOVA: 'MDL', MONACO: 'EUR', MONGOLIA: 'MNT',
  MONTENEGRO: 'EUR', MOROCCO: 'MAD', MOZAMBIQUE: 'MZN', MYANMAR: 'MMK', NAMIBIA: 'NAD',
  NAURU: 'AUD', NEPAL: 'NPR', NETHERLANDS: 'EUR', NEW_ZEALAND: 'NZD', NICARAGUA: 'NIO',
  NIGER: 'XOF', NIGERIA: 'NGN', NORTH_KOREA: 'KPW', NORTH_MACEDONIA: 'MKD', NORWAY: 'NOK',
  OMAN: 'OMR', PAKISTAN: 'PKR', PALAU: 'USD', PALESTINE: 'ILS', PANAMA: 'USD',
  PAPUA_NEW_GUINEA: 'PGK', PARAGUAY: 'PYG', PERU: 'PEN', PHILIPPINES: 'PHP', POLAND: 'PLN',
  PORTUGAL: 'EUR', QATAR: 'QAR', ROMANIA: 'RON', RUSSIA: 'RUB', RWANDA: 'RWF',
  SAINT_KITTS_AND_NEVIS: 'XCD', SAINT_LUCIA: 'XCD', SAINT_VINCENT: 'XCD', SAMOA: 'WST', SAN_MARINO: 'EUR',
  SAO_TOME_AND_PRINCIPE: 'STN', SAUDI_ARABIA: 'SAR', SENEGAL: 'XOF', SERBIA: 'RSD', SEYCHELLES: 'SCR',
  SIERRA_LEONE: 'SLE', SINGAPORE: 'SGD', SLOVAKIA: 'EUR', SLOVENIA: 'EUR', SOLOMON_ISLANDS: 'SBD',
  SOMALIA: 'SOS', SOUTH_AFRICA: 'ZAR', SOUTH_KOREA: 'KRW', SOUTH_SUDAN: 'SSP', SPAIN: 'EUR',
  SRI_LANKA: 'LKR', SUDAN: 'SDG', SURINAME: 'SRD', SWEDEN: 'SEK', SWITZERLAND: 'CHF',
  SYRIA: 'SYP', TAIWAN: 'TWD', TAJIKISTAN: 'TJS', TANZANIA: 'TZS', THAILAND: 'THB',
  TIMOR_LESTE: 'USD', TOGO: 'XOF', TONGA: 'TOP', TRINIDAD_AND_TOBAGO: 'TTD', TUNISIA: 'TND',
  TURKEY: 'TRY', TURKMENISTAN: 'TMT', TUVALU: 'AUD', UGANDA: 'UGX', UKRAINE: 'UAH',
  UNITED_ARAB_EMIRATES: 'AED', UNITED_KINGDOM: 'GBP', UNITED_STATES: 'USD', URUGUAY: 'UYU', UZBEKISTAN: 'UZS',
  VANUATU: 'VUV', VATICAN_CITY: 'EUR', VENEZUELA: 'VES', VIETNAM: 'VND', YEMEN: 'YER',
  ZAMBIA: 'ZMW', ZIMBABWE: 'ZWL',
};

let cachedRates = null; // { base: 'USD', rates: {...}, updatedAt: ISOString }

function loadCacheFromDisk() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      cachedRates = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    }
  } catch {
    cachedRates = null;
  }
}

function saveCacheToDisk() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cachedRates, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Currency] FX 캐시 저장 실패:', err.message);
  }
}

loadCacheFromDisk();

async function fetchLatestRates() {
  // open.er-api.com: 무료, API 키 불필요, 넓은 통화 커버리지
  const response = await nodeFetch('https://open.er-api.com/v6/latest/USD');
  if (!response.ok) throw new Error(`FX rate fetch failed: ${response.status}`);
  const data = await response.json();
  if (data.result !== 'success' || !data.rates) throw new Error('FX rate response malformed');
  return { base: 'USD', rates: data.rates, updatedAt: new Date().toISOString() };
}

// 캐시가 비어있거나 TTL이 지났으면 갱신, 실패 시 기존 캐시(있다면) 그대로 사용
async function getRates() {
  const isStale = !cachedRates || (Date.now() - new Date(cachedRates.updatedAt).getTime() > CACHE_TTL_MS);
  if (isStale) {
    try {
      cachedRates = await fetchLatestRates();
      saveCacheToDisk();
      console.log('[Currency] FX 환율 갱신 완료:', cachedRates.updatedAt);
    } catch (err) {
      console.error('[Currency] FX 환율 갱신 실패, 기존 캐시 사용:', err.message);
      if (!cachedRates) {
        // 캐시조차 없으면 환율 1:1(USD 그대로)로 폴백
        cachedRates = { base: 'USD', rates: { USD: 1 }, updatedAt: new Date().toISOString(), fallback: true };
      }
    }
  }
  return cachedRates;
}

// 회원 가입국가 → 실청구 가능한 통화코드 (PayPal 미지원이면 'USD' 폴백)
function getMemberCurrency(countryEnumKey) {
  const mapped = COUNTRY_TO_CURRENCY[countryEnumKey];
  if (!mapped) return 'USD';
  if (!PAYPAL_SUPPORTED_CURRENCIES.includes(mapped)) return 'USD';
  return mapped;
}

function roundForCurrency(amount, currency) {
  if (ZERO_DECIMAL_CURRENCIES.includes(currency)) return Math.round(amount);
  return Math.round(amount * 100) / 100;
}

// USD 금액 → 대상 통화로 변환 (환율 정보 포함 반환, 변환 실패 시 USD 그대로 반환)
async function convertFromUSD(amountUSD, targetCurrency) {
  if (targetCurrency === 'USD') {
    return { amount: amountUSD, currency: 'USD', fxRate: 1 };
  }
  const rates = await getRates();
  const rate = rates.rates?.[targetCurrency];
  if (!rate) {
    return { amount: amountUSD, currency: 'USD', fxRate: 1 };
  }
  return {
    amount: roundForCurrency(amountUSD * rate, targetCurrency),
    currency: targetCurrency,
    fxRate: rate,
  };
}

module.exports = {
  PAYPAL_SUPPORTED_CURRENCIES,
  COUNTRY_TO_CURRENCY,
  getRates,
  getMemberCurrency,
  convertFromUSD,
  roundForCurrency,
};
