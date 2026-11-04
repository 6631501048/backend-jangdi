const crypto = require('node:crypto');
function configured() { return /^sk_test_/.test(process.env.STRIPE_SECRET_KEY || '') && !!process.env.STRIPE_WEBHOOK_SECRET; }
async function request(endpoint, {method='GET', params={}, key} = {}) {
  if (!configured()) { const err = new Error('ยังไม่ได้ตั้งค่า Stripe โหมดทดสอบและ webhook ที่ backend'); err.statusCode=503; throw err; }
  const query = new URLSearchParams(params);
  let response;
  try { response = await fetch(`https://api.stripe.com/v1/${endpoint}${method === 'GET' && query.size ? `?${query}` : ''}`, {
    method, headers:{Authorization:`Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type':'application/x-www-form-urlencoded', ...(key ? {'Idempotency-Key':key}:{})},
    ...(method === 'POST' ? {body:query.toString()}:{}), signal:AbortSignal.timeout(20000),
  }); } catch {
    throw Object.assign(new Error('เชื่อมต่อ Stripe ไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตของ backend แล้วลองใหม่'),{statusCode:502,code:'STRIPE_CONNECTION_FAILED'});
  }
  let data;
  try { data = await response.json(); } catch {
    throw Object.assign(new Error('Stripe ตอบกลับไม่สมบูรณ์ กรุณาลองใหม่ภายหลัง'),{statusCode:502,code:'STRIPE_INVALID_RESPONSE'});
  }
  if (!response.ok) {
    const safeToken = value => typeof value === 'string' && /^[a-zA-Z0-9_\[\].-]{1,160}$/.test(value) ? value : undefined;
    const details = {status:response.status,type:safeToken(data.error?.type),code:safeToken(data.error?.code),param:safeToken(data.error?.param)};
    // Do not log provider messages, request payloads, URLs or credentials.
    console.warn('Stripe request rejected',details);
    let message='Stripe ปฏิเสธคำขอ กรุณาให้ผู้ดูแลตรวจสอบรหัสข้อผิดพลาดใน backend';
    if (response.status === 401) message='Stripe test key ไม่ถูกต้องหรือถูกเพิกถอน กรุณาอัปเดต backend/.env แล้ว restart backend';
    else if (response.status === 403) message='Stripe key ไม่มีสิทธิ์ทำรายการนี้ กรุณาตรวจสิทธิ์และ sandbox ของบัญชี';
    else if (response.status === 429) message='เรียก Stripe ถี่เกินไป กรุณารอสักครู่แล้วลองใหม่';
    else if (details.code === 'resource_missing') message='ไม่พบรายการ Stripe ใน sandbox ปัจจุบัน กรุณาตรวจว่าใช้บัญชีและ sandbox เดียวกับที่สร้างรายการ';
    else if (details.code === 'amount_too_small') message='ยอดชำระต่ำกว่าขั้นต่ำที่ Stripe รองรับ กรุณาตรวจยอดของงานทดสอบ';
    else if (['payment_method_types','allowed_payment_method_types'].includes(details.param)) message='Stripe ไม่รับการตั้งค่าวิธีชำระเงินนี้ กรุณาตรวจโค้ด Checkout และเปิดใช้บัตรใน Stripe Dashboard';
    const err=Object.assign(new Error(message),{statusCode:502,code:'STRIPE_REQUEST_REJECTED',stripeDetails:details});
    throw err;
  }
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
