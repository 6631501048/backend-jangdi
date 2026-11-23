const { ServicePost, ServiceRequest, Job, Payment } = require('../models');
const { withTransaction } = require('./transaction.service');
const { getActiveServiceOrderCounts } = require('./serviceCapacity.service');
const { closeUnselectedRequests } = require('./serviceRequestOutcome.service');
const { logJobStatusChange } = require('./jobLog.service');
const { createNotification, deliverNotification } = require('./notification.service');
const conflict = message => Object.assign(new Error(message), { statusCode: 409 });

// Single and multiple selection share one capacity lock and all-or-nothing commit.
async function acceptServiceRequests({ postId, requestIds, workerId, io }) {
  const result = await withTransaction(async session => {
    const post = await ServicePost.findOneAndUpdate({
      _id: postId, worker: workerId, availabilityEnd: { $gte: new Date() },
      $or: [{ status: 'active' }, { status: 'closed', closeReason: 'capacity' }],
    }, { $inc: { currentOrderCount: requestIds.length } }, { new: true, runValidators: true, session });
    if (!post) throw conflict('ประกาศปิดรับหรือหมดเวลาแล้ว ไม่สามารถรับงานเพิ่มได้');
    const limit = Number(post.maxSimultaneousOrders);
    if (!Number.isInteger(limit) || limit < 1 || limit > 3) throw conflict('จำนวนงานสูงสุดของประกาศไม่ถูกต้อง');
    const counts = await getActiveServiceOrderCounts([post._id], session);
    const activeCount = counts.get(String(post._id)) || 0;
    if (activeCount + requestIds.length > limit) throw conflict(`โพสต์นี้รับงานพร้อมกันได้สูงสุด ${limit} งาน ขณะนี้มี ${activeCount} งานที่ยังไม่จบ เหลือรับได้ ${Math.max(0, limit - activeCount)} งาน`);

    const requests = await ServiceRequest.find({ _id: { $in: requestIds }, servicePost: post._id, status: 'pending' }).session(session).lean();
    if (requests.length !== requestIds.length) throw conflict('บางคำขอเปลี่ยนสถานะหรือไม่ได้อยู่ในโพสต์นี้ กรุณาตรวจสอบและเลือกใหม่');
    const byId = new Map(requests.map(request => [String(request._id), request]));
    const accepted = [], notifications = [];
    for (const requestId of requestIds) {
      const request = byId.get(String(requestId));
      const claimed = await ServiceRequest.findOneAndUpdate({ _id: request._id, servicePost: post._id, status: 'pending' },
        { $set: { status: 'accepted', respondedAt: new Date(), declineReason: null } }, { new: true, runValidators: true, session });
      if (!claimed) throw conflict('คำขอเปลี่ยนสถานะแล้ว กรุณาตรวจสอบและเลือกใหม่');
      const [job] = await Job.create([{
        hirer: request.hirer, category: post.category, title: post.title,
        description: request.orderDetails || post.description,
        fromText: request.orderData?.pickupLocation || request.orderData?.from || post.title,
        toText: request.orderData?.to || '', notes: request.orderData?.requirements || '',
        price: post.fee, scheduledAt: new Date(), location: post.location, contentFilterPassed: true,
        status: 'assigned', selectedWorker: post.worker, originServiceRequest: request._id,
      }], { session });
      const fees = require('./paymentTerms.service').calculateCombinedFees(Number(post.fee), { deliveryService: post.category === 'delivery' });
      await Payment.create([{
        job: job._id, hirer: request.hirer, worker: post.worker, amount: post.fee,
        platformFeePercent: fees.appPercent, platformFeeAmount: fees.platformFeeAmount,
        platformFeeFixedAmount: fees.appFixed, netAmountToWorker: post.fee, status: 'pending', paymentMode: 'slip_demo',
        gatewayFeeAmount: fees.gatewayFeeAmount, mockGatewayFeeAmount: fees.gatewayFeeAmount,
        mockGatewayFeePercent: fees.gatewayPercent, mockGatewayFeeFixedAmount: fees.gatewayFixed,
      }], { session });
      await ServiceRequest.updateOne({ _id: request._id, status: 'accepted' }, { $set: { resultingJob: job._id } }, { session });
      await logJobStatusChange({ jobId: job._id, previousStatus: null, newStatus: 'assigned', changedBy: workerId,
        note: `แปลงมาจาก Service Request ${request._id}`, session });
      notifications.push(await createNotification({ userId: request.hirer, type: 'payment_update',
        title: 'ผู้รับจ้างรับคำขอแล้ว กรุณาชำระเงิน', message: post.title,
        relatedEntityType: 'Job', relatedEntityId: job._id,
      }, session));
      accepted.push({ requestId: request._id, jobId: job._id });
    }
    const nextCount = activeCount + requestIds.length;
    await ServicePost.updateOne({ _id: post._id }, { $set: {
      currentOrderCount: nextCount, status: nextCount >= limit ? 'closed' : 'active', closeReason: nextCount >= limit ? 'capacity' : null,
    } }, { session });
    if (nextCount >= limit) await closeUnselectedRequests(post._id, 'capacity', session);
    return { accepted, notifications };
  });
  // Delivery failure cannot undo a committed selection; the persisted outbox retries.
  if (io) for (const notification of result.notifications) {
    try { await deliverNotification(io, notification); } catch { /* retryPendingNotifications handles committed intents */ }
  }
  return result.accepted;
}
module.exports = { acceptServiceRequests };
