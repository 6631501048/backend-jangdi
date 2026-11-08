const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { serialize, deserialize } = require('node:v8');
const { once } = require('node:events');
const ids={hirer:'507f1f77bcf86cd799439011',worker:'507f1f77bcf86cd799439012',admin:'507f1f77bcf86cd799439013',other:'507f1f77bcf86cd799439014',job:'507f1f77bcf86cd799439015',payment:'507f1f77bcf86cd799439016'};
const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
const clone=value=>value==null?value:deserialize(serialize(value));
let store,queue=Promise.resolve();
function match(record,query){return record && Object.entries(query).every(([key,value])=>{
  if(value && typeof value==='object' && !Buffer.isBuffer(value)){
    if('$in' in value)return value.$in.includes(record[key]);
    if('$ne' in value)return record[key]!==value.$ne;
  }
  return String(record[key]??null)===String(value??null);
});}
function chain(get){return {selection:'',session(){return this;},select(value){this.selection=value;return this;},populate(){return this;},sort(){return this;},lean(){return this;},then(resolve,reject){
  const record=clone(get());if(record){if(!this.selection.includes('+slipEvidence'))delete record.slipEvidence;if(!this.selection.includes('+completionProofData'))delete record.completionProofData;}
  return Promise.resolve(record).then(resolve,reject);
}};}
function update(kind,query,change,options={}){
  const target=store[kind];if(!match(target,query))return null;const old=clone(target);
  for(const [key,value] of Object.entries(change.$set || {})){
    if(key.includes('.')){const [parent,child]=key.split('.');target[parent]??={};target[parent][child]=clone(value);}
    else target[key]=clone(value);
  }
  for(const [key,value] of Object.entries(change.$push || {})){target[key]??=[];target[key].push(clone(value));}
  return clone(options.new===false?old:target);
}
const users=Object.fromEntries(['hirer','worker','admin','other'].map(role=>[ids[role],{_id:ids[role],currentRole:role==='worker'?'worker':'hirer',isAdmin:role==='admin',isEmailVerified:true,accountStatus:'active'}]));
const models={
  User:{findById:id=>chain(()=>users[id])},
  Job:{findById:id=>chain(()=>String(id)===ids.job?store.job:null),findOne:query=>chain(()=>match(store.job,query)?store.job:null),findOneAndUpdate:async(...args)=>update('job',...args),updateOne:async(...args)=>({modifiedCount:update('job',...args)?1:0})},
  Payment:{findById:id=>chain(()=>String(id)===ids.payment?store.payment:null),findOne:query=>chain(()=>match(store.payment,query)?store.payment:null),findOneAndUpdate:async(...args)=>update('payment',...args),updateOne:async(...args)=>({modifiedCount:update('payment',...args)?1:0})},
};
function stub(relative,value){const filename=require.resolve(relative);require.cache[filename]={id:filename,filename,loaded:true,exports:value};}
stub('../src/models',models);
stub('../src/services/transaction.service',{withTransaction:work=>{
  const task=queue.then(async()=>{const snapshot=clone(store);try{return await work({});}catch(error){store=snapshot;throw error;}});queue=task.catch(()=>{});return task;
}});
stub('../src/services/notification.service',{createNotification:async value=>{if(store.failNotification)throw new Error('Outbox unavailable');const item={...value,_id:'notification'};store.notifications.push(item);return item;},deliverNotification:async()=>true,notifyUser:async()=>{}});
let stripeCalls=[],refundStatus='pending';
stub('../src/services/stripe.service',{request:async endpoint=>{stripeCalls.push(endpoint);return {id:'re_test_refund',status:refundStatus,livemode:false,currency:'thb',amount:10500,payment_intent:'pi_test',metadata:{paymentId:ids.payment}};}});
stub('../src/services/jobLog.service',{logJobStatusChange:async()=>{}});
stub('../src/services/matching.service',{notifyNearbyWorkers:async()=>{}});
const slips=require('../src/controllers/slipPayment.controller');
const refund=require('../src/controllers/refund.controller');
const jobController=require('../src/controllers/job.controller');
const paymentController=require('../src/controllers/payment.controller');
const {protect,adminOnly,requireRole}=require('../src/middleware/auth.middleware');
const app=express();app.use(express.json());
app.post('/payments/:jobId/slips/inbound',protect,requireRole('hirer'),...slips.submitInbound);
app.post('/payments/:jobId/stripe/slip',protect,requireRole('hirer'),...slips.submitStripeEvidence);
app.get('/payments/:id/slips/:direction',protect,slips.getSlip);
app.get('/payments/:jobId/mock',protect,paymentController.getMockPayment);
app.post('/payments/:jobId/refund',protect,requireRole('hirer'),...refund.requestRefund);
app.post('/jobs/:id/confirm',protect,requireRole('hirer'),jobController.confirmCompletion);
app.post('/admin/payments/:id/slip-review',protect,adminOnly,slips.reviewInbound);
app.post('/admin/payments/:id/slips/:direction',protect,adminOnly,...slips.submitOutbound);
app.post('/admin/payments/:id/refund-decision',protect,adminOnly,refund.decideRefund);
app.use((error,req,res,next)=>res.status(error.statusCode || 500).json({message:error.message}));
const fourEyes=process.env.REQUIRE_FOUR_EYES;
let server,base;
test.before(async()=>{process.env.JWT_SECRET='slip-tests-only';server=app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;});
test.after(()=>new Promise(resolve=>server.close(resolve)));
test('four-eyes blocks the reviewer from paying themselves when enabled',async()=>{
  reset();await inbound();await review();store.job.status='awaiting_confirmation';store.payment.status='payout_pending';process.env.REQUIRE_FOUR_EYES='1';
  try{assert.equal((await payout()).status,403);}finally{if(fourEyes===undefined)delete process.env.REQUIRE_FOUR_EYES;else process.env.REQUIRE_FOUR_EYES=fourEyes;}
});
function reset(){stripeCalls=[];refundStatus='pending';store={notifications:[],job:{_id:ids.job,hirer:ids.hirer,selectedWorker:ids.worker,status:'assigned',title:'งานทดสอบ',completionProofUrl:'/uploads/job-proofs/shared.png',completionProofStorage:'mongodb',completionProofData:png},payment:{_id:ids.payment,job:ids.job,hirer:ids.hirer,worker:ids.worker,status:'pending',paymentMode:'slip_demo',amount:100,platformFeeAmount:5,platformFeePercent:5,netAmountToWorker:100,stripeSessionId:null,refundDecision:null}};}
async function request(path,{role='hirer',method='POST',body}={}){
  const headers={};if(role)headers.Authorization=`Bearer ${jwt.sign({id:ids[role]},process.env.JWT_SECRET)}`;
  if(body && !(body instanceof FormData))headers['Content-Type']='application/json';
  return fetch(base+path,{method,headers,body:body instanceof FormData?body:body?JSON.stringify(body):undefined});
}
function form(bytes=png,notes){const body=new FormData();body.append('slip',new Blob([bytes],{type:'image/png'}),'slip.png');if(notes)body.append('notes',notes);return body;}
const inbound=()=>request(`/payments/${ids.job}/slips/inbound`,{body:form()});

