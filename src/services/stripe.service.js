const crypto = require('node:crypto');
function configured() { return /^sk_test_/.test(process.env.STRIPE_SECRET_KEY || '') && !!process.env.STRIPE_WEBHOOK_SECRET; }
async function request(endpoint, {method='GET', params={}, key} = {}) {
  if (!configured()) { const err = new Error('ยังไม่ได้ตั้งค่า Stripe โหมดทดสอบและ webhook ที่ backend'); err.statusCode=503; throw err; }
  const query = new URLSearchParams(params);
  const response = await fetch(`https://api.stripe.com/v1/${endpoint}${method === 'GET' && query.size ? `?${query}` : ''}`, {
    method, headers:{Authorization:`Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type':'application/x-www-form-urlencoded', ...(key ? {'Idempotency-Key':key}:{})},
    ...(method === 'POST' ? {body:query.toString()}:{}), signal:AbortSignal.timeout(20000),
  });
  const data = await response.json();
  if (!response.ok) { const err = new Error('Stripe ไม่สามารถดำเนินการได้ กรุณาลองใหม่หรือตรวจสอบการตั้งค่า'); err.statusCode=502; throw err; }
  return data;
}
function verify(body, signature, now = Date.now()) {
  const parts = String(signature || '').split(',').map(v => v.split('='));
  const timestamp = parts.find(p => p[0] === 't')?.[1];
  if (!process.env.STRIPE_WEBHOOK_SECRET || !/^\d+$/.test(timestamp || '') || Math.abs(now/1000-Number(timestamp)) > 300 || !Buffer.isBuffer(body)) throw new Error('Invalid webhook signature');
  const expected = crypto.createHmac('sha256',process.env.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.`).update(body).digest();
  if (!parts.filter(p => p[0] === 'v1' && /^[a-f0-9]{64}$/.test(p[1])).some(p => crypto.timingSafeEqual(expected,Buffer.from(p[1],'hex')))) throw new Error('Invalid webhook signature');
  return JSON.parse(body.toString('utf8'));
}
module.exports = {configured,request,verify};
