// Repair only old automatic releases with no evidence of an admin payout.
function planPaymentRepair(payment, defaultPercent) {
  const set = {};
  const mode = payment.paymentMode || 'demo';
  if (mode === 'stripe_test' && (payment.mockGatewayFeePercent == null || payment.mockGatewayFeeAmount == null)) {
    const percent = payment.mockGatewayFeePercent ?? defaultPercent;
    set.mockGatewayFeePercent = percent;
    set.mockGatewayFeeAmount = Math.round(payment.amount * percent) / 100;
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
