const asyncHandler = require('express-async-handler');
const multer = require('multer');
const mongoose = require('mongoose');
const {Payment,Job,ServiceRequest,ServicePost} = require('../models');
const {withTransaction} = require('../services/transaction.service');
const {detectProofImage} = require('../utils/proofImage');
const stripe = require('../services/stripe.service');
const {paidTotal} = require('../services/finance.service');
const upload = multer({storage:multer.memoryStorage(),limits:{fileSize:2*1024*1024,files:3,fields:4}}).array('evidence',3);
const error = (message,statusCode=409) => Object.assign(new Error(message),{statusCode});
const requestRefund = [
  asyncHandler(async (req,res,next) => {
    const payment = await Payment.findOne({job:req.params.jobId,hirer:req.user._id,status:'held'});
    if (!payment) return res.status(409).json({message:'ขอคืนเงินได้เฉพาะผู้ว่าจ้างที่ชำระแล้วและยังไม่ยืนยันรับงาน'});
    next();
  }),
  (req,res,next) => upload(req,res,err => err ? res.status(400).json({message:'แนบภาพได้ไม่เกิน 3 ภาพ ภาพละไม่เกิน 2 MB'}) : next()),
  asyncHandler(async (req,res) => {
    const reason = req.body.reason;
    if (typeof reason !== 'string' || reason.trim().length < 10 || reason.trim().length > 1000) return res.status(400).json({message:'ระบุเหตุผล 10–1000 ตัวอักษร'});
    const evidence = (req.files || []).map(file => {
      const image = detectProofImage(file.buffer);
      if (!image) throw error('กรุณาแนบรูป JPEG, PNG หรือ WebP ที่ถูกต้อง',400);
      return {data:file.buffer,contentType:image.mimeType || image.mime || file.mimetype};
    });
    const payment = await withTransaction(async session => {
      const job = await Job.findOneAndUpdate({_id:req.params.jobId,hirer:req.user._id,status:{$in:['assigned','in_progress','awaiting_confirmation']}},{$set:{status:'disputed'}},{new:false,session});
      if (!job) throw error('งานเปลี่ยนสถานะแล้ว ไม่สามารถขอคืนเงินได้');
      const payment = await Payment.findOneAndUpdate({job:job._id,hirer:req.user._id,status:'held'},{$set:{status:'disputed',disputeReason:reason.trim(),disputeRaisedBy:req.user._id,refundRequestedAt:new Date(),refundPreviousJobStatus:job.status,refundEvidence:evidence,refundEvidenceCount:evidence.length,refundDecision:null}},{new:true,session});
      if (!payment) throw error('รายการชำระเงินเปลี่ยนสถานะแล้ว');
      return payment;
    });
    res.json({message:'ส่งคำขอคืนเงินให้ผู้ดูแลแล้ว งานจะพักไว้ระหว่างพิจารณา',paymentId:payment._id});
  }),
];
const getEvidence = asyncHandler(async (req,res) => {
    const payment = await Payment.findById(req.params.id).select('+refundEvidence');
  if (!payment || !req.user.isAdmin && ![String(payment.hirer),String(payment.worker)].includes(String(req.user._id))) return res.status(404).json({message:'ไม่พบหลักฐาน'});
  const index = Number(req.params.index);
  const file = Number.isInteger(index) && index >= 0 ? payment.refundEvidence?.[index] : null;
  if (!file) return res.status(404).json({message:'ไม่พบหลักฐาน'});
  res.set({'Content-Type':file.contentType,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}).send(file.data);
});
async function completeRefund(paymentId, refund, existingSession) {
  const work = async session => {
    const payment = await Payment.findOneAndUpdate({_id:paymentId,status:{$in:['disputed','refund_pending']},refundDecision:'approved'},{$set:{status:'refunded',refundedAt:new Date(),refundStatus:'succeeded',...(refund ? {stripeRefundId:refund.id,refundMethod:'stripe'}:{})}},{new:true,session});
    if (payment) {
      const job = await Job.findOneAndUpdate({_id:payment.job,status:'disputed'},{$set:{status:'cancelled',cancelledAt:new Date(),cancelReason:'ผู้ดูแลอนุมัติคืนเงิน'}},{new:true,session});
      if (job?.originServiceRequest) {
        const origin = await ServiceRequest.findById(job.originServiceRequest).session(session);
        const post = origin?.servicePost ? await ServicePost.findById(origin.servicePost).session(session) : null;
        if (post?.currentOrderCount > 0) {
          const change = {$inc:{currentOrderCount:-1}};
          if (post.status === 'closed' && post.closeReason === 'capacity' && post.availabilityEnd > new Date()) change.$set = {status:'active',closeReason:null};
          await ServicePost.updateOne({_id:post._id,currentOrderCount:{$gt:0}},change,{session});
        }
      }
    }
  };
  if (existingSession) return work(existingSession);
  return withTransaction(work);
}
async function recordStripeRefund(payment, refund) {
  if (!refund || refund.livemode !== false || refund.currency !== 'thb' ||
      refund.payment_intent !== payment.stripePaymentIntentId ||
      refund.amount !== Math.round(paidTotal(payment)*100) ||
      refund.metadata?.paymentId !== String(payment._id) ||
      !refund.id || (payment.stripeRefundId && payment.stripeRefundId !== refund.id)) {
    throw error('ผลคืนเงิน Stripe ไม่ตรงกับรายการ กรุณาตรวจสอบก่อนดำเนินการ',502);
  }
  // A delayed API response must never replace a completed refund with pending/failed.
  await Payment.updateOne({_id:payment._id,paymentMode:'stripe_test',status:'disputed',refundDecision:'approved'},{$set:{stripeRefundId:refund.id,refundStatus:refund.status}});
  if (refund.status === 'succeeded') await completeRefund(payment._id,refund);
}
const decideRefund = asyncHandler(async (req,res) => {
  const {decision,notes} = req.body;
  if (!mongoose.isValidObjectId(req.params.id) || !['approved','rejected'].includes(decision) || typeof notes !== 'string' || notes.trim().length < 10 || notes.trim().length > 1000) return res.status(400).json({message:'กรุณาระบุผลการพิจารณาและเหตุผล 10–1000 ตัวอักษร'});
  let payment;
  if (decision === 'approved') {
    const current = await Payment.findById(req.params.id);
    if (current && ['slip_demo','demo'].includes(current.paymentMode)) {
      payment = await Payment.findOneAndUpdate({ _id: current._id, paymentMode: current.paymentMode, status: 'disputed', refundDecision: null }, {
        $set: { status: 'refund_pending', refundDecision: 'approved', refundNotes: notes.trim(), refundDecidedBy: req.user._id, refundAmount: paidTotal(current), refundStatus: 'pending', refundMethod: 'admin_transfer' },
        $push: { slipAudit: { action: 'refund_approved', by: req.user._id, at: new Date(), notes: notes.trim() } },
      }, { new: true, runValidators: true });
      if (!payment) throw error('รายการนี้ถูกพิจารณาแล้ว');
      return res.json({ message: 'อนุมัติแล้ว รอผู้ดูแลแนบสลิปคืนเงินจำลอง งานยังพักไว้จนกว่าจะบันทึกคืนเงิน' });
    }
  }
  if (decision === 'rejected') {
    await withTransaction(async session => {
      payment = await Payment.findOneAndUpdate({_id:req.params.id,status:'disputed',refundDecision:null},{$set:{status:'held',refundDecision:'rejected',refundNotes:notes.trim(),refundDecidedBy:req.user._id}},{new:true,session});
      if (!payment) throw error('รายการนี้ถูกพิจารณาแล้ว');
      await Job.updateOne({_id:payment.job,status:'disputed'},{$set:{status:payment.refundPreviousJobStatus || 'awaiting_confirmation'}},{session});
    });
  } else {
    // Persist approval before contacting Stripe; retries share one idempotency key.
    payment = await Payment.findOneAndUpdate({_id:req.params.id,status:'disputed',paymentMode:'stripe_test',refundDecision:{$in:[null,'approved']}},{$set:{refundDecision:'approved',refundNotes:notes.trim(),refundDecidedBy:req.user._id}},{new:true});
    if (!payment) throw error('รายการนี้ถูกพิจารณาแล้ว');
    const amount = paidTotal(payment);
    await Payment.updateOne({_id:payment._id},{$set:{refundAmount:amount}});
    if (payment.paymentMode === 'stripe_test') {
      if (!payment.stripePaymentIntentId) throw error('ไม่พบรายการชำระ Stripe สำหรับคืนเงิน');
      // Once a refund exists, retrieve it instead of POSTing again after key expiry.
      const refund = payment.stripeRefundId
        ? await stripe.request(`refunds/${payment.stripeRefundId}`)
        : await stripe.request('refunds',{method:'POST',key:`refund-${payment._id}`,params:{payment_intent:payment.stripePaymentIntentId,amount:Math.round(amount*100),'metadata[paymentId]':String(payment._id)}});
      await recordStripeRefund(payment,refund);
      if (['failed','canceled'].includes(refund.status)) throw error('Stripe คืนเงินไม่สำเร็จ กรุณาตรวจสอบรายการใน Stripe ก่อนดำเนินการต่อ');
      return res.json({message:refund.status === 'succeeded' ? 'Stripe ยืนยันคืนเงินเต็มจำนวนแล้ว' : 'อนุมัติแล้ว กำลังรอ Stripe ยืนยันการคืนเงิน'});
    } else throw error('รายการโอนเงินจริงต้องดำเนินการคืนเงินด้วยตนเอง');
  }
  res.json({message:decision === 'approved' ? 'บันทึกอนุมัติคืนเงินเต็มจำนวนรวมค่าบริการแล้ว':'ปฏิเสธคำขอและคืนงานสู่ขั้นตอนเดิมแล้ว'});
});
module.exports = {requestRefund,getEvidence,decideRefund,completeRefund,recordStripeRefund};
