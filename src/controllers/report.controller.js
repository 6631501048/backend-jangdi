const asyncHandler = require("express-async-handler");
const mongoose = require("mongoose");
const { Report, User, Job } = require("../models");

/** POST /api/reports — authenticated Hirer / Worker reports another user. */
const createReport = asyncHandler(async (req, res) => {
  const { reportedUserId, jobId, reason, description } = req.body || {};
  if (!mongoose.isValidObjectId(reportedUserId) || (jobId != null && !mongoose.isValidObjectId(jobId))) {
    return res.status(400).json({ message: "reportedUserId หรือ jobId ไม่ถูกต้อง" });
  }
  if (String(reportedUserId) === String(req.user._id)) {
    return res.status(400).json({ message: "ไม่สามารถรายงานตัวเองได้" });
  }
  if (typeof reason !== "string" || reason.trim().length < 5 || reason.trim().length > 200) {
    return res.status(400).json({ message: "กรุณาระบุ reason 5-200 ตัวอักษร" });
  }
  if (description != null && (typeof description !== "string" || description.trim().length > 2000)) {
    return res.status(400).json({ message: "description ต้องเป็นข้อความไม่เกิน 2000 ตัวอักษร" });
  }
  const target = await User.findById(reportedUserId).select("_id");
  if (!target) return res.status(404).json({ message: "ไม่พบผู้ใช้ที่ถูกรายงาน" });

  let relatedJob = null;
  if (jobId != null) {
    relatedJob = await Job.findById(jobId).select("hirer selectedWorker");
    if (!relatedJob) return res.status(404).json({ message: "ไม่พบงานที่อ้างอิง" });
    const participants = [relatedJob.hirer, relatedJob.selectedWorker]
      .filter(Boolean).map((id) => String(id));
    if (!participants.includes(String(req.user._id)) || !participants.includes(String(reportedUserId))) {
      return res.status(403).json({ message: "รายงานนี้ต้องเกี่ยวข้องกับผู้ใช้ทั้งสองฝ่ายในงานที่ระบุ" });
    }
  }

  // Prevent multiple open reports about the same person and job from the same reporter.
  const existing = await Report.exists({
    reporter: req.user._id, reportedUser: reportedUserId, job: jobId || null,
    status: { $in: ["pending", "investigating"] },
  });
  if (existing) return res.status(409).json({ message: "คุณมีรายงานที่รอตรวจสอบสำหรับผู้ใช้และงานนี้อยู่แล้ว" });

  const report = await Report.create({
    reporter: req.user._id, reportedUser: reportedUserId,
    job: relatedJob?._id || null, reason: reason.trim(), description: (description || "").trim(),
  });
  res.status(201).json({ message: "ส่งรายงานสำเร็จ ผู้ดูแลระบบจะตรวจสอบโดยเร็วที่สุด", report });
});

module.exports = { createReport };
