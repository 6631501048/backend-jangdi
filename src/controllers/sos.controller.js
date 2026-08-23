const asyncHandler = require("express-async-handler");
const { Sos, Job, User } = require("../models");
const { notifyUser } = require("../services/notification.service");

/**
 * POST /api/sos — FR-SOS-01/02/03, NFR-PERF-02 (ต้องถึง Admin ภายใน 1 นาที)
 * body: { jobId, lat, lng }
 */
const createSos = asyncHandler(async (req, res) => {
  const { jobId, lat, lng } = req.body;
  if (!jobId || lat == null || lng == null) {
    return res.status(400).json({ message: "ต้องระบุ jobId, lat, lng" });
  }

  const job = await Job.findById(jobId);
  if (!job) return res.status(404).json({ message: "ไม่พบงานนี้" });
  if (String(job.selectedWorker) !== String(req.user._id)) {
    return res.status(403).json({ message: "คุณไม่ใช่ผู้รับจ้างของงานนี้" });
  }

  const sos = await Sos.create({
    worker: req.user._id,
    job: job._id,
    location: { type: "Point", coordinates: [Number(lng), Number(lat)] },
  });

  // FR-SOS-03: แจ้ง Admin ทุกคนทันที (fire-and-forget เพื่อไม่ให้ response ช้า — ต้องถึงภายใน 1 นาทีตาม NFR-PERF-02)
  const io = req.app.get("io");
  User.find({ isAdmin: true })
    .select("_id")
    .then((admins) =>
      Promise.all(
        admins.map((admin) =>
          notifyUser(io, {
            userId: admin._id,
            type: "sos_alert",
            title: "🆘 มีสัญญาณ SOS",
            message: `${req.user.fullName || "ผู้รับจ้าง"} ส่งสัญญาณฉุกเฉินระหว่างงาน "${job.title}"`,
            relatedEntityType: "Sos",
            relatedEntityId: sos._id,
          })
        )
      )
    )
    .catch((err) => console.error("แจ้งเตือน SOS ไปยัง Admin ล้มเหลว:", err.message));

  res.status(201).json({ message: "ส่งสัญญาณ SOS สำเร็จ กำลังแจ้งผู้ดูแลระบบ", sos });
});

module.exports = { createSos };