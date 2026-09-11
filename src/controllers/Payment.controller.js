const asyncHandler = require("express-async-handler");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { Payment } = require("../models");
const { notifyUser } = require("../services/notification.service");

/**
 * GET /api/payments/wallet — FR-PAY-08
 * สรุปยอดตาม state ของ Escrow (FR-PAY-02): pending / held (in progress) / released (available)
 * มุมมองสลับตาม currentRole ของผู้ใช้ (บัญชีเดียวสลับ hirer/worker ได้ตาม FR-AUTH-06):
 *   - worker: ดูเงินที่ตัวเอง "ได้รับ" (netAmountToWorker หลังหักค่าธรรมเนียม)
 *   - hirer:  ดูเงินที่ตัวเอง "จ่ายออกไป" (amount เต็มก่อนหักค่าธรรมเนียม)
 * หมายเหตุ: "released" หมายถึงเงินที่ Admin โอนเข้าบัญชีธนาคารของ worker ไปแล้วจริง (FR-PAY-05)
 * ไม่มี wallet กลางในแอปที่ต้อง "เติมเงิน" หรือ "ถอน" — ยึดตามระบบ escrow แบบ manual slip ใน proposal
 */
const getWallet = asyncHandler(async (req, res) => {
  const isHirer = req.user.currentRole === "hirer";
  const matchField = isHirer ? "hirer" : "worker";
  const sumField = isHirer ? "amount" : "netAmountToWorker";

  const rows = await Payment.aggregate([
    { $match: { [matchField]: req.user._id } },
    { $group: { _id: "$status", total: { $sum: `$${sumField}` } } },
  ]);

  const totals = { pending: 0, held: 0, released: 0 };
  rows.forEach((r) => {
    if (r._id in totals) totals[r._id] = r.total;
  });

  if (isHirer) {
    res.json({
      totalPaid: totals.released, // จ่ายออกไปจริงแล้ว (โอนเข้าบัญชี worker ตอน confirm-completion)
      inEscrow: totals.held, // อยู่ใน Escrow รองาน worker ทำเสร็จ+ยืนยัน
      pendingPayment: totals.pending, // เลือก worker แล้วแต่ยังไม่มีสลิปโอนเข้า Escrow (FR-PAY-04)
    });
  } else {
    res.json({
      availableBalance: totals.released, // โอนเข้าบัญชี worker แล้วจริง (FR-PAY-05)
      pendingBalance: totals.pending, // รอผู้ว่าจ้างโอนเงินเข้า Escrow
      inProgressBalance: totals.held, // อยู่ใน Escrow รอ Hirer ยืนยันงานเสร็จ
    });
  }
});

/**
 * GET /api/payments/summary?period=month|last-month|all — FR-PAY-08
 * worker เห็น totalEarnings, hirer เห็น totalSpent
 */
const getSummary = asyncHandler(async (req, res) => {
  const isHirer = req.user.currentRole === "hirer";
  const { period = "all" } = req.query;
  const match = { [isHirer ? "hirer" : "worker"]: req.user._id, status: "released" };

  const now = new Date();
  if (period === "month") {
    match.releasedAt = { $gte: new Date(now.getFullYear(), now.getMonth(), 1) };
  } else if (period === "last-month") {
    match.releasedAt = {
      $gte: new Date(now.getFullYear(), now.getMonth() - 1, 1),
      $lt: new Date(now.getFullYear(), now.getMonth(), 1),
    };
  }

  const payments = await Payment.find(match);

  if (isHirer) {
    const totalSpent = payments.reduce((sum, p) => sum + p.amount, 0);
    res.json({ totalSpent, completeJobs: payments.length });
  } else {
    const totalEarnings = payments.reduce((sum, p) => sum + p.netAmountToWorker, 0);
    res.json({ totalEarnings, completeJobs: payments.length, averageRating: req.user.credibilityScore });
  }
});

/**
 * GET /api/payments/transactions?limit=20 — FR-PAY-08
 * worker: ประวัติเงินที่ได้รับ (received) / hirer: ประวัติเงินที่จ่ายออก (paid) — เรียงล่าสุดก่อน
 */
