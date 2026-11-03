const test = require('node:test');
const assert = require('node:assert/strict');
const id = '507f1f77bcf86cd799439011';
let payment, job, stripeCalls, stripeStatus;
const matches = (record,query) => record && Object.entries(query).every(([key,value]) => value && typeof value === 'object' && '$in' in value ? value.$in.includes(record[key]) : String(record[key] ?? null) === String(value ?? null));
function update(kind,query,changes,options={}) {
  const record = kind === 'payment' ? payment : job;
  if (!matches(record,query)) return null;
  const previous = {...record}; Object.assign(record,changes.$set || {});
  return options.new === false ? previous : {...record};
}
function stub(relative,exports) { const filename=require.resolve(relative); require.cache[filename]={id:filename,filename,loaded:true,exports}; }
stub('../src/models',{
  Payment:{findOne:async query => matches(payment,query) ? {...payment} : null,findOneAndUpdate:async (...args)=>update('payment',...args),updateOne:async (...args)=>update('payment',...args),findById:()=>({select:async()=>payment})},
  Job:{findOneAndUpdate:async (...args)=>update('job',...args),updateOne:async (...args)=>update('job',...args)},
});
stub('../src/services/transaction.service',{withTransaction:async work=>{
  const oldPayment=structuredClone(payment),oldJob=structuredClone(job);
  try{return await work({});}catch(err){payment=oldPayment;job=oldJob;throw err;}
}});
stub('../src/services/stripe.service',{request:async (endpoint,options)=>{stripeCalls.push({endpoint,options});return {id:'re_test',status:stripeStatus};}});
const controller=require('../src/controllers/refund.controller');
function reset(mode='demo') {
  payment={_id:id,job:'job1',hirer:'hirer1',worker:'worker1',status:'held',paymentMode:mode,amount:100,platformFeeAmount:5,refundDecision:null,stripePaymentIntentId:'pi_test'};
  job={_id:'job1',hirer:'hirer1',status:'awaiting_confirmation'};stripeCalls=[];stripeStatus='succeeded';
}
function request(overrides={}) {return {user:{_id:'hirer1'},params:{jobId:'job1',id},body:{reason:'งานไม่ตรงตามข้อตกลง'},files:[],...overrides};}
function invoke(handler,req) {return new Promise((resolve,reject)=>{
  const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){resolve({status:this.statusCode,body});return this;},set(){return this;},send(body){resolve({status:this.statusCode,body});return this;}};
  handler(req,res,err=>err ? reject(err) : resolve({next:true}));
});}
const submit = req => invoke(controller.requestRefund[2],req || request());
const decision = value => request({user:{_id:'admin1',isAdmin:true},body:{decision:value,notes:'ตรวจสอบหลักฐานประกอบแล้ว'}});
test('refund authorizes owner and paid state before accepting file bytes',async()=>{
  reset();assert.equal((await invoke(controller.requestRefund[0],request({user:{_id:'worker1'}}))).status,409);
  payment.status='released';assert.equal((await invoke(controller.requestRefund[0],request())).status,409);
});
test('refund pauses job/payment together and records prior state; repeat is rejected',async()=>{
  reset();assert.equal((await submit()).status,200);assert.equal(job.status,'disputed');assert.equal(payment.status,'disputed');assert.equal(payment.refundPreviousJobStatus,'awaiting_confirmation');
  await assert.rejects(submit(),err=>err.statusCode===409);
});
test('a completion/payment race rolls back the job pause',async()=>{
  reset();payment.status='released';await assert.rejects(submit());assert.equal(job.status,'awaiting_confirmation');
});
test('invalid image data is rejected without changing financial state',async()=>{
  reset();await assert.rejects(submit(request({files:[{buffer:Buffer.from('<svg>malicious</svg>'),mimetype:'image/png'}]})),err=>err.statusCode===400);
  assert.equal(payment.status,'held');
});
test('reject requires notes and restores the original work state',async()=>{
  reset();await submit();assert.equal((await invoke(controller.decideRefund,decision('rejected'))).status,200);assert.equal(job.status,'awaiting_confirmation');assert.equal(payment.status,'held');
  await assert.rejects(invoke(controller.decideRefund,decision('approved')));
});
test('demo approval refunds full customer amount and is committed once',async()=>{
  reset();await submit();await invoke(controller.decideRefund,decision('approved'));
  assert.equal(payment.refundAmount,105);assert.equal(payment.status,'refunded');assert.equal(job.status,'cancelled');assert.equal(stripeCalls.length,0);
  await assert.rejects(invoke(controller.decideRefund,decision('approved')));
});
test('Stripe pending refund does not claim money returned; retries reuse idempotency key',async()=>{
  reset('stripe_test');await submit();stripeStatus='pending';await invoke(controller.decideRefund,decision('approved'));
  assert.equal(payment.status,'disputed');assert.equal(job.status,'disputed');assert.equal(payment.refundStatus,'pending');
  await assert.rejects(invoke(controller.decideRefund,decision('rejected')));
  stripeStatus='succeeded';await invoke(controller.decideRefund,decision('approved'));
  assert.equal(payment.status,'refunded');assert.equal(stripeCalls[0].options.params.amount,10500);assert.equal(stripeCalls[0].options.key,stripeCalls[1].options.key);
});
test('evidence is private to participants and admin',async()=>{
  reset();payment.refundEvidence=[{data:Buffer.from('private-image'),contentType:'image/png'}];
  assert.equal((await invoke(controller.getEvidence,request({params:{id,index:'0'},user:{_id:'outsider'}}))).status,404);
  assert.equal((await invoke(controller.getEvidence,request({params:{id,index:'0'}}))).status,200);
});
