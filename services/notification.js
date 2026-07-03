/**
 * Admin notification service — Telegram only
 *
 * Required env vars:
 *   TELEGRAM_BOT_TOKEN  — from @BotFather
 *   TELEGRAM_CHAT_ID    — your chat ID (get from @userinfobot)
 */

const nodeFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : require('node-fetch');

async function notifyAdminNewOrder(order) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log('[Notification] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — skipping');
    return;
  }

  const currency = order.currency || 'USD';
  const amount = new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(order.amount || 0);
  const date = new Date(order.approvedAt || Date.now()).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });

  const text = [
    '*데이트팜베이 새 주문이 들어왔습니다 !*',
    '',
    `상품: ${order.productName || '-'}`,
    `수량: ${order.quantity || '-'}`,
    `결제금액: ${amount}`,
    `고객: ${order.ordererName || '-'}`,
    `이메일: ${order.ordererEmail || '-'}`,
    `연락처: ${order.ordererContact || '-'}`,
    `배송국가: ${order.destinationCountry || '-'}`,
    `주문ID: \`${order.orderId}\``,
    `결제시각: ${date}`,
  ].join('\n');

  try {
    const response = await nodeFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });

    const data = await response.json();
    if (data.ok) {
      console.log('[Notification] Telegram message sent');
    } else {
      console.error('[Notification] Telegram error:', data.description);
    }
  } catch (err) {
    console.error('[Notification] Telegram send failed:', err.message);
  }
}

module.exports = { notifyAdminNewOrder };
