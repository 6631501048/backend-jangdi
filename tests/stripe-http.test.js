// Real Express routing, JWT/role middleware, raw webhook parsing and controllers.
// MongoDB and outbound Stripe requests are replaced; this is not account UAT.
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const jwt=require('jsonwebtoken');
const id={hirer:'507f1f77bcf86cd799439001',worker:'507f1f77bcf86cd799439002',other:'507f1f77bcf86cd799439003',admin:'507f1f77bcf86cd799439004',job:'507f1f77bcf86cd799439005',pay:'507f1f77bcf86cd799439006'};
let payment,job,refundState,stripeCalls,checkoutSession;
const users=Object.fromEntries(['hirer','worker','other','admin'].map(role=>[id[role],{_id:id[role],currentRole:role==='worker'?'worker':'hirer',isAdmin:role==='admin',accountStatus:'active'}]));
const matches=(row,q)=>row && Object.entries(q).every(([k,v])=>v && typeof v==='object' && '$in' in v?v.$in.includes(row[k]??null):(row[k]??null)===(v??null));
const chain=value=>({select(){return this;},populate(){return this;},sort(){return this;},lean(){return this;},then(resolve,reject){return Promise.resolve(value).then(resolve,reject);}});
function update(row,q,change,options={}){if(!matches(row,q))return null;const old={...row};Object.assign(row,change.$set);return options.new===false?old:{...row};}
function stub(relative,exports){const filename=require.resolve(relative);require.cache[filename]={id:filename,filename,loaded:true,exports};}
stub('../src/models',{
  User:{findById:async value=>users[value]},
  Job:{findById:async value=>value===id.job?{...job}:null,findOneAndUpdate:async(q,c,o)=>update(job,q,c,o),updateOne:async(q,c)=>update(job,q,c)},
  Payment:{
    findOne:async q=>matches(payment,q)?{...payment}:null,
    findById:value=>chain(value===id.pay?{...payment}:null),
    findOneAndUpdate:async(q,c,o)=>update(payment,q,c,o),updateOne:async(q,c)=>update(payment,q,c),
    find:q=>chain(matches(payment,q)?[{...payment}]:[]),
  },
});
stub('../src/services/transaction.service',{withTransaction:async work=>work({})});
const nativeFetch=global.fetch;
global.fetch=async(url,options)=>{
  if(!String(url).startsWith('https://api.stripe.com/'))return nativeFetch(url,options);
  stripeCalls.push({url,options});
  const data=String(url).includes('/refunds')?{id:'re_test',livemode:false,status:refundState,currency:'thb',amount:10500,payment_intent:'pi_test',metadata:{paymentId:id.pay}}:
    String(url).includes('/payment_intents/')?{latest_charge:{balance_transaction:{currency:'thb',fee:400}}}:
    {id:'cs_test',status:'open',url:'https://checkout.stripe.com/c/pay/test',...checkoutSession};
  return {ok:true,json:async()=>data};
};
process.env.JWT_SECRET='stripe-http-test-only-secret-at-least-32-characters';
process.env.STRIPE_SECRET_KEY='sk_test_example';process.env.STRIPE_WEBHOOK_SECRET='http-test-signing-secret';process.env.CLIENT_URL='http://localhost:5173';
const app=require('../src/app');
let base,server;
test.before(async()=>{server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;});
test.after(async()=>{global.fetch=nativeFetch;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
test.beforeEach(()=>{
  payment={_id:id.pay,job:id.job,hirer:id.hirer,worker:id.worker,paymentMode:'slip_demo',status:'pending',amount:100,platformFeePercent:5,platformFeeAmount:5,netAmountToWorker:100,refundDecision:null,createdAt:new Date()};
  job={_id:id.job,hirer:id.hirer,selectedWorker:id.worker,status:'assigned',title:'Stripe HTTP test'};refundState='pending';stripeCalls=[];checkoutSession={};
});
async function req(method,path,role,body){
  const response=await nativeFetch(base+path,{method,headers:{'Content-Type':'application/json',...(role?{Authorization:`Bearer ${jwt.sign({id:id[role]},process.env.JWT_SECRET)}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,data:await response.json()};
}
async function sendEvent(type,object,signatureValid=true){
  const body=JSON.stringify({livemode:false,created:Math.floor(Date.now()/1000),type,data:{object}}),timestamp=Math.floor(Date.now()/1000);
  const signature=crypto.createHmac('sha256',process.env.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest('hex');
  const response=await nativeFetch(base+'/api/payments/stripe/webhook',{method:'POST',headers:{'Content-Type':'application/json','stripe-signature':signatureValid?`t=${timestamp},v1=${signature}`:'invalid'},body});
  return {status:response.status,data:await response.json()};
}
async function paid(){
  await req('POST',`/api/payments/${id.job}/checkout`,'hirer');
  return sendEvent('checkout.session.completed',{id:'cs_test',client_reference_id:id.pay,payment_status:'paid',currency:'thb',amount_total:10500,payment_intent:'pi_test'});
}

test('HTTP checkout and payment details enforce login, role and ownership',async()=>{
  const endpoint=`/api/payments/${id.job}/checkout`;
  assert.equal((await req('POST',endpoint)).status,401);
  for(const role of ['worker','other','admin'])assert.equal((await req('POST',endpoint,role)).status,403);
  assert.equal((await req('GET',`/api/payments/${id.job}/mock`,'other')).status,403);
  assert.equal((await req('GET',`/api/payments/${id.job}/mock`,'worker')).status,200);
  assert.equal(stripeCalls.length,0);assert.equal(payment.status,'pending');
});

test('HTTP signed raw webhook confirms server total exactly once and finance reconciles',async()=>{
  assert.equal((await sendEvent('checkout.session.completed',{},false)).status,400);
  assert.equal((await paid()).status,200);assert.equal(payment.status,'held');assert.equal(payment.gatewayFeeAmount,4);
  await paid();assert.equal(payment.status,'held');
  const summary=await req('GET','/api/payments/overview?period=all','hirer');
  assert.equal(summary.data.lifetime.total,105);
  assert.equal((await req('GET','/api/payments/overview?period=all','other')).data.lifetime.total,0);
  const admin=await req('GET','/api/admin/financials?period=all','admin');assert.equal(admin.data.gross,105);assert.equal(admin.data.gatewayFees,4);
});

test('HTTP refund requires owner and admin, remains pending until Stripe success, and cannot repeat',async()=>{
  await paid();
  const requestPath=`/api/payments/${id.job}/refund-request`,decidePath=`/api/admin/payments/${id.pay}/refund-decision`;
  assert.equal((await req('POST',requestPath,'other',{reason:'ตรวจสอบคำขอคืนเงินทดสอบ'})).status,409);
  assert.equal((await req('POST',requestPath,'worker',{reason:'ตรวจสอบคำขอคืนเงินทดสอบ'})).status,403);
  assert.equal((await req('POST',requestPath,'hirer',{reason:'ตรวจสอบคำขอคืนเงินทดสอบ'})).status,200);
  for(const role of ['hirer','worker','other'])assert.equal((await req('POST',decidePath,role,{decision:'approved',notes:'ตรวจสอบรายการและหลักฐานครบแล้ว'})).status,403);
  assert.equal((await req('POST',decidePath,'admin',{decision:'approved',notes:'ตรวจสอบรายการและหลักฐานครบแล้ว'})).status,200);
  assert.equal(payment.status,'disputed');assert.equal(payment.refundAmount,105);
  refundState='succeeded';await sendEvent('refund.updated',{id:'re_test',payment_intent:'pi_test',status:'pending'});
  assert.equal(payment.status,'refunded');assert.equal(job.status,'cancelled');
  assert.equal((await req('POST',decidePath,'admin',{decision:'approved',notes:'ตรวจสอบรายการและหลักฐานครบแล้ว'})).status,409);
  const totals=(await req('GET','/api/admin/financials?period=all','admin')).data;
  assert.equal(totals.gross,105);assert.equal(totals.refunds,105);assert.equal(totals.netCash,-4);
  assert.equal(stripeCalls.filter(c=>c.options.method==='POST' && c.url.endsWith('/refunds')).length,1);
});

test('HTTP sync requires login, role and ownership and confirms with no webhook delivery',async()=>{
  await req('POST',`/api/payments/${id.job}/checkout`,'hirer');stripeCalls=[];
  const endpoint=`/api/payments/${id.job}/stripe/sync`;
  assert.equal((await req('POST',endpoint)).status,401);
  assert.equal((await req('POST',endpoint,'worker')).status,403);
  assert.equal((await req('POST',endpoint,'other')).status,404);assert.equal(stripeCalls.length,0);
  checkoutSession={livemode:false,status:'complete',payment_status:'paid',client_reference_id:id.pay,currency:'thb',amount_total:10500,payment_intent:'pi_test'};
  assert.equal((await req('POST',endpoint,'hirer')).data.status,'held');
  assert.equal(payment.gatewayFeeAmount,4);
  const count=stripeCalls.length;await req('POST',endpoint,'hirer');assert.equal(stripeCalls.length,count);
});

test('HTTP sync reconciles an approved refund with no refund webhook delivery',async()=>{
  await paid();
  await req('POST',`/api/payments/${id.job}/refund-request`,'hirer',{reason:'ตรวจสอบคำขอคืนเงินทดสอบ'});
  await req('POST',`/api/admin/payments/${id.pay}/refund-decision`,'admin',{decision:'approved',notes:'ตรวจสอบรายการและหลักฐานครบแล้ว'});
  assert.equal(payment.status,'disputed');refundState='succeeded';
  assert.equal((await req('POST',`/api/payments/${id.job}/stripe/sync`,'hirer')).data.status,'refunded');
  assert.equal(job.status,'cancelled');
});
