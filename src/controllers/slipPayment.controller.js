const asyncHandler = require('express-async-handler');
const multer = require('multer');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const { Payment, Job } = require('../models');
const { withTransaction } = require('../services/transaction.service');
const { detectProofImage } = require('../utils/proofImage');
const { terms } = require('../services/paymentTerms.service');
const { completeRefund } = require('./refund.controller');

const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });
const requireId = id => { if (!mongoose.isValidObjectId(id)) throw fail('รหัสรายการไม่ถูกต้อง', 400); };
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 4 } }).single('slip');
const parseSlip = (req, res, next) => upload(req, res, error => error ? res.status(400).json({ message: 'แนบสลิป JPEG, PNG หรือ WebP หนึ่งภาพ ขนาดไม่เกิน 2 MB' }) : next());
function imageBytes(req) {
  if (!req.file || !detectProofImage(req.file.buffer)) throw fail('กรุณาแนบรูปสลิป JPEG, PNG หรือ WebP ที่ถูกต้อง', 400);
  return req.file.buffer;
}
function notes(value) {
  if (typeof value !== 'string' || value.trim().length < 10 || value.trim().length > 1000) throw fail('กรุณาระบุเหตุผล 10–1,000 ตัวอักษร', 400);
  return value.trim();
}
const audit = (req, action, message, version) => ({ action, by: req.user._id, at: new Date(), notes: message, version });
async function assignedJob(payment, session) {
  const job = await Job.findOne({ _id: payment.job, hirer: payment.hirer, selectedWorker: payment.worker, status: 'assigned' }).session(session);
  if (!job) throw fail('งานเปลี่ยนสถานะแล้ว กรุณาโหลดข้อมูลใหม่');
}
const getConfig = (req, res) => res.json(terms());
const submitInbound = [
  asyncHandler(async (req, res, next) => {
    requireId(req.params.jobId);
    const payment = await Payment.findOne({ job: req.params.jobId, hirer: req.user._id, status: { $in: ['pending', 'slip_rejected'] }, paymentMode: { $in: ['demo', 'slip_demo'] }, stripeSessionId: null });
    if (!payment) throw fail('ส่งสลิปได้เฉพาะผู้ว่าจ้างของรายการที่รอชำระหรือถูกปฏิเสธสลิป');
    next();
  }), parseSlip,
  asyncHandler(async (req, res) => {
    const bytes = imageBytes(req), version = randomUUID();
    await withTransaction(async session => {
      const payment = await Payment.findOneAndUpdate({ job: req.params.jobId, hirer: req.user._id, status: { $in: ['pending', 'slip_rejected'] }, paymentMode: { $in: ['demo', 'slip_demo'] }, stripeSessionId: null }, {
        $set: { status: 'awaiting_verification', paymentMode: 'slip_demo', 'slipEvidence.inbound': bytes, hasInboundSlip: true, inboundSlipVersion: version, slipSubmittedAt: new Date(), slipReviewNotes: null, slipReviewedAt: null, slipReviewedBy: null, gatewayFeeAmount: 0 },
        $push: { slipAudit: audit(req, 'inbound_submitted', 'ผู้ว่าจ้างส่งสลิปจำลอง', version) },
      }, { new: true, runValidators: true, session });
      if (!payment) throw fail('ส่งสลิปแล้วหรือรายการเปลี่ยนสถานะ ไม่สามารถส่งซ้ำได้');
      await assignedJob(payment, session);
    });
    res.json({ message: 'ส่งสลิปจำลองแล้ว รอผู้ดูแลตรวจรับก่อนเริ่มงาน' });
  }),
];
const reviewInbound = asyncHandler(async (req, res) => {
  requireId(req.params.id);
  const { decision, version } = req.body;
  const message = notes(req.body.notes);
  if (!['approved', 'rejected'].includes(decision) || typeof version !== 'string' || !version) throw fail('กรุณาระบุผลและเวอร์ชันสลิปที่ตรวจ', 400);
  await withTransaction(async session => {
    const payment = await Payment.findOneAndUpdate({ _id: req.params.id, paymentMode: 'slip_demo', status: 'awaiting_verification', inboundSlipVersion: version, hasInboundSlip: true }, {
      $set: { status: decision === 'approved' ? 'held' : 'slip_rejected', slipReviewNotes: message, slipReviewedBy: req.user._id, slipReviewedAt: new Date(), ...(decision === 'approved' ? { heldAt: new Date() } : {}) },
      $push: { slipAudit: audit(req, `inbound_${decision}`, message, version) },
    }, { new: true, runValidators: true, session });
    if (!payment) throw fail('สลิปถูกตรวจแล้วหรือเป็นรูปคนละเวอร์ชัน กรุณาโหลดใหม่');
    await assignedJob(payment, session);
  });
  res.json({ message: decision === 'approved' ? 'ยืนยันรับเงินจำลองแล้ว ผู้รับจ้างเริ่มงานได้' : 'ปฏิเสธสลิปแล้ว ผู้ว่าจ้างสามารถแนบใหม่ได้' });
});
const submitOutbound = [
  asyncHandler(async (req, res, next) => {
    requireId(req.params.id);
    const direction = req.params.direction;
    if (!['payout', 'refund'].includes(direction)) throw fail('ประเภทสลิปไม่ถูกต้อง', 400);
    const payment = await Payment.findOne({ _id: req.params.id, paymentMode: 'slip_demo', status: direction === 'payout' ? 'payout_pending' : 'refund_pending' });
    if (!payment) throw fail('รายการไม่อยู่ในสถานะรอจ่ายหรือรอคืนเงิน');
    next();
  }), parseSlip,
  asyncHandler(async (req, res) => {
    const bytes = imageBytes(req), message = notes(req.body.notes), direction = req.params.direction;
    await withTransaction(async session => {
      const isPayout = direction === 'payout';
      const payment = await Payment.findOneAndUpdate({ _id: req.params.id, paymentMode: 'slip_demo', status: isPayout ? 'payout_pending' : 'refund_pending' }, {
        $set: { [`slipEvidence.${direction}`]: bytes, [isPayout ? 'hasPayoutSlip' : 'hasRefundSlip']: true, ...(isPayout ? { status: 'released', paidAt: new Date(), releasedAt: new Date() } : {}) },
        $push: { slipAudit: audit(req, `${direction}_confirmed`, message) },
      }, { new: true, runValidators: true, session });
      if (!payment) throw fail('รายการนี้ดำเนินการแล้ว ไม่สามารถจ่ายซ้ำได้');
      if (isPayout) {
        const job = await Job.findOne({ _id: payment.job, status: 'completed' }).session(session);
        if (!job) throw fail('ยังไม่มีการยืนยันรับงาน ไม่สามารถจ่ายค่าจ้างได้');
      } else {
        if (payment.refundDecision !== 'approved') throw fail('ยังไม่ได้อนุมัติคำขอคืนเงิน');
        const job = await Job.findOne({ _id: payment.job, status: 'disputed' }).session(session);
        if (!job) throw fail('งานไม่อยู่ระหว่างพิจารณาคืนเงิน กรุณาตรวจสอบสถานะ');
        await completeRefund(payment._id, null, session);
      }
    });
    res.json({ message: direction === 'payout' ? 'บันทึกจ่ายค่าจ้างจำลองพร้อมสลิปแล้ว' : 'บันทึกคืนเงินจำลองพร้อมสลิปแล้ว' });
  }),
];
const getSlip = asyncHandler(async (req, res) => {
  requireId(req.params.id);
  const direction = req.params.direction;
  if (!['inbound', 'payout', 'refund'].includes(direction)) throw fail('ประเภทสลิปไม่ถูกต้อง', 400);
  const payment = await Payment.findById(req.params.id);
  if (!payment || !req.user.isAdmin && ![String(payment.hirer), String(payment.worker)].includes(String(req.user._id))) return res.status(404).json({ message: 'ไม่พบสลิป' });
  const stored = await Payment.findById(payment._id).select('+slipEvidence');
  const bytes = stored?.slipEvidence?.[direction];
  const image = bytes && detectProofImage(bytes);
  if (!image) return res.status(404).json({ message: 'ยังไม่มีสลิปสำหรับรายการนี้' });
  res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }).type(image.mime).send(bytes);
});
module.exports = { getConfig, submitInbound, reviewInbound, submitOutbound, getSlip };
