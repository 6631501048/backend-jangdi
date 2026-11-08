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
  const payment={...base,status:'released',hasPayoutSlip:true,paidAt:new Date('2026-12-01'),releasedAt:new Date('2026-12-01')};
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

test('Stripe worker earnings require a payout slip, and fee reports use only mock costs',()=>{
  const payment={...base,paymentMode:'stripe_test',mockGatewayFeeAmount:3,mockGatewayFeePercent:3,gatewayFeeAmount:99,status:'payout_pending'};
  let report=financials([payment],window);assert.equal(report.gatewayFees,3);assert.equal(report.netCash,102);assert.equal(report.workerPayouts,0);
  assert.equal(overview([payment],false,window).lifetime.total,0);
  const legacy={...payment,status:'released',releasedAt:new Date('2026-11-03')};
  assert.equal(overview([legacy],false,window).lifetime.total,0);assert.equal(financials([legacy],window).workerPayouts,0);
  const paid={...legacy,hasPayoutSlip:true,paidAt:new Date('2026-11-04')};
  report=financials([paid],window);assert.equal(report.workerPayouts,100);assert.equal(report.netCash,2);
  assert.equal(overview([paid],false,window).lifetime.total,100);
});

test('Stripe successful refunds are accounted once even while waiting for admin proof',()=>{
  const row={...base,paymentMode:'stripe_test',status:'refunded',refundStatus:'succeeded',refundedAt:new Date('2026-11-03'),refundAmount:105,mockGatewayFeeAmount:3};
  const waiting=financials([row],window);const withProof=financials([{...row,hasRefundSlip:true}],window);
  assert.equal(waiting.refunds,105);assert.equal(withProof.refunds,105);assert.equal(waiting.netCash,-3);
  assert.equal(waiting.pendingRefundEvidence,1);assert.equal(withProof.pendingRefundEvidence,0);
});

test('mock percentage accepts zero/decimals and rejects malformed configuration',()=>{
  const {mockStripeFeePercent}=require('../src/services/paymentTerms.service');
  const previous=process.env.MOCK_STRIPE_FEE_PERCENT;
  try {
    for(const value of ['', 'bad','-1','101','Infinity']){process.env.MOCK_STRIPE_FEE_PERCENT=value;assert.equal(mockStripeFeePercent(),3);}
    process.env.MOCK_STRIPE_FEE_PERCENT='0';assert.equal(mockStripeFeePercent(),0);
    process.env.MOCK_STRIPE_FEE_PERCENT='2.75';assert.equal(mockStripeFeePercent(),2.75);
  } finally {if(previous===undefined)delete process.env.MOCK_STRIPE_FEE_PERCENT;else process.env.MOCK_STRIPE_FEE_PERCENT=previous;}
});
