const asyncHandler = require("express-async-handler");
const mongoose = require("mongoose");
const { Job, User, Payment, Report, Sos } = require("../models");
const { logJobStatusChange } = require("../services/jobLog.service");
const { notifyUser } = require("../services/notification.service");
const { notifyNearbyWorkers } = require("../services/matching.service");

// Never expose password hashes, verification secrets, banking details or precise location in Admin user lists.
const ADMIN_USER_FIELDS = "studentId email fullName currentRole accountStatus isEmailVerified isProfileComplete createdAt updatedAt +moderationHistory";
const ADMIN_USER_RESULT_FIELDS = "studentId email fullName currentRole accountStatus isEmailVerified isProfileComplete createdAt updatedAt";
const moderationActions = Object.freeze({ warn: "warned", suspend: "suspended", clear: "active" });
const validId = (id) => mongoose.isValidObjectId(id);


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
 * GET /api/admin/jobs?status=all|pending_review|rejected|waiting|...
 * Full lifecycle overview; approval is a separate operation from job status.
 * Read-only except pending_review actions. Server-side pagination avoids an unbounded list.
 */
const getAllJobs = asyncHandler(async (req, res) => {
  const known = ["pending_filter", "pending_review", "rejected", "waiting", "assigned", "in_progress", "awaiting_confirmation", "completed", "cancelled", "disputed"];
  const status = String(req.query.status || "all");
  if (status !== "all" && !known.includes(status)) return res.status(400).json({ message: "สถานะงานไม่ถูกต้อง" });
  const rawPage = req.query.page == null ? "1" : String(req.query.page);
  const rawLimit = req.query.limit == null ? "20" : String(req.query.limit);
  if (!/^[1-9]\d{0,8}$/.test(rawPage) || !/^[1-9]\d{0,8}$/.test(rawLimit)) {
    return res.status(400).json({ message: "page และ limit ต้องเป็นจำนวนเต็มบวก" });
  }
  const page = Math.min(100000, Number(rawPage));
  const limit = Math.min(100, Number(rawLimit));
  if (typeof req.query.search === "object") return res.status(400).json({ message: "search ต้องเป็นข้อความ" });
  const search = String(req.query.search || "").trim().slice(0, 100);
  const filter = status === "all" ? {} : { status };
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [{ title: { $regex: escaped, $options: "i" } }, { description: { $regex: escaped, $options: "i" } }];
  }
  const [jobs, total, counts] = await Promise.all([
    Job.find(filter)
      .select("title description category status hirer selectedWorker price deliveryFee scheduledAt createdAt updatedAt approvedAt approvedBy rejectionReason cancelReason cancelledAt proofSubmittedAt completionConfirmedAt")
      .populate("hirer", "fullName email")
      .populate("selectedWorker", "fullName")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Job.countDocuments(filter),
    Job.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
  ]);
  res.json({ jobs, total, page, limit, totalPages: Math.ceil(total / limit), counts: Object.fromEntries(counts.map((row) => [row._id, row.count])) });
});

/**
 * POST /api/admin/jobs/:id/approve
 * FR-JOB-05/06, FR-MATCH-01/02: อนุมัติงาน -> แจ้ง Hirer -> แจ้ง Worker ในรัศมี 2km ภายใน 1 นาที
 */