test('Stripe evidence requires ownership and a session, stays private and never marks funds received',async()=>{
  reset();store.payment.paymentMode='stripe_test';
  const endpoint=`/payments/${ids.job}/stripe/slip`;
  assert.equal((await request(endpoint,{body:form()})).status,409);
  store.payment.stripeSessionId='cs_test_evidence';
  for(const role of [null,'worker','other'])assert.ok([401,403,409].includes((await request(endpoint,{role,body:form()})).status));
  assert.equal((await request(endpoint,{body:form(Buffer.from('not an image'))})).status,400);
  for(const status of ['pending','held','released','disputed','refunded']){
    store.payment.status=status;
    assert.equal((await request(endpoint,{body:form()})).status,200);
    assert.equal(store.payment.status,status);assert.equal(store.payment.paymentMode,'stripe_test');
    assert.equal(store.payment.hasInboundSlip,true);assert.ok(store.payment.inboundSlipVersion);
    assert.equal(store.payment.slipAudit.at(-1).action,'stripe_evidence_submitted');
  }
  const proof=await request(`/payments/${ids.payment}/slips/inbound`,{method:'GET'});
  assert.equal(proof.status,200);assert.equal(proof.headers.get('cache-control'),'private, no-store');
  assert.equal((await request(`/payments/${ids.payment}/slips/inbound`,{role:'other',method:'GET'})).status,404);
});
const review=(decision='approved',version=store.payment.inboundSlipVersion)=>request(`/admin/payments/${ids.payment}/slip-review`,{role:'admin',body:{decision,version,notes:'ตรวจสอบรูปและยอดชำระแล้ว'}});
const payout=(bytes=png,extra={})=>{const body=form(bytes,'ตรวจยอดและจ่ายค่าจ้างจำลองแล้ว');body.append('amount','100');body.append('reference','TH202602000001');return request(`/admin/payments/${ids.payment}/slips/payout`,{role:'admin',body,...extra});};
function refundForm(amount='105',reference='re_test_refund') { const body=form(png,'แนบหลักฐานการคืนเงินเต็มจำนวนแล้ว');body.append('amount',amount);body.append('reference',reference);return body; }
async function completeJob(){store.job.status='awaiting_confirmation';return request(`/jobs/${ids.job}/confirm`,{body:{}});}
test('anonymous, worker and outsiders cannot submit a hirer slip; ordinary users cannot approve',async()=>{
  reset();for(const role of [null,'worker','other']){const result=await request(`/payments/${ids.job}/slips/inbound`,{role,body:form()});assert.ok([401,403,409].includes(result.status));}
  assert.equal((await request(`/admin/payments/${ids.payment}/slip-review`,{body:{}})).status,403);assert.equal(store.payment.status,'pending');
});
test('invalid files, oversized slips and duplicate submissions cannot mark payment held',async()=>{
  reset();assert.equal((await request(`/payments/${ids.job}/slips/inbound`,{body:form(Buffer.from('<svg>bad</svg>'))})).status,400);
  assert.equal((await request(`/payments/${ids.job}/slips/inbound`,{body:form(Buffer.alloc(2*1024*1024+1))})).status,400);
  assert.equal((await inbound()).status,200);assert.equal(store.payment.status,'awaiting_verification');assert.equal(store.payment.heldAt,undefined);
  assert.equal((await inbound()).status,409);
});
test('rejected slip can be replaced; stale admin version cannot approve a different image',async()=>{
  reset();await inbound();const first=store.payment.inboundSlipVersion;assert.equal((await review('rejected')).status,200);assert.equal(store.payment.status,'slip_rejected');
  await inbound();assert.notEqual(store.payment.inboundSlipVersion,first);assert.equal((await review('approved',first)).status,409);
  assert.equal((await review()).status,200);assert.equal(store.payment.status,'held');assert.ok(store.payment.heldAt);
  assert.equal((await review()).status,409);
});
test('full slip flow separates job completion from payment and prevents concurrent double payouts',async()=>{
  reset();await inbound();await review();assert.equal((await completeJob()).status,200);
  assert.equal(store.job.status,'completed');assert.equal(store.payment.status,'payout_pending');assert.equal(store.payment.paidAt,null);
  const results=await Promise.all([payout(),payout()]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  assert.equal(store.payment.status,'released');assert.ok(store.payment.paidAt);assert.deepEqual(store.payment.slipEvidence.payout,png);assert.equal(store.payment.slipAudit.filter(item=>item.action==='payout_confirmed').length,1);
});
test('payout is blocked before confirmation, even if the payment record incorrectly says pending payout',async()=>{
  reset();assert.equal((await payout()).status,409);store.payment.status='payout_pending';assert.equal((await payout()).status,409);assert.equal(store.payment.status,'payout_pending');assert.equal(store.payment.hasPayoutSlip,undefined);
});
test('approved refund waits for admin return slip before cancelling job and recording returned amount',async()=>{
  reset();await inbound();await review();
  const body=new FormData();body.append('reason','งานไม่ตรงตามข้อตกลงจึงขอคืนเงิน');assert.equal((await request(`/payments/${ids.job}/refund`,{body})).status,200);
  assert.equal((await request(`/admin/payments/${ids.payment}/refund-decision`,{role:'admin',body:{decision:'approved',notes:'ตรวจสอบหลักฐานและอนุมัติคืนเงิน'}})).status,200);
  assert.equal(store.payment.status,'refund_pending');assert.equal(store.payment.refundAmount,105);assert.equal(store.job.status,'disputed');
  const path=`/admin/payments/${ids.payment}/slips/refund`;
  assert.equal((await request(path,{role:'admin',body:refundForm()})).status,200);
  assert.equal(store.payment.status,'refunded');assert.equal(store.job.status,'cancelled');assert.equal(store.payment.hasRefundSlip,true);
  assert.equal((await request(path,{role:'admin',body:refundForm()})).status,409);
});
test('slips stay private, ordinary payment JSON has no image bytes, and authorized parties can read',async()=>{
  reset();await inbound();
  const image=await request(`/payments/${ids.payment}/slips/inbound`,{method:'GET'});assert.equal(image.status,200);assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);assert.equal(image.headers.get('cache-control'),'private, no-store');
  assert.equal((await request(`/payments/${ids.payment}/slips/inbound`,{role:'other',method:'GET'})).status,404);
  const metadata=await (await request(`/payments/${ids.job}/mock`,{method:'GET'})).json();assert.equal(metadata.hasInboundSlip,true);assert.equal(metadata.slipEvidence,undefined);assert.equal(metadata.totalDue,105);
});
test('Stripe records cannot bypass webhook approval by posting a manual slip',async()=>{
  reset();store.payment.paymentMode='stripe_test';store.payment.stripeSessionId='cs_test_1';assert.equal((await inbound()).status,409);assert.equal(store.payment.status,'pending');
});
test('schema hides slip bytes from ordinary queries and JSON',()=>{
  const Model=require('../src/models/Payment');assert.equal(Model.schema.path('slipEvidence').options.select,false);
  const doc=new Model({slipEvidence:{inbound:png}});assert.equal(doc.toJSON().slipEvidence,undefined);
});

