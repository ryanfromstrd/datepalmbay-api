/**
 * PayPal REST API Service
 * https://developer.paypal.com/docs/api/orders/v2/
 */

// Node.js < 18 fetch polyfill
const nodeFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : require('node-fetch');

// Sandbox defaults (development mock server only)
const SANDBOX_CLIENT_ID = 'Ac7DmyOag05FDBBBPBt9qytCheK3Sg8n9k7C8fwqcbkAkqaujgZFaC7j8unqx6vXwyeBWIXvVTNypYJi';
const SANDBOX_CLIENT_SECRET = 'ENNVrE6wFMBcb5EOSbxTHaBDLAP51C778WAhxd-jgGgU54KhOmVuWcV2E4i5i-37TW7h0hkYF7USFuta';

const PAYPAL_MODE = process.env.PAYPAL_MODE || 'sandbox';
const PAYPAL_API_BASE = PAYPAL_MODE === 'sandbox'
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com';

/**
 * Get PayPal access token
 */
async function getAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID || SANDBOX_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET || SANDBOX_CLIENT_SECRET;

  console.log('\n=== [PayPal] Authentication Debug ===');
  console.log('PAYPAL_MODE:', PAYPAL_MODE);
  console.log('API Base:', PAYPAL_API_BASE);
  console.log('Client ID loaded:', clientId ? `${clientId.substring(0, 10)}...` : 'NOT SET');
  console.log('Client Secret loaded:', clientSecret ? `${clientSecret.substring(0, 10)}...` : 'NOT SET');

  if (!clientId || !clientSecret) {
    throw new Error('PayPal credentials not configured');
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await nodeFetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`PayPal auth failed: ${error}`);
  }

  const data = await response.json();
  return data.access_token;
}

/**
 * Create PayPal order
 * @param {Object} orderData - Order details
 * @param {string} orderData.orderId - Internal order ID
 * @param {number} orderData.amount - Amount in USD (or configured currency)
 * @param {string} orderData.orderName - Order description
 * @param {string} orderData.currency - Currency code (default: USD)
 */
async function createOrder({ orderId, amount, orderName, currency = 'USD' }) {
  const accessToken = await getAccessToken();

  const payload = {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: orderId,
        description: orderName,
        amount: {
          currency_code: currency,
          value: amount.toFixed(2),
        },
      },
    ],
    application_context: {
      brand_name: 'Datepalm Bay',
      landing_page: 'NO_PREFERENCE',
      user_action: 'PAY_NOW',
      return_url: 'https://example.com/success', // Will be handled by frontend
      cancel_url: 'https://example.com/cancel',
    },
  };

  console.log('\n=== [PayPal] Creating Order ===');
  console.log('Payload:', JSON.stringify(payload, null, 2));

  const response = await nodeFetch(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('PayPal create order error:', data);
    throw new Error(data.message || 'Failed to create PayPal order');
  }

  console.log('PayPal Order Created:', data.id);
  return data;
}

/**
 * Capture PayPal order (after user approves)
 * @param {string} paypalOrderId - PayPal order ID
 */
async function captureOrder(paypalOrderId) {
  const accessToken = await getAccessToken();

  console.log('\n=== [PayPal] Capturing Order ===');
  console.log('PayPal Order ID:', paypalOrderId);

  const response = await nodeFetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${paypalOrderId}/capture`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('PayPal capture error:', data);
    throw new Error(data.message || 'Failed to capture PayPal order');
  }

  console.log('PayPal Order Captured:', data.status);
  return data;
}

/**
 * Get PayPal order details
 * @param {string} paypalOrderId - PayPal order ID
 */
async function getOrder(paypalOrderId) {
  const accessToken = await getAccessToken();

  const response = await nodeFetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${paypalOrderId}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || 'Failed to get PayPal order');
  }

  return data;
}

/**
 * Refund a captured payment
 * @param {string} captureId - PayPal capture ID
 * @param {Object} refundData - Refund details
 */
async function refundPayment(captureId, refundData = {}) {
  const accessToken = await getAccessToken();

  console.log('\n=== [PayPal] Refunding Payment ===');
  console.log('Capture ID:', captureId);

  const response = await nodeFetch(`${PAYPAL_API_BASE}/v2/payments/captures/${captureId}/refund`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(refundData),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('PayPal refund error:', data);
    throw new Error(data.message || 'Failed to refund PayPal payment');
  }

  console.log('PayPal Refund Completed:', data.status);
  return data;
}

module.exports = {
  createOrder,
  captureOrder,
  getOrder,
  refundPayment,
};
