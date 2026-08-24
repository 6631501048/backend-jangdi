const asyncHandler = require("express-async-handler");
const { Job, User, Payment, Report, Sos } = require("../models");
const { logJobStatusChange } = require("../services/jobLog.service");
const { notifyUser } = require("../services/notification.service");
const { notifyNearbyWorkers } = require("../services/matching.service");

/**
 * GET /api/admin/jobs/pending
 * FR-ADMIN-02: คิวประกาศงานรออนุมัติ
 */
const getPendingJobs = asyncHandler(async (req, res) => {
  const jobs = await Job.find({ status: "pending_review" })
    .populate("hirer", "fullName email credibilityScore")
    .sort({ createdAt: 1 }); // เก่าสุดก่อน (FIFO)
  res.json(jobs);
});

/**
 * POST /api/admin/jobs/:id/approve
 * FR-JOB-05/06, FR-MATCH-01/02: อนุมัติงาน -> แจ้ง Hirer -> แจ้ง Worker ในรัศมี 2km ภายใน 1 นาที
 */
const approveJob = asyncHandler(async (req, res) => {
  const job = await Job.findById(req.params.id);
  if (!job) return res.status(404).json({ message: "ไม่พบประกาศงานนี้" });
  if (job.status !== "pending_review") {
    return res.status(400).json({ message: `งานนี้มีสถานะ ${job.status} ไม่สามารถอนุมัติได้` });
  }

  const previousStatus = job.status;
  job.status = "waiting"; // เปิดรับสมัคร (JOB_WAITING queue)
  job.approvedAt = new Date();
  job.approvedBy = req.user._id;
  await job.save();

  await logJobStatusChange({
    jobId: job._id,
    previousStatus,
    newStatus: "waiting",
    changedBy: req.user._id,
    note: "Admin อนุมัติประกาศงาน",
  });

  const io = req.app.get("io");

  // FR-JOB-06: แจ้ง Hirer ว่างานได้รับการอนุมัติแล้ว
  await notifyUser(io, {
    userId: job.hirer,
    type: "job_approved",
    title: "ประกาศงานของคุณได้รับการอนุมัติแล้ว",
    message: `งาน "${job.title}" เปิดให้สมัครแล้ว`,
    relatedEntityType: "Job",
    relatedEntityId: job._id,
  });

  // FR-MATCH-01/02 + NFR-PERF-01: ต้องแจ้ง Worker ใกล้เคียงภายใน 1 นาที
  // ไม่ await เพื่อไม่ให้ response ของ Admin ช้าลงตามจำนวน worker ที่ต้องแจ้ง
  notifyNearbyWorkers(io, job).catch((err) =>
    console.error(`notifyNearbyWorkers failed for job ${job._id}:`, err.message)
  );

  res.json({ message: "อนุมัติประกาศงานสำเร็จ", job });
});

/**
 * POST /api/admin/jobs/:id/reject
 * FR-ADMIN-02: ปฏิเสธงาน พร้อมเหตุผล (ไม่บังคับ)
 * body: { reason }
 */
const rejectJob = asyncHandler(async (req, res) => {
  const job = await Job.findById(req.params.id);
  if (!job) return res.status(404).json({ message: "ไม่พบประกาศงานนี้" });
  if (job.status !== "pending_review") {
    return res.status(400).json({ message: `งานนี้มีสถานะ ${job.status} ไม่สามารถปฏิเสธได้` });
  }

  const previousStatus = job.status;
  job.status = "rejected";
  job.rejectionReason = req.body?.reason || "ไม่ผ่านการตรวจสอบโดยผู้ดูแลระบบ";
  await job.save();

  await logJobStatusChange({
    jobId: job._id,
    previousStatus,
    newStatus: "rejected",
    changedBy: req.user._id,
    note: job.rejectionReason,
  });

  const io = req.app.get("io");
  await notifyUser(io, {
    userId: job.hirer,
    type: "job_rejected",
    title: "ประกาศงานของคุณไม่ผ่านการอนุมัติ",
    message: job.rejectionReason,
    relatedEntityType: "Job",
    relatedEntityId: job._id,
  });

  res.json({ message: "ปฏิเสธประกาศงานสำเร็จ", job });
});

/**
 * GET /api/admin/dashboard — FR-ADMIN-01
 * สรุปจำนวนผู้ใช้, ประกาศทั้งหมด, ประกาศรอดำเนินการ, SOS ที่เปิดอยู่, สรุปการเงินรายเดือน
 */
const getDashboard = asyncHandler(async (req, res) => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [totalUsers, totalJobs, pendingJobs, openSos, monthlyPayments] = await Promise.all([
    User.countDocuments(),
    Job.countDocuments(),
    Job.countDocuments({ status: "pending_review" }),
    Sos.countDocuments({ status: "active" }),
    Payment.aggregate([
      { $match: { status: "released", releasedAt: { $gte: startOfMonth } } },
      { $group: { _id: null, totalVolume: { $sum: "$amount" }, totalFees: { $sum: "$platformFeeAmount" }, count: { $sum: 1 } } },
    ]),
  ]);

  res.json({
    totalUsers,
    totalJobs,
    pendingJobs,
    openSos,
    monthlyFinancials: monthlyPayments[0] || { totalVolume: 0, totalFees: 0, count: 0 },
  });
});

/**
 * GET /api/admin/users?role=hirer|worker&search=... — FR-ADMIN-03
 */
