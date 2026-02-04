/**
 * Eximbay Payment API Service
 * https://developer.eximbay.com/eng/eximbay/api_list/reference.html
 *
 * Test Environment: https://api-test.eximbay.com
 * Production Environment: https://api.eximbay.com
 */

const crypto = require('crypto');

const EXIMBAY_API_BASE = process.env.EXIMBAY_MODE === 'production'
  ? 'https://api.eximbay.com'
  : 'https://api-test.eximbay.com';

/**
 * Get Basic Auth header
 */
function getAuthHeader() {
  const apiKey = process.env.EXIMBAY_API_KEY;
  if (!apiKey) {
    throw new Error('EXIMBAY_API_KEY not configured');
  }
  // Format: Basic Base64(API_KEY:)
  const auth = Buffer.from(`${apiKey}:`).toString('base64');
  return `Basic ${auth}`;
}

/**
 * Generate FGKey for request validation
 * @param {string} secretKey - Merchant secret key
 * @param {Object} params - Request parameters
 * @returns {string} SHA-256 hash
 */
function generateFGKey(secretKey, params) {
  // Sort parameters alphabetically
  const sortedKeys = Object.keys(params).sort();
  const sortedData = sortedKeys.map(key => `${key}=${params[key]}`).join('&');

  // Combine secretKey with sorted data
  const dataToHash = `${secretKey}?${sortedData}`;

  // SHA-256 hash
  return crypto.createHash('sha256').update(dataToHash).digest('hex');
}

/**
 * Payment Preparation - Get FGKey for SDK initialization
 * POST /v1/payments/ready
 *
 * @param {Object} paymentData
 * @param {string} paymentData.orderId - Unique order ID
 * @param {number} paymentData.amount - Payment amount
 * @param {string} paymentData.currency - Currency code (USD, KRW, etc.)
 * @param {string} paymentData.orderName - Order description
 * @param {Object} paymentData.buyer - Buyer info { name, email, phone }
 * @param {string} paymentData.returnUrl - Success redirect URL
 * @param {string} paymentData.statusUrl - Server callback URL
 */
async function preparePayment(paymentData) {
  const { orderId, amount, currency, orderName, buyer, returnUrl, statusUrl } = paymentData;

  const payload = {
    payment: {
      transaction_type: 'PAYMENT',
      order_id: orderId,
      currency: currency || 'USD',
      amount: amount.toString(),
      lang: 'EN',
      product_name: orderName,
    },
    merchant: {
      mid: process.env.EXIMBAY_MID,
    },
    buyer: {
      name: buyer.name,
      email: buyer.email,
      phone: buyer.phone || '',
    },
    url: {
      return_url: returnUrl,
      status_url: statusUrl,
    },
  };

  console.log('\n=== [Eximbay] Payment Preparation ===');
  console.log('Order ID:', orderId);
  console.log('Amount:', amount, currency);

  const response = await fetch(`${EXIMBAY_API_BASE}/v1/payments/ready`, {
    method: 'POST',
    headers: {
      'Authorization': getAuthHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();

  if (data.rescode !== '0000') {
    console.error('Eximbay prepare error:', data);
    throw new Error(data.resmsg || 'Failed to prepare Eximbay payment');
  }

  console.log('FGKey generated:', data.fgkey?.substring(0, 20) + '...');
  return {
    fgkey: data.fgkey,
    mid: process.env.EXIMBAY_MID,
    ...payload.payment,
    buyer: payload.buyer,
    returnUrl,
    statusUrl,
  };
}

/**
 * Verify Payment - Validate payment after SDK callback
 * POST /v1/payments/verify
 *
 * @param {Object} verifyData - Payment result from SDK callback
 */
async function verifyPayment(verifyData) {
  const {
    fgkey,
    orderId,
    transactionId,
    amount,
    currency,
    rescode,
    resmsg,
    authCode
  } = verifyData;

  const payload = {
    version: '230101',
    mid: process.env.EXIMBAY_MID,
    fgkey: fgkey,
    transaction_type: 'PAYMENT',
    order_id: orderId,
    currency: currency || 'USD',
    amount: amount.toString(),
    rescode: rescode,
    resmsg: resmsg,
    transaction_id: transactionId,
    auth_code: authCode || '',
  };

  console.log('\n=== [Eximbay] Payment Verification ===');
  console.log('Order ID:', orderId);
  console.log('Transaction ID:', transactionId);

  const response = await fetch(`${EXIMBAY_API_BASE}/v1/payments/verify`, {
    method: 'POST',
    headers: {
      'Authorization': getAuthHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();

  if (data.rescode !== '0000') {
    console.error('Eximbay verify error:', data);
    throw new Error(data.resmsg || 'Failed to verify Eximbay payment');
  }

  console.log('Payment verified. Status:', data.payment?.status);
  return data;
}

/**
 * Retrieve Payment - Get transaction details
 * POST /v1/payments/retrieve
 *
 * @param {Object} queryData
 * @param {string} queryData.orderId - Order ID
 * @param {string} queryData.transactionId - Transaction ID (optional)
 */
async function retrievePayment({ orderId, transactionId }) {
  const payload = {
    mid: process.env.EXIMBAY_MID,
  };

  if (transactionId) {
    payload.transaction_id = transactionId;
  } else {
    payload.order_id = orderId;
  }

  const response = await fetch(`${EXIMBAY_API_BASE}/v1/payments/retrieve`, {
    method: 'POST',
    headers: {
      'Authorization': getAuthHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();

  if (data.rescode !== '0000') {
    throw new Error(data.resmsg || 'Failed to retrieve payment');
  }

  return data;
}

/**
 * Refund Payment
 * POST /v1/payments/{transaction_id}/cancel
 *
 * @param {Object} refundData
 * @param {string} refundData.transactionId - Transaction ID to refund
 * @param {string} refundData.refundType - 'F' (full) or 'P' (partial)
 * @param {number} refundData.refundAmount - Amount to refund
 * @param {string} refundData.reason - Refund reason
 * @param {number} refundData.balance - Current refundable balance
 */
async function refundPayment(refundData) {
  const { transactionId, refundType, refundAmount, reason, balance } = refundData;

  const payload = {
    mid: process.env.EXIMBAY_MID,
    refund: {
      refund_type: refundType || 'F',
      refund_amount: refundAmount.toString(),
      refund_id: `REFUND-${Date.now()}`,
      reason: reason || 'Customer request',
    },
    payment: {
      balance: balance.toString(),
    },
  };

  console.log('\n=== [Eximbay] Payment Refund ===');
  console.log('Transaction ID:', transactionId);
  console.log('Refund Amount:', refundAmount);

  const response = await fetch(`${EXIMBAY_API_BASE}/v1/payments/${transactionId}/cancel`, {
    method: 'POST',
    headers: {
      'Authorization': getAuthHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();

  if (data.rescode !== '0000') {
    console.error('Eximbay refund error:', data);
    throw new Error(data.resmsg || 'Failed to refund payment');
  }

  console.log('Refund completed. Date:', data.refund_date);
  return data;
}

module.exports = {
  preparePayment,
  verifyPayment,
  retrievePayment,
  refundPayment,
  generateFGKey,
};
