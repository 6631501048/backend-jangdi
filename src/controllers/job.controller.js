const asyncHandler = require("express-async-handler");
const { Job } = require("../models");
const { checkContent } = require("../utils/contentFilter");
const { logJobStatusChange } = require("../services/jobLog.service");

/**
 * POST /api/jobs
 * FR-JOB-01: สร้างประกาศงาน
 * FR-JOB-03/04: กรองเนื้อหาอัตโนมัติก่อนเข้าคิว Admin — ถ้าไม่ผ่านให้ reject ทันทีไม่ส่งต่อ Admin
 * body: { category, title, description, price, scheduledAt, locationText, lat, lng }
 */
const createJob = asyncHandler(async (req, res) => {
  const { category, title, description, price, scheduledAt, locationText, lat, lng } = req.body;

  if (!category || !title || !description || price == null || !scheduledAt || lat == null || lng == null) {
    return res.status(400).json({ message: "กรุณากรอกข้อมูลให้ครบ (category, title, description, price, scheduledAt, lat, lng)" });
  }

  // FR-JOB-03: รันตัวกรองเนื้อหาอัตโนมัติกับ title + description
  const filterResult = checkContent(`${title} ${description}`);

  const job = await Job.create({
    hirer: req.user._id,
    category,
    title,
    description,
    price,
    scheduledAt,
    locationText,
    location: { type: "Point", coordinates: [Number(lng), Number(lat)] },
    contentFilterPassed: filterResult.passed,
    status: filterResult.passed ? "pending_review" : "rejected", // FR-JOB-04/05
    rejectionReason: filterResult.passed ? null : filterResult.reason,
  });

  await logJobStatusChange({
    jobId: job._id,
    previousStatus: null,
    newStatus: job.status,
    changedBy: req.user._id,
    note: filterResult.passed ? "ผ่านตัวกรองอัตโนมัติ รอ Admin อนุมัติ" : filterResult.reason,
  });

  if (!filterResult.passed) {
    // FR-JOB-04: แจ้งผู้ว่าจ้างทันทีว่าไม่ผ่าน ไม่ส่งต่อ Admin
    return res.status(400).json({
      message: "ประกาศงานไม่ผ่านการตรวจสอบเนื้อหาอัตโนมัติ",
      reason: filterResult.reason,
      job,
    });
  }

  // FR-JOB-05: ผ่านตัวกรองแล้ว เข้าคิวรอ Admin อนุมัติ
  res.status(201).json({
    message: "ส่งประกาศงานสำเร็จ กำลังรอผู้ดูแลระบบตรวจสอบ",
    job,
  });
});

/**
 * GET /api/jobs/my?status=waiting
 * FR-JOB-08: ดูงานที่ตนเองประกาศ กรองตามสถานะได้
 */
const getMyJobs = asyncHandler(async (req, res) => {
  const { status } = req.query;
  const query = { hirer: req.user._id };
  if (status) query.status = status;

  const jobs = await Job.find(query).sort({ createdAt: -1 });
  res.json(jobs);
});

/** GET /api/jobs/:id — FR-BROWSE-03 (ดูรายละเอียดงาน) */
const getJobById = asyncHandler(async (req, res) => {
  const job = await Job.findById(req.params.id).populate("hirer", "fullName avatarUrl credibilityScore");
  if (!job) return res.status(404).json({ message: "ไม่พบประกาศงานนี้" });
  res.json(job);
});

/**
 * POST /api/jobs/:id/cancel
 * FR-JOB-07: ยกเลิกประกาศงาน (เจ้าของงานเท่านั้น)
 */
const cancelJob = asyncHandler(async (req, res) => {
  const job = await Job.findById(req.params.id);
  if (!job) return res.status(404).json({ message: "ไม่พบประกาศงานนี้" });
  if (String(job.hirer) !== String(req.user._id)) {
    return res.status(403).json({ message: "คุณไม่ใช่เจ้าของประกาศงานนี้" });
  }
  if (["completed", "cancelled"].includes(job.status)) {
    return res.status(400).json({ message: `ไม่สามารถยกเลิกงานที่มีสถานะ ${job.status} ได้` });
  }

  const previousStatus = job.status;
  job.status = "cancelled";
  job.cancelledAt = new Date();
  job.cancelReason = req.body?.reason || null;
  await job.save();

  await logJobStatusChange({
    jobId: job._id,
    previousStatus,
    newStatus: "cancelled",
    changedBy: req.user._id,
    note: job.cancelReason,
  });

  // TODO (FR-JOB-07 / FR-PAY-06,07): ถ้ามีเงินพักใน Escrow (Payment.status === "held")
  // ให้สร้าง refund request ที่นี่ ต่อเมื่อ implement payment.controller.js

  res.json({ message: "ยกเลิกประกาศงานสำเร็จ", job });
});

module.exports = { createJob, getMyJobs, getJobById, cancelJob };