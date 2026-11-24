const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {range,overview,financials} = require('../src/services/finance.service');
const {verify,configured} = require('../src/services/stripe.service');
const now = new Date('2026-11-04T00:00:00Z');
const payment = { _id:'p1',job:{_id:'j1',title:'ทดสอบ'},amount:100,platformFeeAmount:5,netAmountToWorker:100,paymentMode:'stripe_test',status:'held',heldAt:new Date('2026-11-02'),createdAt:new Date('2026-11-01') };
test('Thai month starts at midnight Bangkok, including year rollover',()=>{
  assert.equal(range({period:'month'},now).start.toISOString(),'2026-10-31T17:00:00.000Z');
  assert.equal(range({period:'last-month'},new Date('2026-01-02')).start.toISOString(),'2025-11-30T17:00:00.000Z');
});
test('custom dates include the whole final Thai day and reject malformed dates',()=>{
  const r=range({period:'custom',start:'2026-11-01',end:'2026-11-04'},now);
  assert.equal(r.includes('2026-11-04T16:59:59Z'),true);
  assert.equal(r.includes('2026-11-04T17:00:00Z'),false);
  for (const query of [{period:'bad'},{period:'custom',start:'2026-02-30',end:'2026-03-01'},{period:'custom',start:'2026-11-05',end:'2026-11-04'}]) assert.throws(()=>range(query,now));
});
test('hirer totals include held/released plus fees, exclude pending/refunded',()=>{
  const rows=[payment,{...payment,_id:'p2',status:'pending'},{...payment,_id:'p3',status:'refunded',refundAmount:105}];
  const result=overview(rows,true,range({period:'month'},now));
  assert.equal(result.lifetime.total,105);
  assert.equal(result.lifetime.pending,105);
  assert.equal(result.lifetime.refunded,105);
  assert.equal(result.period.total,105);
  assert.equal(result.period.completedJobs,0);
  assert.equal(overview(rows,false,range({period:'month'},now)).lifetime.total,0);
});
test('unknown gateway cost is never presented as zero or final net',()=>{
  const result=financials([payment],range({period:'month'},now));
  assert.equal(result.gatewayFees,null);assert.equal(result.netCash,null);assert.equal(result.held,105);
});
test('finance reconciles full customer refund and platform gateway expense',()=>{
  const result=financials([{...payment,status:'refunded',refundedAt:new Date('2026-11-03'),refundAmount:105,gatewayFeeAmount:4,mockGatewayFeeAmount:3,mockGatewayFeePercent:3}],range({period:'month'},now));
  assert.equal(result.gross,105);assert.equal(result.refunds,105);assert.equal(result.netCash,-3);
});
test('webhooks require authentic raw payload, fresh signature and test keys',()=>{
  process.env.STRIPE_WEBHOOK_SECRET='test_secret';process.env.STRIPE_SECRET_KEY='sk_test_example';
  const timestamp=Math.floor(now.getTime()/1000), body=Buffer.from('{"livemode":false}');
  const signature=crypto.createHmac('sha256','test_secret').update(`${timestamp}.`).update(body).digest('hex');
  assert.equal(verify(body,`t=${timestamp},v1=${signature}`,now.getTime()).livemode,false);
  assert.throws(()=>verify(Buffer.from('{}'),`t=${timestamp},v1=${signature}`,now.getTime()));
  assert.throws(()=>verify(body,`t=${timestamp},v1=${signature}`,now.getTime()+301000));
  assert.equal(configured(),true);process.env.STRIPE_SECRET_KEY='sk_live_example';assert.equal(configured(),false);
});