const approveJob = asyncHandler(async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ message: "Job ID ไม่ถูกต้อง" });
  // Compare-and-swap: two Admin requests cannot both approve/reject the same pending job.
  const job = await Job.findOneAndUpdate(
    { _id: req.params.id, status: "pending_review" },
    { $set: { status: "waiting", approvedAt: new Date(), approvedBy: req.user._id, rejectionReason: null } },
    { new: true, runValidators: true }
  );
  if (!job) {
    const current = await Job.findById(req.params.id);
    return current
      ? res.status(409).json({ message: `งานนี้มีสถานะ ${current.status} ไม่สามารถอนุมัติได้` })
      : res.status(404).json({ message: "ไม่พบประกาศงานนี้" });
  }

  // Status is already committed; side effect failures must not turn a successful approval into a retryable 500.
  try {
    await logJobStatusChange({
      jobId: job._id, previousStatus: "pending_review", newStatus: "waiting",
      changedBy: req.user._id, note: "Admin อนุมัติประกาศงาน",
    });
  } catch (err) { console.error("Admin approve job log failed:", err); }

  const io = req.app.get("io");
  try {
    await notifyUser(io, {
      userId: job.hirer, type: "job_approved",
      title: "ประกาศงานของคุณได้รับการอนุมัติแล้ว",
      message: `งาน "${job.title}" เปิดให้สมัครแล้ว`,
      relatedEntityType: "Job", relatedEntityId: job._id,
    });
  } catch (err) { console.error("Admin approve notification failed:", err); }
  Promise.resolve().then(() => notifyNearbyWorkers(io, job)).catch((err) =>
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
  if (!validId(req.params.id)) return res.status(400).json({ message: "Job ID ไม่ถูกต้อง" });
  const input = req.body?.reason;
  if (input !== undefined && typeof input !== "string") {
    return res.status(400).json({ message: "reason ต้องเป็นข้อความ" });
  }
  const reason = String(input || "").trim() || "ไม่ผ่านการตรวจสอบโดยผู้ดูแลระบบ";
  if (reason.length > 500) return res.status(400).json({ message: "เหตุผลต้องไม่เกิน 500 ตัวอักษร" });
  const job = await Job.findOneAndUpdate(
    { _id: req.params.id, status: "pending_review" },
    { $set: { status: "rejected", rejectionReason: reason } },
    { new: true, runValidators: true }
  );
  if (!job) {
    const current = await Job.findById(req.params.id);
    return current
      ? res.status(409).json({ message: `งานนี้มีสถานะ ${current.status} ไม่สามารถปฏิเสธได้` })
      : res.status(404).json({ message: "ไม่พบประกาศงานนี้" });
  }
  try {
    await logJobStatusChange({
      jobId: job._id, previousStatus: "pending_review", newStatus: "rejected",
      changedBy: req.user._id, note: reason,
    });
  } catch (err) { console.error("Admin reject job log failed:", err); }
  try {
    await notifyUser(req.app.get("io"), {
      userId: job.hirer, type: "job_rejected",
      title: "ประกาศงานของคุณไม่ผ่านการอนุมัติ", message: reason,
      relatedEntityType: "Job", relatedEntityId: job._id,
    });
  } catch (err) { console.error("Admin reject notification failed:", err); }
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
  if (role && !["hirer", "worker"].includes(role)) {
    return res.status(400).json({ message: "role ต้องเป็น hirer หรือ worker" });
  }
  if (search != null && (typeof search !== "string" || search.length > 100)) {
    return res.status(400).json({ message: "search ต้องเป็นข้อความไม่เกิน 100 ตัวอักษร" });
  }
  const query = { isAdmin: { $ne: true } };
  if (role) query.currentRole = role;
  if (search?.trim()) {
    const escaped = search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.$or = [
      { fullName: { $regex: escaped, $options: "i" } },
      { email: { $regex: escaped, $options: "i" } },
      { studentId: { $regex: escaped, $options: "i" } },
    ];
  }
  const users = await User.find(query).select(ADMIN_USER_FIELDS).sort({ createdAt: -1 });
  res.json(users);
});

/**
 * POST /api/admin/users/:id/suspend — FR-ADMIN-03
 * body: { action: "warn" | "suspend" | "clear", reason: string }
 * All moderation decisions are saved atomically alongside the status update.
 */
