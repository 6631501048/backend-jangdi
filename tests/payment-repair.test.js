const test=require('node:test');
const assert=require('node:assert/strict');
const {planPaymentRepair}=require('../src/services/paymentRepair.service');
const base={paymentMode:'stripe_test',status:'released',amount:100,hirer:'h',worker:'w',releasedAt:'2026-11-06',job:{status:'completed',hirer:'h',selectedWorker:'w'}};
test('repair queues old automatic releases and separates mock fees from provider fees',()=>{
  const plan=planPaymentRepair({...base,gatewayFeeAmount:4},3);
  assert.equal(plan.set.status,'payout_pending');assert.equal(plan.set.mockGatewayFeeAmount,3);
  assert.equal(plan.set.releasedAt,null);assert.equal('gatewayFeeAmount' in plan.set,false);
});
test('repair never requeues records with any indication of an admin payout or mismatched job',()=>{
  for(const override of [{hasPayoutSlip:true},{paidAt:'2026-11-07'},{payoutReference:'bank123'},{payoutAmount:100},{slipEvidence:{payout:Buffer.from('image')}},{job:{...base.job,selectedWorker:'other'}},{job:{...base.job,status:'cancelled'}}]) {
    assert.equal(planPaymentRepair({...base,...override},3).set.status,undefined);
  }
});
test('repair preserves a snapshotted mock percentage and leaves verified records unchanged',()=>{
  assert.equal(planPaymentRepair({...base,mockGatewayFeePercent:7},3).set.mockGatewayFeeAmount,7);
  assert.deepEqual(planPaymentRepair({...base,hasPayoutSlip:true,mockGatewayFeePercent:7,mockGatewayFeeAmount:7},3).set,{});
});