const getTransactions = asyncHandler(async (req, res) => {
  const isHirer = req.user.currentRole === "hirer";
  const limit = Math.min(Number(req.query.limit) || 20, 100);

  const payments = await Payment.find({ [isHirer ? "hirer" : "worker"]: req.user._id, status: "released" })
    .populate("job", "title")
    .sort({ releasedAt: -1 })
    .limit(limit);

  const transactions = payments.map((p) => ({
    id: p._id,
    type: isHirer ? "paid" : "received",
    jobTitle: p.job?.title || "-",
    amount: isHirer ? p.amount : p.netAmountToWorker,
    date: p.releasedAt,
  }));

  res.json(transactions);
});

/* ---------- อัปโหลดสลิปโอนเงิน (FR-PAY-04) ---------- */
const SLIP_DIR = path.join(__dirname, "..", "..", "uploads", "payment-slips");
fs.mkdirSync(SLIP_DIR, { recursive: true });
const slipUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, SLIP_DIR),
    filename: (req, file, cb) => cb(null, `${req.params.jobId}-${Date.now()}${path.extname(file.originalname) || ".jpg"}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
});

/**
 * POST /api/payments/:jobId/upload-slip — FR-PAY-04 (multipart/form-data)
 * field รูป: "slip", body: { direction: "inbound" | "outbound" }
 * inbound = Hirer โอนเงินเข้า Escrow, outbound = Admin โอนเงินออกให้ Worker/คืนเงิน Hirer
 */
const uploadSlip = [
  slipUpload.single("slip"),
  asyncHandler(async (req, res) => {
    const { direction } = req.body;
    if (!["inbound", "outbound"].includes(direction)) {
      return res.status(400).json({ message: "direction ต้องเป็น inbound หรือ outbound" });
    }
    if (!req.file) return res.status(400).json({ message: "กรุณาแนบไฟล์สลิป" });

    const payment = await Payment.findOne({ job: req.params.jobId });
    if (!payment) return res.status(404).json({ message: "ไม่พบรายการชำระเงินของงานนี้" });

    const isParty = [String(payment.hirer), String(payment.worker)].includes(String(req.user._id));
    if (!isParty && !req.user.isAdmin) {
      return res.status(403).json({ message: "คุณไม่เกี่ยวข้องกับรายการชำระเงินนี้" });
    }

    const slipUrl = `/uploads/payment-slips/${req.file.filename}`;
    if (direction === "inbound") {
      payment.inboundSlipUrl = slipUrl;
      if (payment.status === "pending") {
        payment.status = "held";
        payment.heldAt = new Date();
      }
    } else {
      payment.outboundSlipUrl = slipUrl;
    }
    await payment.save();

    res.json({ message: "อัปโหลดสลิปสำเร็จ", payment });
  }),
];

/**
 * POST /api/payments/:jobId/dispute — FR-PAY-06
 * body: { reason }
 * ผู้ว่าจ้างหรือผู้รับจ้างยื่นข้อพิพาท -> พักการชำระเงินที่เกี่ยวข้องไว้รอ Admin ตรวจสอบ
 */
const raiseDispute = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ message: "กรุณาระบุเหตุผลของข้อพิพาท" });

  const payment = await Payment.findOne({ job: req.params.jobId });
  if (!payment) return res.status(404).json({ message: "ไม่พบรายการชำระเงินของงานนี้" });

  const isParty = [String(payment.hirer), String(payment.worker)].includes(String(req.user._id));
  if (!isParty) return res.status(403).json({ message: "คุณไม่เกี่ยวข้องกับงานนี้" });
  if (["released", "refunded"].includes(payment.status)) {
    return res.status(400).json({ message: `ไม่สามารถยื่นข้อพิพาทได้เพราะเงินอยู่ในสถานะ ${payment.status} แล้ว` });
  }

  payment.status = "disputed";
  payment.disputeRaisedBy = req.user._id;
  payment.disputeReason = reason;
  await payment.save();

  const { Job } = require("../models");
  const job = await Job.findById(req.params.jobId);
  if (job) {
    job.status = "disputed";
    await job.save();
  }

  res.json({ message: "ยื่นข้อพิพาทสำเร็จ รอผู้ดูแลระบบตรวจสอบ", payment });
});

module.exports = { getWallet, getSummary, getTransactions, uploadSlip, raiseDispute };