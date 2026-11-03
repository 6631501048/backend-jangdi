const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
let payment, job, apiCalls, heldUpdates;
function stub(relative,exports) { const filename=require.resolve(relative);require.cache[filename]={id:filename,filename,loaded:true,exports}; }
stub('../src/models',{
  Job:{findById:async()=>job},
  Payment:{
    findOneAndUpdate:async (query,change)=>{if(payment.status!==query.status || String(query.hirer)!==String(payment.hirer))return null;Object.assign(payment,change.$set);return {...payment};},
    findOne:async query=>query.stripeSessionId===payment.stripeSessionId && query.paymentMode===payment.paymentMode ? {...payment}:null,
    updateOne:async(query,change)=>{if(query.status && payment.status!==query.status)return;if(change.$set.status==='held')heldUpdates++;Object.assign(payment,change.$set);},
  },
});
const controller=require('../src/controllers/stripe.controller');
function reset(){
  process.env.STRIPE_SECRET_KEY='sk_test_example';process.env.STRIPE_WEBHOOK_SECRET='secret';process.env.CLIENT_URL='http://localhost:5173';
  payment={_id:'pay1',job:'job1',hirer:'hirer1',status:'pending',paymentMode:'demo',amount:100,platformFeeAmount:5};
  job={_id:'job1',hirer:'hirer1',status:'assigned',title:'งานทดสอบ'};apiCalls=[];heldUpdates=0;
  global.fetch=async(url,options)=>{
    apiCalls.push({url,options});
    const data=url.includes('payment_intents') ? {latest_charge:{balance_transaction:{currency:'thb',fee:400}}} : {id:'cs_test_1',status:'open',url:'https://checkout.stripe.com/test'};
    return {ok:true,json:async()=>data};
  };
}
function invoke(handler,req){return new Promise((resolve,reject)=>{
  const res={code:200,status(code){this.code=code;return this;},json(body){resolve({status:this.code,body});return this;}};
  handler(req,res,err=>err ? reject(err):resolve({next:true}));
});}
const request=()=>({user:{_id:'hirer1'},params:{jobId:'job1'}});
function event(overrides={}) {
  const value={type:'checkout.session.completed',created:Math.floor(Date.now()/1000),livemode:false,data:{object:{id:'cs_test_1',client_reference_id:'pay1',payment_status:'paid',currency:'thb',amount_total:10500,payment_intent:'pi_test',...overrides}}};
  const body=Buffer.from(JSON.stringify(value)),timestamp=Math.floor(Date.now()/1000);
  const signature=crypto.createHmac('sha256','secret').update(`${timestamp}.`).update(body).digest('hex');
  return {body,headers:{'stripe-signature':`t=${timestamp},v1=${signature}`}};
}
test('checkout rejects unconfigured or live keys without changing payment',async()=>{
  reset();process.env.STRIPE_SECRET_KEY='sk_live_forbidden';assert.equal((await invoke(controller.createCheckout,request())).status,503);assert.equal(payment.paymentMode,'demo');assert.equal(apiCalls.length,0);
});
test('checkout authorizes owner and charges server total only, without marking paid',async()=>{
  reset();assert.equal((await invoke(controller.createCheckout,{...request(),user:{_id:'outsider'}})).status,403);
  assert.equal((await invoke(controller.createCheckout,request())).status,200);
  assert.equal(payment.paymentMode,'stripe_test');assert.equal(payment.status,'pending');
  const form=new URLSearchParams(apiCalls[0].options.body);
  assert.equal(form.get('line_items[0][price_data][unit_amount]'),'10500');assert.equal(form.get('line_items[0][price_data][currency]'),'thb');assert.ok(apiCalls[0].options.headers['Idempotency-Key']);
});
test('webhook rejects forged signature and mismatched amount',async()=>{
  reset();payment.paymentMode='stripe_test';payment.stripeSessionId='cs_test_1';
  assert.equal((await invoke(controller.webhook,{...event(),headers:{'stripe-signature':'invalid'}})).status,400);
  assert.equal((await invoke(controller.webhook,event({amount_total:1}))).status,400);assert.equal(payment.status,'pending');
});
test('valid paid webhook records gateway cost and repeated delivery releases no duplicate funds',async()=>{
  reset();payment.paymentMode='stripe_test';payment.stripeSessionId='cs_test_1';
  assert.equal((await invoke(controller.webhook,event())).status,200);assert.equal(payment.status,'held');assert.equal(payment.gatewayFeeAmount,4);assert.equal(payment.stripePaymentIntentId,'pi_test');
  await invoke(controller.webhook,event());assert.equal(heldUpdates,1);
});
test('unpaid Checkout completion never marks a payment as held',async()=>{
  reset();payment.paymentMode='stripe_test';payment.stripeSessionId='cs_test_1';await invoke(controller.webhook,event({payment_status:'unpaid'}));assert.equal(payment.status,'pending');
});
