const asyncHandler = require("express-async-handler");
const mongoose = require("mongoose");
const { Sos, Job, User } = require("../models");
const { notifyUser } = require("../services/notification.service");

/** POST /api/sos — Worker may trigger even if location permission is denied. */
const createSos = asyncHandler(async (req, res) => {
  const { jobId, lat, lng } = req.body || {};
  if (!mongoose.isValidObjectId(jobId)) {
    return res.status(400).json({ message: "jobId ไม่ถูกต้อง" });
  }
  const locationProvided = lat != null || lng != null;
  if (locationProvided && (lat == null || lng == null)) {
    return res.status(400).json({ message: "ต้องระบุพิกัด latitude และ longitude ให้ครบทั้งคู่" });
  }
  let location;
  if (locationProvided) {
    const latitude = Number(lat);
    const longitude = Number(lng);
    if (typeof lat === "boolean" || typeof lng === "boolean" ||
        lat === "" || lng === "" || !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
        Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      return res.status(400).json({ message: "พิกัดตำแหน่งไม่ถูกต้อง" });
    }
    location = { type: "Point", coordinates: [longitude, latitude] };
  }

  const job = await Job.findById(jobId);
  if (!job) return res.status(404).json({ message: "ไม่พบงานนี้" });
  if (String(job.selectedWorker) !== String(req.user._id)) {
    return res.status(403).json({ message: "คุณไม่ใช่ผู้รับจ้างของงานนี้" });
  }
  if (!["assigned", "in_progress", "awaiting_confirmation"].includes(job.status)) {
    return res.status(409).json({ message: "สามารถส่ง SOS ได้เฉพาะงานที่กำลังดำเนินการ" });
  }

  // The partial unique index on {worker, job, status=active} also protects simultaneous requests.
  const filter = { worker: req.user._id, job: job._id, status: "active" };
  if (await Sos.exists(filter)) {
    return res.status(409).json({ message: "งานนี้มี SOS ที่รอผู้ดูแลดำเนินการอยู่แล้ว" });
  }
  let sos;
  try {
    sos = await Sos.create({
      worker: req.user._id, job: job._id,
      ...(location ? { location } : {}),
    });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ message: "งานนี้มี SOS ที่รอผู้ดูแลดำเนินการอยู่แล้ว" });
    }
    throw err;
  }

  // Notify all Admins. Notifications are persistent; offline Admin delivery remains pending.
  const io = req.app.get("io");
  Promise.resolve()
    .then(() => User.find({ isAdmin: true }).select("_id"))
    .then((admins) => Promise.all(admins.map((admin) => notifyUser(io, {
      userId: admin._id,
      type: "sos_alert",
      title: "มีสัญญาณ SOS",
      message: `${req.user.fullName || "ผู้รับจ้าง"} ส่งสัญญาณฉุกเฉินระหว่างงาน "${job.title}"`,
      relatedEntityType: "Sos",
      relatedEntityId: sos._id,
    }))))
    .catch((err) => console.error("แจ้งเตือน SOS ไปยัง Admin ล้มเหลว:", err));

  res.status(201).json({ message: "ส่งสัญญาณ SOS สำเร็จ กำลังแจ้งผู้ดูแลระบบ", sos });
});

module.exports = { createSos };