const getUsers = asyncHandler(async (req, res) => {
  const { role, search } = req.query;
  const query = {};
  if (role) query.currentRole = role;
  if (search) {
    query.$or = [
      { fullName: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
      { studentId: { $regex: search, $options: "i" } },
    ];
  }
  const users = await User.find(query).select("-password").sort({ createdAt: -1 });
  res.json(users);
});

/**
 * POST /api/admin/users/:id/suspend — FR-ADMIN-03
 * body: { action: "warn" | "suspend" | "clear" }
 */
const updateUserStatus = asyncHandler(async (req, res) => {
  const { action } = req.body;
  const statusMap = { warn: "warned", suspend: "suspended", clear: "active" };
  if (!statusMap[action]) return res.status(400).json({ message: "action ต้องเป็น warn, suspend หรือ clear" });

  const user = await User.findByIdAndUpdate(req.params.id, { accountStatus: statusMap[action] }, { new: true }).select("-password");
  if (!user) return res.status(404).json({ message: "ไม่พบผู้ใช้นี้" });

  await notifyUser(req.app.get("io"), {
    userId: user._id,
    type: "system",
    title: "สถานะบัญชีของคุณมีการเปลี่ยนแปลง",
    message: `บัญชีของคุณถูกตั้งสถานะเป็น "${statusMap[action]}" โดยผู้ดูแลระบบ`,
  });

  res.json({ message: "อัปเดตสถานะผู้ใช้สำเร็จ", user });
});

/**
 * GET /api/admin/payments/escrow?status=held — FR-ADMIN-04
 */
const getEscrowPayments = asyncHandler(async (req, res) => {
  const { status = "held" } = req.query;
  const payments = await Payment.find({ status })
    .populate("job", "title")
    .populate("hirer", "fullName email")
    .populate("worker", "fullName email")
    .sort({ createdAt: -1 });
  res.json(payments);
});

/**
 * POST /api/admin/payments/:id/refund-decision — FR-ADMIN-05, FR-PAY-07
 * body: { decision: "approved" | "rejected" }
 */
const decideRefund = asyncHandler(async (req, res) => {
  const { decision } = req.body;
  if (!["approved", "rejected"].includes(decision)) {
    return res.status(400).json({ message: "decision ต้องเป็น approved หรือ rejected" });
  }

  const payment = await Payment.findById(req.params.id);
  if (!payment) return res.status(404).json({ message: "ไม่พบรายการนี้" });

  payment.refundDecision = decision;
  payment.refundDecidedBy = req.user._id;
  if (decision === "approved") {
    payment.status = "refunded";
  }
  await payment.save();

  await notifyUser(req.app.get("io"), {
    userId: payment.hirer,
    type: "payment_update",
    title: decision === "approved" ? "คำขอคืนเงินได้รับการอนุมัติ" : "คำขอคืนเงินถูกปฏิเสธ",
    message: `รายการชำระเงินของงาน ${payment.job}`,
    relatedEntityType: "Payment",
    relatedEntityId: payment._id,
  });

  res.json({ message: "บันทึกผลการพิจารณาคำขอคืนเงินสำเร็จ", payment });
});

/**
 * GET /api/admin/reports?status=pending — FR-ADMIN-06
 */
const getReports = asyncHandler(async (req, res) => {
  const { status } = req.query;
  const query = status ? { status } : {};
  const reports = await Report.find(query)
    .populate("reporter", "fullName email")
    .populate("reportedUser", "fullName email accountStatus")
    .sort({ createdAt: -1 });
  res.json(reports);
});

/**
 * POST /api/admin/reports/:id/resolve — FR-ADMIN-06
 * body: { status: "resolved" | "dismissed", resolutionNotes }
 */
const resolveReport = asyncHandler(async (req, res) => {
  const { status, resolutionNotes } = req.body;
  if (!["resolved", "dismissed"].includes(status)) {
    return res.status(400).json({ message: "status ต้องเป็น resolved หรือ dismissed" });
  }

  const report = await Report.findByIdAndUpdate(
    req.params.id,
    { status, resolutionNotes, resolvedBy: req.user._id, resolvedAt: new Date() },
    { new: true }
  );
  if (!report) return res.status(404).json({ message: "ไม่พบรายงานนี้" });

  res.json({ message: "บันทึกผลการตรวจสอบรายงานสำเร็จ", report });
});

/**
 * GET /api/admin/sos?status=active — FR-ADMIN-07
 */
const getSosList = asyncHandler(async (req, res) => {
  const { status } = req.query;
  const query = status ? { status } : {};
  const list = await Sos.find(query)
    .populate("worker", "fullName phone lineId")
    .populate("job", "title")
    .sort({ createdAt: -1 });
  res.json(list);
});

/**
 * POST /api/admin/sos/:id/resolve — FR-SOS-04
 * body: { adminNotes }
 */
const resolveSos = asyncHandler(async (req, res) => {
  const sos = await Sos.findByIdAndUpdate(
    req.params.id,
    { status: "resolved", resolvedAt: new Date(), resolvedBy: req.user._id, adminNotes: req.body?.adminNotes || null },
    { new: true }
  );
  if (!sos) return res.status(404).json({ message: "ไม่พบสัญญาณ SOS นี้" });
  res.json({ message: "ปิดเคส SOS สำเร็จ", sos });
});

module.exports = {
  getPendingJobs, approveJob, rejectJob,
  getDashboard, getUsers, updateUserStatus,
  getEscrowPayments, decideRefund,
  getReports, resolveReport,
  getSosList, resolveSos,
};