test('Stripe completion queues admin payout; roles cannot bypass it and worker sees the final proof',async()=>{
  reset();Object.assign(store.payment,{paymentMode:'stripe_test',status:'held',stripeSessionId:'cs_test',stripePaymentIntentId:'pi_test'});
  assert.equal((await request(`/jobs/${ids.job}/confirm`,{role:'worker',body:{}})).status,403);
  assert.equal((await completeJob()).status,200);assert.equal(store.payment.status,'payout_pending');
  assert.equal(store.payment.hasPayoutSlip,undefined);assert.equal(store.payment.paidAt,null);
  assert.ok(store.notifications.some(n=>n.userId===ids.worker && n.title.includes('รอผู้ดูแล')));
  for(const role of ['hirer','worker','other',null])assert.ok([401,403].includes((await payout(png,{role})).status));
  const before=await request(`/payments/${ids.job}/mock`,{role:'worker',method:'GET'});
  assert.equal((await before.json()).status,'payout_pending');
  const attempts=await Promise.all([payout(),payout()]);assert.deepEqual(attempts.map(r=>r.status).sort(),[200,409]);
  const after=await request(`/payments/${ids.job}/mock`,{role:'worker',method:'GET'});
  const dto=await after.json();assert.equal(dto.status,'released');assert.equal(dto.hasPayoutSlip,true);assert.equal(dto.payoutAmount,100);assert.equal(dto.payoutReference,'TH202602000001');
  assert.equal((await request(`/payments/${ids.payment}/slips/payout`,{role:'worker',method:'GET'})).status,200);
  assert.equal((await request(`/payments/${ids.payment}/slips/payout`,{role:'other',method:'GET'})).status,404);
  assert.equal(store.notifications.filter(n=>n.userId===ids.worker && n.title==='ผู้ดูแลบันทึกจ่ายค่าจ้างแล้ว').length,1);
  assert.equal(stripeCalls.length,0);
});

