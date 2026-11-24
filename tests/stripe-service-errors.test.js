const test=require('node:test');
const assert=require('node:assert/strict');
const stripe=require('../src/services/stripe.service');
const originalFetch=global.fetch,originalWarn=console.warn;
let logs;
test.beforeEach(()=>{process.env.STRIPE_SECRET_KEY='sk_test_sensitive_fixture';process.env.STRIPE_WEBHOOK_SECRET='whsec_sensitive_fixture';logs=[];console.warn=(...args)=>logs.push(args);});
test.afterEach(()=>{global.fetch=originalFetch;console.warn=originalWarn;});
function rejected(status,error){global.fetch=async()=>({ok:false,status,json:async()=>({error})});}

test('invalid key error gives restart guidance without logging credentials or provider message',async()=>{
  rejected(401,{type:'invalid_request_error',message:'Invalid API key sk_test_sensitive_fixture'});
  await assert.rejects(stripe.request('balance'),error=>error.statusCode===502 && error.message.includes('restart backend') && !error.message.includes('sensitive_fixture'));
  assert.equal(JSON.stringify(logs).includes('sensitive_fixture'),false);
});
test('payment-method error identifies the rejected parameter with safe diagnostics',async()=>{
  rejected(400,{type:'invalid_request_error',param:'payment_method_types',message:'Provider text must stay private'});
  await assert.rejects(stripe.request('checkout/sessions'),error=>error.message.includes('วิธีชำระเงิน') && error.stripeDetails.param==='payment_method_types');
  assert.equal(JSON.stringify(logs).includes('Provider text'),false);
});
test('missing Stripe object explains sandbox mismatch',async()=>{
  rejected(404,{code:'resource_missing'});
  await assert.rejects(stripe.request('checkout/sessions/cs_old'),error=>error.message.includes('sandbox'));
});
test('permission and rate-limit failures give distinct actionable errors',async()=>{
  for(const [status,expected] of [[403,'ไม่มีสิทธิ์'],[429,'ถี่เกินไป']]){
    rejected(status,{});await assert.rejects(stripe.request('balance'),error=>error.message.includes(expected));
  }
});
test('network failure never propagates the transport error or its request details',async()=>{
  global.fetch=async()=>{throw new Error('transport leaked sk_test_sensitive_fixture');};
  await assert.rejects(stripe.request('balance'),error=>error.code==='STRIPE_CONNECTION_FAILED' && !error.message.includes('sensitive_fixture'));
});
test('invalid JSON is a controlled upstream error',async()=>{
  global.fetch=async()=>({ok:false,json:async()=>{throw new Error('invalid body');}});
  await assert.rejects(stripe.request('balance'),error=>error.code==='STRIPE_INVALID_RESPONSE' && error.statusCode===502);
});
