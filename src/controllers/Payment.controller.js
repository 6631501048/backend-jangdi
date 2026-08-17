const asyncHandler = require("express-async-handler");
const { Payment } = require("../models");

/**
 * GET /api/payments/wallet — FR-PAY-08
 * สรุปยอดตาม state ของ Escrow (FR-PAY-02): pending / held (in progress) / released (available)
 * หมายเหตุ: "released" หมายถึงเงินที่ Admin โอนเข้าบัญชีธนาคารของ worker ไปแล้วจริง (FR-PAY-05)
 * ไม่ใช่ยอดเงินที่ค้างอยู่ใน wallet ของแอปที่ต้อง "ถอน" อีกขั้นหนึ่ง
 */
const getWallet = asyncHandler(async (req, res) => {
  const rows = await Payment.aggregate([
    { $match: { worker: req.user._id } },
    { $group: { _id: "$status", total: { $sum: "$netAmountToWorker" } } },
  ]);

  const totals = { pending: 0, held: 0, released: 0 };
  rows.forEach((r) => {
    if (r._id in totals) totals[r._id] = r.total;
  });

  res.json({
    availableBalance: totals.released, // โอนเข้าบัญชี worker แล้วจริง (FR-PAY-05)
    pendingBalance: totals.pending, // รอผู้ว่าจ้างโอนเงินเข้า Escrow
    inProgressBalance: totals.held, // อยู่ใน Escrow รอ Hirer ยืนยันงานเสร็จ
  });
});

/**
 * GET /api/payments/summary?period=month|last-month|all — FR-PAY-08
 */
const getSummary = asyncHandler(async (req, res) => {
  const { period = "all" } = req.query;
  const match = { worker: req.user._id, status: "released" };

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
  const totalEarnings = payments.reduce((sum, p) => sum + p.netAmountToWorker, 0);

  res.json({
    totalEarnings,
    completeJobs: payments.length,
    averageRating: req.user.credibilityScore,
  });
});

/**
 * GET /api/payments/transactions?limit=20 — FR-PAY-08
 * ประวัติเงินที่ได้รับจาก Escrow (released) เรียงล่าสุดก่อน
 */
const getTransactions = asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);

  const payments = await Payment.find({ worker: req.user._id, status: "released" })
    .populate("job", "title")
    .sort({ releasedAt: -1 })
    .limit(limit);

  const transactions = payments.map((p) => ({
    id: p._id,
    type: "received", // เงินที่ได้รับจาก Escrow ไม่ใช่ "withdraw" (ดูหมายเหตุใน getWallet)
    jobTitle: p.job?.title || "-",
    amount: p.netAmountToWorker,
    date: p.releasedAt,
  }));

  res.json(transactions);
});

module.exports = { getWallet, getSummary, getTransactions };