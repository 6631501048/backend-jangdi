const test=require('node:test');
const assert=require('node:assert/strict');
const {overview,financials,range}=require('../src/services/finance.service');
const {feePercent}=require('../src/services/paymentTerms.service');
const window=range({period:'custom',start:'2026-11-01',end:'2026-11-30'});
const base={_id:'payment',job:'job',amount:100,platformFeeAmount:5,netAmountToWorker:100,paymentMode:'slip_demo',gatewayFeeAmount:0,createdAt:new Date('2026-11-01'),heldAt:new Date('2026-11-02'),jobCompletedAt:new Date('2026-11-03')};
test('slip awaiting review is not received money and carries no gateway fee',()=>{
  const payment={...base,status:'awaiting_verification',heldAt:null};
  const result=financials([payment],window);assert.equal(result.gross,0);assert.equal(result.pendingSlips,1);assert.equal(result.gatewayFees,0);assert.equal(overview([payment],true,window).lifetime.total,0);
});
test('completed work awaiting payout is counted as work, not a paid wage',()=>{
  const payment={...base,status:'payout_pending',releasedAt:null};
  const report=financials([payment],window);assert.equal(report.gross,105);assert.equal(report.workerPayouts,0);assert.equal(report.pendingPayouts,100);assert.equal(report.platformFees,5);assert.equal(report.held,100);
  const worker=overview([payment],false,window);assert.equal(worker.lifetime.total,0);assert.equal(worker.period.total,0);assert.equal(worker.period.completedJobs,1);assert.equal(worker.lifetime.payout_pending,100);
});
test('wages follow the payout date while job counts follow completion date',()=>{
  const payment={...base,status:'released',paidAt:new Date('2026-12-01'),releasedAt:new Date('2026-12-01')};
  const november=overview([payment],false,window);assert.equal(november.period.total,0);assert.equal(november.period.completedJobs,1);
  const december=overview([payment],false,range({period:'custom',start:'2026-12-01',end:'2026-12-31'}));assert.equal(december.period.total,100);assert.equal(december.period.completedJobs,0);
});
test('refund approval is not a completed return until the admin records its slip',()=>{
  const payment={...base,status:'refund_pending',refundRequestedAt:new Date('2026-11-03')};const report=financials([payment],window);assert.equal(report.refunds,0);assert.equal(report.pendingRefunds,1);assert.equal(report.held,105);
  const finished=financials([{...payment,status:'refunded',refundAmount:105,refundedAt:new Date('2026-11-04')}],window);assert.equal(finished.refunds,105);assert.equal(finished.netCash,0);
});
test('fee configuration defaults to five percent and accepts only five through ten',()=>{
  const before=process.env.ESCROW_FEE_PERCENT_MIN;
  try{for(const value of ['','0','4','11','bad']){process.env.ESCROW_FEE_PERCENT_MIN=value;assert.equal(feePercent(),5);}process.env.ESCROW_FEE_PERCENT_MIN='7.5';assert.equal(feePercent(),7.5);process.env.ESCROW_FEE_PERCENT_MIN='10';assert.equal(feePercent(),10);}
  finally{if(before===undefined)delete process.env.ESCROW_FEE_PERCENT_MIN;else process.env.ESCROW_FEE_PERCENT_MIN=before;}
});
