const asyncHandler = require("express-async-handler");
const { Report } = require("../models");

/**
 * POST /api/reports — รายงานพฤติกรรมไม่เหมาะสมของผู้ใช้ (ใช้ร่วมกับ FR-ADMIN-06)
 * body: { reportedUserId, jobId, reason, description }
 */
const createReport = asyncHandler(async (req, res) => {
  const { reportedUserId, jobId, reason, description } = req.body;
  if (!reportedUserId || !reason) {
    return res.status(400).json({ message: "กรุณาระบุ reportedUserId และ reason" });
  }
  if (String(reportedUserId) === String(req.user._id)) {
    return res.status(400).json({ message: "ไม่สามารถรายงานตัวเองได้" });
  }

  const report = await Report.create({
    reporter: req.user._id,
    reportedUser: reportedUserId,
    job: jobId || null,
    reason,
    description: description || "",
  });

  res.status(201).json({ message: "ส่งรายงานสำเร็จ ผู้ดูแลระบบจะตรวจสอบโดยเร็วที่สุด", report });
});

module.exports = { createReport };