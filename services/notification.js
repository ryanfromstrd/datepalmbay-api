/**
 * Admin notification service
 * Sends email (nodemailer) + SMS (Twilio) when a new order is placed.
 *
 * Required env vars:
 *   ADMIN_EMAIL          — destination address for order emails
 *   SMTP_HOST            — e.g. smtp.gmail.com
 *   SMTP_PORT            — e.g. 587
 *   SMTP_USER            — sender Gmail address
 *   SMTP_PASS            — Gmail App Password (not account password)
 *   ADMIN_PHONE_NUMBER   — E.164 format, e.g. +821012345678
 *   TWILIO_PHONE_NUMBER  — Twilio "from" number in E.164 format
 *   TWILIO_ACCOUNT_SID   — already used for OTP
 *   TWILIO_AUTH_TOKEN    — already used for OTP
 */

const nodemailer = require('nodemailer');

// ── Email ─────────────────────────────────────────────────────────────────────

function createTransporter() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) return null;

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

async function sendOrderEmail(order) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) {
    console.log('[Notification] ADMIN_EMAIL not set — skipping email');
    return;
  }

  const transporter = createTransporter();
  if (!transporter) {
    console.log('[Notification] SMTP not configured — skipping email');
    return;
  }

  const currency = order.currency || 'USD';
  const amount = new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(order.amount || 0);
  const orderDate = new Date(order.approvedAt || Date.now()).toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #27ae60;">🛒 New Order Received</h2>
      <table style="width:100%; border-collapse:collapse; font-size:14px;">
        <tr><td style="padding:8px; border-bottom:1px solid #eee; color:#666; width:40%;">Order ID</td><td style="padding:8px; border-bottom:1px solid #eee;"><strong>${order.orderId}</strong></td></tr>
        <tr><td style="padding:8px; border-bottom:1px solid #eee; color:#666;">Order Code</td><td style="padding:8px; border-bottom:1px solid #eee;">${order.orderCode || '-'}</td></tr>
        <tr><td style="padding:8px; border-bottom:1px solid #eee; color:#666;">Product</td><td style="padding:8px; border-bottom:1px solid #eee;">${order.productName || '-'}</td></tr>
        <tr><td style="padding:8px; border-bottom:1px solid #eee; color:#666;">Quantity</td><td style="padding:8px; border-bottom:1px solid #eee;">${order.quantity || '-'}</td></tr>
        <tr><td style="padding:8px; border-bottom:1px solid #eee; color:#666;">Amount</td><td style="padding:8px; border-bottom:1px solid #eee;"><strong>${amount}</strong></td></tr>
        <tr><td style="padding:8px; border-bottom:1px solid #eee; color:#666;">Customer</td><td style="padding:8px; border-bottom:1px solid #eee;">${order.ordererName || '-'}</td></tr>
        <tr><td style="padding:8px; border-bottom:1px solid #eee; color:#666;">Email</td><td style="padding:8px; border-bottom:1px solid #eee;">${order.ordererEmail || '-'}</td></tr>
        <tr><td style="padding:8px; border-bottom:1px solid #eee; color:#666;">Contact</td><td style="padding:8px; border-bottom:1px solid #eee;">${order.ordererContact || '-'}</td></tr>
        <tr><td style="padding:8px; border-bottom:1px solid #eee; color:#666;">Ship To</td><td style="padding:8px; border-bottom:1px solid #eee;">${order.destinationCountry || ''} ${order.recipientAddress || order.address || ''}</td></tr>
        <tr><td style="padding:8px; color:#666;">Date</td><td style="padding:8px;">${orderDate}</td></tr>
      </table>
      <p style="margin-top:24px;">
        <a href="https://admin-datepalmbay.vercel.app" style="background:#3498db; color:#fff; padding:10px 20px; border-radius:6px; text-decoration:none; font-size:14px;">View in Admin</a>
      </p>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: `"DatepalmBay Orders" <${process.env.SMTP_USER}>`,
      to: adminEmail,
      subject: `[DatepalmBay] New Order — ${order.productName || ''} (${amount})`,
      html,
    });
    console.log(`[Notification] Order email sent to ${adminEmail}`);
  } catch (err) {
    console.error('[Notification] Email send failed:', err.message);
  }
}

// ── SMS ───────────────────────────────────────────────────────────────────────

async function sendOrderSms(order, twilioClient) {
  const adminPhone = process.env.ADMIN_PHONE_NUMBER;
  const fromPhone = process.env.TWILIO_PHONE_NUMBER;

  if (!adminPhone || !fromPhone) {
    console.log('[Notification] ADMIN_PHONE_NUMBER or TWILIO_PHONE_NUMBER not set — skipping SMS');
    return;
  }

  if (!twilioClient) {
    console.log('[Notification] Twilio client not initialized — skipping SMS');
    return;
  }

  const currency = order.currency || 'USD';
  const amount = new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(order.amount || 0);

  const body = `[DatepalmBay] 새 주문 🛒\n상품: ${order.productName || '-'}\n금액: ${amount}\n고객: ${order.ordererName || '-'}\n주문ID: ${order.orderId}`;

  try {
    await twilioClient.messages.create({ body, from: fromPhone, to: adminPhone });
    console.log(`[Notification] Order SMS sent to ${adminPhone}`);
  } catch (err) {
    console.error('[Notification] SMS send failed:', err.message);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

async function notifyAdminNewOrder(order, twilioClient) {
  console.log('\n=== [Notification] New order alert ===');
  await Promise.allSettled([
    sendOrderEmail(order),
    sendOrderSms(order, twilioClient),
  ]);
}

module.exports = { notifyAdminNewOrder };
