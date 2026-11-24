const { ServiceRequest, Job, Payment } = require('../models');
const ACTIVE_STATUSES = ['assigned', 'in_progress', 'awaiting_confirmation', 'disputed'];

// Count persisted work, including old jobs whose request link was only partly saved.
// A completed refund frees its slot even when the old Job status was not repaired.
async function getActiveServiceOrderCounts(postIds, session = null) {
  const counts = new Map(postIds.map(id => [String(id), 0]));
  if (!postIds.length) return counts;
  const requests = await ServiceRequest.find({ servicePost: { $in: postIds } })
    .select('_id servicePost resultingJob').session(session).lean();
  if (!requests.length) return counts;
  const byRequest = new Map(requests.map(request => [String(request._id), String(request.servicePost?._id || request.servicePost)]));
  const byJob = new Map(requests.filter(request => request.resultingJob)
    .map(request => [String(request.resultingJob?._id || request.resultingJob), String(request.servicePost?._id || request.servicePost)]));
  const jobs = await Job.find({
    status: { $in: ACTIVE_STATUSES },
    $or: [{ originServiceRequest: { $in: requests.map(request => request._id) } }, { _id: { $in: [...byJob.keys()] } }],
  }).select('_id originServiceRequest').session(session).lean();
  if (!jobs.length) return counts;
  const refunded = await Payment.find({ job: { $in: jobs.map(job => job._id) }, status: 'refunded' })
    .select('job').session(session).lean();
  const refundedIds = new Set(refunded.map(payment => String(payment.job)));
  for (const job of jobs) {
    if (refundedIds.has(String(job._id))) continue;
    const postId = byRequest.get(String(job.originServiceRequest)) || byJob.get(String(job._id));
    if (counts.has(postId)) counts.set(postId, counts.get(postId) + 1);
  }
  return counts;
}
function presentServiceCapacity(post, count) {
  const result = typeof post.toObject === 'function' ? post.toObject() : { ...post };
  result.currentOrderCount = count || 0;
  if ((result.status === 'active' || (result.status === 'closed' && result.closeReason === 'capacity')) && new Date(result.availabilityEnd) > new Date()) {
    const full = result.currentOrderCount >= result.maxSimultaneousOrders;
    result.status = full ? 'closed' : 'active';
    result.closeReason = full ? 'capacity' : null;
  }
  return result;
}
module.exports = { getActiveServiceOrderCounts, presentServiceCapacity };
