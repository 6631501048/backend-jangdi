const { ServiceRequest } = require('../models');
const { createNotification } = require('./notification.service');

async function closeUnselectedRequests(postId, reason, session) {
  const pending = (await ServiceRequest.find({ servicePost: postId, status: 'pending' })
    .select('_id hirer status').session(session).lean()).filter(request => request.status === 'pending');
  if (!pending.length) return;
  await ServiceRequest.updateMany({ _id: { $in: pending.map(request => request._id) }, status: 'pending' }, {
    $set: { status: 'declined', declineReason: reason, respondedAt: new Date() },
  }, { session, runValidators: true });
  for (const request of pending) {
    await createNotification({ userId: request.hirer, type: 'application_update',
      title: reason === 'capacity' ? 'คำขอบริการไม่ได้รับเลือก' : 'คำขอบริการปิดแล้ว',
      message: reason === 'capacity' ? 'ผู้รับจ้างรับงานครบตามจำนวนแล้ว ดูผลคำขอได้ที่ งานของฉัน › คำขอใช้บริการ' : 'ประกาศบริการนี้ปิดรับแล้ว ดูประวัติคำขอได้ที่ งานของฉัน › คำขอใช้บริการ',
      relatedEntityType: 'ServiceRequestResult', relatedEntityId: request._id,
    }, session);
  }
}

// Legacy pending requests still have an outcome when their listing is gone/closed.
// Keep their history visible even before running the repair script.
function presentServiceRequestOutcome(request) {
  if (request.status !== 'pending') return request;
  const post = request.servicePost;
  let reason;
  if (!post) reason = 'post_closed';
  else if (['closed', 'rejected'].includes(post.status)) reason = post.closeReason === 'capacity' ? 'capacity' : post.closeReason === 'refund' ? 'refund' : 'post_closed';
  else if (post.status === 'expired' || (post.availabilityEnd && new Date(post.availabilityEnd) < new Date())) reason = 'expired';
  return reason ? { ...request, status: 'declined', declineReason: reason } : request;
}
module.exports = { closeUnselectedRequests, presentServiceRequestOutcome };
