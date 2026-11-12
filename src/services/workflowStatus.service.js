const { Payment } = require('../models');

function effectiveJobStatus(status, paymentStatus) {
  if (paymentStatus === 'refunded') return 'cancelled';
  if (['disputed', 'refund_pending'].includes(paymentStatus)) return 'disputed';
  return status;
}
const plain = value => typeof value.toObject === 'function' ? value.toObject() : { ...value };

// Call only after authorizing the jobs/requests. Expose status, never private proof or bank data.
async function withJobPaymentStates(jobs) {
  if (!jobs.length) return [];
  const payments = await Payment.find({ job: { $in: jobs.map(job => job._id) } })
    .select('job status').lean();
  const byJob = new Map(payments.map(payment => [String(payment.job), payment.status]));
  return jobs.map(job => {
    const result = plain(job);
    result.paymentStatus = byJob.get(String(result._id)) || null;
    result.status = effectiveJobStatus(result.status, result.paymentStatus);
    return result;
  });
}

async function withRequestPaymentStates(requests) {
  const jobs = requests.map(request => request.resultingJob).filter(job => job?._id && job.status);
  const states = new Map((await withJobPaymentStates(jobs)).map(job => [String(job._id), job]));
  return requests.map(request => {
    const result = plain(request);
    const job = states.get(String(result.resultingJob?._id));
    if (job) {
      result.resultingJob = job;
      result.paymentStatus = job.paymentStatus;
    }
    return result;
  });
}
module.exports = { effectiveJobStatus, withJobPaymentStates, withRequestPaymentStates };
