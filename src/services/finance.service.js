const round = n => Math.round((Number(n) || 0) * 100) / 100;
const paidTotal = p => round(p.amount + p.platformFeeAmount);
function range(query, now = new Date()) {
  const period = query.period || 'month';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const [year, month] = today.split('-').map(Number);
  let start, end;
  if (period === 'month' || period === 'last-month') {
    const offset = period === 'month' ? 0 : -1;
    start = new Date(Date.UTC(year, month - 1 + offset, 1, -7));
    end = new Date(Date.UTC(year, month + offset, 1, -7));
  } else if (period === 'custom') {
    for (const key of ['start', 'end']) {
      if (typeof query[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(query[key]) || !Number.isFinite(Date.parse(query[key])) || new Date(query[key]).toISOString().slice(0,10) !== query[key]) throw new Error('กรุณาระบุวันที่เริ่มต้นและสิ้นสุดให้ถูกต้อง');
    }
    start = new Date(`${query.start}T00:00:00+07:00`);
    end = new Date(new Date(`${query.end}T00:00:00+07:00`).getTime() + 86400000);
    if (start >= end) throw new Error('วันที่เริ่มต้นต้องไม่อยู่หลังวันที่สิ้นสุด');
  } else if (period !== 'all') throw new Error('ช่วงเวลาไม่ถูกต้อง');
  const format = d => d.toLocaleDateString('th-TH', { timeZone:'Asia/Bangkok', dateStyle:'medium' });
  return { start, end, label: start ? `${format(start)} – ${format(new Date(end - 1))}` : 'ตลอดการใช้งาน', includes: value => !!value && (!start || new Date(value) >= start && new Date(value) < end) };
}
const completionDate = p => p.jobCompletedAt || p.releasedAt;
const payoutDate = p => p.paymentMode === 'slip_demo' ? p.paidAt : p.releasedAt;
function overview(payments, isHirer, window) {
  const sum = (rows, fn) => round(rows.reduce((n,p) => n + Number(fn(p) || 0), 0));
  const amount = p => isHirer ? paidTotal(p) : p.netAmountToWorker;
  const valid = payments.filter(p => ['held','payout_pending','released','disputed','refund_pending'].includes(p.status));
  const completed = payments.filter(p => ['released','payout_pending'].includes(p.status) && window.includes(completionDate(p)));
  const received = payments.filter(p => p.status === 'released' && window.includes(payoutDate(p)));
  const periodPaid = valid.filter(p => window.includes(p.heldAt));
  return {
    rangeLabel: window.label,
    lifetime: { total: sum(isHirer ? valid : payments.filter(p => p.status === 'released'), amount),
      ...Object.fromEntries(['pending','awaiting_verification','slip_rejected','held','payout_pending','disputed','refund_pending','refunded'].map(status => [status, sum(payments.filter(p => p.status === status), p => status === 'refunded' && isHirer ? (p.refundAmount ?? paidTotal(p)) : amount(p))])) },
    period: { total: sum(isHirer ? periodPaid : received, amount), completedJobs: completed.length, fees: sum(isHirer ? periodPaid : received, p => isHirer ? p.platformFeeAmount : Math.max(0, p.amount - p.netAmountToWorker)) },
    transactions: payments.filter(p => window.includes(p.createdAt)).map(p => ({ id:p._id, jobId:p.job?._id || p.job, jobTitle:p.job?.title || 'งานถูกลบ', amount:amount(p), date:p.createdAt, status:p.status, paymentMode:p.paymentMode || 'demo', hasInboundSlip:p.hasInboundSlip, hasPayoutSlip:p.hasPayoutSlip, hasRefundSlip:p.hasRefundSlip })),
  };
}
function financials(payments, window) {
  const sum = (rows, fn) => round(rows.reduce((n,p) => n + Number(fn(p) || 0), 0));
  const incoming = payments.filter(p => p.heldAt && window.includes(p.heldAt));
  const released = payments.filter(p => p.status === 'released' && window.includes(payoutDate(p)));
  const completed = payments.filter(p => ['released','payout_pending'].includes(p.status) && window.includes(completionDate(p)));
  const refunded = payments.filter(p => p.status === 'refunded' && window.includes(p.refundedAt));
  const gateway = incoming.filter(p => p.paymentMode === 'stripe_test');
  const unknownFees = gateway.filter(p => p.gatewayFeeAmount == null).length;
  const gross = sum(incoming, paidTotal), payouts = sum(released, p => p.netAmountToWorker), refunds = sum(refunded, p => p.refundAmount ?? paidTotal(p));
  const fees = sum(incoming, p => p.gatewayFeeAmount || 0);
  return { rangeLabel:window.label, gross, workerPayouts:payouts, refunds, gatewayFees:unknownFees ? null : fees, unknownFees,
    platformFees:sum(completed,p => p.platformFeeAmount), netCash: unknownFees ? null : round(gross-payouts-refunds-fees), completedJobs:completed.length,
    pendingRefunds:payments.filter(p => ['disputed','refund_pending'].includes(p.status) && window.includes(p.refundRequestedAt)).length,
    pendingSlips:payments.filter(p => p.status === 'awaiting_verification').length,
    pendingPayouts:sum(payments.filter(p => p.status === 'payout_pending'),p => p.netAmountToWorker),
    held:round(sum(payments.filter(p => ['held','disputed','refund_pending'].includes(p.status)),paidTotal)+sum(payments.filter(p => p.status === 'payout_pending'),p => p.netAmountToWorker)),
    modes:{demo:incoming.filter(p => (p.paymentMode || 'demo') === 'demo').length,stripe_test:gateway.length,slip_demo:incoming.filter(p => p.paymentMode === 'slip_demo').length} };
}
module.exports = { range, overview, financials, paidTotal, round };