test('outbox failure rolls back payout and its evidence, allowing a safe retry',async()=>{
  reset();store.payment.status='held';await completeJob();store.failNotification=true;
  assert.equal((await payout()).status,500);assert.equal(store.payment.status,'payout_pending');assert.equal(store.payment.hasPayoutSlip,undefined);
  store.failNotification=false;assert.equal((await payout()).status,200);
});

test('Stripe refund proof requires provider success, does not repeat the refund and is private to hirer/admin',async()=>{
  reset();Object.assign(store.payment,{paymentMode:'stripe_test',status:'held',stripePaymentIntentId:'pi_test'});
  assert.equal((await request(`/payments/${ids.job}/refund`,{body:{reason:'งานไม่ตรงตามข้อตกลงจึงขอคืนเงิน'}})).status,200);
  assert.equal((await request(`/admin/payments/${ids.payment}/refund-decision`,{role:'admin',body:{decision:'approved',notes:'ตรวจสอบและอนุมัติคืนเงินเต็มยอด'}})).status,200);
  const path=`/admin/payments/${ids.payment}/slips/refund`;
  assert.equal((await request(path,{role:'admin',body:refundForm()})).status,409);assert.equal(store.payment.hasRefundSlip,undefined);
  await refund.recordStripeRefund(store.payment,{id:'re_test_refund',status:'succeeded',livemode:false,currency:'thb',amount:10500,payment_intent:'pi_test',metadata:{paymentId:ids.payment}});
  assert.equal(store.payment.status,'refunded');assert.equal(store.job.status,'cancelled');
  assert.equal((await request(path,{role:'admin',body:refundForm('104.99')})).status,409);
  assert.equal((await request(path,{role:'admin',body:refundForm('105','re_wrong_refund')})).status,400);
  const count=stripeCalls.length;
  assert.equal((await request(path,{role:'hirer',body:refundForm()})).status,403);
  assert.equal((await request(path,{role:'admin',body:refundForm()})).status,200);
  assert.equal(store.payment.status,'refunded');assert.equal(store.payment.hasRefundSlip,true);assert.equal(stripeCalls.length,count);
  for(const role of ['hirer','admin'])assert.equal((await request(`/payments/${ids.payment}/slips/refund`,{role,method:'GET'})).status,200);
  for(const role of ['worker','other'])assert.equal((await request(`/payments/${ids.payment}/slips/refund`,{role,method:'GET'})).status,404);
  assert.equal((await request(path,{role:'admin',body:refundForm()})).status,409);
});