const updateUserStatus = asyncHandler(async (req, res) => {
  const action = req.body?.action;
  const toStatus = moderationActions[action];
  if (!toStatus) return res.status(400).json({ message: "action ต้องเป็น warn, suspend หรือ clear" });
  const reason = req.body?.reason;
  if (typeof reason !== "string" || reason.trim().length < 5 || reason.trim().length > 500) {
    return res.status(400).json({ message: "กรุณาระบุเหตุผล 5-500 ตัวอักษร" });
  }
  if (!validId(req.params.id)) return res.status(400).json({ message: "User ID ไม่ถูกต้อง" });
  if (String(req.params.id) === String(req.user._id)) {
    return res.status(403).json({ message: "ไม่สามารถเปลี่ยนสถานะบัญชีของตัวเองได้" });
  }
  const target = await User.findById(req.params.id);
  if (!target) return res.status(404).json({ message: "ไม่พบผู้ใช้นี้" });
  if (target.isAdmin) return res.status(403).json({ message: "ไม่สามารถเปลี่ยนสถานะบัญชีผู้ดูแลระบบได้" });
  if (target.accountStatus === toStatus) return res.status(409).json({ message: "บัญชีมีสถานะนี้อยู่แล้ว" });

  // Guard against concurrent moderation and role promotion; audit and new status update in ONE document.
  const now = new Date();
  const user = await User.findOneAndUpdate(
    { _id: req.params.id, isAdmin: { $ne: true }, accountStatus: target.accountStatus },
    { $set: { accountStatus: toStatus }, $push: { moderationHistory: {
      action, previousStatus: target.accountStatus, newStatus: toStatus,
      reason: reason.trim(), performedBy: req.user._id, performedAt: now,
    } } },
    { new: true, runValidators: true, projection: ADMIN_USER_RESULT_FIELDS }
  );
  if (!user) return res.status(409).json({ message: "สถานะบัญชีมีการเปลี่ยนแปลง กรุณารีเฟรชแล้วลองใหม่" });

  try {
    await notifyUser(req.app.get("io"), {
      userId: user._id, type: "system", title: "สถานะบัญชีของคุณมีการเปลี่ยนแปลง",
      message: `บัญชีของคุณถูกตั้งสถานะเป็น "${toStatus}" โดยผู้ดูแลระบบ`,
    });
  } catch (err) { console.error("Admin moderation notification failed:", err); }
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
  const status = req.query.status;
  if (status && !["pending", "investigating", "resolved", "dismissed"].includes(status)) {
    return res.status(400).json({ message: "สถานะ Report ไม่ถูกต้อง" });
  }
  const reports = await Report.find(status ? { status } : {})
    .populate("reporter", "fullName email")
    .populate("reportedUser", "fullName email accountStatus")
    .sort({ createdAt: -1 });
  res.json(reports);
});

/** POST /api/admin/reports/:id/resolve — close once, with an auditable decision. */
const resolveReport = asyncHandler(async (req, res) => {
  const { status, resolutionNotes } = req.body || {};
  if (!["resolved", "dismissed"].includes(status)) {
    return res.status(400).json({ message: "status ต้องเป็น resolved หรือ dismissed" });
  }
  if (typeof resolutionNotes !== "string" || resolutionNotes.trim().length < 5 || resolutionNotes.trim().length > 1000) {
    return res.status(400).json({ message: "กรุณาระบุหมายเหตุ 5-1000 ตัวอักษร" });
  }
  if (!validId(req.params.id)) return res.status(400).json({ message: "Report ID ไม่ถูกต้อง" });
  const report = await Report.findOneAndUpdate(
    { _id: req.params.id, status: { $in: ["pending", "investigating"] } },
    { $set: { status, resolutionNotes: resolutionNotes.trim(), resolvedBy: req.user._id, resolvedAt: new Date() } },
    { new: true, runValidators: true }
  );
  if (!report) {
    const current = await Report.findById(req.params.id);
    return current
      ? res.status(409).json({ message: "รายงานนี้ถูกปิดแล้วหรือมีการอัปเดตโดยผู้ดูแลระบบคนอื่น" })
      : res.status(404).json({ message: "ไม่พบรายงานนี้" });
  }
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
  getPendingJobs, getAllJobs, approveJob, rejectJob,
  getDashboard, getUsers, updateUserStatus,
  getEscrowPayments, decideRefund,
  getReports, resolveReport,
  getSosList, resolveSos,
};