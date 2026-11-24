// Repair only old automatic releases with no evidence of an admin payout.
function planPaymentRepair(payment, defaultPercent, defaultFixedAmount = 10) {
  const set = {};
  const mode = payment.paymentMode || 'demo';
  if (mode === 'stripe_test' && (payment.mockGatewayFeePercent == null || payment.mockGatewayFeeFixedAmount == null || payment.mockGatewayFeeAmount == null)) {
    const percent = payment.mockGatewayFeePercent ?? defaultPercent;
    const fixed = payment.mockGatewayFeeFixedAmount ?? defaultFixedAmount;
    const chargeAmount = Number(payment.amount || 0) + Number(payment.platformFeeAmount || 0);
    set.mockGatewayFeePercent = percent;
    set.mockGatewayFeeFixedAmount = fixed;
    set.mockGatewayFeeAmount = Math.round((chargeAmount * percent / 100 + fixed) * 100) / 100;
  }
  let needsReview = false;
  if (['demo','slip_demo','stripe_test'].includes(mode) && payment.status === 'released' && !payment.hasPayoutSlip) {
    const job = payment.job;
    const completedAt = payment.jobCompletedAt || job?.completionConfirmedAt || payment.releasedAt;
    if (job?.status === 'completed' && String(job.hirer) === String(payment.hirer) && String(job.selectedWorker) === String(payment.worker) && completedAt && !payment.slipEvidence?.payout && !payment.paidAt && !payment.payoutReference && payment.payoutAmount == null) {
      Object.assign(set,{status:'payout_pending',jobCompletedAt:completedAt,releasedAt:null,paidAt:null});
    } else needsReview = true;
  }
  return {set,needsReview};
}
module.exports = {planPaymentRepair};
