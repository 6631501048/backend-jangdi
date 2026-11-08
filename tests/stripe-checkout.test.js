const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
let payment, job, apiCalls, heldUpdates;
function stub(relative,exports) { const filename=require.resolve(relative);require.cache[filename]={id:filename,filename,loaded:true,exports}; }
stub('../src/models',{
  Job:{findById:async()=>job},
  Payment:{
    findOneAndUpdate:async (query,change)=>{if(payment.status!==query.status || String(query.hirer)!==String(payment.hirer) || query.worker!==payment.worker)return null;Object.assign(payment,change.$set);return {...payment};},
    findOne:async query=>Object.entries(query).every(([key,value])=>(payment[key]??null)===(value??null)) ? {...payment}:null,
    updateOne:async(query,change)=>{if(!Object.entries(query).every(([key,value])=>(payment[key]??null)===(value??null)))return;if(change.$set.status==='held')heldUpdates++;Object.assign(payment,change.$set);},
  },
});
const controller=require('../src/controllers/stripe.controller');
function reset(){
  process.env.STRIPE_SECRET_KEY='sk_test_example';process.env.STRIPE_WEBHOOK_SECRET='secret';process.env.CLIENT_URL='http://localhost:5173';
  payment={_id:'pay1',job:'job1',hirer:'hirer1',worker:'worker1',status:'pending',paymentMode:'demo',amount:100,platformFeeAmount:5};
  job={_id:'job1',hirer:'hirer1',selectedWorker:'worker1',status:'assigned',title:'งานทดสอบ'};apiCalls=[];heldUpdates=0;
  global.fetch=async(url,options)=>{
    apiCalls.push({url,options});
    const data=url.includes('payment_intents') ? {latest_charge:{balance_transaction:{currency:'thb',fee:400}}} : {id:'cs_test_1',status:'open',payment_method_types:['card','promptpay'],url:'https://checkout.stripe.com/test'};
    return {ok:true,json:async()=>data};
  };
}
function invoke(handler,req){return new Promise((resolve,reject)=>{
  const res={code:200,status(code){this.code=code;return this;},json(body){resolve({status:this.code,body});return this;}};
  handler(req,res,err=>err ? reject(err):resolve({next:true}));
});}
const request=()=>({user:{_id:'hirer1'},params:{jobId:'job1'}});
function event(overrides={},type='checkout.session.completed') {
  const value={type,created:Math.floor(Date.now()/1000),livemode:false,data:{object:{id:'cs_test_1',client_reference_id:'pay1',payment_status:'paid',currency:'thb',amount_total:10500,payment_intent:'pi_test',...overrides}}};
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
  assert.equal(form.get('allowed_payment_method_types[0]'),'card');assert.equal(form.has('payment_method_types[0]'),false);
  assert.equal(form.get('allowed_payment_method_types[1]'),'promptpay');
  assert.equal(apiCalls[0].options.headers['Idempotency-Key'],'checkout-v3-pay1-first');
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

test('checkout reuses an open session after browser cancellation without a second charge',async()=>{
  reset();await invoke(controller.createCheckout,request());await invoke(controller.createCheckout,request());
  assert.equal(apiCalls.filter(c=>c.options.method==='POST').length,1);assert.equal(payment.status,'pending');
});

test('expired session creates a replacement and complete session waits for webhook',async()=>{
  for(const status of ['expired','complete']){
    reset();payment.paymentMode='stripe_test';payment.stripeSessionId='cs_old';
    global.fetch=async(url,options)=>{apiCalls.push({url,options});return {ok:true,json:async()=>options.method==='GET'?{id:'cs_old',status}:{id:'cs_new',url:'https://checkout.stripe.com/new'}};};
    const result=await invoke(controller.createCheckout,request());
    assert.equal(result.status,status==='complete'?409:200);assert.equal(payment.status,'pending');
    assert.equal(apiCalls.filter(c=>c.options.method==='POST').length,status==='complete'?0:1);
  }
});

test('checkout refuses wrong job state or a payment for a different selected worker',async()=>{
  reset();job.status='completed';assert.equal((await invoke(controller.createCheckout,request())).status,409);
  reset();job.selectedWorker='worker2';assert.equal((await invoke(controller.createCheckout,request())).status,409);assert.equal(apiCalls.length,0);
});

test('checkout uses stored fee and rounds THB to satang at ten percent',async()=>{
  reset();payment.amount=123.45;payment.platformFeeAmount=12.35;await invoke(controller.createCheckout,request());
  assert.equal(new URLSearchParams(apiCalls[0].options.body).get('line_items[0][price_data][unit_amount]'),'13580');
});

test('late duplicate success is acknowledged without contacting Stripe again',async()=>{
  reset();payment.paymentMode='stripe_test';payment.stripeSessionId='cs_test_1';await invoke(controller.webhook,event());apiCalls=[];
  assert.equal((await invoke(controller.webhook,event())).status,200);assert.equal(apiCalls.length,0);assert.equal(heldUpdates,1);
});

test('payment webhook rejects wrong owner reference or currency and ignores unrelated sessions',async()=>{
  reset();payment.paymentMode='stripe_test';payment.stripeSessionId='cs_test_1';
  for(const wrong of [{client_reference_id:'other'},{currency:'usd'}])assert.equal((await invoke(controller.webhook,event(wrong))).status,400);
  assert.equal((await invoke(controller.webhook,event({id:'cs_unrelated'}))).status,200);assert.equal(payment.status,'pending');
});

test('readiness response contains only booleans and never credentials',async()=>{
  reset();const result=await invoke(controller.getStripeStatus,{});
  assert.deepEqual(result.body,{ready:true,testKeyConfigured:true,webhookConfigured:true});
  delete process.env.STRIPE_WEBHOOK_SECRET;assert.deepEqual((await invoke(controller.getStripeStatus,{})).body,{ready:true,testKeyConfigured:true,webhookConfigured:false});
});

test('old open card-only session is expired before a PromptPay-capable replacement is created',async()=>{
  reset();payment.paymentMode='stripe_test';payment.stripeSessionId='cs_old';
  global.fetch=async(url,options)=>{
    apiCalls.push({url,options});
    return {ok:true,json:async()=>options.method==='GET'?{id:'cs_old',status:'open',payment_method_types:['card']}:
      url.endsWith('/expire')?{id:'cs_old',status:'expired'}:{id:'cs_new',status:'open',url:'https://checkout.stripe.com/new'}};
  };
  assert.equal((await invoke(controller.createCheckout,request())).status,200);
  assert.equal(apiCalls[1].url,'https://api.stripe.com/v1/checkout/sessions/cs_old/expire');
  assert.equal(apiCalls[2].url,'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(payment.stripeSessionId,'cs_new');assert.equal(payment.status,'pending');
});

test('if expiring the old session fails, no replacement is created or persisted',async()=>{
  reset();payment.paymentMode='stripe_test';payment.stripeSessionId='cs_old';
  global.fetch=async(url,options)=>{
    apiCalls.push({url,options});
    return {ok:options.method==='GET',status:400,json:async()=>options.method==='GET'?{id:'cs_old',status:'open',payment_method_types:['card']}:{error:{code:'resource_missing'}}};
  };
  await assert.rejects(invoke(controller.createCheckout,request()));assert.equal(apiCalls.length,2);assert.equal(payment.stripeSessionId,'cs_old');
});

test('QR generation, expiry and async failure never mark money as received',async()=>{
  reset();payment.paymentMode='stripe_test';payment.stripeSessionId='cs_test_1';
  for(const type of ['checkout.session.completed','checkout.session.expired','checkout.session.async_payment_failed']){
    await invoke(controller.webhook,event({payment_status:'unpaid'},type));assert.equal(payment.status,'pending');
  }
  assert.equal(heldUpdates,0);
  await invoke(controller.webhook,event({},'checkout.session.async_payment_succeeded'));assert.equal(payment.status,'held');
  await invoke(controller.webhook,event({},'checkout.session.completed'));assert.equal(heldUpdates,1);
});

test('server reconciliation works without a listener or webhook secret and is idempotent',async()=>{
  reset();delete process.env.STRIPE_WEBHOOK_SECRET;
  payment.paymentMode='stripe_test';payment.stripeSessionId='cs_test_1';
  const fetchIntent=global.fetch;
  global.fetch=async(url,options)=>url.includes('checkout/sessions/')?{ok:true,json:async()=>({id:'cs_test_1',livemode:false,client_reference_id:'pay1',payment_status:'paid',currency:'thb',amount_total:10500,payment_intent:'pi_test'})}:fetchIntent(url,options);
  assert.equal((await invoke(controller.syncPayment,request())).body.status,'held');
  assert.equal(payment.gatewayFeeAmount,4);assert.equal(payment.stripePaymentIntentId,'pi_test');
  await invoke(controller.syncPayment,request());assert.equal(heldUpdates,1);
});

test('reconciliation authorizes ownership and rejects mismatched or live sessions',async()=>{
  reset();payment.paymentMode='stripe_test';payment.stripeSessionId='cs_test_1';
  assert.equal((await invoke(controller.syncPayment,{...request(),user:{_id:'outsider'}})).status,404);
  assert.equal(apiCalls.length,0);
  for(const wrong of [{amount_total:1},{currency:'usd'},{client_reference_id:'other'},{id:'cs_other'},{livemode:true}]){
    global.fetch=async()=>({ok:true,json:async()=>({id:'cs_test_1',livemode:false,client_reference_id:'pay1',payment_status:'paid',currency:'thb',amount_total:10500,...wrong})});
    if(wrong.livemode)assert.equal((await invoke(controller.syncPayment,request())).status,400);
    else await assert.rejects(invoke(controller.syncPayment,request()),{statusCode:400});
    assert.equal(payment.status,'pending');
  }
});

test('unpaid and expired sessions stay pending when reconciled',async()=>{
  reset();payment.paymentMode='stripe_test';payment.stripeSessionId='cs_test_1';
  for(const status of ['open','expired','complete']){
    global.fetch=async()=>({ok:true,json:async()=>({id:'cs_test_1',livemode:false,status,payment_status:'unpaid'})});
    assert.equal((await invoke(controller.syncPayment,request())).body.status,'pending');
    assert.equal(heldUpdates,0);
  }
});
