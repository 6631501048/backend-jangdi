const asyncHandler = require("express-async-handler");
const { Job } = require("../models");
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

module.exports = { getPendingJobs, approveJob, rejectJob };